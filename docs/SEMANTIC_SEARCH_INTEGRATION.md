# 직접 문장 검색 연동 (2026-10-18)

기준은 추론 PR #96, develop `6411c129`다. `/semantic-search`는 `{query, topK}`만 받는다.
이전 PR #87의 source/tags/mirror_alternates 계약을 보내거나 가정하지 않는다.
`/healthz.semantic_text.ready`가 실제 index·validator 준비 상태를 나타낸다.

## 공개 API

- `GET /v1/semantic-search/capabilities`: 설치 인증, feature flag와 실제 추론 준비 상태, 최대 500자·TopK 20.
- `POST /v1/semantic-search`: `{query, topK?}`. 입력을 trim하고 빈 문장·추가 정책 필드·범위를 거절한다. `topK`는 정수 1–20, 생략 시 기존 기본값 5다. 앱은 capabilities의 `maxTopK`를 요청해 최대 20개를 받는다.
- 후보가 전혀 없으면 `{status:no_result,jobId:null}`. 근접 후보만 있으면 조회 작업을 만들고 참고 그룹으로만 표시한다.
- 오류·미준비·정상 빈 결과는 서로 다르다. 입력 원문이나 추론 예외 원문을 요청 로그에 남기지 않는다.
- 별도 설치별 10회/분 제한과 30초 기본 기한을 사용한다. 검색 API는 VLM·이미지 처리·포즈 생성을 호출하지 않는다.

앱은 검색 후보와 근접 참고 그룹을 각각 5개씩 페이지로 표시한다. 총 개수·현재 범위·이전/다음 버튼을 제공하고 표시 중인 페이지의 3D 모델만 올린다. 그룹별 상한이 20이며 두 그룹의 개수는 합치지 않는다. `/analyze`의 러프 입력 Top-5와 이미지 내부 의미 라우팅은 변경하지 않는다.
자연어 모델 미리보기는 설치별 60회/분으로 제한한다. 두 그룹(최대 40개)을 모두 탐색하고 체형 변경·재시도에도 여유를 두되, 기존 모델 변환 동시 실행 제한은 유지한다.

## 배포 순서

새 앱을 먼저 배포하고 BFF를 배포한다. 새 앱은 기존 `maxTopK:10`과 새 `maxTopK:20`을 모두 허용한다. 구형 앱은 capabilities를 `maxTopK:10` 리터럴로 검사하므로 BFF를 먼저 올리면 문장 검색을 미준비로 처리할 수 있다. 추론 서버는 이미 TopK 20을 지원해 이번 변경이 없다.

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
기존 내보내기·최종 framed FBX·직접 refine 요청은 서버에서 거절한다. 손 선택이나 선택 확정으로 이 정책이 바뀌지 않는다.
구형 자연어 작업을 다시 열어도 refine/body camera 권한을 켜지 않는다.
라이브러리 검색 결과·근접 참고·생성 결과를 정상 후보로 서로 대체하지 않는다.

## 검증

실제 라우트 조합 테스트는 문장 검색→비공개 BVH 조회→수동 손 선택 저장/재조회→모든 release/refine 차단,
다른 설치의 접근 거부·SHA 변경·오류·빈 결과·근접 전용 결과를 확인한다.
외부 검색·DB·변환 fixture를 사용한 로컬 검증과 실제 staging 검증은 별도로 기록한다.
