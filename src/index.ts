// Standin BFF (앱 서버) 엔트리포인트.
// 경계: [Tauri] ──/v1──> [BFF: 이 서버] ──HTTP──> [도원 추론 서버]
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { closeDb, initDb } from "./db.js";
import type { AppEnv } from "./env.js";
import { health } from "./inference.js";
import { requireAuth } from "./auth/middleware.js";
import { authRoutes } from "./auth/routes.js";
import { usersRoutes } from "./users/routes.js";
import { jobsRoutes } from "./jobs/routes.js";
import { poseRoutes } from "./pose/routes.js";

const app = new Hono<AppEnv>();

// requestId 부여(오류봉투·로깅용)
app.use("*", async (c, next) => {
  c.set("requestId", `req_${randomUUID()}`);
  await next();
});

// 공개 엣지 헬스체크(+ 추론 서버 연결 상태)
app.get("/healthz", async (c) => {
  return c.json({ ok: true, inference: await health() });
});

// /v1 계약 (클라 endpoints.ts와 맞물림)
// 공개: /v1/auth/*  |  보호(requireAuth): users·analysis·pose-candidates
app.route("/v1/auth", authRoutes);

app.use("/v1/users/*", requireAuth);
app.use("/v1/analysis/*", requireAuth);
app.use("/v1/pose-candidates/*", requireAuth);

app.route("/v1/users", usersRoutes);
app.route("/v1/analysis/jobs", jobsRoutes);
app.route("/v1/pose-candidates", poseRoutes);

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

// ECS는 태스크를 교체할 때 SIGTERM을 보낸다. 진행 중 요청을 마치고 커넥션을 정리한다.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(`[bff] ${signal} 수신 — 종료합니다.`);
    server.close(() => {
      void closeDb().finally(() => process.exit(0));
    });
  });
}
