# API 계약 — BFF가 클라(Tauri)에 노출하는 `/v1`

> 이 서버가 **클라이언트에 제공하는** 계약. 스키마 소스는 `src/types.ts`.
> 이 서버가 **호출하는** 도원 추론 계약은 `Standin-server/docs/API_CONTRACT.md`.
> 기본 주소: `http://localhost:8080` (env `PORT`).

## 원칙

- 시간은 ISO 8601, ID는 string.
- 오류는 **봉투 형식**으로 통일(§오류). `requestId`는 서버가 부여.
- 분석은 **Job 기반**(제출→폴링). 동기 추론을 BFF가 감싼다.
- **인증**: `/v1/auth/*`·`/healthz`·`POST /v1/installations`는 공개. `/v1/users/*`는 JWT, `/v1/analysis/*`·`/v1/pose-candidates/*`·`/v1/events/*`는 동의된 설치 인증이 필수다.

## 설치 인증과 동의

`POST /v1/installations`에 현재 동의 버전과 최소 환경정보를 보내면 서버가 `installationId`와 한 번만 노출하는 `deviceToken`을 발급한다. 이후 보호 API에는 두 헤더를 보낸다.

```http
X-Installation-Id: inst_...
X-Device-Token: ...
```

서버에는 토큰 SHA-256 해시만 저장한다. 현재 동의 버전은 `BETA_CONSENT_VERSION`이며 불일치 시 `CONSENT_REQUIRED`, 자격증명 누락 시 `INSTALLATION_REQUIRED`로 거부한다.

`DELETE /v1/installations/current/data`는 전용 S3 prefix, 작업·파생 데이터·이벤트·선택·피드백과 설치 레코드를 삭제한다. 응답은 `{ "deleted": true, "backupExpiryDays": 7 }`이다.

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
주요 코드: `INVALID_INPUT`/`PROVIDER_UNAVAILABLE`/`OAUTH_STATE_MISMATCH`/`EMAIL_REQUIRED`(400) · `UNAUTHENTICATED`/`INVALID_TOKEN`/`INVALID_CREDENTIALS`(401) · `EMAIL_NOT_VERIFIED`(403) · `NOT_FOUND`(404) · `NOT_READY`/`EMAIL_TAKEN`(409) · `DAILY_QUOTA_EXCEEDED`/`GLOBAL_QUOTA_EXCEEDED`(429) · `NOT_IMPLEMENTED`(501) · `OAUTH_FAILED`(502) · `STORAGE_UNAVAILABLE`(503) · `INFERENCE_FAILED`(Job status=failed).

### 사용량 제한 (`429`)

