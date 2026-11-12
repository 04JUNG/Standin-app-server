# 자연어 검색 점진 로딩 (2026-11-04)

## 확인한 원인과 범위

클라이언트 `useSemanticSearch`는 `topK:null`로 BFF를 호출하고 `loadResult`가 끝난 뒤 앱/바 후보 화면으로 이동한다.
BFF `semantic/routes.ts`는 검색 기준을 통과한 정식/근접 후보 전체를 받아, 모든 후보의 BVH를 최대 4개씩 읽어
해시를 계산한 뒤에야 Job을 반환했다. “약 1,000개”는 사용자 체감이며 운영 결과 수를 측정했다고 주장하지 않는다.
전체 라이브러리를 무조건 보여주는 코드가 아니라 검색 기준을 통과한 전체 결과를 반환하는 경로다.
현재 자연어 목록의 조건은 문장이고 별도 카테고리 필터는 없다. 이미지 기반 Top-5는 이 경로와 다르다.

기존 `SemanticCandidateList`는 이미 각 그룹 20개씩 추가했지만, 추가한 카드를 제거하지 않았다.
`DefaultPoseImage`는 이미 viewport 부근 포스터를 지연 요청했으므로, 원래 모든 이미지를 처음부터 다운로드했다고
설명하면 틀리다. 병목은 첫 응답 전에 전체 BVH 준비 + 이미지 동시성 무제한 + 누적 DOM이다.

## 최종 동작

- 전체 검색은 한 번 실행하여 순위·분류·총개수·라이브러리 식별자를 스냅샷으로 고정한다. 검색 품질과 결과 범위를 자르지 않는다.
- 첫 20개만 준비한다. 이후 목록 끝 150px 부근에서 다음 20개를 자동으로 요청한다. 그룹 경계를 넘어도 전체 순서와 각 그룹 순위를 유지한다.
- metadata 페이지는 누적 결과에 병합하되 중복 ID·잘못된 snapshot/job/개수·표시 연결을 거부한다. 페이지 재시도는 앞선 선택을 초기화하지 않는다.
- 카드는 그룹당 최대 60개만 마운트하고 제거된 행의 높이를 유지한다. 포스터 요청은 앱 전체 최대 6개, BVH 확인은 묶음당 최대 4개다.
- 포스터는 viewport 부근에서 요청하고 미사용 캐시는 30초 후 회수한다. 목록에서 Converter나 새 3D 렌더를 호출하지 않는다.
- 입력 변경은 이전 검색과 추가 페이지를 취소하고 늦은 응답을 버린다. 이전 결과를 유지하되 추가 로딩을 멈춘다. 원래 문장으로 돌아가면 이어본다.
- 페이지 실패에는 수동 재시도, 끝에는 마지막 포즈 안내를 표시한다. 큰 wheel·작은 연속 wheel·스크롤 위치/크기 변화로 끝 감지 지점을 지나쳐도 이어간다.

## API와 보관

`GET /v1/semantic-search/capabilities`: `supportsProgressiveResults:true` 추가. 이전 필드는 유지한다.

`POST /v1/semantic-search {query,topK:null,progressive:true}`: 전체 검색 metadata를 한 번 저장하고 첫 20개만 준비한다.
응답은 기존 `{status,jobId}`이며 결과 GET의 `semantic.paging`에 아래 정보가 있다.

```json
{"snapshotId":"UUID","nextCursor":"UUID.20","loaded":20,"total":1000,"matches":965,"near":35,"pageSize":20}
```

`GET /v1/semantic-search/:jobId/pages?cursor=UUID.20`: 기존 결과 형식의 **해당 묶음 후보만** 반환하며
`paging.loaded`/`nextCursor`는 그 묶음 끝을 가리킨다. 결과 GET/기록은 준비된 후보 전체와 다음 커서를 반환한다.

스냅샷 UUID는 작업에 묶이고 커서 offset은 서버가 이미 준비한 위치까지만 허용한다. 건너뛰기·다른 snapshot은 409,
다른 설치/없는 작업은 404다. UUID는 인증 수단이 아니며 매 요청의 설치 소유권을 검사한다.
같은 cursor는 이미 저장된 묶음을 재생하므로 검색/BVH 확인을 다시 하지 않는다. 마지막 cursor는 null이다.
Job 행을 `FOR UPDATE`로 잠그고 신규 후보/비공개 자산 맵/결과 JSON을 한 트랜잭션으로 추가한다.
기존 후보·확정 선택·체형·손·scope 행을 지웠다 다시 만들지 않는다. 실패는 묶음 전체를 롤백한다.
`semantic_snapshots`는 Job FK cascade로 작업/설치 삭제·보관 만료 시 함께 삭제된다.

