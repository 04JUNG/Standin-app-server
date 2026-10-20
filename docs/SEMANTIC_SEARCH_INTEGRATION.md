# 직접 문장 검색 연동 (2026-10-18)

기본 계약은 추론 PR #96이며, 전체 결과 반환은 PR #107(develop `766ce81` 포함)의 배포가 선행돼야 한다. `/semantic-search`는 `{query, topK}`만 받는다.
이전 PR #87의 source/tags/mirror_alternates 계약을 보내거나 가정하지 않는다.
`/healthz.semantic_text.ready`가 실제 index·validator 준비 상태를 나타낸다.

## 공개 API

- `GET /v1/semantic-search/capabilities`: 설치 인증, feature flag와 실제 추론 준비 상태, 최대 500자. 기존 설치 앱과의 호환을 위해 `maxTopK:20`을 유지하고 `supportsAllResults:true`를 추가한다. `maxTopK`는 구형 앱의 요청 개수 힌트이며 서버의 결과 상한이 아니다.
- `POST /v1/semantic-search`: `{query, topK?}`. 입력을 trim하고 빈 문장·추가 정책 필드·잘못된 개수를 거절한다. `topK` 생략은 기존 기본값 5, 양의 안전 정수는 지정 개수, 명시적인 `null`은 검색 기준을 통과한 전체 결과다. 숫자 문자열·bool·0·음수·소수는 거절한다. `null`을 5/20으로 바꾸거나 응답 배열을 잘라내지 않는다.
- 후보가 전혀 없으면 `{status:no_result,jobId:null}`. 근접 후보만 있으면 조회 작업을 만들고 참고 그룹으로만 표시한다.
- 오류·미준비·정상 빈 결과는 서로 다르다. 입력 원문이나 추론 예외 원문을 요청 로그에 남기지 않는다.
- 별도 설치별 10회/분 제한과 30초 기본 기한을 사용한다. 검색 API는 VLM·이미지 처리·포즈 생성을 호출하지 않는다.

새 앱은 `supportsAllResults:true`를 확인한 뒤 다음 요청을 보낸다.

```json
{"query":"공을 던지는 자세","topK":null}
```

서버 페이지네이션은 없다. 전체 JSON 결과를 저장하고 정식 결과와 근접 참고 그룹을 분리해
스크롤 시 각각 20개씩 점진 표시한다. BFF의 `candidateCount`는 두 그룹의 총 자산 수이므로
정식 검색 결과 개수로 사용하지 않는다. 정식 개수는 `posePresentation.library_candidates.length`,
근접 개수는 `posePresentation.review_candidates.length`다. 각 그룹의 원래 순서와 rank를 유지한다.
`no_result`에서도 근접 후보가 있으면 작업을 만들며, 근접을 정식 후보로 승격하지 않는다.

목록은 저장된 기본 체형 썸네일을 지연 로딩하고, 3D 변환·렌더는 상세 선택 시에만 실행한다.
BFF는 기존 자산 소유권·수동 저장 계약을 위해 검색 시 BVH를 최대 4개 병렬로 읽어 SHA를 묶는다.
이 검증은 Converter/Blender 렌더가 아니며, 결과 개수가 커지면 자산 조회 시간은 늘 수 있다.
검색창은 상단에 유지하고 입력 변경 300ms 뒤 재검색한다. 이전 요청 취소와 늦은 응답 차단은
클라이언트가 처리한다. `/analyze`의 러프 입력 Top-5와 이미지 내부 의미 라우팅은 변경하지 않는다.
자연어 모델 미리보기의 설치별 제한과 기존 모델 변환 동시 실행 제한도 유지한다.

## 배포 순서

전체 결과 지원 추론 서버 → BFF → 새 앱 순서다. 구형 추론은 `null`을 거절하므로
BFF/앱 전환 전에 PR #107 적용을 확인한다. 이전 BFF는 `supportsAllResults`가 없으므로
새 앱이 그 환경에서 `null` 검색을 지원하는 것으로 가정하면 안 된다. 기존 앱의 숫자 요청과
기존 `maxTopK:10/20` 인식 계약은 유지한다.

## 결과와 미리보기

인물 슬롯 0은 검색 결과 슬롯이며 검출한 인물 수를 의미하지 않는다. `source=semantic`, image/skeleton=null,
refine=false다. 기존 설치 소유 Job·기록·삭제·보관 정책을 사용한다. 문장은 결과가 있는 작업 JSON 안에만 보관한다.
작업은 running으로 만들고 후보 행·비공개 자산 바인딩·completed 결과를 한 트랜잭션으로 공개한다.

각 후보의 실제 BVH를 최대 4개 병렬·2MB 제한으로 읽어 UTF-8/HIERARCHY와 SHA를 검증한다.
인물의 `posePresentation.version=semantic-pose-presentation-v1`은 BFF 표시 계약이다.
정식 결과는 library_candidates, 근접 결과는 review_candidates에 넣고 원래 그룹 순위를 유지한다.
생성은 요청하지 않는다. 점수는 semantic_similarity이며 정확도나 기하 거리가 아니다.

텍스트 검색에는 fitted/search camera가 없으므로 명시적인 정사영 정면 참고 카메라를 사용한다.
projection_matches_search=false이고 출력 범위는 full이다. BVH 원본의 frame 0을 기존 관절 3D 뷰어로 확인한다.
BVH는 기존 `/v1/analysis/jobs/:id/people/0/pose-previews/:candidate/:sha`의 소유권·후보·SHA 검증을 거친다.
내부 경로나 원문 BVH를 공개 JSON에 넣지 않는다.

## 권한

모든 신규 문장 후보는 source=semantic, lookupAllowed=true, refineAllowed=false,
releaseAllowed=false, actualMeshValidated=false다. 표시 계약도 auto_apply/refine/export/release=false다.
자동 적용·직접 refine은 계속 거절한다. 2026-10-19부터 실제 BVH 해시가 바인딩된 후보에만
별도 `manualExportAllowed=true`를 부여하여 작가의 선택 확정과 최종 framed 검수 뒤 BVH/FBX 저장을 지원한다.
release/actual_mesh_validated=false는 검증 통과를 의미하지 않으므로 그대로 보존한다.
기존 작업도 비공개 자산 바인딩을 잠금 아래 검증하여 재분석 없이 보강한다.
상세 검수 키·해시·설정 변경 거절 계약은 [MANUAL_POSE_EXPORT.md](MANUAL_POSE_EXPORT.md)를 따른다.
구형 자연어 작업을 다시 열어도 refine/body camera 권한을 켜지 않는다.
라이브러리 검색 결과·근접 참고·생성 결과를 정상 후보로 서로 대체하지 않는다.

## 검증

실제 라우트 조합 테스트는 문장 검색→비공개 BVH 조회→수동 손 선택 저장/재조회→모든 release/refine 차단,
다른 설치의 접근 거부·SHA 변경·오류·빈 결과·근접 전용 결과를 확인한다.
외부 검색·DB·변환 fixture를 사용한 로컬 검증과 실제 staging 검증은 별도로 기록한다.
