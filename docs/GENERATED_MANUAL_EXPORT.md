# 생성 포즈 수동 확인·개별 FBX 저장 (02~08)

2026-10-20. 기준 develop ffc0a8a7976f6562559ad868ad5dcb8d232cc5f4.
추론/Converter 기준 f98b2fa4b33709e7d562798f128517be4d82ac9d; 그 저장소 코드는 변경하지 않았다.

## 자산과 권한

- PoseCandidate: `source=generation`, `poseId=null`, `id=원래 candidate_id`, `sourceBvhSha256`.
- `manualExportAllowed=true`는 직접 선택/최종 확인용 capability다. 기존
  `releaseAllowed/refineAllowed/actualMeshValidated=false`는 유지한다.
- 기존 성공한 생성 `preview_ready`, 검색 정상 상태, 자동 금지 정책, 표시 카메라,
  비공개 inline 원본·candidateId·SHA가 일치할 때만 선택 목록에 넣는다.
  저장된 기존 검사 근거에 명시적인 관절/검사 실패가 있으면 거부한다.
  과거 BFF가 근거 상세를 생략한 작업은 기존 trusted preview_ready와 바이트 바인딩을 사용한다.
  완전한 충돌 인증을 새로 주장하거나 추가 임계값을 만들지 않는다.
- `actual_mesh_validated=false`만으로 정상 생성물의 수동 확인을 막지 않는다.
- 비공개 원본은 `analysis_people.refine_context_json.posePresentationAssets`에 보관하며
  기존 생성 `validation`도 같은 자산에 보존한다. 공개 JSON/로그에 원문을 넣지 않는다.
- 입력 BVH/URL/허용 flag를 클라이언트가 제출해 권한을 만들 수 없다.

## DB / 구 작업

`analysis_candidates.pose_id`는 nullable로 변경한다. SCHEMA의 idempotent
`ALTER ... DROP NOT NULL`이 기존 DB에도 적용된다. 원본 식별은 job/person/candidate 키와
owned result의 source/해시를 사용한다. 가짜 library pose ID를 저장하지 않는다.

결과 버전은 2다. 버전 1 및 더 오래된 completed job도 getOwnedJob에서 기존 installation 소유권,
90일 보관 기간, job row FOR UPDATE 아래 후보 등록과 JSON을 함께 갱신한다.
체형·손·범위 설정과 기존 확정 선택을 덮어쓰지 않는다. 원본/근거가 없는 작업은 승격하지 않는다.

## 확인 / 저장

기존 `/v1/pose-candidates/:id/framed?jobId&personIndex&candidateId`를 재사용한다.
`:id`는 라이브러리에선 실제 poseId, 생성에선 실제 candidateId다. 원본 조회 helper는
`candidate-source.ts`이며 호출 전에 owned completed job과 등록 후보를 검사한다.
생성은 라이브러리 조회를 하지 않는다. 원본 크기·SHA 및 기존 Converter 검사는 그대로다.

기존 체형·수치·손·출력 범위·카메라·변환기 runtime/revision을 같은 변환 입력에 적용한다.
최종 PNG/GLB와 FBX는 기존 paired artifact 저장소/캐시의 같은 결과다. 다운로드는
수동 선택 확정, reviewKey, 원본/체형/runtime 해시를 검증하고 반환 직전 다시 확인한다.
manual FBX 다운로드는 existingOnly로 기존 결과만 읽는다. 보관된 결과가 사라졌으면
다운로드 중 재변환하지 않고 `MANUAL_REVIEW_REQUIRED`를 반환한다.
원본 BVH 직접 다운로드는 이 최종 FBX 경로를 대체하지 않는다.

생성이 포함된 작업의 sceneExport/sceneRefinement capability는 false다. 직접 scene 요청도
`GENERATED_INDIVIDUAL_ONLY`로 거부한다. 다른 라이브러리 포즈로 대체하거나 생성 인물을 누락하지 않는다.

## 오류 계약

presentation 후보의 `manual_use_block_reason`은 선택 불가일 때만 다음 코드 중 하나다.
`generation_unavailable`, `source_missing`, `source_changed`, `policy_unavailable`.
생성 자체가 실패해 후보가 없으면 기존 `generation_status/generation_reason`을 유지한다.

HTTP: `GENERATED_SOURCE_UNAVAILABLE`(409), `PREVIEW_SOURCE_CHANGED`/`PREVIEW_HASH_MISMATCH`(409),
`GENERATED_INDIVIDUAL_ONLY`(409). 선택/설정/검수는 기존
`MANUAL_SELECTION_REQUIRED`, `MANUAL_REVIEW_REQUIRED`, `BODY_PREVIEW_STALE`, `HANDS_CHANGED`,
`OUTPUT_SCOPE_CHANGED`, `PREVIEW_CHANGED`를 유지한다. 변환 오류는 기존
`CONVERTER_REJECTED/INTEGRITY/TIMEOUT`이다. 원문 예외나 BVH를 사용자 메시지에 넣지 않는다.

## 검증 경계

`npm run typecheck`, `npm test`.
`manual-export.test.ts`: 생성 전용 선택 등록·완료된 버전1 작업 DB migration·소유권·동일 candidate/null poseId·
실패/시간초과/검사탈락/원본소실/해시변경·체형/손/범위 적용 paired FBX·변환 중 설정 변경 거부.
`converter/framing.test.ts`: 복제본/재시작에서도 같은 저장된 파일, 만료 시 재변환 없음.
`pose-presentation.test.ts`: 기존 생성/라이브러리 비공개 미리보기 유지.
테스트 Converter는 fixture다. 실제 설치 앱/실제 생성 FBX 재열기·육안 확인·스테이징은 별도 검증해야 한다.

09 복구 코드: private validation에 기존 검사 탈락이 있으면 `GENERATED_CHECKS_FAILED`(409), 원본 transport/등록 해시 변경은 `PREVIEW_SOURCE_CHANGED`(409), 원본 소실은 `GENERATED_SOURCE_UNAVAILABLE`(409). 검사 기준은 동일하며 다른 포즈/체형으로 대체하지 않는다.