각 신규 묶음 준비 전후 `/healthz`의 라이브러리 version/content hash를 검색 스냅샷과 비교한다.
식별자가 없거나 바뀌면 `SEMANTIC_SNAPSHOT_CHANGED`를 반환한다. 같은 content hash의 라이브러리는 불변이어야 한다.
서로 다른 라이브러리를 같은 주소 뒤에 섞는 rolling deployment에서 개별 BVH 응답 자체의 version attestation까지
보장하는 계약은 현재 추론 API에 없으므로, 버전별 upstream routing/immutable deployment가 필요하다.
각 준비된 후보의 실제 BVH SHA와 이후 포스터/저장 권한 검사는 기존 경계를 그대로 사용한다.

## 검증과 수치 해석

1,000개(정식 965 + 근접 35)는 **통제된 로컬 fixture**다. 실제 제품 `PoseViewerPage`/`BarCandidatesPage`,
실제 목록/포스터 HTTP adapter와 로컬 저장 PNG를 사용했다. 순위·ID·헤더는 fixture이므로 검색 품질 인증 자료가 아니다.
운영 API·유료 API·배포는 실행하지 않았다.

| 확인 항목 | 변경 전 develop | 변경 후 |
|---|---:|---:|
| 첫 응답 전에 확인하는 BVH (fixture 1,000개) | 1,000 | 20 |
| 초기 클라이언트 후보 metadata | 1,000 | 20 |
| 첫 이미지 요청 (1280×800 앱) | 15 | 15 |
| 첫 이미지 요청 (850×640 바) | 별도 비교 안 함 | 10 |
| 이미지 최대 동시 요청 (앱 traversal) | 20 | 6 |
| 끝까지 이동 후 마운트된 카드 (두 그룹 합계) | 1,000 | 최대 75 |
| 추가 metadata 요청 | 없음 | 20개당 GET 1회 (취소/실패는 재시도 가능) |

첫 검색의 기능별 클라이언트 제어 요청은 capabilities GET + search POST + result GET이고, 초기 페이지 GET은 0회다.
BFF 검색/BVH 경로는 upstream 검색 1회 + 첫 BVH 20회 + 라이브러리 확인 2회다.
추가 묶음은 client GET 1회 + BVH 최대 20회 + 라이브러리 확인 2회다. 포스터는 보이는 수만 요청한다.
제품의 기존 analytics/선택/카탈로그 등 다른 요청을 위 숫자에 포함하지 않았다.
스크롤을 건너뛰면 방문하지 않은 이미지가 요청되지 않으므로 전체 이미지 수는 스크롤 속도에 따라 달라진다.
이 수치는 실서비스 지연 시간이나 몇 배 빨라졌다는 주장이 아니다. upstream 전체 검색 계산/metadata 전달은 남아 있다.

검증: TypeScript/production build/lint, 검색/페이지/포스터/선택 회귀, PGlite 실제 SQL의 순서·중복·소유권·삭제·재생·그룹 경계,
headless Chrome의 전체화면/바에서 1,000개 도달·재시도·늦은 응답 차단·기존 선택 복원.
macOS headless Chrome에서 크고 작은 wheel 이벤트를 주입했다. 물리 트랙패드/마우스, Windows, native Tauri는 검증하지 않았다.
실제 PostgreSQL 다중 인스턴스 경합은 별도 검증 범위이며 테스트는 PGlite 트랜잭션을 사용한다.
Node 26에서는 `NODE_OPTIONS=--no-experimental-webstorage npm test`로 jsdom 저장소와의 충돌을 피했다.

## 배포/관련 작업

BFF migration + API를 먼저 반영하면 새 클라이언트가 capability를 보고 점진 로딩을 사용한다.
새 클라이언트와 구 BFF 조합은 기존 전체 JSON 계약으로 동작하며 DOM/이미지 제한만 먼저 개선된다.
첫 BVH 병목 개선에는 BFF 반영이 필요하다. 이 변경에서 운영 배포나 merge는 하지 않았다.

미병합 3D PR client #173 / BFF #154 / server #167에 의존하지 않는다. 해당 커밋을 cherry-pick하지 않았다.
공통 수정 파일은 client `pose.contract.ts`, `pose.http.ts`; BFF `db.ts`, `retention.ts`, `package.json`, `docs/API.md`다.
나중에 합칠 때 additive 타입/스키마/retention/스크립트 항목을 모두 유지해야 한다. 큰 3D 화면/렌더러는 수정하지 않았다.
동시에 진행 중인 전체화면 3D 작업이 `PosePresentationPanel`을 바꾸면 목록 호출의 `telemetryJob`와
`SemanticResultList` 연결, 안정적인 job/group key를 함께 유지해야 한다.
