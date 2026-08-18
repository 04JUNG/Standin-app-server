// Standin BFF (앱 서버) 엔트리포인트.
// 경계: [Tauri] ──/v1──> [BFF: 이 서버] ──HTTP──> [도원 추론 서버]
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { closeDb, initDb, runDataMaintenance } from "./db.js";
import type { AppEnv } from "./env.js";
import { health } from "./inference.js";
import { startInferenceWatch } from "./inferenceWatch.js";
import { errorFields, log } from "./log.js";
import { flush as flushAlerts, notify, notifyNow } from "./notify.js";
import { runWithContext } from "./requestContext.js";
import { errorEnvelope } from "./mapping.js";
import { requireAuth } from "./auth/middleware.js";
import { authRoutes } from "./auth/routes.js";
import { usersRoutes } from "./users/routes.js";
import { jobsRoutes } from "./jobs/routes.js";
import { failStaleJobs } from "./jobs/store.js";
import { dispatchPendingJobs } from "./jobs/queue.js";
import { poseRoutes } from "./pose/routes.js";
import { analyticsRoutes } from "./analytics/routes.js";
import { installationRoutes } from "./installations/routes.js";
import { requireInstallation } from "./installations/middleware.js";
import { rateLimitByIp } from "./limits/middleware.js";
import { adminRoutes } from "./admin/routes.js";

const app = new Hono<AppEnv>();

/**
 * requestId 부여 + 요청 로그 한 줄(오류봉투·집계·알림의 공통 입구).
 *
 * `runWithContext`로 감싸는 이유: 이 안에서 await하는 모든 코드가 requestId를 자동으로
 * 물고 다닌다. 로거가 알아서 싣고, 추론 호출도 `X-Request-Id`로 그대로 넘긴다 —
 * 함수 시그니처마다 requestId를 끼워 넣지 않아도 두 서버의 로그가 이어진다.
 */
app.use("*", async (c, next) => {
  const requestId = `req_${randomUUID()}`;
  const startedAt = Date.now();
  c.set("requestId", requestId);
  const pathJobId = c.req.path.match(/^\/v1\/analysis\/jobs\/(job_[0-9a-f-]+)/i)?.[1];
  const queryJobId = c.req.query("jobId");
  const jobId = pathJobId ?? (/^job_[0-9a-f-]+$/i.test(queryJobId ?? "") ? queryJobId : undefined);

  await runWithContext({ requestId, jobId }, async () => {
    // 라우트 **패턴**을 쓴다. 실제 경로를 넣으면 jobId마다 다른 값이 되어
    // 집계 카디널리티가 터진다.
    const requestLine = (status: number, errorCode?: string) =>
      log[status >= 500 ? "warn" : "info"]({
        type: "http_request",
        route: c.req.routePath,
        method: c.req.method,
        installationId: c.get("installationId"),
        status,
        durationMs: Date.now() - startedAt,
        ...(errorCode ? { errorCode } : status >= 400 ? { errorCode: `HTTP_${status}` } : {}),
      });

    try {
      await next();
      requestLine(c.res.status);
    } catch (error) {
      // ⚠ 여기서 c.res를 읽으면 안 된다 — 응답이 아직 없으면 Hono가 404를 만들어 낸다.
      //   실제 500 본문은 아래 onError가 만들고, 여기서는 한 줄만 남기고 다시 던진다.
      requestLine(500, "INTERNAL_ERROR");
      throw error;
    }
  });
});

/**
 * 처리되지 않은 예외의 단일 종착지.
 *
 * 이게 없으면 Hono 기본 핸들러가 평문 500을 돌려주는데, 그건 클라가 기대하는
 * `{error:{code}}` 봉투가 아니다(docs/API.md). 그리고 알림을 걸 지점도 사라진다.
 */
