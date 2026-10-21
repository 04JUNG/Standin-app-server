# API 계약 — BFF가 클라(Tauri)에 노출하는 `/v1`

## Top5 수평 8방향 미리보기 2026-10-21

기존 일반 후보와 동적 `pose-previews`의 `/poster` URL에 `variant=rough-yaw8-v1`을 추가하면, BFF가 저장된 후보별 `render_camera`에서 가장 가까운 45도 방향을 고릅니다. 중간값은 증가 방향으로 선택하며 원본 검색·내보내기 카메라는 보존합니다. 임의 query `view`는 저장된 선택과 불일치하면 409입니다. legacy 카메라는 검증된 변환이 없으면 정면 참고로 둡니다.

자산은 기존 S3 라이브러리를 로드한 추론 서버에서 읽습니다. BFF는 source·scope·served yaw·native azimuth·모델·revision·이미지 SHA를 검증합니다. 두 poster route 모두 기존 소유권·원본 SHA·범위·응답 전후 후보 검사를 유지합니다. 새 S3 prefix 직접 조회와 IAM 변경은 포함하지 않습니다.

새 응답 헤더: `X-Standin-Poster-Variant`, `X-Standin-Poster-Yaw`, `X-Standin-Poster-Fallback`, `X-Standin-Poster-Requested-Yaw`, `X-Standin-Poster-Camera-Source`, `X-Standin-Projection-Matches-Search`. CORS expose에도 추가했습니다. camera source는 `fixed_117`, `semantic_preview`, `unavailable`입니다. 없으면 requested yaw=`none`, served yaw=0, fallback=`camera_unavailable`입니다. 투영 일치 헤더는 항상 false입니다.

variant 없는 요청은 기존 PNG 계약입니다. opt-in 응답은 승인된 native 512 JPEG 또는 동일 source·scope의 검증된 기존 정면 PNG입니다. 자산 누락 시 사유를 기록하며 손상을 다른 그림으로 숨기지 않습니다. 상세 자산/좌표 규칙은 Standin-server의 `docs/ROUGH_YAW8_PREVIEWS.md`를 참조합니다. 회귀는 `src/poster-yaw.test.ts` 및 기존 poster/presentation/CORS 테스트에 포함합니다.


## v4 장면 보정과 최종 장면 확인

기본 꺼짐입니다. 기존 scene export 조건에 더해 `SCENE_REFINEMENT_ENABLED=true`,
내부 `SCENE_REFINEMENT_BASE_URL`·토큰, 작업 원본 이미지가 있을 때만
`capabilities.sceneRefinement=true`를 제공합니다. 추론의 `/analyze` 제한 시간은 변경하지 않습니다.

같은 scene endpoint에 `{ persons, prepare: true }`를 보내면 원본을 새로 분석하고 방향·범위·팔·관계·배치를
보정합니다. `persons`는 위의 확인한 FBX 참조 형식 그대로이며 클라가 좌표·관절·새 pose ID를 지정하지 않습니다.
응답은 `{ version: "scene-refinement-v4", reviewKey, artifactSha256, previewSha256, previewBase64,
personCount, summary }`입니다. PNG를 확인한 사용자가 저장을 누르면 같은 `persons`와
`reviewKey`로 POST합니다. 응답은 검수한 것과 동일한 SHA의 binary FBX입니다.
검수 키는 소유자·작업·원본 참조에 묶이고 15분 후 또는 서버 재시작 시 사라집니다.
만료·선택 변경 시 409 `SCENE_REVIEW_REQUIRED`이며 새 확인이 필요합니다.

선택 체형·손·출력 범위와 후보 확정·등록 라이브러리·원본 SHA 검증은 유지합니다.
지원하지 않는 체형 calibration이나 보정 실패는 오류로 표시합니다. 기능 꺼짐 또는 원본 미보관 작업은
기존 기본 장면 경로를 사용합니다. CSP의 카메라 채택과 원본 절대 화면 크기 일치는 이 계약으로 보장하지 않습니다.
설정·내부 호출·검증 경계는 [v4 장면 저장](scene-refinement-v4.md)을 참고하세요.

## 선택 품질 검토 동의 (2026-10-19)

기본 설치 인증과 품질 검토 참여를 분리한다. 기본 동의 버전(`BETA_CONSENT_VERSION`)과
설치 자격증명은 유지하고, 선택 동의는 별도 버전 `2026-10-19`로 관리한다.

- `POST /v1/installations`의 선택 필드 `qualityConsent`와
  `PUT /v1/installations/current/quality-consent` 요청은 아래 형식이다.
  설치 등록에서 필드를 생략한 구 앱과 기존 설치는 **미동의**로 처리한다.
- `GET /v1/installations/current/quality-consent`는 현재 상태를 반환한다.
  GET/PUT에는 설치 인증 헤더가 필요하며 응답은 `Cache-Control: no-store`다.

```json
{ "version": "2026-10-19", "personalData": true, "contentLicense": true }
```

등록 응답의 `qualityConsent`와 GET/PUT 응답에는 위 필드에 `consentId`, `grantedAt`이
추가된다. 두 허용값이 모두 true일 때만 서버가 동의 ID와 시각을 발급한다. 하나라도
false이면 두 값은 null이다. 동일한 값의 재시도는 기존 동의 ID를 유지한다.
지원하지 않는 버전이나 boolean이 아닌 값은 `400 INVALID_INPUT`이다.

- 동의 후 생성한 Job에 그 시점의 동의 ID를 기록한다. 이전 Job은 소급 편입하지 않는다.
- `POST /v1/events/batch` 최상위와 피드백 요청에 `qualityConsentId`를 보낸다.
  현재 동의 ID 및 Job의 동의 ID가 일치해야 저장한다. 구 앱·누락·철회·과거 동의의
  오프라인 이벤트는 저장하지 않는다. 배치 응답의 기존 `duplicates` 수에는 이 제외 건도 포함된다.
- 품질 동의가 없어도 분석, 후보 확정, 내보내기와 기본 작업 이력은 이용할 수 있다.
  내보내기에 필요한 `confirmed_selections`는 기본 처리이며 품질 이벤트와 별개다.
- 철회는 설치 인증을 유지하고, 품질 전용 이벤트·피드백·평가 필드와 모든 이전 Job의
  검토 권한을 제거한다. 90일이 지난 Job도 이 트랜잭션에서 삭제한다. 남은 기본 작업은
  최초 90일 범위에서만 유지한다. 재동의하면 새 동의 ID로 이후 Job만 검토한다.
- 최소 동의 증빙은 문서 버전·두 허용값·시각·설치 ID의 해시만 별도 보관하고,
  동의 종료 후 365일에 정리한다. 이미지·원문·장치 토큰을 포함하지 않는다.

관리자 목록·갤러리·통계·공백 관측은 `quality_review_*` 뷰를 통해 현재 동의와
Job의 동의 ID가 일치하는 행만 읽는다. Job 상세·원본·조정본·변환 다운로드는
처리 전후에 권한을 다시 확인한다. 원본·파생 파일은 90일, 연결 평가정보는 최대
365일이며 철회 시 더 일찍 제외한다. 관리자 파일 URL은 매번 관리자 인증을 요구하는
프록시 경로이고 독립적으로 유효한 S3 서명 URL을 발급하지 않는다.

배포 순서와 검증 범위는 [선택 동의 배포 점검](OPTIONAL_QUALITY_CONSENT.md)을 따른다.

## 러프 장면 FBX 저장 (로컬 검증, 기본 꺼짐)

`SCENE_EXPORT_ENABLED=true`이고 FBX Converter가 설정되어 있으면 이미지 작업 결과에
`capabilities.sceneExport=true`를 노출합니다. 구 서버·문장 검색은 기존 저장 흐름을 유지합니다.

`POST /v1/analysis/jobs/:jobId/scene`에는 설치 인증과 아래 JSON을 보냅니다.

```json
{"persons":[{"personIndex":0,"candidateId":"pick","exportPath":"/v1/pose-candidates/pose/framed?jobId=job&personIndex=0&candidateId=pick&format=fbx&reviewKey=...","sha256":"<확인한 최종 FBX SHA256>"}]}
```

1~8명을 한 FBX로 합칩니다. 인물 위치·크기 관측은 소유 작업의 box/COCO17만 사용하고,
클라이언트 좌표를 받지 않습니다. exportPath는 해당 후보의 로컬 framed/export 경로만
허용하며 외부 URL을 요청하지 않습니다. 기존 저장 핸들러를 인증 헤더로 내부 호출해
소유권·확정·현재 체형·손·범위·검수 키를 합성 전후에 다시 검증합니다. FBX SHA가 바뀌면
409 `SCENE_SOURCE_CHANGED`, 러프 관측이 없으면 409 `SCENE_OBSERVATION_MISSING`입니다.
내부 Converter의 `rough-layout-v1` 입력·출력 SHA와 인원 수가 일치해야 응답합니다.
응답은 binary FBX이며 `X-Standin-Artifact-SHA256`, `X-Standin-Person-Count`,
`X-Standin-Scene-Version`을 웹뷰에 노출합니다. 장면 합성 실패를 개별 저장으로 바꾸지 않습니다.

**CSP에서 원본 화면 구도를 그대로 유지하는 기능은 아직 완료되지 않았습니다.**
T001·p0718 실제 import에서 CSP가 FBX 카메라를 따르지 않고 장면을 다시 중앙·크기 맞춤했습니다.
상대 world 배치는 파일에 남지만 CSP 화면의 절대 위치·크기를 보장하지 않습니다.
따라서 flag 기본값은 false이며, 배포·기본 활성화 및 CSP 구도 완료 판정은 보류합니다.
로컬 검증은 실제 BFF 합성 핸들러→HTTP Converter→Blender→FBX 재import 및 CSP import를
사용했고, 소유 작업·검수 다운로드 인증은 fixture였습니다. 운영 DB·설치 앱 E2E는 별도입니다.

## 작가 수동 선택·검수·저장 (2026-10-19)

검색 품질 판정과 작가의 수동 저장 권한은 별개입니다. 공개·비공개 자산의 pose ID와 SHA가
일치하는 라이브러리 원본·실제 미러·근접·기하·구도 참고 및 직접 자연어 검색 후보는
`candidates`에 `manualExportAllowed=true`, `presentationKind`, `sourceBvhSha256`로 노출합니다.
`releaseAllowed=false`, `actualMeshValidated=false`, `refineAllowed=false`와 기존 검색/생성 오류는
그대로 유지합니다. 검색 실패를 통과로 기록하거나 자동 적용·보정 권한을 늘리지 않습니다.

작가는 후보를 선택하고 기존 `PUT /analysis/jobs/:id/selections`로 확정한 뒤,
`/:pose/framed?format=preview|model`에서 실제 체형·수치·손·출력 범위를 확인합니다.
확인 응답의 `X-Standin-Review-Key`를 같은 설정의 `format=fbx` 요청에 보내야 저장됩니다.
`X-Standin-Artifact-SHA256`는 쌍으로 만든 최종 FBX 해시이고,
`X-Standin-Preview-Artifact-SHA256`는 PNG/GLB 바이트 해시입니다. 원본 BVH 및 체형 SHA도
응답에 제공합니다. 기본 카드 이미지는 최종 파일 검수의 대체물이 아닙니다.

수동 후보의 원본 BVH 저장도 확정 선택이 필요하며, `/export?format=fbx`는
`MANUAL_REVIEW_REQUIRED`로 최종 framed 검수를 요구합니다. `MANUAL_SELECTION_REQUIRED`는
확정 선택이 없는 경우입니다. 원본/체형/손/scope/revision/runtime/카메라/소유권/격리 상태가
바뀌면 이전 검수 키를 거절합니다. 원본과 미러는 각각 실제 등록 BVH 바이트를 사용합니다.

