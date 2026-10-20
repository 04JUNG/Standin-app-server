# 생성 포즈 09·10 오류·복구 통합 검증

기준 `origin/develop` ffc0a8a. 전용 워크트리 `/private/tmp/standin-generated-recovery-qa/bff`,
전용 브랜치 `codex/generated-recovery-qa`. 선행 완료 커밋 3a52640을 81a12eb로 가져왔다.

`candidateSourceBytes`에서 기존 거부 조건을 그대로 유지하고, 기존 검사 탈락은
GENERATED_CHECKS_FAILED, 원본 등록 정보 변경은 PREVIEW_SOURCE_CHANGED,
원본 소실은 GENERATED_SOURCE_UNAVAILABLE로 구분했다. 검사/생성/자동 적용 정책 변경 없음.

`npm test`: 656개 중 654 통과, 2 skipped. tsc build 성공.
추가 테스트 3개는 소실·등록 정보 변경·기존 검사 실패의 코드와 라이브러리 대체 조회 0회를 검증한다.
선행 테스트 포함: 소유자/원본/nullable DB migration, 생성-only/라이브러리 회귀,
후보·체형/수치·손·범위·runtime 변경 중 결과 거절, 최종 확인과 저장할 동일 FBX 바이트/해시,
만료된 확인 파일 재생성 금지, 개별 저장만 허용.
이 테스트의 Converter는 fixture다. 실제 Blender 검증은 서버 워크트리 보고서로 분리한다.

외부 운영/Staging 데이터 수정, 기본 checkout 수정, develop/main 반영, push/PR/배포 없음.
