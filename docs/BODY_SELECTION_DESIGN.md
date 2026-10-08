# 체형 기본 설정·인물별 선택 저장 v1

구현일: 2026-10-08. 기준 develop: `adf45ab`.

## 범위와 활성화

이번 구현은 개인 기본 설정, 인물별 체형 선택 저장, `/analyze.body_matching` 추천 결과 전달이다. 추론·포즈 검색·refine 계산·후보 순위는 바꾸지 않는다. Top-5 렌더·차렷 카드·클라이언트 UI·저장 체형을 Export에 적용하는 연결은 후속 단계다.

```dotenv
BODY_SELECTION_ENABLED=false
BODY_CATALOG_PATH=config/body-models.json
```

기본은 off다. 승인된 manifest를 배포하고 테스트 환경에서 true로 켜서 새 Job을 분석한다. 구 Job에는 설정 snapshot이 없으므로 인물별 API는 `409 BODY_SELECTION_UNSUPPORTED`를 반환한다. 구 Job을 새 개인 기본 설정으로 자동 재해석하지 않는다.

capabilities:

- `bodySelection`: 기본 설정 및 인물별 선택 저장 계약 사용 가능 여부.
- `bodyRecommendation`: 추천 sidecar 소비 지원 여부. 개별 추천 성공 여부는 person의 recommendation.status를 확인한다.
- `bodyPreviews`: 항상 false. 새 UX/체형 렌더/Export가 연결되었다고 표시하면 안 된다.

`resolutionStatus=ready`는 승인 manifest에서 해당 후보들을 지원하는 선택이 결정됐다는 뜻이다. 이미지 렌더나 최종 FBX 검증 완료가 아니다. `renderingExecuted=false`를 반환한다. 현재 Export는 기존 계약을 유지하므로 이 단계만으로 사용자용 체형 변경 UX를 활성화하지 않는다.

## 정책

개인 설정은 기존 인증 경계에 맞춰 installation 단위다. 계정 간 동기화나 다음 컷의 동일 인물 인식은 제공하지 않는다.

- `auto`: 유효 추천 → 개인 기본 캐릭터 → 승인 카탈로그 기본 캐릭터 순으로 선택한다.
- `fixed_default`: 개인 기본 캐릭터 우선. 없거나 사용할 수 없으면 unavailable이다.
- 새 Job 생성 트랜잭션에서 설정과 기본 자산을 snapshot으로 저장한다. 이후 설정 변경은 과거 작업에 영향을 주지 않는다.
- 인물별 `manual`: 직접 선택이 가장 우선한다.
- 인물별 `auto`: 그 인물만 fixed_default를 건너뛰고 추천을 사용한다.
- 인물별 `inherit`: 작업 시작 시의 기본 정책을 따른다.
- 추천이 없을 때 명시적 auto 요청은 거절하고 기존 선택을 유지한다.
- 선택한 자산이 manifest에서 제거되거나 hash/버전이 달라지면 기존 참조를 유지한 채 unavailable로 표시한다. 임의 대체하지 않는다.
- 후보가 없는 인물은 not_applicable이다.

## HTTP 계약

모든 경로는 기존 `X-Installation-Id` + `X-Device-Token` 인증을 사용한다. 설치 설정 경로도 requireInstallation을 명시적으로 적용한다. body flag off면 해당 API만 503이며 기존 분석 경로를 막지 않는다.

| 경로 | 동작 |
|---|---|
| GET `/v1/installations/current/body-preferences` | 설정 조회. 없으면 auto/null/revision=0 |
| PUT 같은 경로 | 설정 저장 |
| GET `/v1/analysis/jobs/{jobId}/people/{personIndex}/body-selection` | 저장된 인물 선택 복원 |
| PUT 같은 경로 | 직접 선택/자동 추천/작업 기본 정책 적용 |
| GET `/v1/analysis/jobs/{jobId}/people/{personIndex}/body-options` | 승인 매핑 중 해당 인물의 모든 후보를 지원하고 converter가 제공할 수 있는 모델 목록 |
| GET `.../result` 확장 | `candidatesByPerson[].bodyRecommendation`과 `bodySelection` 전달 |
| GET `/v1/models` 확장 | flag on에서 `characters[].bodyRef` 추가. 매핑 없는 모델은 null |