app.onError((error, c) => {
  const route = c.req.routePath;
  log.error({
    type: "unhandled_error",
    route,
    method: c.req.method,
    errorCode: "INTERNAL_ERROR",
    ...errorFields(error),
  });
  // 라우트별로 접는다 — 한 엔드포인트가 터진 것과 서버 전체가 터진 것은 다른 사건이다.
  notify({
    severity: "P2",
    code: "UNHANDLED_ERROR",
    key: `P2:unhandled:${route}`,
    message: `${c.req.method} ${route} 처리 중 예외가 발생했습니다.`,
    context: { 예외: error instanceof Error ? error.name : "NonError" },
  });
  return c.json(
    errorEnvelope("INTERNAL_ERROR", "일시적인 오류가 발생했습니다.", c.get("requestId")),
    500,
  );
});

// 클라는 Tauri 웹뷰라 출처가 이 서버와 다르다. CORS가 없으면 preflight가 404로 떨어져
// 로그인 요청 자체가 나가지 못한다(브라우저 dev는 http://localhost:1420, 패키지된 앱은
// Windows가 http://tauri.localhost, macOS가 tauri://localhost).
// 허용 목록은 CORS_ORIGINS로 덮어쓴다 — 배포에서 아무 출처나 열지 않기 위해 * 는 쓰지 않는다.
app.use(
  "*",
  cors({
    origin: config.corsOrigins,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "X-Installation-Id",
      "X-Device-Token",
      "X-Beta-Admin-Token",
    ],
    // 429 응답의 Retry-After를 웹뷰가 읽으려면 노출 목록에 있어야 한다(사용량 제한 안내).
    exposeHeaders: ["Retry-After"],
    credentials: true,
    maxAge: 600,
  }),
);

// 공개 엣지 헬스체크(+ 추론 서버 연결 상태)
app.get("/healthz", async (c) => {
  return c.json({ ok: true, inference: await health() });
});

// /v1 계약 (클라 endpoints.ts와 맞물림)
// 공개: /v1/auth/*  |  보호(requireAuth): users·analysis·pose-candidates
app.route("/v1/auth", authRoutes);

// 설치 등록은 공개 엔드포인트라 IP 제한이 유일한 방어선이다(무제한 발급 차단).
// 동의 철회 삭제(DELETE /current/data)는 제한하지 않는다 — 메서드를 좁혀서 건다.
app.on(
  "POST",
  "/v1/installations",
  rateLimitByIp("ip_register", config.rateIpRegister, config.rateIpRegisterWindow),
);
app.route("/v1/installations", installationRoutes);

app.use("/v1/users/*", requireAuth);
app.use("/v1/analysis/*", requireInstallation);
// 인증 뒤·본문 파싱 앞에 둔다. 미인증 요청이 IP 예산을 깎지 않게 하고,
// 20MB body를 읽기 전에 거절하기 위해서다.
app.on(
  "POST",
  "/v1/analysis/jobs",
  rateLimitByIp("ip_analyze", config.rateIpAnalyze, config.rateIpAnalyzeWindow),
  // parseBody()는 body를 통째로 메모리에 올린 뒤에야 크기를 알 수 있다. 그 전에
  // Content-Length로 끊어 500MB 업로드를 다 받아놓고 거절하는 일이 없게 한다.
  bodyLimit({
    maxSize: config.maxUploadBytes,
    onError: (c) =>
      c.json(
        errorEnvelope(
          "PAYLOAD_TOO_LARGE",
          "이미지가 너무 큽니다. 20MB 이하로 줄여 주세요.",
          c.get("requestId"),
        ),
        413,
      ),
  }),
);
app.use("/v1/pose-candidates/*", requireInstallation);
app.use("/v1/events/*", requireInstallation);

app.route("/v1/users", usersRoutes);
app.route("/v1/analysis/jobs", jobsRoutes);
app.route("/v1/pose-candidates", poseRoutes);
app.route("/v1/events", analyticsRoutes);
app.route("/v1/admin", adminRoutes);