기존 검수 전용 작업은 소유자가 다시 열 때 job 행 잠금 아래 비공개 자산과 공개 행을 검증하고
후보 행·JSON을 함께 보강합니다. 재분석·VLM 호출이 필요하지 않습니다. 구형 semantic 후보 ID가
presentation ID로 정리되면 직접 다시 선택·확정해야 하며 원래 검색·손·범위 설정은 보존합니다.
등록 BVH/해시 바인딩이 없는 구형 dynamic 결과와 inline 생성 실패 후보는 이 권한을 받지 않습니다.
자세한 경계와 검증은 [MANUAL_POSE_EXPORT.md](MANUAL_POSE_EXPORT.md)를 따릅니다.

## 동적 검색 조회 전용 후보 (2026-10-17)

`candidatesByPerson[].routedSearch`는 route/status/reason, 근접·구도 참고 개수, 별도 생성 검수 상태,
기본 인체 여부를 보존합니다. `candidates[].source=dynamic|semantic`인 후보는 `rankScore`를 가지며
기하 `distance`로 변환하지 않습니다. `lookupAllowed=true`, `refineAllowed=false`,
`releaseAllowed=false`, `actualMeshValidated=false`, `reviewRequired=true`, `bvhAvailable=false`입니다.
`searchCamera`는 검색 카메라 메타데이터이며 기존 정렬 렌더 camera 계약과 구별합니다.

`GET /v1/pose-candidates/:id/lookup-thumbnail?jobId=...&personIndex=...&candidateId=...`는
소유권·후보 ID·포즈를 검증한 정면 참고 이미지를 제공합니다. 검색 시점의 정렬 렌더라고 표시하지 않습니다.
해당 후보의 refine은 409 `CANDIDATE_REFINE_FORBIDDEN`, BVH/FBX/framed FBX 저장은
409 `CANDIDATE_RELEASE_FORBIDDEN`으로 거부합니다. 구형 무해시 dynamic 결과에는 이 차단을 유지합니다. 버전이 확인된 presentation과 직접 자연어 검색의 수동 저장 계약은 위 절을 따릅니다.
상세는 [동적 검색 연결](ROUTED_SEARCH_INTEGRATION.md)을 참조합니다.

## 빠른 후보 카드 (2026-10-08)

카메라가 지정된 후보에는 기존 `thumbnailUrl`(정확한 각도의 느린 렌더)과 함께
`quickThumbnailUrl`(이미 준비된 라이브러리 JPEG)을 제공합니다. 후보 카드에서는 빠른
이미지를 먼저 사용하고, 저장 전 확인 화면은 최종 모델/FBX 계약을 그대로 사용합니다.
JPEG는 검색 시점의 근사 시점이며 선택한 체형이나 정밀 카메라를 보장하지 않습니다.
응답에 이미지가 없는 구 번들은 `quickThumbnailUrl`을 생략합니다.

## 모델 미리보기와 FBX 재사용 (2026-10-08)

- `capabilities.modelPreview`는 정상 Converter의 모델 exporter revision 및 체형 SHA를
  확인했을 때만 true다. 구 Converter/BFF/앱은 기존 PNG 경로를 유지한다.
- 선택 refine POST의 선택 필드 `deferPreview: true`는 추론에 `render_thumbnail:false`를
  전달한다. 후보 소유권·관측 정책·결과 저장은 그대로이고 `thumbnailUrl`은 null일 수 있다.
- 기존 `/v1/pose-candidates/:id/framed`의 `format=model`은 최종 범위/체형/각도가 적용된
  정적 GLB (`model/gltf-binary`)를 반환한다. 소유권·확정 후보·현재 범위 검사를 모두 적용한다.
- 동일 URL의 `format=fbx&previewType=model`은 모델 준비 때 만든 **동일 FBX 바이트**를
  재사용한다. `format=preview` 및 기존 FBX 호출은 기존 PNG+FBX 경로다.
- `format=model&useLibraryModel=true`는 서버에 저장된 결과가 원본·전신이고 후보 각도가
  확인될 때만 사전 생성 `posed-mesh-v1`을 반환하고 FBX 준비를 시작한다. 앱은 후보의
  회전을 한 번 적용한다. 실제 리파인 결과가 있거나 캐시/체형 해시가 맞지 않으면 최종
  `framed-mesh-v1`으로 처리한다. 사전 생성 응답에는 최종 FBX 해시 헤더를 붙이지 않는다.
- 모델에서 확인한 `expectedBvhSha256`, `expectedCharacterSha256`, 선택적
  `expectedModelRevision`을 저장 요청에 싣는다. 실제 소스/체형/exporter가 바뀌면 변환 전에
  `409 PREVIEW_CHANGED`로 거절한다. 사전 생성 모델은 최종 exporter revision을 고정하지 않는다.
- 캐시는 소유자, job, 인물, 후보, 실제 BVH SHA, 체형, 출력 범위, 각도, 모델 exporter revision,
  체형 SHA로 구분한다. PNG/model 캐시는 분리되고 동일 진행 요청은 합쳐진다.
  프로세스별 128 MiB/10분/최대 16개 진행 요청이며, 캐시 적중 시에도 접근 권한을 재검사한다.
  재시작·다른 BFF 인스턴스·퇴출 뒤에는 다시 변환할 수 있다. 공유 영구 캐시는 후속 범위다.

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

`DELETE /v1/installations/current/data`는 전용 S3 prefix, 작업·파생 데이터(조정본 대장 포함)·이벤트·선택·피드백, 이 설치를 연 관리자 열람 기록, 주간 쿼터 카운터와 설치 레코드를 삭제한다. 진행 중인 작업도 지운다. 워커가 결과를 쓰는 중이면 그 쓰기가 끝난 뒤 지우고, 이미 지운 작업에는 결과를 쓰지 않는다. 지우는 테이블 목록은 `src/retention.ts` 하나이며 작업 삭제·365일 보관 만료도 같은 목록을 쓴다. 응답은 `{ "deleted": true, "backupExpiryDays": 7 }`이다.

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
    "details": {
      "retryAfterSeconds": 213000,
      "limit": 100,
      "retryAt": "2026-08-24T00:00:00.000+09:00"
    },
    "requestId": "req_..."
  }
}
```

| code                    | 의미                              | `details`                                     |
| ----------------------- | --------------------------------- | --------------------------------------------- |
| `WEEKLY_QUOTA_EXCEEDED` | 설치별 **주간** 분석 한도 초과    | `retryAfterSeconds`, `limit`, `retryAt`       |
| `GLOBAL_QUOTA_EXCEEDED` | 서비스 전체 일일 분석 한도 초과   | `retryAfterSeconds`, `retryAt`                |
| `RATE_LIMITED`          | 짧은 시간에 요청이 몰림(IP 단위)  | `retryAfterSeconds`, `limit`, `windowSeconds` |
| `CONCURRENCY_LIMIT`     | 같은 설치에 진행 중인 분석이 있음 | `retryAfterSeconds`, `limit`                  |

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

| 필드              | 필수 | 설명                                                                                            |
| ----------------- | :--: | ----------------------------------------------------------------------------------------------- |
| `file`            |  ✅  | PNG/JPEG/WEBP 러프 콘티 이미지, 최대 20MB. MIME·파일 시그니처·헤더의 실제 픽셀 크기를 검증한다. |
| `source`          |  ✅  | `capture \| file \| clipboard`                                                                  |
| `width`, `height` |  —   | 원본 픽셀 크기(참고값). 서버가 헤더에서 실제 크기를 읽으면 **그 값이 우선한다**                 |

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

| 쿼리     | 기본 | 설명                                                         |
| -------- | ---- | ------------------------------------------------------------ |
| `limit`  | 20   | 1~50 정수. 범위 밖은 클램프하지 않고 `400 INVALID_INPUT`.    |
| `cursor` | —    | 이전 응답의 `nextCursor`. 손상된 값은 `400 INVALID_INPUT`.   |
| `status` | —    | `queued \| running \| completed \| failed` 중 하나로 거른다. |

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
기록·분석 이벤트·조정본 대장·관리자 열람 기록), 그리고 S3의 입력 원본과 조정본을 모두 지운다.

```json
{ "deleted": true }
```

- 진행 중(`queued`/`running`)이면 `409 JOB_IN_PROGRESS`. 삭제로 슬롯이 바로 비면 설치별 동시
  분석 한도가 무의미해진다.
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
    {
      "personIndex": 0,
      "candidateId": "pose-1::front",
      "rank": 1,
      "confirmedAt": "..."
    }
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
`ANALYSIS_UNAVAILABLE`은 상류 VLM 혼잡 또는 구 서버/미지원 본문의 `503`이다.
Standin-server #86의 `503 detail.code=VLM_UNAVAILABLE`은 `detail.reason`을 아래처럼
기존 `error` 문자열에 구분 저장한다. 작업 기록의 `errorCode`에도 같은 값이 내려간다.

| 추론 `reason` | Job `error` / 기록 `errorCode` | 앱 안내 |
|---|---|---|
| `rate_limited` | `ANALYSIS_RATE_LIMITED` | AI 요청 한도에 일시 도달, 잠시 기다린 뒤 재시도 |
| `daily_quota_exhausted` | `ANALYSIS_DAILY_QUOTA_EXHAUSTED` | AI 제공 서비스의 일일 한도 소진, 즉시 재시도 버튼 없음 |
| `upstream_unavailable` | `ANALYSIS_UNAVAILABLE` | 혼잡/일시 이용 불가, 잠시 후 재시도 |
| `timeout` | `ANALYSIS_UPSTREAM_TIMEOUT` | AI 응답 시간 초과, 잠시 후 재시도 |
| `upstream_error` | `ANALYSIS_UPSTREAM_ERROR` | AI 서비스 일시 오류, 잠시 후 재시도 |

일일 한도는 사용자 설치의 주간 한도와 다르며 초기화 시각을 추정하지 않는다.
제공자 원문/메시지는 노출하지 않는다. 비 JSON·누락·미지원 reason은 기존
`ANALYSIS_UNAVAILABLE`로 유지한다. HTTP 503의 기존 환급 결과는 모든 세부 코드에 보존한다.
BFF 자체의 `ANALYSIS_TIMEOUT`과 400/500 등의 분류·환급은 바뀌지 않는다.
이번 변경은 DB 구조와 재시도 실행 정책을 변경하지 않는다. 정확한 `retry_after_seconds`
영속화·카운트다운은 포함하지 않으며 숫자 대기 시간을 임의로 표시하지 않는다.
배포는 새 코드를 해석하는 클라이언트를 먼저 배포한 뒤 BFF를 배포한다. 구 클라이언트는
새 코드를 일반 실패로 표시할 수 있다. 과거 저장된 실패 사유는 소급 재분류하지 않는다.

기존 `ANALYSIS_UNAVAILABLE`은
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
    "poseLibraryVersion": "lib-20261002-91b57d0f",
    "featureVersion": 1,
    "vlmPromptVersion": "p1-scope",
    "poseLibrarySha256": "91b57d0f…"
  },
  "candidatesByPerson": [
    {
      "personIndex": 0,
      "box": [120, 80, 360, 720],
      "tags": {
        "shot": "full_half",
        "action": "standing",
        "view": "front",
        "relationship": "solo"
      },
      "skeleton": {
        "schemaVersion": "coco17-v1",
        "keypoints": [[1, 2]],
        "scores": [0.9]
      },
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

`inferenceMetadata.vlmPromptVersion`(답한 VLM 프롬프트)과 `poseLibrarySha256`(포즈 라이브러리 번들의 내용 해시)은 추론이 함께 보낼 때만 있다. 그 전에 저장된 결과에는 이 필드가 없다.

### 인물별 출력 범위 설정 (1단계)

`candidatesByPerson[].outputScope`:
`{ selection: "auto", detected: "half", detectionSource: "vlm_person", resolved: "half", resolutionSource: "auto" }`.

- 범위: `full`(전신), `half`(반신), `bust`(흉상), `head`(두상). 선택값에는 `auto`도 허용.
- `detected: null`은 판별 불가/구 응답. `auto`는 이 경우 전신으로 폴백하며 `resolutionSource: "fallback"`.
- 자동 판별과 사용자 선택은 독립적이다. 수동 선택 후 `auto`로 되돌리면 원래 판별을 다시 사용.
- `detectionSource`: `vlm_person | legacy_shot | unknown`; `resolutionSource`: `auto | user | fallback`.
- `PUT /v1/analysis/jobs/{jobId}/people/{personIndex}/output-scope`, body: `{ "selection": "half" }`.
  응답: `{ personIndex, outputScope }`. 설치 소유권 검사, 완료된 Job/실제 인물만 허용.
  잘못된 본문/번호 400, 다른 설치·없는 작업/인물 404, 미완료 409.
- Job의 `result_json`에 영속화. 후보 선택/refine과 독립적이며 GET result로 복원.
  행 잠금 트랜잭션으로 다른 인물의 동시 수정을 보존한다. 새 분석 Job은 자동부터 시작.
- `capabilities.outputScopeSelection: true`; `outputScopeCropping`은 converter 지원 상태에 따라 결정한다.
  현재 설정 저장 단계이며 검색, 미리보기, BVH/FBX 바이트는 바뀌지 않는다.
  export 쿼리에 범위를 붙이지 않는다. 실제 crop은 별도 converter 계약/버전 작업이다.
- 흉상/두상 조기 종료 응답에도 인물 메타데이터는 남는다. 후보 없음/검색 미지원은 그대로다.

### `matchLevel`

`person.confidence`가 **1급 기준**이다. `confidence != high`면 그 인물의 모든 후보가 `matchLevel=low`가 되고,
`high`일 때만 원시 `distance` 구간(≤0.25 high / ≤0.45 medium / 그 외 low)을 표시용 세부 등급으로 쓴다(`src/mapping.ts`).

거리만으로 판단하지 않는 이유: 구조 검사에서 마스킹된 관절이 많을수록 남은 관절끼리의 평균 거리가 **작아진다**.
즉 정보가 거의 없는 스켈레톤일수록 raw distance가 좋아 보인다. 서로 다른 `coverageClass`의 raw distance를
같은 절대 구간으로 비교하거나 정렬해서는 안 된다. `distance`/`rerankScore`는 개발자 진단용 원시값이다.

### 인물 품질 필드

| 필드             | 값                                                          | 의미                               |
| ---------------- | ----------------------------------------------------------- | ---------------------------------- |
| `confidence`     | `high` \| `low`                                             | 최종 인물 단위 신뢰도              |
| `skeletonState`  | `valid` \| `partial` \| `suspect` \| `missing` \| `invalid` | 구조 품질과 fallback 사유          |
| `skeletonSource` | `full_image` \| `crop_retry` \| `none`                      | crop 재추론으로 복구했는지         |
| `coverageClass`  | `full` \| `reduced` \| `sparse` \| `insufficient`           | 거리 임계값이 적용된 관측 범위     |
| `fallbackMode`   | `none` \| `soft` \| `hard`                                  | 아래 표 참고                       |
| `refineAllowed`  | boolean                                                     | 이 인물에 refine을 호출해도 되는가 |
| `refinableLimbs` | string[]                                                    | refine이 움직여도 되는 사지        |

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

### `capabilities.characterSelection`

이 BFF가 export의 `characterId`를 존중하는가. `fbxExport`가 켜져 있고 **동시에** 기본 체형 말고 고를 수
있는 체형이 하나 이상 있을 때만 `true`다. 모델 목록(`GET /v1/models`)과 export 처리는 따로 배포될 수
있으므로 `fbxExport`와 따로 둔다 — 목록만 먼저 나가면 클라이언트가 고른 체형과 다른 FBX가 저장된다.
converter를 부르지 못하면 `false`다(없는 기능이라고 말하는 쪽이 안전하다).

⚠ `capabilities`는 이 Job이 아니라 **지금 서버**의 성질이다. 분석 시점에 굳어 있으면 작업 기록에서 다시
연 작업이 몇 주 전 배포 상태를 보게 되므로, `/result` 응답 직전에 조회 시점 값으로 덮어쓴다.

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
  "exportUrl": "/v1/pose-candidates/stand_solo/export?jobId=job_...&personIndex=0&candidateId=stand_solo%3A%3Afront",
  "thumbnailUrl": "/v1/analysis/jobs/job_.../people/0/refine/thumbnail?candidateId=stand_solo%3A%3Afront"
}
```

