// 환경설정 단일 소스. dev는 셸 env 또는 `tsx --env-file=.env`로 주입.
function env(key: string, def = ""): string {
  return process.env[key] ?? def;
}

export const config = {
  port: Number(process.env.PORT ?? 8080),
  // BFF 공개 URL(OAuth 콜백·이메일 인증 링크 구성용)
  publicUrl: env("PUBLIC_URL", "http://localhost:8080"),

  /**
   * CORS 허용 출처. 콤마로 구분해 CORS_ORIGINS로 덮어쓴다.
   *
   * 기본값은 클라가 쓰는 출처들이다 — Tauri dev 웹뷰(1420), 패키지된 앱의 Windows
   * (http://tauri.localhost)와 macOS(tauri://localhost), 그리고 랜딩 dev 서버(5173).
   * 랜딩의 /signup 이 register·resend-verification 을 직접 호출한다.
   * 배포에서는 실제 랜딩 도메인을 CORS_ORIGINS에 넣는다.
   */
  corsOrigins: env(
    "CORS_ORIGINS",
    "http://localhost:1420,http://tauri.localhost,tauri://localhost,http://localhost:5173",
  )
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),

  // 도원 추론 서버(내부망, 무인증). ⚠ 공개 노출 금지.
  inferenceBaseUrl: env("INFERENCE_BASE_URL", "http://127.0.0.1:8000"),
  inferenceServiceToken: env("INFERENCE_SERVICE_TOKEN"),

  /**
   * refine 노출 스위치(OPS-02). 추론 서버의 REFINE_ENABLED와 **별도**다.
   *
   * 추론 endpoint가 살아 있어도 이 값이 false면 클라이언트에 refine을 노출하지 않는다.
   * 조정본 영속화와 저장 전 미리보기가 staging에서 검증되기 전까지 production 기본값은 off다.
   */
  refineFeatureEnabled: env("REFINE_FEATURE_ENABLED", "false") === "true",
  // refine은 사용자가 저장을 기다리는 동기 경로다. 느려지면 베이스로 넘어간다(BFF-07).
  refineTimeoutMs: Number(process.env.REFINE_TIMEOUT_MS ?? 5000),
  // Explicit temporary demo mode. User/account endpoints remain protected.
  allowAnonymousAnalysis: env("ALLOW_ANONYMOUS_ANALYSIS", "false") === "true",
  betaDataBucket: env("BETA_DATA_BUCKET"),
  deploymentVersion: env("DEPLOYMENT_VERSION", "development"),
  consentVersion: env("BETA_CONSENT_VERSION", "2026-08-02"),
  betaReviewAdminToken: env("BETA_REVIEW_ADMIN_TOKEN"),

  // 인증(JWT)
  jwtSecret: env("JWT_SECRET", "dev-only-change-me"),
  accessTokenTtl: Number(process.env.ACCESS_TOKEN_TTL ?? 900), // 15분
  refreshTokenTtl: Number(process.env.REFRESH_TOKEN_TTL ?? 1209600), // 14일
  emailVerifyTtl: Number(process.env.EMAIL_VERIFY_TTL ?? 86400), // 24시간

  // BFF 전용 DB(추론 poses.db와 분리). PostgreSQL.
  // 기본 포트가 5433인 이유는 docker-compose.yml 주석 참고(네이티브 Postgres와 충돌 회피).
  databaseUrl: env("DATABASE_URL", "postgres://standin:standin@localhost:5433/standin"),
  /**
   * PGHOST가 있으면 접속 문자열 대신 표준 PG* 변수를 쓴다.
   *
   * 배포(ECS)에서는 RDS가 만든 시크릿을 PGHOST/PGPORT/PGUSER/PGPASSWORD로 그대로
   * 주입한다 — 접속 문자열을 따로 조립해 어딘가에 보관할 필요가 없다.
   * 로컬은 PGHOST가 없으므로 위 DATABASE_URL 기본값이 그대로 쓰인다.
   */
  usePgEnvVars: Boolean(process.env.PGHOST),
  // RDS는 TLS 필수. 로컬 compose는 TLS가 없으므로 기본 off.
  databaseSsl: env("DATABASE_SSL", "false") === "true",
  databasePoolMax: Number(process.env.DATABASE_POOL_MAX ?? 10),

  // 소셜 로그인 성공 후 토큰을 넘길 클라 리디렉트(데스크톱 딥링크 등). 없으면 콜백이 JSON 반환.
  oauthSuccessRedirect: env("OAUTH_SUCCESS_REDIRECT"),
  oauth: {
    google: { clientId: env("GOOGLE_CLIENT_ID"), clientSecret: env("GOOGLE_CLIENT_SECRET") },
    kakao: { clientId: env("KAKAO_CLIENT_ID"), clientSecret: env("KAKAO_CLIENT_SECRET") },
    naver: { clientId: env("NAVER_CLIENT_ID"), clientSecret: env("NAVER_CLIENT_SECRET") },
  },

  // 이메일 인증 발송(SMTP). 미설정이면 콘솔에 링크 출력(dev).
  smtp: {
    host: env("SMTP_HOST"),
    port: Number(process.env.SMTP_PORT ?? 587),
    user: env("SMTP_USER"),
    pass: env("SMTP_PASS"),
    from: env("SMTP_FROM", "Standin <no-reply@standin.local>"),
  },
} as const;