오픈베타는 로그인 없이 설치 단위로 쓰므로 서버가 사용량을 강제한다. 한도를 넘으면 `429`와 함께
**언제 다시 쓸 수 있는지**를 `details`와 `Retry-After` 헤더로 준다. 클라는 원인과 다음 사용 가능
시점을 함께 표시한다.

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 41230
```
```json
{
  "error": {
    "code": "DAILY_QUOTA_EXCEEDED",
    "message": "오늘 사용할 수 있는 분석 횟수를 모두 사용했습니다.",
    "details": { "retryAfterSeconds": 41230, "limit": 10, "retryAt": "2026-08-12T00:00:00.000+09:00" },
    "requestId": "req_..."
  }
}
```

| code | 의미 | `details` |
|---|---|---|
| `DAILY_QUOTA_EXCEEDED` | 설치별 일일 분석 한도 초과 | `retryAfterSeconds`, `limit`, `retryAt` |
| `GLOBAL_QUOTA_EXCEEDED` | 서비스 전체 일일 분석 한도 초과 | `retryAfterSeconds`, `retryAt` |

일일 한도는 **KST 자정**에 리셋된다(`retryAt`은 항상 `+09:00` 표기). 한도값은 서버 환경변수로
조정되므로 클라가 숫자를 하드코딩하지 않고 `details.limit`을 그대로 보여준다.

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
| `file` | ✅ | PNG/JPEG/WEBP 러프 콘티 이미지, 최대 20MB. MIME과 파일 시그니처를 함께 검증한다. |
| `source` | ✅ | `capture \| file \| clipboard` |
| `width`, `height` | — | 원본 픽셀 크기 |

응답 `202`:

```json
{ "jobId": "job_...", "status": "queued", "createdAt": "2026-07-16T..." }
```

사용량 한도를 넘으면 Job을 만들지 않고 `429`(`DAILY_QUOTA_EXCEEDED`·`GLOBAL_QUOTA_EXCEEDED`)를
반환한다 — 위 [사용량 제한](#사용량-제한-429) 참고. 한도는 입력 검증을 통과한 요청만 소비하며,
입력 저장이 실패해 `503 STORAGE_UNAVAILABLE`이 나가면 소비한 쿼터를 돌려준다.

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
  "image": { "width": 1280, "height": 720 },
  "inferenceMetadata": {
    "deploymentVersion": "git-sha",
    "vlmProvider": "gemini",
    "vlmModel": "gemini-2.5-flash",
    "poseBackend": "rtmlib",
    "poseModelVersion": "runtime-default",
    "poseLibraryVersion": "v1",
    "featureVersion": 1
  },
  "candidatesByPerson": [
    {
      "personIndex": 0,
      "box": [120, 80, 360, 720],
      "tags": { "shot": "full_half", "action": "standing", "view": "front", "relationship": "solo" },
      "skeleton": { "schemaVersion": "coco17-v1", "keypoints": [[1, 2]], "scores": [0.9] },
      "confidence": "high",
      "skeletonState": "valid",
      "skeletonSource": "full_image",
      "coverageClass": "full",
      "fallbackMode": "none",
      "refineAllowed": true,
      "refinableLimbs": ["left_arm"],
      "candidateCount": 1,
      "candidateShortfallReason": "UPSTREAM_FEWER_THAN_REQUESTED",
      "candidates": [
        {
          "id": "stand_solo::front",
          "poseId": "stand_solo",
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
  "notes": [],
  "capabilities": { "refine": false }
}
```

### `matchLevel`

`person.confidence`가 **1급 기준**이다. `confidence != high`면 그 인물의 모든 후보가 `matchLevel=low`가 되고,
`high`일 때만 원시 `distance` 구간(≤0.25 high / ≤0.45 medium / 그 외 low)을 표시용 세부 등급으로 쓴다(`src/mapping.ts`).

거리만으로 판단하지 않는 이유: 구조 검사에서 마스킹된 관절이 많을수록 남은 관절끼리의 평균 거리가 **작아진다**.
즉 정보가 거의 없는 스켈레톤일수록 raw distance가 좋아 보인다. 서로 다른 `coverageClass`의 raw distance를
같은 절대 구간으로 비교하거나 정렬해서는 안 된다. `distance`/`rerankScore`는 개발자 진단용 원시값이다.

### 인물 품질 필드

| 필드 | 값 | 의미 |
|---|---|---|
| `confidence` | `high` \| `low` | 최종 인물 단위 신뢰도 |
| `skeletonState` | `valid` \| `partial` \| `suspect` \| `missing` \| `invalid` | 구조 품질과 fallback 사유 |
| `skeletonSource` | `full_image` \| `crop_retry` \| `none` | crop 재추론으로 복구했는지 |
| `coverageClass` | `full` \| `reduced` \| `sparse` \| `insufficient` | 거리 임계값이 적용된 관측 범위 |
| `fallbackMode` | `none` \| `soft` \| `hard` | 아래 표 참고 |
| `refineAllowed` | boolean | 이 인물에 refine을 호출해도 되는가 |
| `refinableLimbs` | string[] | refine이 움직여도 되는 사지 |

`fallbackMode`는 `candidates.length == 0 → hard`, `길이 > 0 && confidence=low → soft`, 그 외 `none`이다.
**`soft`와 `hard`는 다른 상태다.** soft는 참고용 Top-5를 보여주되 refine을 금지하고, hard는 그 인물에 자동
후보가 없다는 뜻이다(다른 인물의 흐름은 계속 진행한다).