**`refined: false`는 오류가 아니다.** 안전 게이트가 조정을 버리고 베이스를 유지한 정상 결과이며, HTTP는 200이다.
`reasonCode`는 추론의 사유(`entangled_set`, `no_gain`, `collision_gate` …)이거나 BFF가 붙인 스킵 사유다.

| `reasonCode`            | 의미                                                                       |
| ----------------------- | -------------------------------------------------------------------------- |
| `feature_disabled`      | BFF의 refine flag가 off. 추론을 호출하지 않았다                            |
| `skeleton_policy`       | 저신뢰 인물이라 refine 금지. 추론을 호출하지 않았다                        |
| `storage_unavailable`   | 조정본을 보관할 저장소가 없다                                              |
| `context_unavailable`   | 보관된 refine 입력이 없거나 17×2가 아니다                                  |
| `upstream_unavailable`  | 추론 timeout·5xx. 베이스로 전환                                            |
| `artifact_store_failed` | 조정은 됐지만 보관에 실패. **refined=true로 기록하지 않는다**              |
| `upstream_missing_bvh`  | `refined=true`인데 `bvh` 본문이 없거나 `null`. 계약 위반이라 베이스로 전환 |

추론이 돌려주는 사유에는 v2.5에서 `timeout`, `safety_gate`, `unchanged_geometry`, `low_observability`,
`no_solvable_joints`, `final_collision_gate`, `final_extension_gate`가 추가됐다. 전부 `refined=false` +
베이스 저장으로 수렴하므로 클라이언트 분기는 달라지지 않는다.

같은 `(jobId, personIndex, candidateId)`는 멱등이다 — 다시 호출해도 추론을 재호출하지 않고 저장된 결과를 돌려준다.

오류: 접근 권한 없는 job은 `404 NOT_FOUND`, 그 인물에게 노출되지 않은 후보는 `409 INVALID_SELECTION`.

### `thumbnailUrl`

저장 직전 확인 화면(클라 `ADR-010`)이 쓰는 미리보기 PNG 경로. 없으면 `null`이고, 그때 화면은 후보
썸네일로 폴백한다 — **그림이 없는 것은 오류가 아니다.**

`refined`와 독립이다. 추론은 `refined=false`일 때 실제로 저장될 **베이스 BVH**를 후보 썸네일과 같은
렌더러(`warm-mannequin-v1`)·같은 `view`로 그려 주므로, 확인 화면은 조정 여부와 무관하게 "저장될 것"의
그림을 얻는다. 반대로 조정에 성공했는데 그림만 없을 수도 있다.

BFF는 받은 PNG를 조정본 BVH와 **같은 prefix**(`installations/{id}/jobs/{jobId}/refined/{personIndex}/…`,
확장자만 `.png`)에 보관한다. 추론 서버는 PNG를 저장하지 않고 멱등 캐시가 추론 재호출을 막으므로,
보관하지 않으면 작업 기록에서 다시 열었을 때 그림이 사라진다.

계약에 어긋난 PNG(잘못된 시그니처·`media_type`·`encoding`, 1 MB 초과)는 보관하지 않고 버린다.
미리보기는 "이게 저장된다"고 주장하는 그림이라, 확신이 없으면 아무것도 보여주지 않는 편이 맞다.

## GET /v1/analysis/jobs/{jobId}/people/{personIndex}/refine/thumbnail?candidateId=… 🔒

위 `thumbnailUrl`이 가리키는 경로. `image/png`를 그대로 돌려준다.

POST와 **같은 두 단계 소유권 검사**를 거친다 — job이 이 installation의 것인지, 그리고 그 인물에게
실제로 노출된 후보인지. 미리보기도 사용자 입력에서 파생된 private artifact다.

보관된 그림이 없으면 `404 NOT_FOUND`다. 빈 200을 주면 클라이언트가 깨진 이미지를 그린다.

---

## 행동·선택·피드백

- `POST /v1/events/batch`: 최대 100개의 `eventId`, `sequence`, `occurredAt`, 이벤트명, `jobId`, 허용 속성을 받는다. `eventId`로 중복 제거한다.
- 허용 이벤트는 `src/analytics/store.ts`의 `CLIENT_EVENT_PROPERTIES`가 기준이다.
  - 흐름: `app_started`, `input_confirmed`, `results_viewed`, `candidate_selected`, `selection_confirmed`
  - 실패·이탈: `analysis_failed`, `rerun_requested`, `export_completed`, `export_failed`, `capture_failed`
  - 자동 업데이트: `update_check`, `update_installed`, `update_failed`
- ⚠ **허용 목록에 없는 이름이 배치에 하나라도 섞이면 배치 전체를 `400 INVALID_INPUT`으로 거절한다.** 클라이언트는 4xx를 영구 거절로 보고 그 배치를 버리므로, 같이 실린 정상 이벤트까지 사라진다. **클라이언트에 새 이벤트를 넣기 전에 이 목록을 먼저 배포한다.** 목록에 항목을 더하는 것은 구버전 클라이언트에 영향이 없다.
- `PUT /v1/analysis/jobs/{jobId}/selections`: `[{personIndex,candidateId}]`를 멱등 저장하며 해당 작업에서 노출된 후보인지 검증한다. 요청은 그 작업의 확정 집합을 **대체**한다 — 목록에 없는 인물(사용자가 내보내기를 끈 인물)의 이전 확정은 지운다.
- `POST /v1/analysis/jobs/{jobId}/feedback`: `good | person_missing | skeleton_wrong | candidates_irrelevant | export_problem | other`만 허용한다.

---

## POST /v1/analysis/jobs/{jobId}/rerun

🚧 Phase 2. `excludeCandidateIds`로 재검색. 현재 `501`.

---

## GET /v1/models 🔒

저장할 체형(모델) 목록. 클라이언트의 모델 화면과 선택 UI가 이것으로 그려진다
(Standin-client `docs/adr/ADR-013-model-selection.md`).

```json
{
  "characters": [
    {
      "characterId": "standin-master-v2",
      "displayName": "기본 남성",
      "gender": "male",
      "availability": "available",
      "source": "builtin",
      "isDefault": true,
      "rigProfile": "mixamo",
      "revision": "v2",
      "previewUrl": null,
      "description": "표준 남성 체형입니다."
    },
    {
      "characterId": "standin-female-v2-lbs",
      "displayName": "기본 여성",
      "gender": "female",
      "availability": "coming_soon",
      "source": "builtin",
      "isDefault": false,
      "rigProfile": null,
      "revision": null,
      "previewUrl": null,
      "description": "표준 여성 체형입니다."
    }
  ],
  "defaultCharacterId": "standin-master-v2"
}
```

**가용 여부는 converter가, 표현은 BFF가 정한다.** converter `GET /characters`는 artifact를 실제로
resolve 해 본 것만 돌려주므로 그것이 `availability`의 유일한 근거다. 반면 converter의 `display_name`은
"Standin Master V2" 같은 내부 코드명이고 성별·설명은 아예 없다 — 화면 문구를 Python 저장소에 넣을
이유가 없으므로 `src/characters/catalog.ts`가 소유한다.

⚠ **converter가 지금 못 만드는 체형도 목록에서 빼지 않고 `coming_soon`으로 내린다.** 빼 버리면
앱에는 "모델 선택이라는 기능이 없다"로 보인다. `coming_soon`으로 보내면 앱이 회색 "준비 중" 카드를
그려서, 기능은 있고 준비 중이라는 것이 드러난다. 반대로 converter에만 있고 우리 표에 없는 캐릭터도
코드명 그대로 내보낸다 — 등록된 줄도 모르는 것보다 낫다.

`previewUrl`은 아직 항상 `null`이다. 앱이 자기가 커밋한 이미지를 쓴다.

**`503 CONVERTER_UNAVAILABLE`**: converter가 꺼져 있거나(`FBX_EXPORT_ENABLED`·`CONVERTER_BASE_URL`)
도달할 수 없다. 빈 배열이 아니라 503인 이유는 빈 배열이 "모델이 하나도 없다"로 읽히기 때문이다.
클라이언트는 404·501·503을 "이 배포엔 이 기능이 없다"로 보고 자기 폴백 목록을 그린다.

