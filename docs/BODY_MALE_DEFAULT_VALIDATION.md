# 체형 감지 실패와 남성 기본형 — 검증 기록 (2026-10-20)

## 작업 기준

| 저장소 | 기준 origin/develop | 전용 작업 경로 | 브랜치 |
| --- | --- | --- | --- |
| BFF | ffc0a8a7976f6562559ad868ad5dcb8d232cc5f4 | /private/tmp/standin-body-male-default/bff | codex/body-male-default |
| 클라이언트 | fe78785be035782dfc71118deb0c0dd48cbfa7f3 | /private/tmp/standin-body-male-default/client | codex/body-male-default |
| 추론 | 750fbe567 (전체 SHA는 해당 checkout 기록) | /Users/dowon/.codex/worktrees/1c75/Standin-server | codex/body-male-default |

추론/Converter 코드는 변경하지 않았다. 별도 생성 포즈 작업의 브랜치·커밋은 포함하지 않았다.

## 자산 확인

커밋된 `config/body-models.json`은 빈 예시다. 기존 로컬 배포 준비 패키지
`/private/tmp/standin-deploy-20261017/package`의 승인 매핑/characters/실제 FBX를 읽기만 했다.
현재 운영 ECS 상태나 이번 변경이 배포됐음을 증명하는 자료로 사용하지 않는다.

- characterId/bodyId: `male-base-v0-7-2`, bodyVersion `0.7.2`
- asset SHA256: `809a131510434089888429605bf7cd2e3bc75b63109e4ac5c9734b211ee52365`
- rigVersion: `male-anatomy-c1-warp-1`, measurementVersion: `shape-authoring-v1`
- Converter registry rig_profile: `mixamo`, revision: `0.7.2`
- 실 FBX 2,009,084 bytes의 계산 SHA256가 매핑/Converter 등록값과 일치했다.
- 해당 패키지의 supportedPoseIds는 5개다. 이 목록을 확대하지 않았으며 출력 적격성·자산 존재·Converter·최종 결과 무결성 가드를 유지한다. 표현용 previewOnly는 기존 계약대로 카탈로그 식별자를 검증하고, 실제 저장은 기존 출력 검증을 거친다.

## 로컬 검증

- BFF: typecheck/build, 전체 테스트 626 통과·2 opt-in PostgreSQL 통합 테스트 생략, 운영 의존성 audit 0 vulnerabilities.
- 신규 PGlite 테스트는 실제 SCHEMA에 과거 설정을 넣고 읽기 정규화→모드 쓰기→작업 snapshot→추천 실패→명시 auto→저장/재시도→manual 우선→카드 삭제/재등장 방지를 검증한다.
- 정상 추천/실패·disabled·not_applicable/명시 auto/마지막 체형 최초·삭제·무효 수치/수동 우선/기본 자산 부재·해시 변경·포즈 미지원/과거 작업 재해석을 검증한다.
- 기존 Top-K PNG/GLB 테스트에 남성 기본형 실패 복구를 추가하고 자산 부재·Converter 비활성 시 차단을 확인했다. Converter 응답은 fixture다.
- 클라이언트: lint/typecheck/build, 전체 921 통과·1 대형 runtime opt-in 생략. 호스트 Node 26의 전역 Web Storage가 jsdom localStorage를 가려 전체 테스트는 `NODE_OPTIONS=--no-experimental-webstorage npm test`로 실행했다. CI는 Node 22다.
- 앱/바 공통 패널에서 fallback 안내 및 명시 자동 추천 버튼, ready 기본형의 확정 가능/자산 부재 차단, paired 최종 확인 receipt로 남성 기본형을 저장하는 훅을 검사했다. native writer와 API는 mock이다.
- 기존 카드 CRUD·라이브러리 수동 저장·최종 확인 무결성 회귀는 전체 테스트에 포함됐다.

설치된 Tauri 앱을 업데이트하거나 Windows/macOS 네이티브 파일 저장, 실제 Converter의 새 FBX 출력 또는 CSP import를 이번 작업에서 실행하지 않았다. 로컬 기존 FBX의 바이트 해시 확인과 실제 내보내기 검증은 구분한다.

## 배포와 호환 경계

BFF를 먼저 반영하고 클라이언트를 함께 업데이트한다. 새 설정 PUT은 mode/revision/mutationId만 허용한다. 과거 사용자 기본값 필드를 계속 보내는 구 클라이언트는 설정 쓰기에 400을 받으므로 새 클라이언트가 필요하다. 기존 DB·snapshot은 읽기 경계에서 정규화하고 이후 쓰기 때 현재 계약만 저장한다. 현재 카드·lastUsed·수동 체형은 유지한다. 운영 DB 일괄 변경/수동 배포는 하지 않는다.

병합 전 저장소 문서의 최소 1명 확인 및 GitHub CI 조건을 충족해야 한다. main 반영은 범위 밖이다.
