# main → develop 공통 코드 동기화 (2026-11-13)

명시적 refspec fetch 기준 main `36fdb9c87e2c8c8ba9271463d0ad3206d82c6ede`, develop `6ae4a9b2158ce07b2394f0e53ce2b34f0e38a73e`. squash 커밋 개수가 아니라 전체 tree/patch와 계약을 비교했다. 전용 워크트리 `/private/tmp/standin-sync-20261113/Standin-app-server`, 브랜치 `codex/sync-main-develop-20261113`.

| 판정 | 기능 묶음 | 반영/유지 근거 |
|---|---|---|
| 반영 | #202 binary v2, #200 packet validation worker/판정 캐시 | packetV2/packet-worker/validation/revalidation, 협상 protocol, vendored reader와 build copy, v1 fallback 그대로 |
| 반영 | #204 skin UV worker | 승인 UV 규칙/길이/SHA/topology 유지하며 event loop 밖 검증 |
| 반영 | #203 probe deadline/손 readiness | converter probeDeadline, hands/agreement와 service; busy/일시 장애에 기존 work/권한 유지 |
| 반영 | #205 skinUnavailable/outputScope | head HTTP sibling 사유 전달, full 외 범위 차단, 기본 skin 안내 계약 |
| 반영 | #192, #195–199 fallback/진단/검증 복구 | ranking 오류에도 실제 사용 가능한 base 후보 유지, poll/timing/selection 최적화, readiness 장애 때 work 보존 |
| 이미 포함 | #193 export authority, 로컬 외관/검증 final FBX, composed skin | develop 고유/공통 구현 보존; main tree와 동일 파일 중복 이식 안 함 |
| 환경별 유지 | deploy workflow, production parity/config/refine helpers, .env의 refine/replay/access/operator 설정 | staging New Refine OFF/legacy aggressive, endpoint/DB/token/bucket/pin/수집 정책 불변. .env.example에는 협상용 binary switch 설명만 추가 |
| 미반영(정책 경계) | acquisition/journey/marketing API·DB·admin/dashboard·retention, acquisition workflow | main에만 있던 광고·여정 동의/수집이라는 별도 제품 흐름. 기존 staging 설치/동의/수집 정책을 바꾸지 않도록 import·schema·route·계측까지 일관되게 제외 |
| 미반영(열린 PR) | #201 중복 skin contract 조회 제거; 개인 FBX/CSP/Replay 등 | main에 아직 미병합이므로 포함하지 않음. 기존 PR/head 수정 없음 |
| 생략 | access/schema 끝 빈 줄, 과거 운영 승격 기록 | 동작 차이 없음 또는 운영 기록 |

## 계약과 순서

서버 Converter → BFF → client 순서로 검토/병합한다. BFF는 client가 capability를 확인하고 `solved-state-binary-v2` token을 보낸 경우 binary를 요청한다. 구 Converter/v1 rollback 응답도 검증한다. selectionPreview는 v1이다. runtime revision 변경에 따라 기존 private cache는 재생성되며 final receipt 권한/소유권·선택 검증은 유지한다. 새 DB migration은 없다. BFF/Converter/client 공유 binary reader의 바이트를 비교하고 HTTP/v1/v2 계약 회귀로 확인한다.

## 이번 검증

Node 22 타입 검사·build·전체 suite: 1,164 passed / 2 skipped / 0 failed. 초기 sandbox 실행의 loopback EPERM 2건은 listen 허용 환경에서 전체 재실행하여 통과했다. 추가 Node 20/설정 검사·통합 결과는 아래에 기록한다. 실제 native UI/운영 트래픽/배포 성능은 이 검사로 주장하지 않는다.

main/develop 직접 push·병합·배포·릴리스·AWS 변경 없음. PR base는 develop.

추가 검증: Node20 interactive suite 109/109, staging scene/refine·code-only develop·initializer 설정 회귀 27/27 통과. 세 저장소의 binary 공유 reader SHA256은 모두 `4f249f923166f92294126097561696243e4033e9b42f108a56c13bcc09908530`로 동일하다.

열린 #201 통합 검사: squash 승격으로 이력이 갈라져 전체 브랜치 merge-tree에는 기존 release/환경 파일 충돌이 발생한다. 실제 main 대비 #201 delta는 skin-contract.test/converter skin/interactive service·test의4파일이며, 이 동기화 head에 git apply --check clean이다. 별도 detached 임시 워크트리에만 적용한 Node22 전체 회귀 1,165 passed / 2 skipped / 0 failed. #201은 이번 PR에 포함하지 않았으며 향후 main 병합 후 기능 delta만 별도 동기화해야 한다.

환경 확인: develop 대비 workflows/config/DB/installations/replay/client-version/access/retention/index 경로 byte diff 없음. binary/v1 호환 및 기존 수집·동의 정책 보존.