인물 순서는 추론 서버가 최종 `box.x1` 기준 왼쪽→오른쪽으로 고정한다. BFF와 클라이언트는 다시 정렬하지 않는다.

추론의 `raw_scores`·`quality_trace`는 진단 자료이므로 **이 응답에 나가지 않는다**. 서버측 컬럼에만 남는다.

신규 필드가 없는 구버전 추론 응답은 `confidence=low`, `refineAllowed=false`, `coverageClass=insufficient`로
안전하게 해석한다 — 순차 배포 창에서 저정보 결과가 낙관적으로 표시되지 않게 하기 위해서다.

### `capabilities.refine`

이 BFF가 refine을 노출하는가(`REFINE_FEATURE_ENABLED`). 추론 endpoint가 살아 있어도 이 값이 `false`면
클라이언트는 refine을 호출하지 않는다.

후보가 5개 미만이면 실제 개수만 반환하고 `candidateShortfallReason`을 기록한다. `id`는 작업에서 실제 노출된 후보를 유일하게 식별하며, `poseId`는 BVH 원본 포즈 식별자다.

---

## POST /v1/analysis/jobs/{jobId}/people/{personIndex}/refine 🔒

작가가 고른 후보 1개를 러프에 맞춰 미세조정한다. 요청 본문은 `candidateId` 하나뿐이다.

```json
{ "candidateId": "stand_solo::front" }
```

COCO-17 좌표와 안전정책(`refineAllowed`, `refinableLimbs`)은 **클라이언트가 보내지 않는다**. `/analyze` 때
BFF가 보관해 둔 값을 서버측에서 읽는다 — 클라이언트가 값을 되돌려 보내면 refine 금지를 우회할 수 있기 때문이다.

응답:

```json
{
  "jobId": "job_...",
  "personIndex": 0,
  "candidateId": "stand_solo::front",
  "refined": true,
  "reasonCode": "ok_partial",
  "adjustedLimbs": ["left_arm"],
  "exportUrl": "/v1/pose-candidates/stand_solo/export?jobId=job_...&personIndex=0&candidateId=stand_solo%3A%3Afront"
}
```

**`refined: false`는 오류가 아니다.** 안전 게이트가 조정을 버리고 베이스를 유지한 정상 결과이며, HTTP는 200이다.
`reasonCode`는 추론의 사유(`entangled_set`, `no_gain`, `collision_gate` …)이거나 BFF가 붙인 스킵 사유다.

| `reasonCode` | 의미 |
|---|---|
| `feature_disabled` | BFF의 refine flag가 off. 추론을 호출하지 않았다 |
| `skeleton_policy` | 저신뢰 인물이라 refine 금지. 추론을 호출하지 않았다 |
| `storage_unavailable` | 조정본을 보관할 저장소가 없다 |
| `context_unavailable` | 보관된 refine 입력이 없거나 17×2가 아니다 |
| `upstream_unavailable` | 추론 timeout·5xx. 베이스로 전환 |
| `artifact_store_failed` | 조정은 됐지만 보관에 실패. **refined=true로 기록하지 않는다** |

같은 `(jobId, personIndex, candidateId)`는 멱등이다 — 다시 호출해도 추론을 재호출하지 않고 저장된 결과를 돌려준다.

오류: 접근 권한 없는 job은 `404 NOT_FOUND`, 그 인물에게 노출되지 않은 후보는 `409 INVALID_SELECTION`.

---

## 행동·선택·피드백

- `POST /v1/events/batch`: 최대 100개의 `eventId`, `sequence`, `occurredAt`, 이벤트명, `jobId`, 허용 속성을 받는다. `eventId`로 중복 제거한다.
- 허용 이벤트: `app_started`, `input_confirmed`, `results_viewed`, `candidate_selected`, `selection_confirmed`.
- `PUT /v1/analysis/jobs/{jobId}/selections`: `[{personIndex,candidateId}]`를 멱등 저장하며 해당 작업에서 노출된 후보인지 검증한다.
- `POST /v1/analysis/jobs/{jobId}/feedback`: `good | person_missing | skeleton_wrong | candidates_irrelevant | export_problem | other`만 허용한다.

---

## POST /v1/analysis/jobs/{jobId}/rerun