`Cache-Control: public, max-age=300`.

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

### `characterId` — 저장할 체형

`format=fbx`일 때만 읽는다. 생략하면 배포 기본값(`CONVERTER_CHARACTER_ID`)으로 변환한다.

| 상황                                        | 응답                        |
| ------------------------------------------- | --------------------------- |
| 목록에 있고 지금 만들 수 있음               | 그 체형으로 변환            |
| 우리가 모르는 값                            | `400 INVALID_CHARACTER`     |
| 아는 체형인데 지금 못 만듦(artifact 미배포) | `409 CHARACTER_UNAVAILABLE` |
| `format=bvh`에 함께 옴                      | **무시한다**(400 아님)      |

BVH에서 무시하는 이유: BVH는 동작만 담아 체형이 들어갈 자리가 없는데, 클라이언트와 BFF는 따로
배포되므로 400으로 막으면 구버전 클라이언트의 저장이 통째로 깨진다.

⚠ **조용히 기본 체형으로 대체하지 않는다.** 고른 체형과 파일이 일치하는 것이 이 기능의 전부다 —
대체하면 사용자는 다른 인형을 받고도 알 방법이 없다. 두 오류 모두 재시도로 풀리지 않으므로
클라이언트는 "다른 모델 선택" 또는 "기본 모델로 저장" 경로를 보여준다.

### `format=fbx` — V3.2 FBX 변환

최종 BVH 바이트를 확정하는 규칙은 위와 **똑같다**. 그 뒤에 내부 Converter API `POST /convert`를 인물마다
한 번 호출해 rigged FBX를 받는다(`character_id`는 위 규칙으로 정한 값, `frame=0`,
`output_mode=rigged_rest`, `apply_root_translation=false`, `mirror=false`).

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

| 상태  | 코드                    | 재시도                            |
| ----- | ----------------------- | --------------------------------- |
| `409` | `FBX_UNAVAILABLE`       | converter가 꺼진 배포. BVH로 저장 |
| `409` | `CONVERTER_REJECTED`    | ✗ 같은 입력은 계속 거부된다       |
| `409` | `CONVERTER_INTEGRITY`   | ✗ lineage 불일치. 운영 확인 필요  |
| `503` | `CONVERTER_UNAVAILABLE` | ○                                 |
| `504` | `CONVERTER_TIMEOUT`     | ○                                 |
| `502` | `CONVERTER_FAILED`      | ○                                 |

FBX 변환이 실패해도 **BVH로 조용히 바꿔 내려보내지 않는다.** 사용자가 고른 포맷과 저장된 파일이 달라지면
클립스튜디오에서 열리지 않는 이유를 알 방법이 없다.

---

## 관리자 품질 검토

모든 관리자 경로는 `X-Beta-Admin-Token` 헤더가 필요하고, 접근은 `admin_access_audit`에 기록된다.

토큰은 **사람마다 다르게 줄 수 있다.** `standin/<env>/beta-review-token` 시크릿 값이 `{"보라":"...","도원":"..."}` 형태의 JSON이면 앱이 토큰으로 검토자를 식별해 `admin_access_audit.reviewer`에 그 이름을 남기고, `GET /v1/admin/ops` 응답의 `reviewer`로도 돌려준다(대시보드 우측 상단에 뜬다). 값이 JSON이 아니면 단일 토큰으로 읽고 이름은 `beta-reviewer`가 된다 — 전환 순서는 [README](../README.md)의 「팀원에게 열어 줄 때는 사람별 토큰으로 준다」 참고.

이름은 한글을 포함한 유니코드 글자·숫자와 `_.@-`를 받고 공백·제어문자는 막는다(최대 40자). 규칙에 맞지 않는 항목은 조용히 버린다 — 오타 하나로 관리자 경로 전체가 닫히면 장애 중에 대시보드를 못 여는 쪽이 더 위험하다. 대신 값을 바꾼 뒤에는 각자 한 번씩 열어 `reviewer`에 자기 이름이 뜨는지 확인한다.

### 설치 명부

`GET /v1/admin/review/installations`

어떤 설치가 있는지 최근 접속 순으로 준다. 쿼리는 `limit`(1~50, 기본 20) · `cursor` · `activeOnly`(`true`면 철회·삭제 요청 설치를 뺀다. 기본은 `false` — 그 설치에 기록이 남아 있는지 확인하는 자리이기도 하다).

```json
{
  "items": [
    {
      "installationId": "inst_...",
      "createdAt": "2026-09-01T...",
      "lastSeenAt": "2026-09-11T...",
      "appVersion": "0.1.1-beta.7",
      "osName": "windows",
      "osVersion": "11",
      "locale": "ko",
      "consentVersion": "2026-08-02",
      "revokedAt": null,
      "deletionRequestedAt": null,
      "jobCount": 12,
      "failedCount": 1,
      "lastJobAt": "2026-09-04T00:29:24.879Z"
    }
  ],
  "nextCursor": "eyJ..."
}
```

`jobCount`·`failedCount`는 **그 페이지에 실린 행에 대해서만** 센다(LATERAL). 전체를 GROUP BY로 말면 설치가 늘수록 한 페이지를 여는 비용이 전체 Job 수에 비례한다.

정렬 기준이 `lastSeenAt`이라 페이지를 넘기는 도중 값이 바뀌면 그 행이 첫 페이지로 올라간다. 고정 스냅샷 대신 "지금 기준"을 보여 주는 선택이다. `lastJobAt`이 `null`이면 접속만 하고 분석은 돌리지 않은 설치다.

### 설치 단위 작업 기록

`GET /v1/admin/review/installations/{installationId}/jobs`

특정 설치가 무엇을 돌렸고 무엇이 실패했는지 훑는다. 쿼리는 사용자용 `GET /v1/analysis/jobs`와 같다 — `limit`(1~50, 기본 20) · `cursor` · `status`(`queued`|`running`|`completed`|`failed`).

```json
{
  "installation": {
    "installationId": "inst_...",
    "createdAt": "2026-08-01T...",
    "lastSeenAt": "2026-09-11T...",
    "appVersion": "0.4.2",
    "osName": "windows",
    "osVersion": "11",
    "locale": "ko-KR",
    "consentVersion": "2026-08-02",
    "revokedAt": null,
    "deletionRequestedAt": null
  },
  "items": [
    {
      "jobId": "job_...",
      "status": "failed",
      "createdAt": "2026-09-11T...",
      "completedAt": null,
      "errorCode": "INFERENCE_TIMEOUT",
      "source": "capture",
      "personCount": 0,
      "selectionCount": 0,
      "hasSelection": false,
      "thumbnailUrl": null,
      "inputAvailable": true,
      "inputWidth": 1920,
      "inputHeight": 1080
    }
  ],
  "nextCursor": "eyJ..."
}
```

`items`는 사용자 화면과 같은 모양이다. 검토자가 사용자와 다른 것을 보면 "지금 사용자에게 뭐가 보이나"를 판단할 수 없기 때문이다. 두 가지만 다르게 읽는다.

- `thumbnailUrl`은 **설치 토큰이 필요한 경로**다. 관리자 토큰으로는 열리지 않는다.
- 원본 러프는 목록에 없다. `inputAvailable: true`인 Job을 아래 상세로 열면 서명 URL이 나온다. 목록에 20건치 서명 URL을 달면 한 번의 조회가 그 설치의 사진 전부를 꺼내는 열쇠가 된다.

| 상태                | 언제                                                                |
| ------------------- | ------------------------------------------------------------------- |
| `400 INVALID_INPUT` | installationId 형식이 아니거나 `limit`·`cursor`·`status`가 잘못됐다 |
| `404 NOT_FOUND`     | 없는 설치. 기록이 0건인 설치는 `items: []`로 구분된다               |

### Job 상세

### 최근 Job (설치 무관)

`GET /v1/admin/review/jobs?limit=20&cursor=&status=completed`

설치 id를 모르는 상태에서 "방금 들어온 분석"부터 본다. 정렬·커서·`status`는 설치별 목록과 같은 규칙이고(`(created_at, id)` 내림차순), 항목에 `installationId`가 한 칸 더 붙어 거기서 그 설치의 전체 기록으로 넘어갈 수 있다.

**서명 URL은 없다.** 목록 한 번이 사진 여러 장을 한꺼번에 여는 열쇠가 되지 않게 하는 방침은 설치별 목록과 같다. 원본은 상세에서 한 건씩 연다. 열람은 `review_recent_jobs`로 기록된다.

`GET /v1/admin/review/jobs/{jobId}`는 한 건을 끝까지 보여 준다 — 5분짜리 원본 서명 URL, 인물·스켈레톤, 후보, 확정 선택, refine 산출물, 사용자 피드백, 추론 메타.

```json
{
  "jobId": "job_...",
  "status": "completed",
  "createdAt": "2026-09-04T...",
  "inputUrl": "https://...",
  "inputUrlExpiresInSeconds": 300,
  "image": { "width": 900, "height": 1200 },
  "cutSummary": {
    "route": "core",
    "countConfidence": "high",
    "detectorCount": 2,
    "vlmCount": 2,
    "vlmTags": { "shot": "full_half", "action": "standing" }
  },
  "inferenceMetadata": { "solver": "v3.2.5", "poseLibraryVersion": "v2.5" },
  "people": [
    {
      "personIndex": 0,
      "confidence": "high",
      "candidateCount": 3,
      "box": [120, 80, 360, 720],
      "tags": { "action": "standing", "view": "front" },
      "skeleton": {
        "schemaVersion": "coco17-v1",
        "keypoints": [[450, 180]],
        "scores": [0.91]
      },
      "jointScores": { "values": [0.91], "source": "effective" },
      "skeletonState": "valid",
      "skeletonSource": "full_image",
      "coverageClass": "full",
      "fallbackMode": "none",
      "slotOrigin": "vlm",
      "lowerBodyObserved": true,
      "refineAllowed": true,
      "refinableLimbs": ["left_arm"],
      "personTags": {
        "action": "reaching",
        "view": "three_quarter",
        "source": "vlm_person"
      },
      "searchSignals": {
        "rankDistance": 0.182,
        "distanceMetric": "pos",
        "searchStability": "stable",
        "confidenceThreshold": 0.45
      },
      "outputScope": {
        "selection": "auto",
        "detected": "full",
        "detectionSource": "vlm_person",
        "resolved": "full",
        "resolutionSource": "auto"
      }
    }
  ],
  "candidates": [
    {
      "person_index": 0,
      "candidate_id": "...",
      "pose_id": "...",
      "rank": 1,
      "view": "front",
      "distance": 0.13,
      "rerank_score": 0.89,
      "match_level": "exact"
    }
  ],
  "selections": [{ "person_index": 0, "candidate_id": "...", "rank": 2 }],
  "refined": [
    {
      "personIndex": 0,
      "candidateId": "...",
      "poseId": "...",
      "refined": true,
      "reason": "P3a 관통 복구",
      "limbs": ["left_forearm"],
      "bvhUrl": "https://...",
      "thumbnailUrl": "https://..."
    }
  ],
  "feedback": "손 위치가 어색해요"
}
```

`people`은 `analysis_people`을 파싱해 내보낸다(2026-10-06부터 camelCase다. 그 전에는 row를 그대로 실어 `skeleton_json`이 문자열이었다). 화면이 쓰지 않는 서버측 전용 컬럼 `refine_context_json`·`raw_scores_json`은 응답에 넣지 않는다 — 전자에는 같은 관절 좌표가 또 들어 있다.

