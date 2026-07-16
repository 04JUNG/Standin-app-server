// 환경설정 단일 소스. dev는 셸 env 또는 `tsx --env-file=.env`로 주입.
export const config = {
  port: Number(process.env.PORT ?? 8080),
  // 도원 추론 서버(내부망, 무인증). ⚠ 공개 노출 금지.
  inferenceBaseUrl: process.env.INFERENCE_BASE_URL ?? "http://127.0.0.1:8000",
  inferenceServiceToken: process.env.INFERENCE_SERVICE_TOKEN ?? "",
  // 인증(Phase 1)
  jwtSecret: process.env.JWT_SECRET ?? "dev-only-change-me",
  accessTokenTtl: Number(process.env.ACCESS_TOKEN_TTL ?? 900),
  refreshTokenTtl: Number(process.env.REFRESH_TOKEN_TTL ?? 1209600),
  // BFF 전용 DB(추론 poses.db와 분리)
  dbPath: process.env.DB_PATH ?? "data/bff.db",
} as const;
