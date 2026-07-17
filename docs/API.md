# API 계약 — BFF가 클라(Tauri)에 노출하는 `/v1`

> 이 서버가 **클라이언트에 제공하는** 계약. 스키마 소스는 `src/types.ts`.
> 이 서버가 **호출하는** 도원 추론 계약은 `Standin-server/docs/API_CONTRACT.md`.
> 기본 주소: `http://localhost:8080` (env `PORT`).

## 원칙

- 시간은 ISO 8601, ID는 string.
- 오류는 **봉투 형식**으로 통일(§오류). `requestId`는 서버가 부여.
- 분석은 **Job 기반**(제출→폴링). 동기 추론을 BFF가 감싼다.
- **인증**: `/v1/auth/*`·`/healthz`는 공개. **`/v1/users/*`·`/v1/analysis/*`·`/v1/pose-candidates/*`는 `Authorization: Bearer <access>` 필수**(없으면 401).

---

## 오류 형식

```json
{
  "error": {
    "code": "INVALID_INPUT",
    "message": "file(멀티파트 이미지)이 필요합니다.",
    "details": null,
    "requestId": "req_..."
  }
}
```

클라는 `message`를 직접 표시하지 않고 `code`를 사용자 메시지로 매핑한다.
주요 코드: `INVALID_INPUT`/`PROVIDER_UNAVAILABLE`/`OAUTH_STATE_MISMATCH`/`EMAIL_REQUIRED`(400) · `UNAUTHENTICATED`/`INVALID_TOKEN`/`INVALID_CREDENTIALS`(401) · `EMAIL_NOT_VERIFIED`(403) · `NOT_FOUND`(404) · `NOT_READY`/`EMAIL_TAKEN`(409) · `NOT_IMPLEMENTED`(501) · `OAUTH_FAILED`(502) · `INFERENCE_FAILED`(Job status=failed).

---

## GET /healthz

```json
{ "ok": true, "inference": true }
```

`inference`는 도원 추론 서버 연결 여부. 인증 불필요.

---

## POST /v1/analysis/jobs 🔒

컷 이미지 업로드 → Job 생성. **즉시 `jobId` 반환**하고 추론은 백그라운드로 수행. (인증 필요)

요청: `multipart/form-data`

| 필드 | 필수 | 설명 |
|---|:---:|---|
| `file` | ✅ | 러프 콘티 컷 이미지 |
| `hint` | — | mock 추론용 dev 힌트(실모델이면 무시) |

응답 `202`:

```json
{ "jobId": "job_...", "status": "queued", "createdAt": "2026-07-16T..." }
```

---

## GET /v1/analysis/jobs/{jobId}

상태 폴링.

```json
{
  "jobId": "job_...",
  "status": "queued | running | completed | failed",
  "createdAt": "...",
  "updatedAt": "...",
  "error": null
}
```

> ⚠ 동기 추론을 감싸므로 세분 단계(`detecting`/`skeleton`/…)는 제공하지 않는다. Phase 0은 4-상태만.

---

## GET /v1/analysis/jobs/{jobId}/result

완료 시 결과. 미완료면 `409 NOT_READY`.

```json
{
  "jobId": "job_...",
  "candidatesByPerson": [
    {
      "personIndex": 0,
      "box": [120, 80, 360, 720],
      "tags": { "shot": "full_half", "action": "standing", "view": "front", "relationship": "solo" },
      "candidates": [
        {
          "id": "stand_solo",
          "rank": 1,
          "view": "front",
          "tags": ["full_half", "standing", "solo", "front"],
          "matchLevel": "high",
          "bvhAvailable": true,
          "distance": 0.168,
          "rerankScore": 0.91
        }
      ]
    }
  ],
  "notes": []
}
```

`matchLevel`(high/medium/low)은 **BFF가 원시 `distance`에서 매핑**한다(`src/mapping.ts`). `distance`/`rerankScore`는 개발자 모드용 원시값.

