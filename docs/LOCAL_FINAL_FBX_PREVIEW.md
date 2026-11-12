# 결과 미리보기용 최종 FBX

`GET /v1/pose-candidates/:id/framed?format=ready`의 verified-fbx-v1 응답에
`X-Standin-Local-Preview: fbx-v1`이 있으면 클라는 PNG 대신 최종 FBX를 표시할 수 있다.
구 클라는 이 헤더를 무시하고 기존 PNG 경로를 계속 사용한다.

같은 URL의 `format=review-fbx`에 `artifactReceipt`와 `reviewKey`를 전달한다.
`format=fbx`와 같은 모든 release·소유권·확정 선택·출처·체형·손·runtime 검사를 거친다.
준비된 동일 FBX를 반환하며 PNG를 만들지 않는다. 미리보기이므로 recordExport를 남기지 않는다.
receipt 없는 요청이나 변경된 선택은 거부된다. CORS는 새 헤더와 HEAD를 허용한다.

클라에서 미리보기 바이트를 재사용해 저장하려면, 명시적 저장 시 같은 다운로드 URL
(`format=fbx`)로 HEAD를 보내 현재 권한·선택·lineage를 서버에서 다시 확인한다.
HEAD는 Hono의 GET 경로 전체 검증을 실행하고 응답 본문만 생략한다.
저장 요청의 recordExport는 기존대로 남긴다. 클라는 받은 SHA와 revision이 캐시와 일치해야 재사용한다.

Converter·추론·기능 플래그·운영 설정은 변경하지 않는다. 새로운 포즈 생성이나 재보정도 없다.
BFF를 먼저 배포해도 기존 클라는 유지되며, 새 클라를 먼저 배포하면 구 BFF에는 PNG로 복구한다.

검증: 전체 BFF 테스트 1,099개 통과, 기존 skip 2개. ready → review-fbx → HEAD에 Converter 호출 1회,
PNG 호출 0회, 미리보기 export 통계 0회, 저장 통계 1회임을 확인했다.
체형·손·원본·runtime·권한·receipt 변경 및 소유권 철회를 거부하는 회귀 테스트를 포함한다.
실제 AWS 배포·앱 전체 E2E는 수행하지 않았다.
