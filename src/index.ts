// Standin BFF (앱 서버) 엔트리포인트.
// 경계: [Tauri] ──/v1──> [BFF: 이 서버] ──HTTP──> [도원 추론 서버]
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import type { AppEnv } from "./env.js";
import { health } from "./inference.js";
import { authRoutes } from "./auth/routes.js";
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
app.route("/v1/auth", authRoutes);
app.route("/v1/analysis/jobs", jobsRoutes);
app.route("/v1/pose-candidates", poseRoutes);
// TODO(Phase 1): app.route("/v1/users", usersRoutes)  // GET /v1/users/me

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[bff] listening on http://localhost:${info.port}`);
  console.log(`[bff] inference → ${config.inferenceBaseUrl}`);
});