- `skeleton.keypoints`는 **원본 러프의 픽셀 좌표**다. 겹쳐 그리려면 `image`(= `jobs.input_width/height`)가 필요하다. 옛 Job은 두 컬럼이 비어 있어 `image`가 `null`이다.
- `skeleton.scores`를 그대로 쓰면 안 된다. 추론이 refine을 막은 인물은 그 배열을 0으로 덮어쓴다(Standin-server `pipeline.py::_apply_refine_policy`). `jointScores`가 그 경우 마스킹 전 `raw_scores`로 갈아 끼우고 `source`로 어느 쪽인지 알려 준다(`effective` | `raw` | `none`).
- `tags`는 **컷 단위** VLM 태그다(shot·action·view·relationship). 같은 컷의 모든 인물이 같은 값을 받는다.
- `personTags`는 **인물별** 태그다(P2). `null`이면 그 Job은 인물별로 물어본 적이 없다(프롬프트 `p1-scope` 또는 구 추론). `source`가 `unknown`이면 물었는데 VLM이 모른다고 답한 것이다 — 이 둘은 다른 상태라 화면도 다르게 적는다.
- `cutSummary.vlmTags`는 VLM이 **실제로 말한** 컷 태그라 `tags`와 다를 수 있다. `tags`는 추론이 `other`·`front`로 좁힌 뒤의 값이다.
- `outputScope`는 `jobs.result_json`을 먼저 쓰고(사용자가 고른 구도가 거기 있다), 없을 때만 `analysis_people.output_scope_json`으로 메운다. 어느 쪽이든 저장된 파생 필드를 믿지 않고 다시 계산한다.

`GET /v1/admin/product`의 응답에는 `accuracy`와 `usage`가 함께 온다.

- `accuracy`: `selectionRate`(완료 Job 중 고른 비율), `top1Rate`(고른 것 중 1순위), `meanReciprocalRank`, `exportRate`, 사유별 `feedback[]`와 `feedbackRate`, 날짜별 `trend`
- `usage`: `jobsStarted/Completed/Failed`, `failureRate`, `jobsPerDay`, `jobsPerActiveInstallation`, 날짜별 `trend`
- 둘 다 원본이 `daily_analytics_aggregates`라 **오늘은 들어 있지 않다**(하루가 끝나야 집계한다). `days`가 0이면 아직 마감된 날이 없다는 뜻이고, 비율이 `null`이면 분모가 0이라 "아직 모른다"는 뜻이다 — 0%와 구분한다.
- `meanReciprocalRank`는 날짜별 평균을 다시 평균 내지 않는다. 그날의 선택 수로 가중해 합산한다.

`refined`는 `refined_artifacts`를 그대로 싣되 `object_key`·`thumbnail_key`를 서명해 URL로 바꾼 것이다. **`refined: false`인 행도 뺴지 않는다** — 왜 조정하지 않았는지(`reason`)가 조정 결과만큼 중요하다. 그 경우 두 URL은 `null`이다.

### 관리자용 후보 썸네일

`GET /v1/admin/review/pose-candidates/{poseId}/thumbnail?view=front`

사용자 경로(`/v1/pose-candidates/...`)는 설치 토큰을 요구해 검토자가 열 수 없다. 프록시 본체는 같고 인증만 관리자 토큰이다. 포즈 라이브러리는 사용자 데이터가 아니라 공용 자산이라 서명 URL을 만들지 않는다.

`view`가 없으면 `400 INVALID_INPUT`. `ETag`와 `If-None-Match`를 그대로 통과시킨다.

⚠ `<img src>`로는 부를 수 없다. 관리자 토큰이 헤더로 가야 하므로 `fetch` → `blob` → `URL.createObjectURL`로 실어야 한다(대시보드가 그렇게 한다).

### 라이브러리 공백 관측 export

`GET /v1/admin/gaps/observations?days=90&cursor=…`

러프 데이터 선순환에서 쓰는 비식별 관측이다. 맞는 포즈가 없던 인물을 모아 라이브러리에 더할 포즈를 정한다. 받는 쪽은 Standin-server `python -m pose_gaps pull`이고, 항목 형식(schema 1)은 그 저장소의 `docs/POSE_GAP_LOOP.md`가 정본이다.

- 관리자 토큰에 더해 **`GAP_EXPORT_REVIEWERS`에 든 검토자만** 받는다. 아니면 `403 FORBIDDEN`이다. 한 번에 모든 사용자의 관측을 가져가는 경로라서 한 건씩 여는 검토 화면보다 좁게 연다.
- `GAP_EXPORT_HMAC_KEY`가 비어 있으면 `503 GAP_EXPORT_DISABLED`이다. 두 값은 인프라 시크릿 `standin/<env>/gap-export`에서 온다.
- `days`는 1~365, 기본 90이다. 첫 페이지가 범위를 그 시각에 고정하고, 다음 페이지는 `nextCursor`로만 받는다.
- 커서는 암호화돼 있고 한 시간 지나면 `400 INVALID_CURSOR`가 된다.
- 감사 기록: 페이지마다 `admin_access_audit`에 `gap_export_start` 또는 `gap_export_page`가 남는다. 첫 페이지에서는 운영 채널에 알린다.

```json
{ "schemaVersion": 1, "exportId": "…", "window": { "days": 90 }, "generatedAt": "…",
  "retention": { "localTtlDays": 14, "maxSnapshotAgeDays": 7 },
  "items": [ { "obs": "o_…", "inst": "i_…", "observed_on": "2026-10-05", "expires_on": "2027-10-05",
               "versions": { … }, "cut": { … }, "person": { … }, "candidates": [ … ], "behavior": { … } } ],
  "nextCursor": "v1.…" }
```

**항목에 넣지 않는 것**: 작업·설치 ID, 입력 해시, S3 key, bbox, 이미지 크기.

- 날짜는 일 단위, 관절은 0.1px로 반올림한다.
- `obs`·`inst`는 export마다 새 salt로 만든 HMAC이다. 같은 export 안에서만 같은 값이고 export끼리는 이을 수 없다.
- 응답 직전에 원본 ID 모양 값을 검사한다. 하나라도 걸리면 그 페이지는 `500 GAP_EXPORT_PRIVACY`로 막고 알린다.

**대상 행**

- 뷰 `gap_observations_v1`에서 읽는다. 완료된 작업 중 철회·삭제 요청이 없는 설치의 행만 담고, 쿼터 면제 설치(개발 단말)는 뺀다.
- 원본 테이블 위의 뷰라서 작업 삭제·동의 철회·365일 정리 때 함께 사라진다.
- 관절이 없는 인물은 담지 않는다.

### 라이브러리 공백과 VLM 프롬프트 지표

`GET /v1/admin/product?days=7`(1~90) 응답에 두 섹션이 있다. 대시보드 제품 지표 ⑥·⑦이다.

- `library.weeks[]`: 주(월요일 시작, UTC) × 라이브러리 버전 × coverage별 집계.
  - 인원: `people`, `eligible`
  - 공백 구간: `weakGap`, `strongGap`, `extractionSuspect`
  - 비율(%): `gapRate`, `strongGapRate`, `selectionRate`, `irrelevantRate`
  - `top1Median`
- 비율의 분모는 `eligible`이다.
  - 적격 조건: VLM 인물 슬롯, 전체 이미지 추출, valid/partial, full/reduced, 전신 검색, 얽힘 아님, 관절 오류 피드백 없음.
  - 이 조건은 Standin-server `pose_gaps/eligibility.py`의 운영 조건과 같다.
- 경계 `library.thresholds`는 `{ weak: 0.25, strong: 0.35, extractionCap: 0.6 }`(pose_gaps와 같음)이다. 0.6을 넘는 거리는 공백이 아니라 추출 실패 의심으로 따로 센다.
- `vlm.prompts[]`: 프롬프트 버전별 `routes`, `countConfidenceHighRate`, `personTagFillRate`, `personTagSources`. 버전을 저장하기 전의 분석은 `unrecorded`다.
- 개발 단말(쿼터 면제 설치)은 뺀다.
- 원본이 365일 뒤 지워져도 버전 사이 비교가 남도록 `daily_library_aggregates`에 ID 없는 일별 집계를 둔다. Top-1 거리는 0.05 구간 히스토그램으로 둔다.

`GET /v1/admin/ops` 응답의 `inferenceLibrary`(`{ version, source, contentSha256 }` 또는 `null`)는 추론 `/healthz`가 알려 준, 지금 떠 있는 포즈 라이브러리다. 대시보드에서는 추론 상태 옆에 뜬다.

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
{
  "analysisEnabled": false,
  "reason": "Gemini 비용 급증",
  "updatedAt": "2026-08-11T...",
  "propagationSeconds": 5
}
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
  "user": {
    "id": "user_...",
    "email": "a@b.com",
    "displayName": "작가",
    "provider": "local",
    "emailVerified": true
  },
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

### 관측 상체 검색 (2026-10-02)

- `coverageClass=upper_only`: 골반 기준을 쓸 수 없어, 관측된 어깨·팔만으로 검색한 후보.
  `confidence=low`, `fallbackMode=soft`, `refineAllowed=false`, `refinableLimbs=[]`.
  거리의 단위가 달라 전신 일치도 임계값으로 승격하지 않는다.
- 혼합 구도의 두상 인물은 후보 없이 `candidateShortfallReason=HEAD_SEARCH_UNSUPPORTED`.
  같은 컷의 검색 가능한 인물에는 영향이 없다.
- 출력 범위 수동 선택은 검색을 재실행하지 않는다. 관측 관절과 출력 설정은 별개다.
  부분 FBX 지원은 아래 `outputScopeCropping` 계약을 따른다.
- 구 응답의 누락 필드는 기존 폴백 처리. 실제 부분 검색은 새 분석부터 적용된다.

### 부분 FBX 출력과 검토 미리보기 (2026-10-02)

`outputScopeCropping`은 converter `/healthz`의 건강 상태, 고정 solver 버전,
`framing_version=skin-regions-v1`, full/half/bust/shoulder_head/head 지원을 확인한 경우에만 true다.
false/누락이면 기존 전신 출력과 설정 저장 안내를 유지한다.

`GET /v1/pose-candidates/:poseId/framed?jobId=…&personIndex=…&candidateId=…&outputScope=half&format=preview`
는 실제 최종 FBX를 재import해 만든 정면 PNG를 반환한다. 같은 URL에서 `format=fbx`는 그 FBX다.
optional `characterId`는 두 요청에 동일하게 적용한다. 설치 인증, 소유 Job, 확정 후보,
poseId를 매번 검사하며 outputScope는 서버 저장 resolved 값과 일치해야 한다.
다르면 `409 OUTPUT_SCOPE_CHANGED`; 변환 실패 시 전신 파일로 대체하지 않는다.
응답은 `private, no-store`, `X-Standin-Output-Scope`, FBX의 `X-Standin-Artifact-SHA256`를 포함한다.

기존 `/export` 요청과 BVH는 전신 동작을 유지한다. half는 상체+팔+손, bust는
가슴+어깨+목+머리(팔 제외), head는 머리 메시만 남기고 뼈대 계층은 전신으로 보존한다.
후보 카드의 기존 썸네일과 달리 **저장 전 확인 화면**에서 선택 범위를 렌더링한다.
이 기능은 얼굴만 있는 러프의 머리 방향 검색을 추가하지 않는다.
자세한 알고리즘·제한·검증은 `Standin-server/docs/BODY_SCOPE.md`의 3단계를 따른다.

## 후보별 표시 카메라 (candidate-camera-v1)

새 후보의 선택적 `camera`는 추론이 정한 Y-up 회전행렬과 원본 BVH SHA를 담는다.
`view`/`id`는 기존 검색 식별자다. `tags`의 view만 실제 표시 방향으로 바뀐다.
카메라가 있는 후보의 `thumbnailUrl`은 소유권을 확인하는
`/v1/pose-candidates/:id/aligned?jobId=...&personIndex=...&candidateId=...`다.
이 경로는 후보를 선택하기 전에도 같은 Job의 소유자에게만 제공한다. 선택적
`characterId`는 기존 모델 카탈로그로 검증한다. 회전값은 요청에서 받지 않는다.

BFF는 저장된 카메라를 refine과 `/convert-framed`로 전달한다. 원본이 변경되거나
격리되면 409다. Converter가 회전을 누락하면 integrity 오류이며 구 썸네일로
바꿔 성공시키지 않는다. 카메라·모델·소유자·작업이 다른 요청은 캐시가 분리된다.
캐시는 128 MiB/10분, 후보 렌더 대기는 16개, HTTP 대기는 최대 300초다. 후보 목록은 새 클라이언트에서 미리보기와 독립적으로 열린다.

