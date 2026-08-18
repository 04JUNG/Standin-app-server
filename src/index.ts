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

// requestId 부여(오류봉투·로깅용)
app.use("*", async (c, next) => {
  const requestId = `req_${randomUUID()}`;
  const startedAt = Date.now();
  c.set("requestId", requestId);
  const pathJobId = c.req.path.match(/^\/v1\/analysis\/jobs\/(job_[0-9a-f-]+)/i)?.[1];
  const queryJobId = c.req.query("jobId");
  const jobId = pathJobId ?? (/^job_[0-9a-f-]+$/i.test(queryJobId ?? "") ? queryJobId : undefined);
  try {
    await next();
    console.info(
      JSON.stringify({
        type: "http_request",
        requestId,
        ...(jobId ? { jobId } : {}),
        status: c.res.status,
        durationMs: Date.now() - startedAt,
        ...(c.res.status >= 400 ? { errorCode: `HTTP_${c.res.status}` } : {}),
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "http_request",
        requestId,
        ...(jobId ? { jobId } : {}),
        status: 500,
        durationMs: Date.now() - startedAt,
        errorCode: "INTERNAL_ERROR",
      }),
    );
    throw error;
  }
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
await initDb().catch((err) => {
  console.error("[bff] DB 초기화 실패:", err);
  process.exit(1);
});
if (config.jobExecutionMode === "sqs" && !config.analysisQueueUrl) {
  throw new Error("ANALYSIS_QUEUE_URL is required when JOB_EXECUTION_MODE=sqs");
}

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[bff] listening on http://localhost:${info.port}`);
  console.log(`[bff] inference → ${config.inferenceBaseUrl}`);
});

const maintenanceTimer = setInterval(() => {
  void runDataMaintenance().catch(() => console.error("[bff] data maintenance failed"));
}, 24 * 60 * 60 * 1000);
maintenanceTimer.unref();

// 유실된 Job 정리. 24시간 주기 유지보수로는 너무 느리다 — 동시 분석 한도가 1이라
// running인 채로 남은 Job 하나가 그 설치를 계속 막는다.
const sweepStaleJobs = () =>
  (config.jobExecutionMode === "inline" ? failStaleJobs() : Promise.resolve(0))
    .then((count) => {
      if (count > 0) console.warn(JSON.stringify({ type: "stale_jobs_swept", count }));
    })
    .catch(() => console.error("[bff] stale job sweep failed"));
void sweepStaleJobs();
const staleJobTimer = setInterval(() => void sweepStaleJobs(), 60 * 1000);
staleJobTimer.unref();

// 요청 직후 전송이 실패해도 outbox를 주기적으로 재발행한다.
const outboxTimer = setInterval(() => {
  if (config.jobExecutionMode === "sqs") {
    void dispatchPendingJobs().catch(() => console.error("[bff] queue dispatch failed"));
  }
}, 5000);
outboxTimer.unref();

// ECS는 태스크를 교체할 때 SIGTERM을 보낸다. 진행 중 요청을 마치고 커넥션을 정리한다.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(`[bff] ${signal} 수신 — 종료합니다.`);
    server.close(() => {
      void closeDb().finally(() => process.exit(0));
    });
  });
}
