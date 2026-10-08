# 체형 선택 1~2단계 — 자산 계약 및 Top-K 미리보기

구현: 2026-10-08. 기반: 체형 저장 브랜치 `b52d302`. BFF 워크트리: `Standin-app-server-body-preview`, 브랜치 `codex/body-preview-integration`.

## 범위

저장된 BodySelection을 기준으로 Top-K의 GLB/PNG를 제공한다. 기존 컨버터 사전 생성 GLB와 `convertFramed` PNG 경로를 재사용한다. 체형 선택 PUT·검색·후보 순위·refine은 변경하지 않는다.

- `BODY_SELECTION_ENABLED=true`와 converter 설정으로 API를 사용한다. 승인 `BODY_CATALOG_PATH`는 필수다. 커밋된 빈 카탈로그를 테스트용 9종으로 채우지 않았다.
- `capabilities.bodyPreviewAssets`: 버전이 결합된 미리보기 API 제공 여부. flag와 converter 설정으로 결정한다. 실제 자산 준비나 converter health를 보증하지 않는다.
- `capabilities.bodyPreviews=false`: 앱 UI·최종 확인·Export까지 연결되는 다음 단계 전에는 전체 체형 UX를 활성화하지 않는다.
- 기존 `/aligned`, `/preview-model`, Export 응답 및 구 클라이언트의 체형 선택 경로는 그대로 둔다. 신규 URL을 명시적으로 소비하는 다음 클라이언트 작업이 필요하다.

## HTTP 계약

기존 `X-Installation-Id` + `X-Device-Token` 인증, Job 소유권을 사용한다. 모든 응답은 `Cache-Control: private, no-store`다.

### 미리보기 목록

`GET /v1/analysis/jobs/{jobId}/people/{personIndex}/body-previews`

`GET .../result`의 person에 `bodyPreviewManifestUrl`을 추가한다(저장된 bodySelection이 있는 경우). 개별 선택 변경 후에는 이 URL을 재조회하며 분석 API를 다시 호출하지 않는다.

응답 `BodyPreviewManifest`:

| 필드                             | 내용                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| schemaVersion                    | `body-previews.v1`                                                                     |
| jobId / personIndex              | 서버 Job·인물 ID                                                                       |
| selectionRevision / resolvedBody | 실제 저장된 선택 버전과 BodyRef 전체                                                   |
| renderKey                        | 해당 인물의 후보 묶음·체형·렌더 버전을 식별하는 SHA256                                 |
| outputScope                      | `full`. Top-K 비교용이며 최종 Export 범위와 별개                                       |
| status                           | `renderable`. 각 GLB/PNG 다운로드 성공을 뜻하지 않음                                   |
| renderingExecuted                | false. 목록 조회만으로 Blender 실행이나 bake를 시작하지 않음                           |
| runtime                          | previewRevision, modelVersion, modelRevision, solverVersion, framingVersion            |
| candidates[]                     | 원래 순서·실제 개수를 유지한 candidateId/poseId/rank/view/camera/sourceBvhSha256       |
| candidates[].thumbnailUrl        | PNG 폴백 경로                                                                          |
| candidates[].previewModel        | url, rotation, sourceSha, characterId, characterSha256, modelRevision, previewRevision |

`renderKey`에는 owner/job/person/selectionRevision/BodyRef/full scope/runtime/후보 전체를 넣는다. 체형 hash, camera, 원본 BVH hash 또는 렌더 코드가 바뀌면 다른 key다. 다른 인물의 선택 변경은 현재 인물의 key를 바꾸지 않는다. 이 key는 인증 토큰이 아니며 매 요청 소유권을 다시 검사한다.

### 바이트 조회

- `GET .../body-previews/{renderKey}/{candidateId}/glb`
- `GET .../body-previews/{renderKey}/{candidateId}/png`

후보 ID는 URL encode한다. URL은 manifest가 제공한 값을 그대로 사용한다. **characterId·camera 등의 query를 붙이지 않는다.** 기존 client `candidateThumbnailOptions`가 characterId query를 붙이는 부분은 신규 manifest 모드에서 분기해야 한다.

1. 현재 저장 선택·카탈로그·후보·runtime으로 manifest를 다시 계산한다.
2. URL의 renderKey와 일치해야 한다. 불일치하면 `409 BODY_PREVIEW_STALE`.
3. 원본 BVH를 읽어 격리 여부와 bytes hash를 확인한다. 캐시 적중에도 생략하지 않는다.
4. GLB: 기대 체형 hash·preview revision을 전달하고 HTTP checksum/헤더와 GLB 내장 identity를 검증한다.
5. PNG: 동일한 기대 체형 hash·preview revision·원래 camera로 convertFramed를 실행한다. 반환된 체형/렌더 버전·PNG/FBX checksum을 검증한다.
6. 바이트 반환 직전 현재 manifest를 재조회한다. 렌더 중 선택·후보·카탈로그·배포 runtime이 바뀌면 반환을 거절한다.

응답 헤더(브라우저/Tauri에서 읽을 수 있도록 BFF CORS exposeHeaders에도 등록):

- Content-Type: `model/gltf-binary` 또는 `image/png`
- X-Standin-Body-Render-Key / X-Standin-Body-Revision
- X-Standin-Character-SHA256 / X-Standin-Source-BVH-SHA256
- X-Standin-Preview-Revision / X-Standin-Model-Revision
- X-Standin-Artifact-SHA256: 이번 응답 GLB 또는 PNG bytes hash

PNG cache는 기존 process-local 제한 캐시를 재사용한다. owner·renderKey·candidate·BVH·character hash·preview revision·scope·camera를 분리한다. 완료 후 DB가 변경돼 결과를 버리더라도 그 오래된 URL로 현재 결과를 받을 수 없다.