FBX와 전신/반신/흉상/두상 미리보기에 같은 회전이 적용된다. BVH는 원래 방향을 유지한다.
구 작업은 camera가 없어 기존 경로를 사용하므로, 개선 적용 후에는 새로 분석해야 한다.
배포 순서: Converter → BFF → Inference. 느린 렌더로 화면 전체가 대기하지 않도록 progressive-preview 클라이언트도 함께 배포한다.

## Precomputed candidate previews

Camera candidates in GET job result additionally expose `previewModelUrl`.
GET `/v1/pose-candidates/:id/preview-model` takes the same jobId/personIndex/candidateId/
optional characterId as `/aligned`. It rechecks job ownership, current source
BVH digest, quarantine and character availability even for cached assets.
It returns a bounded static `model/gltf-binary` with no public cache URL.
Missing/stale assets return 503 immediately; this route never starts Blender.
Clients fall back to `/aligned` when unavailable or WebGL fails. Existing clients,
BVH downloads and final FBX/refined/cropped export contracts are unchanged.

## 체형 기본 설정·인물별 선택 저장 (body-selection.v1)

`BODY_SELECTION_ENABLED=true`인 새 작업에서 선택적 body 추천·선택 저장 계약을 제공한다. 기본은 off다.

- GET/PUT `/v1/installations/current/body-preferences`: 설치별 last_used/auto 모드와 체형 카드. PUT 본문은 `{ mode, expectedRevision, mutationId }`만 받는다. 과거 사용자 기본값 필드/모드의 새 쓰기는 `400 INVALID_INPUT`이다.
- GET/PUT `/v1/analysis/jobs/{jobId}/people/{personIndex}/body-selection`: inherit/manual/auto 선택 저장·조회.
- GET 같은 인물 경로의 `/body-options`: 적용 가능한 승인 체형 목록.
- GET result에 person별 bodyRecommendation/bodySelection 추가. 기존 포즈 후보는 유지한다.
- 변경에는 expectedRevision과 mutationId가 필요하다. 사용자 직접 선택이 추천보다 우선한다.
- capabilities.bodyPreviews는 false다. 이 단계는 이미지 렌더와 Export 체형 연결 완료를 의미하지 않는다.

요청/응답·오류·승인 manifest·호환 정책의 정본: [체형 선택 저장 설계](BODY_SELECTION_DESIGN.md).

### 아동형 자동 추천 제한 (2026-10-21)

현재 이미지 계약은 검증된 아동 디자인 근거를 제공하지 않는다. 따라서 아동 자산의 자동 추천은 `status=unavailable`, `body=null`, `reasonCodes`에 `child_requires_explicit_user_selection`을 기록한다. 나이 추정/비율/얼굴 스타일만으로 추천을 승격하지 않는다. 일반 성인/TOON64 추천은 유지한다.

명시적 manual 및 수동으로 고른 last_used 아동은 유지한다. 자동 아동 추천은 추천으로 쓰지 않고 공통 남성 기본형으로 시작한다. 과거 자동 아동 선택은 읽기 때 같은 정책으로 재검증한다.

### 체형 수치 조절 (body-shape.v1, 2026-10-14)

`BODY_SHAPE_EDIT_ENABLED=true`이고 승인 manifest의 asset에 `shape`가 선언된 체형만 수치 조절을 연다. 기본은 off이며, 끄면 기존 응답과 같다.

- manifest asset: `shape: { schemaVersion: "body-shape.v1", controls: [{ key, min, max, step, default, label? }], basic? }`. `label`(1–24자)은 화면 이름 — 체형마다 같은 key를 달리 부를 수 있다(예: 여성 `physique`="지방"). `basic`(1–12, 컨트롤 수 이하)은 앞에서부터 기본으로 보일 조절 수, 없으면 5(남성 5개 위3·아래2, 여성 7개 위4·아래3). key는 `^[a-z][a-z0-9_]{0,39}$`, `min < max`, `step > 0`, `default ∈ [min,max]`. 형식이 틀리면 카탈로그 전체를 닫는다.
- `GET .../body-options`: 조절 가능한 체형에만 `shape`(위 spec)를 싣는다.
- `PUT .../body-selection`: `intent: "manual"`일 때만 `shape: { controls: { key: number } }`를 받는다. 빠진 key는 default, 모르는 key·범위 밖·step에 맞지 않는 값은 `400 INVALID_SHAPE`, 조절을 선언하지 않은 체형은 `409 SHAPE_UNSUPPORTED`. 모든 값이 default면 `shape: null`로 저장한다(평범한 asset과 같은 렌더 키).
- `body-selection` 응답: `shape: { schemaVersion, controls, shapeSha256 } | null`. `shapeSha256 = sha256(["body-shape.v1", characterId, assetSha256, sorted controls])`. 체형이 더는 조절을 선언하지 않으면 `resolutionStatus: "unavailable"`.
- 설정 GET은 읽기 전용 `shapeEditable: [{ characterId, shape, displayName?, neutralPreview?, shapeRuntime? }]`를 제공한다. 작업 밖의 체형 커스텀에서도 같은 메타데이터를 사용한다. 개인 수치는 카드 API로 저장한다.
- `BODY_SHAPE_BAKE_ENABLED=false`(기본)이면 `shape`가 있는 선택은 `body-previews`와 체형 FBX export에서 `409 BODY_SHAPE_RENDER_UNSUPPORTED`로 거절한다 — 조절 전 체형을 조절한 것처럼 그리거나 저장하지 않는다.
- `BODY_SHAPE_BAKE_ENABLED=true`는 검증된 shape-bake.v2 converter와 일치하는 카탈로그를 배포한 뒤에만 켠다. on에서는 `/convert-framed`에 저장된 shape 전체와 `expected_shape_source`를 전달하고, 응답 `shape_sha256`과 `shape_bake`(rules·blend_sha256·controller_sha256)가 약속한 원본과 같은지 검증한다. 캐시 키에도 shapeSha256과 원본을 포함한다. 수치 체형 호출 상한은 `CONVERTER_SHAPE_TIMEOUT_MS`(기본 320000, converter `CONVERTER_SHAPE_TIMEOUT_SECONDS` 300보다 크게)다 — 굽기 1회 30~110초 실측.
- **체형 원본 바인딩 (2026-10-16 확정)**: manifest asset에 `shapeSource: { rules, blendSha256, controllerSha256 }`(컨트롤러 `VERSION`과 .blend·`standin_body.py` SHA-256). `shape`가 없는 asset에 선언하거나 형식이 틀리면 카탈로그를 닫는다. 수치 선택은 읽을 때마다 현재 카탈로그에서 `shapeSource`를 붙여 돌려주고(저장하지 않음), 원본이 없으면 굽기가 켜져 있어도 `409 BODY_SHAPE_RENDER_UNSUPPORTED`다. converter가 다른 원본이면 `409 SHAPE_SOURCE_MISMATCH` → BFF `CONVERTER_REJECTED`.
- 수치 변경 Top-K GLB는 정적 라이브러리 자산을 재사용하지 않고 PNG로 폴백한다. 최종 검토 GLB는 실제 최종 FBX에서 만들어진다.
- 실시간 체형 미리보기(`standin-shape-runtime.v1`, 2026-10-15 / `v2`, 2026-10-16): manifest asset에 `shapeRuntime: { path, sha256, bytes, format: "standin-shape-runtime.v1" | "standin-shape-runtime.v2", rules, preset }`. v2(표본 자산, 머리 `SSR2`)는 버전에 매이지 않고 머리말에 원본 해시를 담는다 — v2를 선언한 asset은 `shapeSource.rules`가 같아야 하고(아니면 카탈로그를 닫음), 서빙할 때 머리말의 원본이 `shapeSource`와 다르면 404다. `shape`가 없는 asset에 선언하면 카탈로그 전체를 닫는다. `rules`는 `^[a-z0-9][a-z0-9.-]{0,63}$`, `preset`은 `^[A-Z][A-Z0-9_]{0,31}$`, `bytes` ≤ 32 MiB.
  - `GET .../body-options`: 수치 조절이 열린 체형에만 `shapeRuntime: { url, sha256, bytes, format, rules, preset, source? }`(로컬 경로 없음). `source`는 asset의 `shapeSource`이며, 앱은 자산 머리말의 원본과 다르면 실시간 3D를 끄고 고정 그림을 쓴다. 같은 규칙의 프리셋은 같은 자산을 가리키고 `preset`만 다르다.
  - `GET /v1/models/:characterId/shape-runtime/:sha256`: 승인된 바이트를 그대로 준다(`application/octet-stream`, `Cache-Control: private, max-age=86400, immutable`). 크기·`SSR1` 머리·sha256이 manifest와 다르거나 체형 편집이 꺼져 있으면 404.
  - 클라이언트가 sha256·형식·규칙을 다시 검사하고 앱 안에서 계산해 "내 체형" 박스에만 그린다. 서버의 미리보기·FBX(converter)와는 별개다 — 이 자산이 있다고 수치 체형 렌더가 열리지는 않는다(`BODY_SHAPE_BAKE_ENABLED=false`일 때 409 가드 유지).

### 체형 카드 · 마지막 사용 체형 (2026-10-16)

체형 커스텀에서 만든 체형을 이름 붙인 카드("주인공 A")로 저장하고, 새 작업은 마지막으로 직접 고른 체형으로 시작한다. 카드는 설치(installation) 단위로 body-preferences 안에 저장된다.

- `GET .../body-preferences`는 `cards: [{ cardId, name, characterId, controls, createdAt, updatedAt }]`와 `lastUsed: { characterId, controls | null, usedAt } | null`을 반환한다. 과거 수치는 카드로 마이그레이션한다(아래).
- `POST .../body-preferences/cards` `{ name, characterId, controls, expectedRevision, mutationId }` — 카드 추가. `PUT .../cards/{cardId}` `{ name?, characterId?, controls?, expectedRevision, mutationId }` — 이름 변경·수치 변경(하나 이상). `DELETE .../cards/{cardId}` `{ expectedRevision, mutationId }`. 셋 다 응답은 GET과 같은 설정 전체이고 `revision`이 1 오른다(설정 PUT과 같은 revision·mutationId 규칙, 충돌은 `409 BODY_PREFERENCE_CONFLICT`).
  - 이름은 앞뒤 공백을 지운 1–24자(`400 INVALID_CARD_NAME`). 카드는 수치 조절이 열린 체형만(`409 SHAPE_UNSUPPORTED`), controls는 카탈로그의 수치 규칙으로 정규화한다(`400 INVALID_SHAPE`). 최대 48장(`409 CARD_LIMIT`), 없는 카드는 `404 CARD_NOT_FOUND`. 카탈로그 프리셋은 카드가 아니다 — 이름을 바꾸거나 지울 수 없다.
  - 카드의 성별은 따로 저장하지 않는다. `characterId`(기준 체형)의 종류를 따른다.
- 지원 모드는 `last_used`(새 설치 기본)와 `auto`다. `last_used`는 마지막 수동 선택의 체형·수치가 유효하면 그대로 쓰고, 최초 사용·삭제된 체형·무효 수치는 공통 남성 기본형으로 시작한다.
- `auto` 및 인물별 명시적 `auto`는 정상 추천을 사용한다. 추천 없음·실패·disabled·not_applicable·지원 불가이면 같은 남성 기본형을 사용한다. 유효하지만 그림과 다른 추천을 실패로 임의 판단하지 않는다.
- `manual`은 언제나 직접 고른 체형·수치를 유지한다. 자산 소실·해시 변경·변환 실패를 다른 체형으로 숨기지 않는다.
- 남성 기본형은 승인 카탈로그의 현행 `male-base-*` 자산이다. 작업 시작에 자산·버전·해시·리그를 고정한다. 구 snapshot에 이 정보가 없을 때만 현재 카탈로그에서 찾는다. 자산이 없거나 출력 조건을 만족하지 못하면 unavailable로 저장을 막는다. 후보가 없으면 not_applicable이다.