---

## POST /v1/analysis/jobs/{jobId}/rerun

🚧 Phase 2. `excludeCandidateIds`로 재검색. 현재 `501`.

---

## GET /v1/pose-candidates/{poseId}/export

선택 후보의 BVH를 도원 서버(`GET /pose/{id}/bvh`)에서 프록시. 바이트 스트림(`application/octet-stream`), `Content-Disposition` 파일명 포함.

> 도원 서버가 `409`(합성 단계, 실 BVH 미존재)를 주면 그대로 전달된다.

---

## 인증

JWT access(짧게) + refresh(회전). 비밀번호는 argon2 해시. `/v1/auth/*`는 공개.
로그인 방식: **local(이메일+비번, 이메일 인증 필요)** + **소셜(google·kakao·naver)**.

**토큰 응답 형태**(login·refresh·소셜 콜백 공통):

```json
{
  "user": { "id": "user_...", "email": "a@b.com", "displayName": "작가",
            "provider": "local", "emailVerified": true },
  "accessToken": "eyJ...",
  "accessTokenExpiresAt": "2026-07-16T14:18:54.000Z",
  "refreshToken": "eyJ..."
}
```
(refresh 응답은 `user` 없이 토큰 3필드만)

### local 이메일 인증 흐름
`register → (인증 메일) → verify-email 클릭 → login`. 인증 전에는 login이 `403`.

- **POST /v1/auth/register** — `{ email, password(8자+), displayName? }`
  → `201 { user, requiresEmailVerification: true }` (⚠ 토큰 미발급) + 인증 메일 발송. 중복 `409 EMAIL_TAKEN`.
  (SMTP 미설정 시 dev에서는 인증 링크가 **서버 콘솔**에 출력됨)
- **GET /v1/auth/verify-email?token=…** — 인증 링크 처리(성공/실패 HTML).
- **POST /v1/auth/resend-verification** — `{ email }` → 항상 `{ ok:true }`(계정 존재 비노출). 미인증 local이면 재발송.
- **POST /v1/auth/login** — `{ email, password }` → `200` 토큰. 불일치 `401 INVALID_CREDENTIALS`, 미인증 `403 EMAIL_NOT_VERIFIED`.

### 소셜 로그인 (google · kakao · naver)
브라우저 리디렉트 기반 authorization code flow. BFF가 code 교환·프로필 조회·유저 upsert·토큰 발급을 담당.

- **GET /v1/auth/oauth/:provider/start** — provider 인가 페이지로 `302`. 미설정 provider면 `400 PROVIDER_UNAVAILABLE`.
- **GET /v1/auth/oauth/:provider/callback?code&state** — code 교환 → 토큰.
  - `OAUTH_SUCCESS_REDIRECT` 설정 시 그 URL로 `302`(쿼리에 `accessToken`·`refreshToken`). 미설정이면 토큰 JSON.
  - CSRF: state httpOnly 쿠키 검증(불일치 `400 OAUTH_STATE_MISMATCH`).
  - provider 콘솔에 등록할 Redirect URI: `{PUBLIC_URL}/v1/auth/oauth/{provider}/callback`.
  - 소셜 이메일이 기존 다른 방식 계정과 겹치면 `409 EMAIL_TAKEN`(자동 링크 안 함).

### 세션
- **POST /v1/auth/refresh** — `{ refreshToken }` → `200` 새 토큰 쌍. **회전**(재사용 `401` — ADR-002 single-flight).
- **POST /v1/auth/logout** — `{ refreshToken }` → `{ "ok": true }`.
- **GET /v1/users/me** 🔒 — 현재 유저(`{ id, email, displayName, provider, emailVerified }`). 세션 복원용.

> 저장: 유저·refresh jti·Job은 **SQLite**(`data/bff.db`, BFF 전용·추론 poses.db와 분리)에 영속한다. 스케일 시 Postgres.