// DB가 준비된 뒤에 요청을 받는다. 실패하면 기동하지 않는다 —
// 스키마 없이 떠 있으면 모든 요청이 500이 되고 컨테이너는 healthy로 보인다.
await initDb().catch(async (err) => {
  log.error({ type: "startup", errorCode: "DB_INIT_FAILED", ...errorFields(err) });
  // 곧 프로세스가 죽는다. 배치 창을 기다릴 수 없으므로 동기로 한 번 보낸다 —
  // 이 알림을 놓치면 "태스크가 계속 재시작한다"는 사실을 아무도 모른다.
  await notifyNow({
    severity: "P1",
    code: "DB_INIT_FAILED",
    message: "BFF가 DB 초기화에 실패해 기동하지 못했습니다. 태스크가 반복 재시작합니다.",
    context: { 원인: err instanceof Error ? err.name : "NonError" },
  });
  process.exit(1);
});
if (config.jobExecutionMode === "sqs" && !config.analysisQueueUrl) {
  throw new Error("ANALYSIS_QUEUE_URL is required when JOB_EXECUTION_MODE=sqs");
}

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  log.info({
    type: "startup",
    msg: "listening",
    port: info.port,
    inference: config.inferenceBaseUrl,
  });
});

notify({
  severity: "P3",
  code: "STARTUP",
  message: `BFF 기동 — port ${config.port}`,
  context: { version: config.deploymentVersion, env: process.env.NODE_ENV ?? "development" },
});

// 추론 서버는 ALB에 붙어 있지 않아 밖에서 아무도 보지 않는다. BFF가 대신 지켜본다.
const stopInferenceWatch = startInferenceWatch();

const maintenanceTimer = setInterval(() => {
  void runDataMaintenance().catch((error) =>
    log.error({ type: "data_maintenance", errorCode: "MAINTENANCE_FAILED", ...errorFields(error) }),
  );
}, 24 * 60 * 60 * 1000);
maintenanceTimer.unref();

// 유실된 Job 정리. 24시간 주기 유지보수로는 너무 느리다 — 동시 분석 한도가 1이라
// running인 채로 남은 Job 하나가 그 설치를 계속 막는다.
const sweepStaleJobs = () =>
  (config.jobExecutionMode === "inline" ? failStaleJobs() : Promise.resolve(0))
    .then((count) => {
      if (count === 0) return;
      log.warn({ type: "stale_jobs_swept", count, errorCode: "STALE_JOBS" });
      // 유실 Job은 사용자가 결과를 못 받았다는 뜻이다. 조용히 지나가면 안 된다.
      notify({
        severity: "P2",
        code: "STALE_JOBS",
        message: `${config.analysisStaleAfterSeconds}초 넘게 진행 중이던 Job ${count}건을 실패로 정리했습니다.`,
      });
    })
    .catch((error) =>
      log.error({ type: "stale_jobs_swept", errorCode: "SWEEP_FAILED", ...errorFields(error) }),
    );
void sweepStaleJobs();
const staleJobTimer = setInterval(() => void sweepStaleJobs(), 60 * 1000);
staleJobTimer.unref();

// 요청 직후 전송이 실패해도 outbox를 주기적으로 재발행한다.
const outboxTimer = setInterval(() => {
  if (config.jobExecutionMode === "sqs") {
    void dispatchPendingJobs().catch((error) => {
      log.error({
        type: "queue_dispatch",
        errorCode: "QUEUE_DISPATCH_FAILED",
        ...errorFields(error),
      });
      notify({
        severity: "P2",
        code: "QUEUE_DISPATCH_FAILED",
        message: "BFF가 대기 중인 분석 작업을 SQS에 발행하지 못했습니다.",
      });
    });
  }
}, 5000);
outboxTimer.unref();

// ECS는 태스크를 교체할 때 SIGTERM을 보낸다. 진행 중 요청을 마치고 커넥션을 정리한다.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    log.info({ type: "shutdown", msg: `${signal} 수신 — 종료합니다.`, signal });
    stopInferenceWatch();
    server.close(() => {
      // 버퍼에 남은 알림을 먼저 밀어낸다. 종료 신호 뒤에는 배치 창을 기다릴 수 없다.
      void flushAlerts()
        .catch(() => undefined)
        .finally(() => void closeDb().finally(() => process.exit(0)));
    });
  });
}
