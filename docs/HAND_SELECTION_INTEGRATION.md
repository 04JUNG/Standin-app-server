# 손 선택 BFF 연동

기반: 추론 서버 PR 89의 `fcd0a0d`. 추론 서버 담당은 이동원이며 이 변경은 BFF에 한정한다.

## 활성화

`HAND_SELECTION_ENABLED=true`, `FBX_EXPORT_ENABLED=true`, `CONVERTER_BASE_URL`이 필요하다.
기본은 비활성이다. GitHub 환경 변수 `HAND_SELECTION_ENABLED`는 배포 workflow에서 API/worker task로 전달한다.
배포나 운영 변수 변경은 이 구현에 포함하지 않는다.

`capabilities.handSelection`은 추론 카탈로그와 converter `/healthz.hand_library`의
version·SHA-256, solver, framing, 지원 출력 범위가 일치할 때만 true다.
썸네일 조회의 readiness는 5초간 합쳐 쓰고, 최종 변환 전후에는 converter를 새로 확인한다.
자동 인식이 꺼져 있어도 카탈로그와 converter가 준비되면 기본 손을 수동으로 선택할 수 있다.

## 클라이언트 API

모든 경로는 기존 `X-Installation-Id`·`X-Device-Token` 인증을 요구한다.

| 경로 | 용도 |
|---|---|
| `GET /v1/hands/catalog` | 분류·프리셋·한국어 설명·BFF 썸네일 URL·library hash |
| `GET /v1/hands/{preset}/thumbnail?side=left|right` | PNG 중계, ETag/304. side는 캐릭터 기준 |
| `GET /v1/analysis/jobs/{id}/people/{index}/hands` | 추천·최종 손 선택 조회. 첫 조회 시 추천 preset으로 초기화 |
| `PUT /v1/analysis/jobs/{id}/people/{index}/hands` | 양손 또는 한쪽 선택 변경 |

PUT 예시:

```json
{"left":"fist","library_sha256":"<catalog hash>","expectedRevision":0}
```

응답은 `personIndex`, `left`, `right`, `recommended:{left,right}`, `observation`,
`library_version`, `library_sha256`, `revision`, `changed`다. `observation`은 추론의
`status`, 양손 `preset/source/confidence/visible/candidates`를 보존한다.
선택값은 `preset`으로 초기화하며 `candidates[0]`를 사용하지 않는다.

## 영속화와 경합

손 선택은 기존 PostgreSQL `jobs.result_json`의 인물별 `handSelection`에 저장한다.
새 테이블·migration은 없다. 기존 Job 삭제·동의 철회·보관 만료 경로가 손 선택도 지운다.
기존 손 추천은 `people[].hands`에서 BFF `candidatesByPerson[].hands`로 보존한다.

소유 installation과 completed 상태를 Job 행의 `FOR UPDATE` 잠금 안에서 확인한 뒤
JSON을 변경한다. 반대 손과 포즈·출력 범위 등 나머지 결과는 유지한다.
PUT의 `expectedRevision`이 다르면 409로 거절한다. 동일 값을 다시 저장하면 revision은 유지한다.
카탈로그가 바뀐 후 GET은 유효한 선택을 보존하고 없어진 ID만 현재 default로 변경한다.
이때 revision과 library hash를 갱신한다.

## 최종 미리보기와 다운로드

저장된 손이 있으면 `/v1/pose-candidates/{id}/framed`의 요청에
`handSelectionRevision=N`이 필요하다. PNG 미리보기 응답의 `X-Standin-Review-Key`를
동일 조건의 `format=fbx&reviewKey=...` 요청에 보낸다. 기존 체형 모드라면
`bodySelectionRevision` 검증도 함께 적용한다.

추가 응답 헤더:

- `X-Standin-Hand-Revision`
- `X-Standin-Hand-Library-SHA256`
- `X-Standin-Review-Key`
- 기존 `X-Standin-Artifact-SHA256`는 PNG가 아니라 짝인 FBX의 hash다.

손·revision·library hash는 변환 캐시와 review key에 포함된다. 선택된 손은 converter
`hand_left`·`hand_right`로 전달하고 실제 `/convert-framed` 본문의 `hands`에서
left/right/library_version/version을 검증한다. 손이 적용되지 않은 사전 생성 GLB는 사용하지 않는다.
변환 후 소유권·포즈·출력 범위·손·library readiness를 다시 확인한다.

