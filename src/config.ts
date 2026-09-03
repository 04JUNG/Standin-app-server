// 환경설정 단일 소스. dev는 셸 env 또는 `tsx --env-file=.env`로 주입.
import { parseExemptList } from "./limits/policy.js";

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
  /**
   * refine은 사용자가 저장을 기다리는 동기 경로다. 느려지면 베이스로 넘어간다(BFF-07).
   *
   * ⚠ 추론 서버의 `REFINE_TIMEOUT_SECONDS`(기본 5.0s)보다 **반드시 커야 한다.** 같으면
   *   서버가 cooperative timeout으로 `reason=timeout` 폴백을 만들어 직렬화하기 전에
   *   여기서 abort하고, 그 결과가 전부 `upstream_unavailable`로 뭉개진다 — 서버가 설계한
   *   복구 경로가 실전에서 한 번도 관측되지 않는다.
   */
  refineTimeoutMs: Number(process.env.REFINE_TIMEOUT_MS ?? 9000),

  /**
   * 내부 Converter API(V3.2 BVH→FBX). 추론 서버와 **다른 서비스**다 — 별도 ECS service,
   * 별도 포트(8001), Blender 자식 프로세스. ⚠ 추론 서버와 마찬가지로 공개 노출 금지.
   *
   * 비어 있으면 FBX export를 노출하지 않는다. Phase 5 문서 기준으로 AWS 리소스와 private
   * endpoint가 아직 확정되지 않았으므로 기본값은 "꺼짐"이다. 배포되면 이 값만 채운다.
   */
  converterBaseUrl: env("CONVERTER_BASE_URL"),
  /**
   * FBX export 노출 스위치. converterBaseUrl과 **둘 다** 있어야 켜진다.
   *
   * URL만 보고 켜면 endpoint를 미리 채워 두는 것만으로 사용자에게 기능이 열린다.
   * 반대로 flag만 보고 켜면 URL 없이 켜져 전건 실패한다. 둘을 함께 요구하는 이유다.
   */
  fbxExportEnabled: env("FBX_EXPORT_ENABLED", "false") === "true",
  /**
   * converter 호출 상한. converter 자체 변환 timeout이 30초이므로 **그보다 커야** 한다.
   *
   * 같거나 작으면 converter가 504와 conversion_id를 만들기 전에 여기서 끊는다. 그러면
   * 양쪽 로그를 conversion_id로 이을 수 없어 어느 변환이 늦었는지 추적하지 못한다.
   */
  converterTimeoutMs: Number(process.env.CONVERTER_TIMEOUT_MS ?? 35_000),
  /**
   * 변환에 쓸 캐릭터. 현재 registry에는 승인된 것이 하나뿐이라 클라이언트에 고르게 하지
   * 않는다. 늘어나면 converter `GET /characters`를 프록시해 노출한다.
   */
  converterCharacterId: env("CONVERTER_CHARACTER_ID", "standin-master-v2"),
  /**
   * 분석 호출 상한(OB-04). 없으면 추론이 멈췄을 때 Job이 running에 영원히 남고,
   * 동시 분석 한도가 1이라 그 설치는 스위퍼가 돌 때까지 아무것도 못 한다.
   */
  analysisTimeoutMs: Number(process.env.ANALYSIS_TIMEOUT_MS ?? 120_000),
  /** inline은 기존 프로세스 내 실행, sqs는 영속 queue/worker 실행이다. */
  jobExecutionMode: env("JOB_EXECUTION_MODE", "inline") as "inline" | "sqs",
  analysisQueueUrl: env("ANALYSIS_QUEUE_URL"),
  workerVisibilitySeconds: Number(process.env.WORKER_VISIBILITY_SECONDS ?? 180),
  workerLeaseSeconds: Number(process.env.WORKER_LEASE_SECONDS ?? 180),
  /**
   * 헬스체크의 추론 확인 상한. ⚠ 이게 없으면 추론이 멈출 때 /healthz도 같이 멈추고,
   * ALB가 멀쩡한 BFF 태스크를 비정상으로 판단해 교체한다.
   */
  healthTimeoutMs: Number(process.env.HEALTH_TIMEOUT_MS ?? 3000),
  /** 업로드 상한(bytes). body를 다 읽기 전에 이 값으로 먼저 끊는다. */
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 20 * 1024 * 1024),
  /**
   * 허용할 최대 픽셀 수. 파일 크기 상한과 별개다 — 압축이 잘 되는 이미지는 20MB
   * 안에서도 수십억 픽셀을 선언할 수 있고, 그걸 펼치는 건 추론 서버다.
   */
  maxImagePixels: Number(process.env.MAX_IMAGE_PIXELS ?? 50_000_000),
  // Explicit temporary demo mode. User/account endpoints remain protected.
  allowAnonymousAnalysis: env("ALLOW_ANONYMOUS_ANALYSIS", "false") === "true",
  betaDataBucket: env("BETA_DATA_BUCKET"),
  deploymentVersion: env("DEPLOYMENT_VERSION", "development"),
  consentVersion: env("BETA_CONSENT_VERSION", "2026-08-02"),
  betaReviewAdminToken: env("BETA_REVIEW_ADMIN_TOKEN"),

  /**
   * 사용량 제한(오픈베타). 전체 일일 상한의 초깃값은 스프린트 2026-08-11 §3 권장값이다.
   *
   * 설치별 한도는 **주 단위**다. 하루 10회는 "오늘 몰아서 여러 컷"이라는 실제 사용 방식과
   * 맞지 않았다 — 작가는 작업하는 날에 몰아 쓰고 며칠은 아예 안 쓴다. 창을 주로 넓히면
   * 같은 총량으로도 그 리듬을 막지 않는다.
   *
   * 0 이하는 "제한 없음"으로 읽는다 — 전체 일일 상한은 Gemini 비용 산정 전이라
   * 기본 off로 두고, 숫자가 정해지면 env만 채워 켠다.
   */
  quotaInstallationWeekly: Number(process.env.QUOTA_INSTALLATION_WEEKLY ?? 100),
  quotaGlobalDaily: Number(process.env.QUOTA_GLOBAL_DAILY ?? 0),
  /**
   * 사용량 쿼터를 적용하지 않을 설치 ID(콤마 구분). 개발자 단말용이다.
   *
   * 자기 한도에 막힌 개발자는 정작 한도를 확인해야 할 때 확인하지 못한다. 설치 ID는 앱
   * 설정 화면에 그대로 표시되므로 그 값을 넣는다. 인증(기기 토큰)을 통과한 뒤에만 적용된다.
   */
  quotaExemptInstallations: parseExemptList(env("QUOTA_EXEMPT_INSTALLATIONS")),
  // 설치별 동시 분석. 중복 클릭·폭주 방지가 목적이라 1이면 충분하다.
  quotaInstallationConcurrent: Number(process.env.QUOTA_INSTALLATION_CONCURRENT ?? 1),
  /**
   * 이 시간이 지나도 queued/running인 Job은 유실로 본다.
   *
   * 러너가 프로세스 내 fire-and-forget이라 배포·태스크 교체 시 상태가 running인 채로 남는다.
   * 동시 분석 한도가 1이면 그 설치는 영원히 막히므로, 오래된 Job은 세지 않고 실패로 정리한다.
   */
  analysisStaleAfterSeconds: Number(process.env.ANALYSIS_STALE_AFTER_SECONDS ?? 300),
  // IP burst. NAT·공용망 사용자를 고려해 너무 낮게 잡지 않는다.
  rateIpRegister: Number(process.env.RATE_IP_REGISTER ?? 5),
  rateIpRegisterWindow: Number(process.env.RATE_IP_REGISTER_WINDOW ?? 3600),
  rateIpAnalyze: Number(process.env.RATE_IP_ANALYZE ?? 5),
  rateIpAnalyzeWindow: Number(process.env.RATE_IP_ANALYZE_WINDOW ?? 60),
  /**
   * X-Forwarded-For 오른쪽에서 신뢰하는 프록시 홉 수.
   *
   * 배포는 ALB가 client IP를 XFF 오른쪽 끝에 기록하므로 0이다.
   * 프록시가 없는 로컬은 -1로 둔다. ⚠ 이 값을 잘못 키우면 클라가 XFF를 위조해
   * IP 제한을 우회할 수 있다.
   */
  trustedProxyHops: Number(process.env.TRUSTED_PROXY_HOPS ?? -1),
  // IP는 원문 대신 해시로만 저장한다. 전용 값이 없으면 JWT 시크릿을 재사용한다.
  ipHashSalt: env("IP_HASH_SALT") || env("JWT_SECRET", "dev-only-change-me"),

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

  /**
   * 장애 알림(디스코드 웹훅). 설계: 마스터독스 「관측성 — 로그·모니터링·디스코드 알림」 §5.
   *
   * ⚠ 웹훅 URL 자체가 비밀이다 — URL을 아는 누구나 그 채널에 글을 쓸 수 있다.
   *   배포에서는 Secrets Manager의 `standin/discord`에서 주입한다.
   * 비어 있으면 알림기는 조용히 no-op이다. 로컬은 웹훅 없이 그대로 돈다.
   */
  discord: {
    webhookAlert: env("DISCORD_WEBHOOK_ALERT"), // P1
    webhookWarn: env("DISCORD_WEBHOOK_WARN"), // P2
    webhookOps: env("DISCORD_WEBHOOK_OPS"), // P3
    // P1에 붙일 멘션(`@here` 등). 코드에 박지 않는다 — 야간 호출 정책은 팀이 정한다.
    mention: env("DISCORD_ALERT_MENTION"),
  },
  /** 배치 창. 이 시간 안의 알림을 한 메시지로 묶는다. */
  alertFlushMs: Number(process.env.ALERT_FLUSH_MS ?? 10_000),
  /** 같은 키를 다시 보내지 않는 시간. 그 사이의 재발은 세었다가 "×N"으로 보고한다. */
  alertSuppressSeconds: Number(process.env.ALERT_SUPPRESS_SECONDS ?? 300),
  /** 한 메시지에 담을 임베드 상한. 초과분은 "외 N종"으로 접는다. */
  alertMaxPerFlush: Number(process.env.ALERT_MAX_PER_FLUSH ?? 5),
  /**
   * 추론 서버 헬스 확인 주기와 P1 승격 임계. 일시적 흔들림으로 사람을 깨우지 않기 위해
   * 연속 실패 횟수를 센다(기본 30초 × 3회 = 약 1분 30초).
   */
  inferenceWatchIntervalMs: Number(process.env.INFERENCE_WATCH_INTERVAL_MS ?? 30_000),
  inferenceWatchFailureThreshold: Number(process.env.INFERENCE_WATCH_FAILURES ?? 3),

  // 이메일 인증 발송(SMTP). 미설정이면 콘솔에 링크 출력(dev).
  smtp: {
    host: env("SMTP_HOST"),
    port: Number(process.env.SMTP_PORT ?? 587),
    user: env("SMTP_USER"),
    pass: env("SMTP_PASS"),
    from: env("SMTP_FROM", "Standin <no-reply@standin.local>"),
  },
} as const;