### 기본 설정 변경

```json
{
  "mode": "fixed_default",
  "defaultCharacterId": "registered-character-id",
  "expectedRevision": 0,
  "mutationId": "settings-change-001"
}
```

mode는 auto/fixed_default만 허용한다. auto의 defaultCharacterId는 null 또는 사용 가능한 ID다. fixed_default에는 사용 가능한 ID가 필수다. 기본 ID 저장만으로 고정 모드를 추정하지 않는다.

응답은 `version=body-preferences.v1`, `scope=installation`, mode, defaultCharacterId, revision이다.

### 인물별 변경

```json
{
  "intent": "manual",
  "characterId": "registered-character-id",
  "expectedRevision": 0,
  "mutationId": "person-change-001"
}
```

intent=auto/inherit에서는 characterId를 생략한다. 서버 소유 resolvedBody/hash/추천값은 요청으로 받지 않는다. 알 수 없는 필드는 400이다.

응답 BodySelection:

- schemaVersion, personIndex, intent, manualCharacterId
- recommendation: status, body, reasonCodes, 가능하면 input/catalog hash 및 selectionSource
- resolvedBody: bodyId/bodyVersion/assetSha256/rigVersion/measurementVersion/characterId 또는 null
- resolvedSource: manual/fixed_default/auto_recommendation/user_default_fallback/catalog_default_fallback 또는 null
- resolutionStatus: ready/needs_selection/unavailable/not_applicable
- selectionRevision, renderingExecuted=false

GET result와 인물별 GET은 같은 저장 대장을 사용한다. JSON 원본에 최신 선택을 중복 기록하지 않는다. 기본 설정 변경이나 GET으로 선택 revision을 증가시키지 않는다.

### 동시 변경·재시도

expectedRevision은 0 이상의 안전한 정수다. mutationId는 영숫자·하이픈·밑줄 8~128자다. 클라이언트 생성 UUID를 사용할 수 있다.

- Job 행 잠금 후 revision을 검사한다. 동시에 같은 버전으로 변경하면 하나만 성공한다.
- 같은 owner/resource/mutationId와 같은 본문은 최초 변경 응답을 돌려준다. 현재 상태는 GET으로 조회한다.
- 같은 mutationId에 다른 본문을 보내면 409다.
- 인물·설정 리소스별 최근 128개 mutation 기록을 유지한다. 기록이 제거된 오래된 재시도는 revision 검사로 거절한다.
- 클라이언트는 인물별 변경을 순차 전송하고, 대기 중 클릭은 마지막 의도로 합친다. 충돌 시 현재 상태를 재조회한다.

### 오류

기존 `{error:{code,message,details,requestId}}` 봉투를 유지한다.

| HTTP | code | 의미 |
|---|---|---|
| 400 | INVALID_INPUT | 잘못된 모드/필드/버전/mutationId |
| 400 | INVALID_CHARACTER | 승인 manifest에 없는 체형 |
| 404 | NOT_FOUND | 없는/소유하지 않은 Job 또는 인물 |
| 409 | NOT_READY | 미완료 분석 |
| 409 | BODY_SELECTION_UNSUPPORTED | 설정 snapshot 없는 구 작업 |
| 409 | BODY_SELECTION_CONFLICT / BODY_PREFERENCE_CONFLICT | revision 불일치. details.currentRevision 제공 |
| 409 | IDEMPOTENCY_CONFLICT | 동일 mutationId에 다른 요청 |
| 409 | BODY_RECOMMENDATION_UNAVAILABLE | 명시적 auto에 사용할 추천 없음 |
| 409 | BODY_NOT_APPLICABLE | 후보 없는 인물 |
| 409 | BODY_POSE_UNSUPPORTED | 선택 체형이 현재 후보 전부를 지원하지 않음 |
| 409 | BODY_UNAVAILABLE | 체형이 사용 불가 |
| 503 | BODY_UNAVAILABLE | converter 가용 여부 확인 실패 |
| 503 | BODY_SELECTION_DISABLED | 기능 비활성화 |

