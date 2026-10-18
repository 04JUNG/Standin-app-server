# 동적 라우팅 결과 연결

## 2026-10-18: Top-5 직접 선택과 저장

검증된 `posePresentation.library_candidates`만 일반 포즈 선택 목록으로 연결한다.
사용자가 카드를 누르면 선택되고 기존 확정 → 최종 확인 → BVH/FBX 저장 흐름을 따른다.
BFF가 `source=library`, `lookupAllowed=true`, `releaseAllowed=true`,
`sourceBvhSha256`를 부여하며 저장 시 소유권·확정 선택·원본 BVH 해시를 검증한다.
자동 적용과 refine은 켜지 않는다. 근접·구도·생성 후보는 기존 검수 전용 계약을 유지한다.
카드는 정면 라이브러리 이미지를 사용하며 검색 원근 카메라를 출력 카메라로 위장하지 않는다.
클라이언트의 확대·회전 모달은 제거한다. 양쪽 저장 화면은 기존 네이티브 파일 드래그를 사용한다.
이전 배포에서 저장된 검수 전용 Job은 재검색해야 새 선택 목록을 받는다.
아래의 `dynamic/semantic` 조회 전용 경로는 계속 차단한다.

기준: 추론 develop `4d6e84c7`, BFF develop `ee2e9a12`, 클라이언트 develop `4b07a94e`.

## 결과 계약

추론 `people[].dynamic_search.selected`를 BFF `candidatesByPerson[].candidates`로 옮긴다.
기존 `candidates`가 비어 있어도 새 후보를 버리지 않는다. 구형 `semantic_candidates`도 동일한 조회 전용 계약으로 번역한다.
기하 거리와 의미 점수는 섞지 않는다. 새 후보는 `source=dynamic|semantic`, `rankScore`를 가지며 `distance`를 만들지 않는다.
새 후보의 `lookupAllowed=true`, `refineAllowed=false`, `releaseAllowed=false`, `actualMeshValidated=false`,
`reviewRequired=true`, `bvhAvailable=false`를 보존한다. 상류가 다른 권한을 주면 해당 batch를 계약 오류로 처리한다.

`routedSearch`에는 route/status/reason, 근접·구도 참고 개수, 별도 생성 상태/개수, 기본 인체 여부를 보존한다.
near/framing/generation/basic-model은 selected로 승격하지 않는다. 실제 검색 실패와 후보가 있는 검수 결과를 구별한다.
스켈레톤 소유권·추론 안전 게이트·검색 가중치는 변경하지 않는다.

## 조회와 차단

`GET /v1/pose-candidates/:id/lookup-thumbnail?jobId=...&personIndex=...&candidateId=...`
은 installation 소유권과 저장된 후보의 pose/ID/lookup 권한을 검증한 후 정면 라이브러리 JPEG를 반환한다.
상류 URL은 공개 응답으로 통과시키지 않는다. 이 이미지는 **정면 참고 이미지**이며 원근/부감 검색 카메라의 정렬 렌더가 아니다.
숫자 검색 카메라는 `searchCamera`로 별도 전달하며 정렬 카메라(v1/v2)로 위장하지 않는다.
현재 converter의 회전 전용 framed API에 원근 거리를 버리고 연결하지 않는다.

새 후보는 BFF의 BVH/FBX export, framed FBX export, refine에서 409로 차단한다.
클라이언트도 검수용 표시, 저장 확정 차단, refine 호출 차단, 저장 훅의 재검증을 적용한다.
구형/다른 인물의 기존 후보 권한은 기존 계약을 따른다. 결과 JSON은 source와 권한을 함께 보관하므로 재조회 때도 같다.
새 후보를 포함하는 작업에서는 현행 v1/v2 카메라·export용 body preview capability를 끄고 조회용 JPEG를 사용한다.

## 신기능 연결 점검

| 기능 | 추론/Converter develop | BFF·클라이언트 develop 기준 상태 | 남은 연결 |
|---|---|---|---|
| 전신 동적 라우팅 | #92/#95 병합, staging 활성 | 이번 변경으로 후보·상태·정책 전달 | 실제 검색 카메라의 원근 렌더는 별도 작업 |
| 구형 의미 라우팅 후보 | semantic_candidates 제공 | 이번 변경으로 조회 전용 후보 전달 | refine/release 승격 없음 |
| 손 라이브러리 79종 | #89 병합, /hands/catalog·thumbnail, converter 손 굽기 | develop에 손 필드·라우트·선택 UI 없음 | 손 연동 로컬 브랜치 5699953/3d2ee59는 아직 미병합; staging VLM_HAND_SHAPES 기본 off |
| 직접 자연어 검색 | #96 및 #87 OPEN. 현재 develop에 /semantic-search 없음 | develop에 입력 UI·프록시 없음 | #96 계약 승인·병합 후 연결. 라우팅 내부 semantic 엔진과 직접 입력 API는 다름 |
| 포즈 목록 | /poses·/poses/folders 제공 | BFF 관리자 gallery에 프록시가 있음 | 일반 사용자용 폴더 탐색 UI와 구분 |
| 원근 검색·카메라 v2 | #88 병합 | BFF v2 필드 보존; client 모델 프리뷰는 v1 위주 | 고정 카메라 메타데이터와 정렬 렌더의 투영 동등성 필요 |
| 다인 장면·자동 보정 실험 | #93 병합 | 기존 BFF는 인물별 export 경로 | scene/bundle 사용자 흐름 및 검수 계약은 미연결 |
| 체형 수치 굽기 | #90/#91 및 BFF #82·client #87 병합 | staging 29종 catalog/남성 9종 수치 편집 연동 | 여성 수치 편집 off는 검증 정책이며 연결 누락이 아님 |
| 설치파일 환경 | develop CI installer mock=true | 실제 staging 기능을 확인할 수 없음 | client CI의 명시적 staging dispatch는 실제 API·별도 앱 식별자·업데이트 비활성 사용 |

손·직접 자연어·장면 기능을 이번 동적 라우팅 수정에 임의로 승격하지 않는다. 별도 기존 작업을 덮어쓰지 않는다.

## 검증

추론 응답 fixture → 실제 mapCutResult → 저장 JSON → public result, 혼합 인물/legacy,
상류 권한 모순, 상태별 결과, 소유권·후보 spoof, 직접 refine 및 BVH/FBX/framed export 거부를 테스트한다.
클라이언트 API 번역, 검수 상태 문구, 저장 진행 차단과 refine 호출 금지도 검증한다.
배포 SHA와 실제 staging probe 결과는 PR 검증 기록에 남긴다.


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