과거 저장 경계에서만 legacy를 읽는다. `fixed_default`는 `last_used`로 정규화하고 기존 `auto`/`last_used`, 카드, 마지막 선택을 보존한다. `shapeDefault`의 체형·수치는 `my-default` 개인 카드로 합치고, 현재 응답/다음 설정 쓰기에는 `defaultCharacterId`·`shapeDefault`를 넣지 않는다. 카드 삭제 후 다시 생기지 않는다. `catalog.defaultCharacterId`와 일반 모델 카탈로그 계약은 유지한다.

과거 작업의 `fixed_default`/`user_default_fallback`, 자동 기본형, 미확정 자동 선택은 작업 snapshot을 기준으로 읽기 때 다시 결정한다. 유효한 수동/마지막 선택과 정상 추천은 유지한다. GET은 DB·revision을 바꾸지 않고 다음 명시적 변경은 현재 계약으로 저장한다. 이전 mutation 응답도 반환 경계에서 정규화한다.

`manual` 선택 성공 시 `lastUsed`를 적되 설정 revision은 올리지 않는다. 기본형 선택은 lastUsed를 덮어쓰지 않는다.
  - ⚠ `lastUsed`에 수치가 있으면 그 인물의 선택에도 `shape`가 붙으므로 위 `BODY_SHAPE_RENDER_UNSUPPORTED` 가드가 똑같이 적용된다.

구형 고정 성인 6종과 `body-teen-male`, `body-teen-female`은 모델·체형 옵션 목록과 직접 선택에서 제외한다. `body-child` 아동 체형은 유지한다. 기존 청소년 선택/마지막 사용 체형은 현재 카탈로그로 재검증하며, 지원 종료 모델을 다시 렌더하거나 자동으로 다른 체형으로 덮어쓰지 않는다.

## 체형 Top-K 미리보기 자산 (2026-10-08, 1~2단계)

[체형 미리보기 계약](BODY_PREVIEW_DESIGN.md)을 따른다. 기존 설치 인증을 사용한다.

- GET `/v1/analysis/jobs/:jobId/people/:personIndex/body-previews`: 저장된 체형/selectionRevision과 원래 후보·camera에 연결된 manifest.
- GET 같은 prefix `/:renderKey/:candidateId/glb` 또는 `/png`: 기대 체형 hash·렌더 revision 검증, 완료 직전 최신 선택 재검사. URL query는 허용하지 않는다.
- `/result`의 person에 `bodyPreviewManifestUrl` 추가. `capabilities.bodyPreviewAssets`는 API 지원이고 `bodyPreviews=false`는 앱/Export 전체 미연결 상태를 유지한다.
- `renderable`/`renderingExecuted=false`는 목록만 결정됐다는 뜻이다. 개별 바이트 요청 성공 전 렌더 성공으로 표시하면 안 된다.
- GLB miss는 같은 manifest의 PNG로 폴백 가능. stale/권한/체형 변경 오류를 기본 남성 이미지로 대체하지 않는다.

## 체형 선택 UI 계약

[최종 확인·Export 및 차렷 카드 계약](BODY_SELECTION_UI_CONTRACT.md)을 추가한다. 기존 경로와 호환되는 opt-in 확장이다.


## pose_presentation v1 (2026-10-18)

추론 PR #99(develop 831efd38)의 `people[].pose_presentation`이 non-null이면 표시 기준은 이 계약이다.
BFF는 인물별 `posePresentation`으로 전달하며 library/review/generated 그룹, 순위, 개별 검색·생성 상태, 카메라, scope, 정책을 보존한다.
null/미포함만 기존 dynamic_search 경로를 유지한다. 알 수 없는 버전·계약 오류는 오류 표시로 남기며 다른 후보로 대체하지 않는다.

BVH 본문과 내부 경로는 공개 결과 JSON에 포함하지 않는다. 기존 analysis_people.refine_context_json의
비공개 posePresentationAssets에 보관하므로 기존 작업 소유권·보관·삭제 정책을 따른다.
앱은 BFF의 `GET /v1/analysis/jobs/:jobId/people/:index/pose-previews/:candidateId/:sha256`만 사용한다.
라이브러리는 고정 추론 getPoseBvh를 통해 읽고 SHA를 확인한다. 생성은 UTF-8 본문 바이트의 SHA를 검증하며 라이브러리 조회하지 않는다.
소유권·후보·인물·해시 불일치는 404/409이고 임의 URL이나 다른 파일로 폴백하지 않는다.
이 조회는 preview 전용이며 export 권한이 아니다. 모든 신규 후보의 auto_apply/refine/export/release/actual_mesh_validated=false를 유지한다.

앱은 BVH frame 0의 관절을 Three.js로 렌더하고, hip midpoint 이동·hip-to-shoulder 길이 정규화 후
서버 rotation을 한 번 적용한다. 원근은 xy=(x,-y)/(z+distance_torso), 정사영은 xy=(x,-y)와 동등한 투영을 사용한다.
full/half/shoulder_head/head 범위를 적용하며 카메라 또는 범위가 유효하지 않으면 표시 실패를 알린다.
미리보기에서 좌우 회전과 기준 시점 복원이 가능하다. 관절 기반 뷰어이며 실제 체형 메시의 피부 안전 인증이나 보정·저장 기능은 제공하지 않는다.
기본 인체 계획은 미렌더 상태로 표시한다. 제공된 비공개 BVH/JSON은 Git에 올리지 않는다.
## 손 라이브러리 선택

`HAND_SELECTION_ENABLED=true`이며 추론·converter의 손 라이브러리가 일치하면
`capabilities.handSelection=true`를 반환한다. 기본은 false다.

- `GET /v1/hands/catalog`: 분류·프리셋·인증된 썸네일 URL·library hash.
- `GET /v1/hands/{preset}/thumbnail?side=left|right`: 인물 기준 양손 PNG.
- `GET /v1/analysis/jobs/{id}/people/{index}/hands`: 저장된 손과 원본 추천.
- `PUT /v1/analysis/jobs/{id}/people/{index}/hands`: `{left?, right?, library_sha256, expectedRevision}`.

선택은 기존 Job 결과 JSON에 영속화하며 인물별 revision으로 경합을 막는다.
손이 선택된 최종 `/framed` 요청은 `handSelectionRevision`을 요구하고,
FBX 저장에는 미리보기의 `reviewKey`도 필요하다. BVH에는 손 모양을 굽지 않는다.
요청·응답·오류·캐시·배포 조건은 [손 선택 연동](HAND_SELECTION_INTEGRATION.md)을 따른다.

손 썸네일 `GET /v1/hands/{preset}/thumbnail`은 선택적 `library=<SHA-256>`을 검증한다.
PNG/304 응답의 `X-Standin-Hand-Library-SHA256`으로 카탈로그 일치를 확인할 수 있다.
미준비는 404 `HAND_THUMBNAIL_UNAVAILABLE`, 라이브러리 변경은 409 `HAND_LIBRARY_CHANGED`다.
## 직접 자연어 포즈 검색

`GET /v1/semantic-search/capabilities`, `POST /v1/semantic-search`는 설치 인증을 사용한다. `query`와 `topK`(양의 안전 정수 또는 명시적인 `null`, 생략 시 5)로 검색하고 정식 또는 근접 후보가 있으면 `jobId`를 반환한다. 자동 refine·release는 금지하며 원본 해시에 바인딩된 후보의 수동 저장은 위 계약을 따른다. 이미지 없는 `source=semantic` 결과의 `image`는 null이다. 자연어 작업은 이미지 기반 refine/search-fit camera를 허용하지 않으며 정면 참고 카메라의 체형 검수는 지원한다. `topK:null`은 검색 기준을 통과한 전체 결과를 전달하며 BFF에서 5/20개로 자르지 않는다. capabilities의 `supportsAllResults:true`로 이를 알리고, 기존 앱용 `maxTopK:20` 힌트는 유지한다. 서버 페이지네이션은 없으며 UI에서 저장 썸네일을 지연 로딩하고 그룹별 20개씩 추가 표시한다. 입력 제한, 별도 검색 rate limit, 오류, 기록·해시 계약은 [SEMANTIC_SEARCH_INTEGRATION.md](SEMANTIC_SEARCH_INTEGRATION.md)를 따른다.

두 기능의 공통 흐름·통합 검증·PR 제출 범위는 [HANDS_SEMANTIC_INTEGRATION.md](HANDS_SEMANTIC_INTEGRATION.md)를 따른다. 자연어 결과도 준비된 handSelection capability를 유지해 수동 손 선택을 사용할 수 있다.

손 조회 전용 PNG 및 문장 표시 계약의 최신 기준은 [통합 계약](HANDS_SEMANTIC_INTEGRATION.md)을 따른다. 문장 API는 추론 PR #96의 candidates/near_candidates를 별도 그룹으로 보존하며 source/tags/mirror_alternates를 전송하거나 가정하지 않는다.

### 자연어 검색 기본 남성 모델 미리보기

`GET /v1/analysis/jobs/:job/people/:index/pose-previews/:candidate/:sha/model`

완료된 semantic 작업 소유자만 조회할 수 있다. semantic-pose-presentation-v1의 full 라이브러리 검색/근접 후보만 지원하며 query(체형·format 포함)는 거절한다.
기본 남성 `standin-master-v2`를 고정 사용한다. 사전 계산된 정확한 BVH/캐릭터/revision의 표면이 없으면 동일 BVH로 기본 남성 모델을 렌더한다.
소유권·원본 BVH SHA·캐릭터 SHA·모델 revision을 확인하고, 작업 또는 모델 변경 시 응답을 폐기한다.
응답은 `model/gltf-binary` GLB만 반환하며 FBX는 반환하지 않는다. `X-Standin-Preview-Only: true`,
`X-Standin-Character-Id`, `X-Standin-Model-Version`, `X-Standin-Source-BVH-SHA256`,
`X-Standin-Character-SHA256`, `X-Standin-Model-Revision`, `X-Standin-Artifact-SHA256`을 제공한다.
20회/분/설치 한도이며 counter는 설치 데이터 삭제 시 함께 정리한다. 404(작업/후보/범위), 409(변경), 429(한도), 503(렌더/모델 실패)를 구분한다.
신규 후보 refine/release/export 금지와 actual_mesh_validated=false를 유지한다. 체형 선택은 제공하지 않으며 손 선택의 별도 PNG 참고 렌더는 기존 경로를 유지한다.

## 조회 전용 포즈의 체형 참고 PNG (2026-10-18)

`capabilities.presentationBodyPreviews`는 `posePresentation`의 조회 전용 후보에 저장된 인물별
체형/수치를 적용하는 기능이다. 기존 `bodyPreviews`와 별개이며 저장·보정 권한을 부여하지 않는다.
새 문장 검색 작업도 체형 설정을 시작 시점에 고정한다. 이전 이미지 작업의 `not_applicable`
선택은 원래 작업의 설정 snapshot으로 조회 시 복원하며 GET은 저장 상태를 바꾸지 않는다.
이전 문장 검색 작업은 아래 semantic 체형 선택 계약에 따라 소유권 잠금 아래 누락된 snapshot/선택만 초기화한다.

`GET /v1/analysis/jobs/:job/people/:index/pose-previews/:candidate/:bvhSha/body/:selectionRevision`

설치 인증·작업 소유권·인물·후보·비공개 BVH와 SHA를 검증하고 `body-selection`의 현재 체형,
수치 및 승인된 shape source로 기존 converter를 호출한다. 임의 쿼리 덮어쓰기는 허용하지 않는다.
`previewOnly=true`인 체형 선택은 카탈로그 자산 일치만 허용하며 기존 내보내기용 포즈 커버리지
검증을 대체하지 않는다. 생성 후보는 비공개 inline BVH를 사용하고 라이브러리로 조회하지 않는다.

PNG는 범위(full/half/bust/shoulder_head/head)와 저장된 카메라 회전을 적용한 **정사영 참고 이미지**이다.
원근 검색 투영과 동일하다고 주장하지 않으며 관절용 BVH 전송은 기존 계약을 유지한다.
성공해도 모든 후보의 `actual_mesh_validated`, `release_allowed`, `export_allowed`, `refine_allowed`는
false다. 정식 후보 배열에 합치지 않는다.