## 추천 검증

`src/body-selection/recommendation.ts`는 소비하는 sidecar 필드를 검증한다. TypeScript 타입 선언만 믿고 raw JSON을 넘기지 않는다.

- 구 응답/빈 object는 disabled, shadow는 적용하지 않는다.
- 인물 index/id·입력 hash·중복 인물·포즈 ID/view/순서를 검증한다.
- 후보 camera에 원본 BVH hash가 있고 binding hash도 있으면 일치해야 한다.
- selected_asset의 ID/version/hash/rig/measurement가 승인 manifest와 모두 일치해야 한다.
- auto_default는 감지 성공으로 표시하지 않는다. 개인 기본값을 우선한 뒤 카탈로그 기본값을 사용한다.
- invalid/partial/unavailable 체형 결과 때문에 성공한 포즈 후보나 quality 필드를 버리지 않는다.
- 순위 점수를 확률로 표시하지 않는다. 원본 관측 문장이나 서버 파일 경로는 공개 상태에 복사하지 않는다.

## 승인 manifest

`config/body-models.json`은 빈 목록으로 커밋한다. 실제 QA가 확인되지 않은 모델을 자동 등록하지 않는다. 운영자가 검증한 참조만 배포한다. 모델 수나 특정 성별 ID에 의존하지 않는다.

```json
{
  "version": "your-approved-catalog-version",
  "defaultCharacterId": null,
  "assets": []
}
```

assets 한 항목의 필수값: bodyId, characterId, bodyVersion, assetSha256(64자리 소문자 hex), rigVersion, measurementVersion, supportedPoseIds(정확한 pose ID 배열). ID 중복과 불명확한 기본값을 거절한다. wildcard 지원은 없다.

BFF manifest는 승인 매핑이다. 실제 FBX bytes hash를 이 단계에서 재계산하거나 최종 렌더에 사용한 자산임을 증명하지 않는다. 다음 렌더 연결 단계에서 기대 hash와 converter 결과를 대조해야 한다.

## 저장·삭제

- body_preferences: 설치별 JSONB 설정. 설치 FK + 삭제 cascade.
- jobs.body_policy_json: 작업 시작 시 설정·기본 자산 snapshot.
- body_selections: (job_id,person_index)별 최신 선택. 재전달된 분석은 기존 선택을 덮어쓰지 않는다.
- body_mutations: owner/resource/mutationId별 요청 hash·응답. 설정/작업 삭제 범위 모두 처리.
- 신규 선택은 기존 포즈 확정 테이블이나 검색 결과 JSON을 수정하지 않는다.
- 기존 삭제 registry에 신규 테이블을 등록한다. Job 삭제 시 선택·관련 mutation 삭제, 설치 삭제 시 설정도 삭제한다.

## 검증

```bash
npm run typecheck
npm test
# 실제 PostgreSQL: 운영 DB가 아닌 일회용 테스트 DB를 지정한다.
BODY_TEST_DATABASE_URL=postgresql://... npm test
```

통합 테스트는 별도 임의 schema에서 저장소 실제 SCHEMA를 실행한다. snapshot 복원, 두 연결의 동시 쓰기, 멱등성, 다른 설치 접근, 모델 교체, Job/설치 삭제를 확인한 뒤 schema를 제거한다. URL 미설정 시 해당 테스트만 skip한다.

2026-10-08: 임시 로컬 PostgreSQL에서 전체 256개 테스트 통과(생략 없음). typecheck 및 build 통과. 실제 converter·승인 FBX·Gemini 운영 호출은 이번 저장 기능 검증에 포함하지 않았다.
