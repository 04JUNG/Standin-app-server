// Standin BFF (앱 서버) 엔트리포인트.
// 경계: [Tauri] ──/v1──> [BFF: 이 서버] ──HTTP──> [도원 추론 서버]
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { closeDb, initDb, runDataMaintenance } from "./db.js";
import type { AppEnv } from "./env.js";
import { health } from "./inference.js";
import { requireAuth } from "./auth/middleware.js";
import { authRoutes } from "./auth/routes.js";
import { usersRoutes } from "./users/routes.js";
import { jobsRoutes } from "./jobs/routes.js";
import { poseRoutes } from "./pose/routes.js";
import { analyticsRoutes } from "./analytics/routes.js";
import { installationRoutes } from "./installations/routes.js";
import { requireInstallation } from "./installations/middleware.js";
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
app.route("/v1/installations", installationRoutes);

app.use("/v1/users/*", requireAuth);
app.use("/v1/analysis/*", requireInstallation);
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

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[bff] listening on http://localhost:${info.port}`);
  console.log(`[bff] inference → ${config.inferenceBaseUrl}`);
});

const maintenanceTimer = setInterval(() => {
  void runDataMaintenance().catch(() => console.error("[bff] data maintenance failed"));
}, 24 * 60 * 60 * 1000);
maintenanceTimer.unref();

// ECS는 태스크를 교체할 때 SIGTERM을 보낸다. 진행 중 요청을 마치고 커넥션을 정리한다.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(`[bff] ${signal} 수신 — 종료합니다.`);
    server.close(() => {
      void closeDb().finally(() => process.exit(0));
    });
  });
}
