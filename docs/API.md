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

발급은 공개 엔드포인트라 **IP 단위 속도 제한**이 걸린다(기본 1시간 5회). 초과하면 `429 RATE_LIMITED`가 나가므로, 클라는 발급을 재시도 루프로 돌리지 말고 받은 자격증명을 안전 저장소에 보관해 재사용한다.

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
주요 코드: `INVALID_INPUT`/`PROVIDER_UNAVAILABLE`/`OAUTH_STATE_MISMATCH`/`EMAIL_REQUIRED`(400) · `UNAUTHENTICATED`/`INVALID_TOKEN`/`INVALID_CREDENTIALS`(401) · `EMAIL_NOT_VERIFIED`(403) · `NOT_FOUND`(404) · `NOT_READY`/`EMAIL_TAKEN`/`JOB_IN_PROGRESS`(409) · `PAYLOAD_TOO_LARGE`(413) · `WEEKLY_QUOTA_EXCEEDED`/`GLOBAL_QUOTA_EXCEEDED`(429) · `NOT_IMPLEMENTED`(501) · `OAUTH_FAILED`(502) · `STORAGE_UNAVAILABLE`(503) · `INFERENCE_FAILED`/`ANALYSIS_UNAVAILABLE`(Job status=failed).

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
    "code": "WEEKLY_QUOTA_EXCEEDED",
    "message": "이번 주에 사용할 수 있는 분석 횟수를 모두 사용했습니다.",
    "details": { "retryAfterSeconds": 213000, "limit": 100, "retryAt": "2026-08-24T00:00:00.000+09:00" },
    "requestId": "req_..."
  }
}
```

| code | 의미 | `details` |
|---|---|---|
| `WEEKLY_QUOTA_EXCEEDED` | 설치별 **주간** 분석 한도 초과 | `retryAfterSeconds`, `limit`, `retryAt` |
| `GLOBAL_QUOTA_EXCEEDED` | 서비스 전체 일일 분석 한도 초과 | `retryAfterSeconds`, `retryAt` |
| `RATE_LIMITED` | 짧은 시간에 요청이 몰림(IP 단위) | `retryAfterSeconds`, `limit`, `windowSeconds` |
| `CONCURRENCY_LIMIT` | 같은 설치에 진행 중인 분석이 있음 | `retryAfterSeconds`, `limit` |

설치별 한도는 **주 단위**이고 **KST 월요일 자정**에 리셋된다. 하루 단위로 끊으면 "작업하는 날에
몰아서 여러 컷"이라는 실제 사용 방식을 막는다 — 같은 총량이라도 창이 넓으면 그 리듬을 막지 않는다.
전체 상한(`GLOBAL_QUOTA_EXCEEDED`)은 비용 방어용이라 여전히 일 단위(KST 자정)다.
`retryAt`은 항상 `+09:00` 표기이며, 리셋이 여러 날 뒤일 수 있으므로 클라는 "내일"로 단정하지 않는다.
한도값은 서버 환경변수로 조정되므로 클라가 숫자를 하드코딩하지 않고 `details.limit`을 그대로 보여준다.

**쿼터를 적용하지 않는 설치.** 개발자 단말은 `QUOTA_EXEMPT_INSTALLATIONS`(콤마 구분)에 설치 ID를
넣어 제외한다. 자기 한도에 막힌 개발자는 정작 한도를 확인해야 할 때 확인하지 못한다. 설치 ID는
앱 설정 화면에 표시된다. 제외되는 것은 **주간 한도·전체 상한·동시 분석**이고, IP burst
(`RATE_LIMITED`)는 그대로 적용된다 — 그건 인증 이전 단계라 헤더 값만으로 우회를 열어 줄 수 없다.

**환불되는 실패.** 쿼터는 "우리가 한 일"에 매기는 값이라, 분석이 아예 수행되지 않은 실패는
소비한 1회를 되돌린다 — 입력 저장 실패(`INPUT_STORAGE_FAILED`)와 상류 VLM 혼잡
(`ANALYSIS_UNAVAILABLE`)이다. 추론이 실제로 돌다가 늦어지거나(`ANALYSIS_TIMEOUT`) 거절한
경우(`INFERENCE_FAILED`)는 환불하지 않는다.

`RATE_LIMITED`는 IP 단위 burst 제한이며 `POST /v1/installations`와 `POST /v1/analysis/jobs`에
걸린다. 주간 쿼터와는 별개 카운터라, 남은 횟수가 있어도 잠깐 몰리면 나올 수 있다.
공용망·NAT에서는 같은 IP를 여러 사용자가 공유할 수 있으므로 "잠시 후 다시 시도"로 안내한다.
서버는 IP 원문을 저장하지 않고 해시 버킷만 센다.

`CONCURRENCY_LIMIT`은 같은 설치가 분석을 동시에 여러 개 돌리지 못하게 막는다(기본 1개).
중복 클릭이 대부분이므로 진행 중인 Job의 완료를 기다렸다가 다시 시도하면 된다.

### 서비스 일시 중단 (`503 SERVICE_PAUSED`)

운영자가 분석을 즉시 중단한 상태다(비용·장애 대응). 사용자 잘못이 아니므로 `429`와 구분한다.
재시도 시각을 줄 수 없으므로 `Retry-After`가 없다 — 클라는 "지금은 분석을 이용할 수 없습니다"
계열로 안내하고 자동 재시도 루프를 돌리지 않는다.

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
| `file` | ✅ | PNG/JPEG/WEBP 러프 콘티 이미지, 최대 20MB. MIME·파일 시그니처·헤더의 실제 픽셀 크기를 검증한다. |
| `source` | ✅ | `capture \| file \| clipboard` |
| `width`, `height` | — | 원본 픽셀 크기(참고값). 서버가 헤더에서 실제 크기를 읽으면 **그 값이 우선한다** |

응답 `202`:

```json
{ "jobId": "job_...", "status": "queued", "createdAt": "2026-07-16T..." }
```

### 업로드 방어

- **`413 PAYLOAD_TOO_LARGE`** — body가 20MB를 넘으면 `Content-Length` 단계에서 끊는다. 전체를 다 받은 뒤 거절하지 않는다. (`Content-Length`가 없거나 거짓이면 파싱 후 `400 INVALID_INPUT`으로 잡힌다.)
- MIME 값을 믿지 않고 **파일 시그니처**를 확인한다. 불일치는 `400 INVALID_INPUT`.
- 헤더에서 **실제 픽셀 크기**를 읽어 상한(기본 5천만 픽셀)을 넘으면 `400 INVALID_INPUT`. 파일 크기 상한만으로는 막을 수 없다 — 잘 압축된 20MB 이미지가 수십억 픽셀을 선언할 수 있고 그걸 펼치는 것은 추론 서버다.
- 클라가 보낸 `width`/`height`는 **참고값**이다. 헤더에서 읽어낸 값이 있으면 그 값을 기록한다.

사용량 한도를 넘으면 Job을 만들지 않고 `429`(`WEEKLY_QUOTA_EXCEEDED`·`GLOBAL_QUOTA_EXCEEDED`·
`CONCURRENCY_LIMIT`·`RATE_LIMITED`)를 반환한다 — 위 [사용량 제한](#사용량-제한-429) 참고.
운영자가 분석을 중단했으면 `503 SERVICE_PAUSED`다. 한도는 입력 검증을 통과한 요청만 소비하며,
입력 저장이 실패해 `503 STORAGE_UNAVAILABLE`이 나가면 소비한 쿼터를 돌려준다.

---

## GET /v1/analysis/jobs 🔒

작업 기록 목록. 최신순(`createdAt DESC`), 커서 페이지네이션.

| 쿼리 | 기본 | 설명 |
|---|---|---|
| `limit` | 20 | 1~50 정수. 범위 밖은 클램프하지 않고 `400 INVALID_INPUT`. |
| `cursor` | — | 이전 응답의 `nextCursor`. 손상된 값은 `400 INVALID_INPUT`. |
| `status` | — | `queued \| running \| completed \| failed` 중 하나로 거른다. |

```json
{
  "items": [
    {
      "jobId": "job_...",
      "status": "completed",
      "createdAt": "...",
      "completedAt": "...",
      "errorCode": null,
      "source": "capture",
      "personCount": 2,
      "selectionCount": 2,
      "hasSelection": true,
      "thumbnailUrl": "/v1/pose-candidates/{poseId}/thumbnail?view=front",
      "inputAvailable": true,
      "inputWidth": 1920,
      "inputHeight": 1080
    }
  ],
  "nextCursor": "eyJ..." 
}
```

`nextCursor`가 `null`이면 마지막 페이지다.

> ⚠ `thumbnailUrl`은 **입력 러프가 아니라 매칭된 포즈 후보**의 썸네일 경로다. 확정 선택한
> 후보를 우선 쓰고, 없으면 첫 인물의 1순위로 폴백한다. 후보가 없는 Job(실패 등)은 `null`.
> 원본을 20건 내려보내면 수십 MB가 되지만 후보 썸네일은 이미 하루 캐시되는 작은 PNG다.
> 인증 헤더가 필요하므로 절대 URL이 아닌 상대 경로를 준다.

> ⚠ `inputAvailable`은 입력 원본이 S3에 남아 있는지다. **DB의 Job은 365일, S3 객체는
> lifecycle 90일**이라 그 사이 구간의 Job은 목록에 나오지만 원본은 제공되지 않는다.

> ⚠ 이 경로에는 IP 속도 제한이 없다(제한은 `POST /v1/analysis/jobs`에만 붙는다).
> 부하 상한은 `limit` 최대 50으로만 강제된다.

---

## DELETE /v1/analysis/jobs/{jobId} 🔒

기록에서 작업 하나를 지운다. Job 행과 파생 데이터(인물·후보·확정 선택·피드백·내보내기
기록·분석 이벤트·조정본 대장), 그리고 S3의 입력 원본과 조정본을 모두 지운다.

```json
{ "deleted": true }
```

- 진행 중(`queued`/`running`)이면 `409 JOB_IN_PROGRESS`. 삭제를 허용하면 워커가 남긴
  인물·후보 행이 회수 불가능한 고아가 되고, 설치별 동시 분석 한도가 무의미해진다.
- 남의 Job이거나 없는 Job이면 `404 NOT_FOUND`.
- DB를 먼저 커밋하고 S3 삭제는 best-effort다. S3가 실패해도 응답은 성공이며, 남는 것은
  lifecycle 90일이 어차피 지우는 고아 객체뿐이다.
- ⚠ `analytics_events`도 함께 지운다. `daily_analytics_aggregates`는 기동마다 과거 일자를
  **재계산**하므로, 개별 삭제는 지나간 날짜의 집계 수치를 소급해서 낮춘다.

계정(설치) 전체 삭제는 `DELETE /v1/installations/current/data`가 담당한다.

---

## GET /v1/analysis/jobs/{jobId}/selections 🔒

확정 선택 조회. `PUT .../selections`의 짝이며, 작업 기록 상세가 이전 선택을 화면에
되살릴 때 쓴다.

```json
{
  "selections": [
    { "personIndex": 0, "candidateId": "pose-1::front", "rank": 1, "confirmedAt": "..." }
  ]
}
```

상태 폴링(`GET /{jobId}`)에 얹지 않은 이유는 그 경로가 분석 중 750ms마다 불리는
hot path이기 때문이다.

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

`error`(status=`failed`)에는 `INFERENCE_FAILED`, `ANALYSIS_TIMEOUT`, `ANALYSIS_UNAVAILABLE`, `INPUT_STORAGE_FAILED`, `ABANDONED`가 들어간다.
`ANALYSIS_TIMEOUT`은 추론이 상한 시간(`ANALYSIS_TIMEOUT_MS`, 기본 120초) 안에 응답하지 않은 경우다 — 추론이 거절한 `INFERENCE_FAILED`와 구분한다.
`ANALYSIS_UNAVAILABLE`은 상류 VLM이 혼잡해 지금은 분석할 수 없는 경우다(추론이 `503`으로 알려 준다 — Standin-server `docs/API_CONTRACT.md` §7-1).
**같은 이미지로 잠시 후 다시 시도하면 되는 상태**이므로, 클라는 "다른 이미지로 다시 시도"가 아니라 "잠시 후 다시 시도"를 안내한다.
`ABANDONED`는 배포·태스크 교체로 실행 중이던 Job이 유실된 경우다 — 러너가 아직 프로세스 내
fire-and-forget이라 생길 수 있고, 서버가 주기적으로 정리해 무응답 대신 명시적 실패로 만든다.
클라는 "다시 시도"를 안내하면 된다.

---

## GET /v1/analysis/jobs/{jobId}/result

완료 시 결과. 미완료면 `409 NOT_READY`.

`inputUrl`은 입력 원본의 presigned GET URL(900초)이다. 작업 기록 상세가 원본 미리보기에
쓴다. 키가 없거나 버킷이 설정되지 않았으면 `null`이고, 그때는 `inputUrlExpiresInSeconds`도
`null`이다. **S3 lifecycle이 90일**이라 그보다 오래된 Job은 `null`이 되며, 화면은 "보관
기간이 지났다"로 안내한다.

```json
{
  "jobId": "job_...",
  "inputUrl": "https://... | null",
  "inputUrlExpiresInSeconds": 900,
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
  "capabilities": { "refine": false, "fbxExport": false }
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

### `capabilities.fbxExport`

이 BFF가 FBX 저장을 노출하는가. `CONVERTER_BASE_URL`과 `FBX_EXPORT_ENABLED=true`가 **둘 다** 있어야
`true`다. converter는 추론 서버와 별개로 배포되므로 refine과 함께 켜지지 않는다 — 클라이언트가 자기
판단으로 `format=fbx`를 보내면 converter가 없는 배포에서 전건 실패한다. `false`면 저장 포맷 선택에서
FBX를 고를 수 없게 하고 BVH로 저장한다.

후보가 5개 미만이면 실제 개수만 반환하고 `candidateShortfallReason`을 기록한다. `id`는 작업에서 실제 노출된 후보를 유일하게 식별하며, `poseId`는 BVH 원본 포즈 식별자다.

---

## POST /v1/analysis/jobs/{jobId}/people/{personIndex}/refine 🔒

작가가 고른 후보 1개를 러프에 맞춰 미세조정한다. 요청 본문은 `candidateId` 하나뿐이다.

```json
{ "candidateId": "stand_solo::front" }
```

COCO-17 좌표와 안전정책(`refineAllowed`, `refinableLimbs`)은 **클라이언트가 보내지 않는다**. `/analyze` 때
BFF가 보관해 둔 값을 서버측에서 읽는다 — 클라이언트가 값을 되돌려 보내면 refine 금지를 우회할 수 있기 때문이다.

추론 refine v2.5부터는 여기에 **policy lineage**(`skeleton_state`·`coverage_class`·`slot_origin`·
`skeleton_source`·`lower_body_observed`)가 함께 전달된다. 추론의 `structural_refine_allowed`가 다섯 값을
전부 검사하고 하나라도 빠지면 fail-closed로 `skeleton_policy`를 돌려주는데, 그건 오류 응답이 아니라 정상
스킵이라 로그에도 지표에도 안 남는다 — 즉 **전달이 끊기면 refine이 아무 신호 없이 꺼진다.** 값은 전부
`/analyze` 때 `analysis_people`에 저장한 것이고, 없으면 지어내지 않고 `null` 그대로 보내 추론이 판단하게 둔다.

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
| `upstream_missing_bvh` | `refined=true`인데 `bvh` 본문이 없거나 `null`. 계약 위반이라 베이스로 전환 |

추론이 돌려주는 사유에는 v2.5에서 `timeout`, `safety_gate`, `unchanged_geometry`, `low_observability`,
`no_solvable_joints`, `final_collision_gate`, `final_extension_gate`가 추가됐다. 전부 `refined=false` +
베이스 저장으로 수렴하므로 클라이언트 분기는 달라지지 않는다.

같은 `(jobId, personIndex, candidateId)`는 멱등이다 — 다시 호출해도 추론을 재호출하지 않고 저장된 결과를 돌려준다.

오류: 접근 권한 없는 job은 `404 NOT_FOUND`, 그 인물에게 노출되지 않은 후보는 `409 INVALID_SELECTION`.

---

## 행동·선택·피드백

- `POST /v1/events/batch`: 최대 100개의 `eventId`, `sequence`, `occurredAt`, 이벤트명, `jobId`, 허용 속성을 받는다. `eventId`로 중복 제거한다.
- 허용 이벤트는 `src/analytics/store.ts`의 `CLIENT_EVENT_PROPERTIES`가 기준이다.
  - 흐름: `app_started`, `input_confirmed`, `results_viewed`, `candidate_selected`, `selection_confirmed`
  - 실패·이탈: `analysis_failed`, `rerun_requested`, `export_completed`, `export_failed`, `capture_failed`
  - 자동 업데이트: `update_check`, `update_installed`, `update_failed`
- ⚠ **허용 목록에 없는 이름이 배치에 하나라도 섞이면 배치 전체를 `400 INVALID_INPUT`으로 거절한다.** 클라이언트는 4xx를 영구 거절로 보고 그 배치를 버리므로, 같이 실린 정상 이벤트까지 사라진다. **클라이언트에 새 이벤트를 넣기 전에 이 목록을 먼저 배포한다.** 목록에 항목을 더하는 것은 구버전 클라이언트에 영향이 없다.
- `PUT /v1/analysis/jobs/{jobId}/selections`: `[{personIndex,candidateId}]`를 멱등 저장하며 해당 작업에서 노출된 후보인지 검증한다.
- `POST /v1/analysis/jobs/{jobId}/feedback`: `good | person_missing | skeleton_wrong | candidates_irrelevant | export_problem | other`만 허용한다.

---

## POST /v1/analysis/jobs/{jobId}/rerun

🚧 Phase 2. `excludeCandidateIds`로 재검색. 현재 `501`.

---

## GET /v1/pose-candidates/{poseId}/export?jobId=...&personIndex=...&candidateId=...&format=bvh|fbx

작업에서 실제 노출된 후보인지 확인한 뒤 최종 포즈 파일을 반환한다. 요청·성공·실패를 서버에서 직접 기록한다.

`format`은 `bvh`(기본) 또는 `fbx`다. 값을 생략하면 `bvh`로 읽는다 — 구버전 클라이언트가 계속 동작해야
하기 때문이다.

**무엇을 내보낼지는 이 엔드포인트가 정한다.** 해당 `(jobId, personIndex, candidateId)`에 유효한 조정본이
있으면 private S3에 보관된 조정본을, 없으면 도원 서버(`GET /pose/{id}/bvh`)의 베이스 BVH를 프록시한다.
클라이언트는 어느 쪽인지 몰라도 이 URL 하나만 내려받으면 된다 — 추론 서버의 `/refined/{handle}`를 직접
호출해서는 안 된다(그 파일은 추론 태스크의 로컬 디스크에 있어 태스크가 교체되면 사라진다).

조정본을 보관했다고 기록해 놓고 객체를 읽지 못하면 베이스로 안전 전환하고 `export_events`에
`variant=base`, `fallback_reason=refined_object_missing`을 남긴다. 조정본도 원본과 HIERARCHY·채널 순서가
같으므로 CSP 축 보정·드래그 로직은 달라지지 않는다.

**`409 POSE_UNAVAILABLE`**: 추론이 릴리스 시점에 격리한 포즈(`pose_quarantined`)다. 후보 목록은 `/analyze`
때 저장돼 있으므로 격리가 늘어나면 화면에 남아 있던 선택이 여기서 409로 돌아온다. **재시도로는 풀리지
않는다** — 클라이언트는 재시도 버튼이 아니라 "다른 후보를 선택" 경로를 보여줘야 한다.

### `format=fbx` — V3.2.5 FBX 변환

최종 BVH 바이트를 확정하는 규칙은 위와 **똑같다**. 그 뒤에 내부 Converter API `POST /convert`를 인물마다
한 번 호출해 rigged FBX를 받는다(`character_id=standin-master-v2`, `frame=0`, `output_mode=rigged_rest`,
`apply_root_translation=false`, `mirror=false`).

응답을 내보내기 전에 세 가지를 대조한다. 하나라도 어긋나면 그 FBX는 **폐기**한다.

```text
X-Standin-Source-BVH-SHA256 == sha256(우리가 보낸 최종 BVH)
X-Standin-Artifact-SHA256   == sha256(응답 본문)
X-Standin-Solver-Version    == chain-transport-v3.2.5
```

성공하면 `converter` 구조화 로그(`convert_completed`)에 `conversionId`·`finalBvhSha256`·
`fbxArtifactSha256`·`artifactKind`를 남긴다. converter의 CloudWatch 로그와 잇는 키가 `conversionId`다.

mirror는 **converter가 한 번만** 적용한다. BFF가 BVH rotation을 직접 미러링하지 않고, CSP 단계도 같은
반전을 다시 하지 않는다. 현재는 사용자에게 노출하지 않아 항상 `false`다.

| 상태 | 코드 | 재시도 |
|---|---|---|
| `409` | `FBX_UNAVAILABLE` | converter가 꺼진 배포. BVH로 저장 |
| `409` | `CONVERTER_REJECTED` | ✗ 같은 입력은 계속 거부된다 |
| `409` | `CONVERTER_INTEGRITY` | ✗ lineage 불일치. 운영 확인 필요 |
| `503` | `CONVERTER_UNAVAILABLE` | ○ |
| `504` | `CONVERTER_TIMEOUT` | ○ |
| `502` | `CONVERTER_FAILED` | ○ |

FBX 변환이 실패해도 **BVH로 조용히 바꿔 내려보내지 않는다.** 사용자가 고른 포맷과 저장된 파일이 달라지면
클립스튜디오에서 열리지 않는 이유를 알 방법이 없다.

---

## 관리자 품질 검토

`GET /v1/admin/review/jobs/{jobId}`는 `X-Beta-Admin-Token`이 필요하다. 5분짜리 원본 서명 URL, 인물·스켈레톤·후보·선택·피드백을 반환하고 접근을 감사 테이블에 기록한다.

---

## 운영 스위치 (kill switch)

토큰이 틀리면 다른 관리자 경로와 마찬가지로 `404`로 응답한다(경로 존재를 숨긴다).

`GET /v1/admin/flags`

```json
{
  "analysisEnabled": true,
  "reason": null,
  "updatedAt": null,
  "globalDaily": { "day": "2026-08-11", "used": 42, "limit": 0 }
}
```

`PUT /v1/admin/flags/analysis_enabled`

```json
{ "enabled": false, "reason": "Gemini 비용 급증" }
```
```json
{ "analysisEnabled": false, "reason": "Gemini 비용 급증",
  "updatedAt": "2026-08-11T...", "propagationSeconds": 5 }
```

값은 DB(`service_flags`)에 있어 **재배포 없이** 모든 태스크에 반영된다. 각 태스크는 5초 캐시를
쓰므로 전파에 최대 5초 걸린다. 꺼진 동안 `POST /v1/analysis/jobs`는 `503 SERVICE_PAUSED`를
반환하며, 이미 접수된 Job의 폴링·결과 조회는 그대로 동작한다. 토글은 `admin_access_audit`에
`pause_analysis`·`resume_analysis`로 남는다.

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