응답은 `private, no-store`이며 `X-Standin-Body-Revision`, `Character-SHA256`, `Shape-SHA256`
(고정 체형은 `none`), `Source-BVH-SHA256`, `Artifact-SHA256`, `Preview-Projection=orthographic`,
`Preview-Only=true` 헤더를 보낸다(각 이름에 `X-Standin-` 접두사).
`X-Standin-Output-Scope`도 최종 메시 범위를 담는다. 허용된 Tauri·개발 출처에서는
이 무결성·범위 헤더가 `Access-Control-Expose-Headers`에 포함되어 웹뷰가 읽을 수 있어야 한다.
특히 `Shape-SHA256`은 일반 체형 경로의 `Body-Shape-SHA256`과 별도 이름이다.
캐시는 소유자/작업/인물/후보/체형/수치/원본/범위/카메라/런타임에 묶이고 렌더 후 다시 검증한다.
선택이 바뀌면 409 `BODY_PREVIEW_STALE`, 미지원·원본 불일치면 409, 타 소유자면 404,
변환기 비활성/실패면 503이다. 클라이언트는 구 체형이나 기본 체형으로 조용히 폴백하지 않는다.

### 자연어 검색의 조회 전용 체형 선택

`semanticBodySelection=true`일 때 자연어 결과도 기존 인물별 `body-options`, `body-selection` GET/PUT과 체형 카드·수치 조절을 사용한다.
`bodySelection.previewOnly=true`이며, 검색 후보를 기존 내보내기용 포즈 허용 목록에 추가하지 않는다. 선택 가능한 체형은 승인된 체형 카탈로그의 정확한 asset/rig/measurement identity와 converter 가용 상태를 확인한다. 기존 이미지 결과의 포즈 허용 목록 검사는 그대로다.
새 semantic Job은 body policy를 캡처하고 선택을 초기화한다. 이전 semantic 기록은 소유권 행 잠금 아래 누락 상태만 초기화하며 수동 선택을 덮어쓰지 않는다. 체형 추천/이미지 기반 카메라/refine은 제공하지 않는다.

`GET {preview_bvh_url}/model?bodyRevision=N`은 저장된 체형 revision만 받는다. characterId/shape/format을 query로 주입할 수 없다.
응답의 `X-Standin-Body-Revision`, `X-Standin-Body-Shape-SHA256`(`none` 또는 SHA-256), Character-Id/SHA, Model-Revision, 원본 BVH SHA 및 GLB digest를 검증한다.
수치 조절 체형은 승인된 authoring source로 정확히 bake하며 미조절 모델로 대체하지 않는다. 변환 전후 선택 revision·body identity·shape/source·runtime 변경은 409로 응답을 폐기한다.
query 없는 기존 dev.172는 기본 남성 미리보기를 유지한다. 신규 후보의 자동 적용·refine·export·release와 actual_mesh_validated 금지는 그대로다.


### 수동 라이브러리 후보와 체형 결과의 통합 (2026-10-18)

직접 선택 가능한 라이브러리 후보는 소유 작업의 presentation 라이브러리 행과 ID/pose/SHA가 모두
일치해야 체형 Top-5와 저장 전 확인을 사용할 수 있다. 검색용 candidate-camera를 임의로 만들지
않고 저장된 presentation 카메라의 회전만 정사영 체형 렌더에 적용한다. 체형·편집 수치·승인된
shape source를 기존 변환기에 전달하며 PNG/GLB 확인과 FBX 다운로드는 같은 변환 결과와
reviewKey를 사용한다. 렌더 중 원본·카메라·체형·수치/source 변경은 409로 폐기한다.

새 수동 후보의 이 예외는 원본 해시가 확인된 라이브러리와 작가의 선택·확인에 한정된다.
기존 자동 포즈 커버리지 검사와 actual_mesh_validated=false, auto/refine 금지는 유지한다.
2026-10-19부터 hash-bound 참고/semantic은 별도 manualExportAllowed 계약으로 작가 검수 후 저장한다.
2026-10-20부터 유효한 inline 생성 후보도 별도 manualExportAllowed 계약으로 수동 선택·최종 확인·개별 FBX 저장을 지원한다. 후보가 없는 참고 인물은 저장 가능한 다른 인물의 체형 기능을
비활성화하지 않으며, 별도의 조회 전용 체형 미리보기를 유지한다.


## 체형 Top-K 출력 범위 연결 (2026-10-18)

body-previews.v1의 outputScope는 기존 full 전용에서 full/half/bust/shoulder_head/head로 확장한다.
저장된 인물 범위를 resolveOutputScope로 재계산하고, 해당 값이 없을 때만 유효한 presentation 범위를 사용한다.
동일 범위가 manifest/renderKey/PNG/GLB에 결합되며 변경 중인 이전 요청은 BODY_PREVIEW_STALE이다.
full GLB는 posed-mesh-v1, 부분 GLB는 scope·camera rotation이 적용된 framed-mesh-v1이다.
부분 GLB의 modelRevision은 framed exporter revision이다. 앱에서 rotation을 중복 적용하지 않는다.
수치 조절 체형 또는 부분 모델 capability가 없는 경우 GLB의 PREVIEW_NOT_READY(503) 뒤 같은 manifest의 PNG로 폴백한다.
권한·무결성·stale 오류에는 PNG 폴백하지 않는다. 원본 BVH·후보 순위·Export 정책은 바꾸지 않는다.
구 앱은 full만 허용하므로 새 BFF와 앱의 릴리스를 함께 조율해야 한다.

#### #91 추가분 통합
#92의 framed exporter revision과 PNG fallback 계약을 유지한다. 최종 범위 resolver를 카드·선택 체형·손·최종 확인에 공통 적용한다. source는 vlm_person/vlm_description/legacy_shot/observed_legs/unknown을 보존하고 meshScope를 결과에 저장한다. 자동 범위는 meshScope를 사용하며 수동 범위가 우선이다. shoulder_head와 수동 bust는 구분한다. 검색 순위/원본 BVH/검수 권한은 변경하지 않는다.

body manifest의 선택적 hands는 revision/library_sha256을 포함하며 renderKey와 PNG 손 identity에 결합한다. 손 선택이 있으면 GLB는 PREVIEW_NOT_READY이고 같은 manifest의 검증된 PNG를 사용한다. PNG/GLB 및 presentation body·손 PNG는 X-Standin-Output-Scope를 반환한다. 변경 중 늦은 범위·손·카메라 응답은 폐기한다.

### Actual default-human reference assets

`GET /v1/pose-candidates/default-body-template/:scope` requires installation context and reads one approved static template from inference. It verifies compressed asset hash, character, preview-only, method and scope. HTTP returns native gzip JSON; `X-Standin-Artifact-SHA256` and `X-Standin-Template-JSON-SHA256` describe decoded JSON, while `X-Standin-Template-SHA256` identifies the stored gzip. The matching client checks decoded bytes and the pinned default body before rendering. All five scopes are supported; no Converter runs.

`GET /v1/pose-candidates/:id/poster-source?jobId=...&personIndex=...&candidateId=...&scope=...` is an owned, completed-job reference source endpoint. It checks candidate/pose identity, current manual-priority scope, explicit lookup denial, registered/quarantine-safe source bytes and expected hash, then rechecks the immutable candidate snapshot/scope after reading. It returns bounded BVH bytes with source SHA, scope and preview-only headers. It grants no export/refine/actual-mesh permission. Inline presentation sources continue to use their existing owned hash-bound BVH reference route.

Poster responses may identify `X-Standin-Preview-Method=reference-skinning-v1` and `X-Standin-Template-SHA256`. This is actual default-human geometry with approximate reference retarget, not the frozen final Converter solver. It must be labeled as approximate reference. CORS exposes method/template/source provenance for desktop webviews. Unknown methods, wrong body/digests and lookup/source/scope changes fail closed. Selected-body detail/final export paths are unchanged.

Deployment prerequisites: matching inference reader/template endpoint and full verified five-scope asset snapshot; matching client loader and approximate-reference captions. Local staging and production snapshots were prepared separately; no remote write/deployment was performed by this change. See `Standin-server/docs/HUMAN_REFERENCE_POSTERS.md` and client counterpart for complete workflow and validation limits.

### 최종 메시 범위별 손 단계 제외

`resolvePersonOutputScope`의 최종 범위가 `full`/`half`일 때만 손 선택과 적용을 사용한다.
`head`, `shoulder_head`, 수동 `bust`는 Converter의 skin-region 규칙상 손 표면이 없다.
수동 `selection`이 자동 `meshScope`보다 우선하며 자동 `bust`→`half`는 손을 유지한다.

- 해당 인물의 GET/PUT `.../people/:index/hands`와 `.../pose-previews/:candidate/:hash/hands`
  는 소유권·완료·인물 검증 후 409 `HANDS_NOT_APPLICABLE`을 반환한다. 손 카탈로그 조회,
  선택 생성/변경, BVH 조회 및 손 변환을 실행하지 않는다.
- body manifest는 `hands: null`, renderKey는 저장된 손 선택과 독립적이다. 최종 `/framed`
  PNG/model/FBX도 손 라이브러리 확인, 손 revision 대기와 Converter 손 인자를 생략하고
  `X-Standin-Hand-*`를 반환하지 않는다. 체형·범위·원본·최종 검수 영수증은 유지한다.
- 저장된 손 선택은 보존한다. 범위를 `full`/`half`로 되돌리면 기존 revision/library 검사를
  다시 수행한다. 다른 인물의 손 처리는 유지한다. 렌더 중 범위 변경 결과는 폐기한다.
- 이는 손 적용의 불필요한 작업만 제외한다. 자동 release/refine 자격이나 수동 후보의 확정·
  최종 검수 요구는 변경하지 않는다. 추론의 검색 후 실제 피부 검사 정책은 별도 계약이다.

## 생성 참고 포즈 수동 저장 확장 (2026-10-20)

`source=generation`, `poseId=null`, 원래 candidateId와 원본 BVH 해시를 유지한다.
생성은 owned job/person/candidate의 비공개 자산으로만 조회하며 라이브러리 ID를 만들지 않는다.
`manualExportVersion=2` 마이그레이션은 기존 사용자 설정·선택을 덮어쓰지 않는다.
자동 금지 정책과 완전한 메시 인증 여부는 그대로다. 체형·손·범위의 최종 확인과 동일 FBX
파일만 개별 저장한다. 생성 포함 작업의 통합/v4는 지원하지 않는다.
[상세 계약과 검증](GENERATED_MANUAL_EXPORT.md).

## 동적 라이브러리 refine 복구 (2026-10-21)

추론의 `people[].refine_candidates`는 선택 후보별 기존 CandidateOut + candidate-camera-v2
바인딩이다. `pose_presentation.library_candidates`의 library_match와 pose_id·BVH 해시·
관절 해시·원래 검색 카메라가 같은 항목만 공개 후보의 `refineAllowed=true` 및 `camera`로
전달한다. 인물의 refineAllowed/refinableLimbs도 기존 추론 구조 정책을 따른다. 검색 confidence와
fallbackMode를 high/none으로 승격하지 않는다. preview 객체 자체의 refine_allowed는 계속 false다.

이 권한은 자동 release와 별개다. 기존 수동 선택·최종 확인·해시/격리 검사를 유지하면서
`POST /v1/analysis/jobs/:jobId/people/:personIndex/refine`을 호출할 수 있다. 원본을 재검증한 뒤
보관된 조정 BVH가 최종 미리보기와 FBX/BVH 저장에 사용된다. 조정본을 원본 해시와 다르다는
이유만으로 거절하지 않는다. 참고/생성/문장 직접 입력 및 바인딩 없는 구 결과는 보정하지 않는다.

`REFINE_FEATURE_ENABLED`의 코드 기본값과 예시는 true다. ECS 등의 명시적 false는 비상 스위치로
유지되므로 활성화 배포에서는 true로 설정해야 한다. 추론의 REFINE_ENABLED도 1이어야 한다.
배포 순서는 추론 → BFF → 클라이언트다. 과거 Job은 소급 승격하지 않으며 새로 분석해야 한다.
Converter 코드·모델·라이브러리 자산 변경은 필요 없다.