PR 89의 실제 `hands` 요약은 left/right/library_version/version만 반환한다.
설계 예시의 library_sha256·body_bones_preserved 등을 응답에 있다고 가정하지 않는다.
library hash는 변환 전후 health와 추론 카탈로그를 비교하며, 결과물 자체의 hash는
기존 FBX 검증을 유지한다. 변환 응답에 library hash를 직접 포함하는 강화는 추론/converter 담당과 후속 협의할 수 있다.

손이 저장된 작업은 기존 `/export?format=fbx`로 확인 절차를 우회할 수 없다.
`HAND_REVIEW_REQUIRED`를 받고 `/framed`의 최종 확인 경로를 사용한다.
BVH는 기존 동작 그대로이며 손 모양을 굽지 않는다.

| 오류 | 복구 |
|---|---|
| `400 INVALID_HAND_PRESET` | 목록에서 유효한 ID 재선택 |
| `400 INVALID_INPUT` | index·hash·revision·본문 형식 확인 |
| `404 NOT_FOUND` | 다른 설치 소유 작업 또는 없는 인물. 접근 불허 |
| `409 NOT_READY` | 분석 완료 후 선택 |
| `409 HAND_LIBRARY_CHANGED` | 카탈로그와 현재 선택 재조회 |
| `409 HANDS_CHANGED` | 현재 선택·미리보기 재조회 |
| `409 HAND_REVIEW_REQUIRED` | 최종 미리보기 확인 후 다운로드 |
| `503 HAND_SELECTION_DISABLED` / `HANDS_UNAVAILABLE` | 지원 환경·flag·양쪽 library 확인. 손 없는 FBX로 대체하지 않음 |

## 검증 범위

단위/HTTP 테스트는 카탈로그·readiness·소유권·부분 변경·재조회·동시 revision 충돌·
카탈로그 교체·PNG/FBX 캐시·변환 중 손 변경·converter 손 응답 불일치를 확인한다.
실제 Blender 남/여 FBX와 원격 서비스 검증은 PR 89 배포 환경에서 별도로 수행한다.

## 손 PNG 중계 보강 (2026-10-16)

프론트는 썸네일 URL에 `library=<catalog SHA-256>`을 붙인다. BFF는 형식이 잘못되면
400, 현재 카탈로그와 다르면 409 `HAND_LIBRARY_CHANGED`로 거절한다. 카탈로그의
썸네일 미준비 상태는 404 `HAND_THUMBNAIL_UNAVAILABLE`이며 기본 아이콘을 만들지 않는다.
성공한 PNG와 304에는 `X-Standin-Hand-Library-SHA256`을 포함한다. 기존 CORS 노출 목록을 사용한다.
기존 클라이언트의 library 파라미터 없는 요청도 계속 받는다.

실제 추론 PR #89의 manifest와 PNG 158개를 내려받아 해시 대조한 뒤, 로컬에서
`createHandRoutes`를 통해 전부 중계하고 원본 SHA와 다시 비교했다. 프론트 Chrome
검증에서도 실제 PNG와 인물 기준 좌우를 확인했다. BFF 전체 381 pass, 기존 DB 통합 2 skip.
원격 배포, converter FBX 내용과 Tauri 네이티브 저장은 이번 썸네일 검증 범위 밖이다.

## 2026-10-18 신규 후보의 조회 전용 손 미리보기

기존 후보의 위 최종 확인/FBX 계약은 유지한다. 신규 동적·문장 후보는 파일 저장이 금지되어 별도 PNG 경로를 쓴다.
`GET /v1/analysis/jobs/:id/people/:index/pose-previews/:candidate/:sha/hands?revision=N`
은 설치 소유 작업·공개 후보·비공개 자산·BVH SHA·손 revision/library를 확인한 후 PNG만 반환한다.
생성은 비공개 inline BVH를 쓰고 라이브러리 조회하지 않는다. 출력 범위를 유지하며 기본 체형의 정면 참고 렌더다.
변환 전후 소유권·손·scope·library를 다시 확인한다. 요청 중 손이 바뀌면 409로 이미지도 폐기한다.
설치별 6회/분, 최대 4개 동시 변환의 제한된 캐시를 사용한다. 기본 BVH 및 FBX release 정책을 우회하지 않는다.
응답은 X-Standin-Preview-Only=true, X-Standin-Hand-Revision, X-Standin-Hand-Library-SHA256이다.
앱은 명시적으로 후보와 미리보기 버튼을 선택한 경우에만 요청하며 손 revision이 바뀌면 옛 이미지를 숨긴다.
동적 표시 후보는 legacy candidates=[]여도 인물별 손 선택을 저장할 수 있다.