🚧 Phase 2. `excludeCandidateIds`로 재검색. 현재 `501`.

---

## GET /v1/pose-candidates/{poseId}/export?jobId=...&personIndex=...&candidateId=...

작업에서 실제 노출된 후보인지 확인한 뒤 BVH를 반환한다. 요청·성공·실패를 서버에서 직접 기록한다.

**무엇을 내보낼지는 이 엔드포인트가 정한다.** 해당 `(jobId, personIndex, candidateId)`에 유효한 조정본이
있으면 private S3에 보관된 조정본을, 없으면 도원 서버(`GET /pose/{id}/bvh`)의 베이스 BVH를 프록시한다.
클라이언트는 어느 쪽인지 몰라도 이 URL 하나만 내려받으면 된다 — 추론 서버의 `/refined/{handle}`를 직접
호출해서는 안 된다(그 파일은 추론 태스크의 로컬 디스크에 있어 태스크가 교체되면 사라진다).

조정본을 보관했다고 기록해 놓고 객체를 읽지 못하면 베이스로 안전 전환하고 `export_events`에
`variant=base`, `fallback_reason=refined_object_missing`을 남긴다. 조정본도 원본과 HIERARCHY·채널 순서가
같으므로 CSP 축 보정·드래그 로직은 달라지지 않는다.

---

## 관리자 품질 검토

`GET /v1/admin/review/jobs/{jobId}`는 `X-Beta-Admin-Token`이 필요하다. 5분짜리 원본 서명 URL, 인물·스켈레톤·후보·선택·피드백을 반환하고 접근을 감사 테이블에 기록한다.

> 도원 서버가 `409`(합성 단계, 실 BVH 미존재)를 주면 그대로 전달된다.

---

## 인증

JWT access(짧게) + refresh(회전). 비밀번호는 argon2 해시. `/v1/auth/*`는 공개.
로그인 방식: **local(이메일+비번, 이메일 인증 필요)** + **소셜(google·kakao·naver)**.

**토큰 응답 형태**(login·refresh·oauth exchange 공통):

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
- **GET /v1/auth/oauth/:provider/callback?code&state** — provider code 교환 → 프로필 조회 → 유저 upsert.
  - `OAUTH_SUCCESS_REDIRECT` 설정 시 그 URL로 `302`(쿼리에 **1회용 `code`만**). 미설정이면 토큰 JSON(dev/curl).
  - CSRF: state httpOnly 쿠키 검증(불일치 `400 OAUTH_STATE_MISMATCH`).
  - provider 콘솔에 등록할 Redirect URI: `{PUBLIC_URL}/v1/auth/oauth/{provider}/callback`.
  - 소셜 이메일이 기존 다른 방식 계정과 겹치면 `409 EMAIL_TAKEN`(자동 링크 안 함).
- **POST /v1/auth/oauth/exchange** — `{ code }` → `200` 토큰(login과 동일 형태). 만료·재사용 `401 INVALID_CODE`, 누락 `400 INVALID_INPUT`.
  - 콜백이 넘긴 **60초 1회용** 코드. 서버에는 SHA-256 해시만 저장하고, 소비는 확인·삭제를 한 문장으로 처리해 중복 사용을 막는다.
  - ⚠ 토큰을 딥링크 URL(`standin://…?accessToken=`)에 실으면 OS 로그·최근 실행 기록에 장기 자격증명이 남는다(클라 `docs/06 §6` 금지). 그래서 코드만 넘긴다.

### 세션
- **POST /v1/auth/refresh** — `{ refreshToken }` → `200` 새 토큰 쌍. **회전**(재사용 `401` — ADR-002 single-flight).
- **POST /v1/auth/logout** — `{ refreshToken }` → `{ "ok": true }`.
- **GET /v1/users/me** 🔒 — 현재 유저(`{ id, email, displayName, provider, emailVerified }`). 세션 복원용.

> 저장: 유저·refresh jti·oauth 교환코드·Job은 **PostgreSQL**(BFF 전용·추론 poses.db와 분리)에 영속한다. 접속 정보는 `DATABASE_URL`.