### 오류와 클라이언트 처리

| HTTP/code                                            | 다음 행동                                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------------------ |
| 400 INVALID_INPUT                                    | 잘못된 인물 index/format/key/query. 클라이언트 계약 수정                       |
| 404 NOT_FOUND                                        | 없는/다른 설치 소유 Job·인물·후보                                              |
| 409 BODY_PREVIEW_STALE                               | 현재 body-selection과 manifest만 재조회. 분석 재실행 금지                      |
| 409 BODY_SELECTION_REQUIRED / BODY_UNAVAILABLE       | 현재 체형 선택 또는 가용 여부 확인                                             |
| 409 BODY_SELECTION_UNSUPPORTED                       | 설정 snapshot 없는 구 작업. 신규 UX 비활성                                     |
| 409 BODY_NOT_APPLICABLE                              | 후보 없는 인물                                                                 |
| 409 BODY_PREVIEW_UNSUPPORTED                         | 원본 hash·유효 camera·BVH가 없는 후보. 기존 이미지를 새 체형으로 표시하지 않음 |
| 409 POSE_UNAVAILABLE                                 | BVH 격리·삭제·hash 변경                                                        |
| 409 CONVERTER_INTEGRITY / CONVERTER_REJECTED         | 기대 자산/런타임 계약 불일치. 선택을 바꾸거나 새 manifest 확인                 |
| 503 PREVIEW_NOT_READY                                | 사전 GLB 없음. 같은 manifest의 PNG를 요청 가능                                 |
| 503 BODY_PREVIEW_UNAVAILABLE / CONVERTER_UNAVAILABLE | 구/중단된 converter 또는 통신 실패. 재시도 가능                                |
| 503 BODY_SELECTION_DISABLED                          | feature off                                                                    |

GLB/WebGL 실패 시 같은 manifest의 PNG로 폴백한다. Abort나 BODY_PREVIEW_STALE은 오래된 PNG 생성으로 이어지면 안 된다. 카탈로그 기본 체형으로 임의 대체하지 않는다. 후속 앱은 최신 renderKey의 모든 후보가 준비됐을 때 이미지 묶음을 전환하고 진행 버튼을 활성화한다.

## 컨버터 의존 계약

Standin-server `codex/body-preview-contract`의 `converter_api/body_preview.py` / `app.py`:

- GET `/preview-contract` → `body-preview-runtime.v1`. Blender나 자산 다운로드 없이 모델/렌더/solver/framing 버전 반환.
- GET `/pose-preview/{sha}`에 optional expected_character_sha256, expected_preview_revision 추가.
- POST `/convert-framed`의 form에 같은 optional 두 필드 추가.
- 체형 hash/preview revision 불일치 시 409, 잘못된 형식은 400. 기존 필드 생략 호출은 호환.
- GLB 응답에 X-Standin-Preview-Revision / X-Standin-Model-Revision 추가. framed JSON에 preview_revision 추가.
- GLB는 기존 offline 검증 manifest/bytes를 읽는다. 실제 FBX 변환은 registry 및 runner/worker에서 파일 hash를 검증한다.

컨버터를 먼저 배포하고 BFF를 연결한다. 구 컨버터가 기대 필드를 무시해도 새 BFF는 runtime 헤더/응답 검증에서 거절한다. 배포·기능 활성화는 이번 작업에서 수행하지 않았다.

## 자산 준비와 후속 작업

- 승인된 bodyId↔characterId, hash, rig/measurement 버전, supportedPoseIds가 실제 converter registry와 맞아야 한다.
- 각 승인 체형의 GLB를 기존 `precompute_pose_previews.py --character ...`로 준비한다. 스크립트 기본값은 한 체형뿐이므로 필요한 체형을 명시한다. 임의로 9종을 자동 승인하지 않는다.
- 실제 차렷 카드 생성·9종 정규화 QA·production 자산 배포는 아직 수행하지 않았다.
- 3~4단계: 앱의 새 contract parser·Query/cache·이미지 묶음·기본 설정·인물별 펼침 패널 연결. 클라이언트 GLB 검증에도 기대 character hash/model revision을 추가.
- 5단계: 최종 refine BVH·scope·체형의 확인 fingerprint와 Export 연결. 현 `bodyPreviews=false` 유지.

## 검증 기록

- BFF: typecheck/build 통과. 일회용 PostgreSQL 사용 전체 **289개 통과, skip 0**.
- 실제 PostgreSQL + Hono: 자동 선택 조회 → GLB → 실제 선택 PUT → PNG/GLB 체형 변경 → 이전 URL 거절 → 타 인물 유지 → 소유권 검사 → 렌더 도중 변경 거절. 원본 result_json 불변 확인.
- 테스트용 9종 참조로 양 경로의 체형 전달 검증. 이는 실제 9종 FBX 렌더 검수와 다르다.
- 단위 검증: camera/원본hash/선택revision/runtime 변경, 정적 GLB 내부 identity 위조, 캐시 조회 시 권한·격리 검사, 후보 부족/구 camera, PNG 기대 hash 불일치.
- 컨버터: 실제 FastAPI 경로 + fixture runner로 관련 계약/배포 검사 **80개 통과**. Docker COPY 파일만 구성한 디렉터리에서 runtime 계약 import 검증 포함. 실제 Docker build·Blender 실행·배포 완료 증거는 아니다.

## 후속 구현 (2026-10-08)

앱 UI 및 최종 확인·Export 연결은 [BODY_SELECTION_UI_CONTRACT.md](BODY_SELECTION_UI_CONTRACT.md)를 따른다. `bodyPreviews`는 이제 기본 off인 `BODY_UX_ENABLED`로 별도 제어한다. 위의 고정 false 설명을 대체한다.
