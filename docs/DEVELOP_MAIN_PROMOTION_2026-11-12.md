# develop → main 승격 점검 · 2026-11-12

기준: main `a51f294b7ae81a7f14552d10e76978569fc6dc10`, develop `7a3dbcfa4b7493507c85f4e78a5615c82f9f48d9`.

이전 승격이 squash로 쌓여 두 브랜치를 직접 merge하면 이미 운영 중인 코드까지 충돌한다. 마지막 main→develop 동기화 당시의 main `774107918757fbda22cb6e2d51038f5bd9f55475`를 비교 기준으로 삼아 develop 변경과 main 전용 수정사항을 검토하고, 현재 main에서 분기한 승격 브랜치에 결과를 올렸다. develop/main 원본 브랜치는 수정하지 않았다.

- develop의 접근 코드, 진행 정보, 후보 페이지, 새 체형·preview·RC4 계약을 승격한다.
- main의 광고 집계, 선택적 유입 연결, 블로그/방문 경로 대시보드와 관련 schema·retention·라우트·테스트·배포 변수 배선을 보존한다.
- 새 제품 journey panel과 기존 마케팅 journey script의 이름 충돌을 분리한다.
- main의 BFF와 analysis-worker에 `REFINE_RELEASE_ENABLED=0`, `REFINE_V3_SHADOW=false`를 명시한다. legacy refine 노출/저장 설정을 유지한다.

검증: Node 22 typecheck/build. 전체 Node 테스트에서 retention 목록 하나의 누락을 발견해 main의 journey_links 삭제를 복구했고, 관련 28개 회귀 테스트가 통과했다. 두 serving container의 production refine 설정도 독립 검사한다.

## refine와 develop 전용 기능 최종 점검

| 항목 | 이번 production 승격 정책 |
|---|---|
| legacy refine | `REFINE_ENABLED=1`, `REFINE_V2_ENABLED=1` |
| 알고리즘/요청 기본값 | `v2.5.4`, `REFINE_DEFAULT_MODE=aggressive` |
| aggressive 안전 selector | `REFINE_V25_SELECTOR_ENABLED=1` |
| 제한 몸통 | `REFINE_V2_TORSO=0` |
| New Refine RC4 | inference/BFF/worker `REFINE_RELEASE_ENABLED=0` |
| v3 실험 | inference `REFINE_V3_MODE=off`, evidence OFF; BFF shadow OFF |
| staging 전용 배포 | scene worker, anatomy initializer/preset pin, interactive transport 준비는 staging guard를 유지 |

`services/refine_release`의 전용 worker 이미지에는 실행용 ON 기본값이 있지만, production inference 이미지나 BFF가 그 worker로 바뀌지 않는다. 전용 worker 생성/배포도 이번 PR 범위가 아니다. 신형 refine 코드는 포함하되 production에서 광고하거나 호출하지 않는다.

검사 시점 실제 production은 inference task revision 53, BFF revision 59, analysis-worker revision 25였다. `REFINE_ENABLED=1`/BFF 노출 true였고 RC4·v3 override는 없었다. 당시 inference 이미지의 legacy 버전은 v2.5.3이므로 **이 PR 병합·배포 전부터 live가 v2.5.4라고 해석하지 않는다**. 이 문서와 PR 생성은 배포 실행이 아니다.

전체 저장소 점검: server/BFF/client/infra에 승격할 코드가 있다. 랜딩 `04JUNG/Standin`의 develop 트리 `295790a4b4670995233befcba7dd775f2e667f42`는 이미 과거 main `cb2a74bdd6d078a7200ff4d7d3819521426c8144`에 포함돼 새 승격 PR이 필요 없다. `Standin-master-docs`, `demo-repository`에는 develop이 없다.
