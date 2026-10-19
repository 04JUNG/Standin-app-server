# 수동 포즈 검수와 파일 저장 — 2026-10-19

문제: 손 검사 오류/근접 참고만 있는 러프와 직접 문장 검색은 실제 등록 BVH를 보여주면서도
자동 품질 판정의 `release_allowed=false`를 파일 저장 금지로 해석해 작가가 결과를 사용할 수 없었다.

## 계약

- `manualExportAllowed=true`는 BFF가 저장된 소유 작업에 부여하는 별도 수동 권한이다.
  요청 body/query의 동명 값은 읽지 않는다. 라이브러리 원본·실제 미러·근접·기하·구도 참고와
  직접 문장 검색의 등록 자산에 한한다. `lookupAllowed`, `bvhAvailable`, `reviewRequired`와
  64자 원본 SHA가 필요하며 `refineAllowed=false`를 유지한다.
- 기존 `releaseAllowed=false`, `actualMeshValidated=false`, 검색/손 검사 실패, 반대손 참고라는
  의미를 보존한다. 수동 선택을 검색 통과나 정확도 보장으로 바꾸지 않는다.
- `presentationKind`는 원래 그룹 의미를 유지한다. presentation의 public 정책은 그대로이고
  동일 ID의 `candidates`가 수동 선택 가능 여부를 제공한다. semantic도 같은 presentation ID를 사용한다.
- hash-bound BVH가 없는 구형 dynamic 조회 결과와 inline 생성 후보는 새 권한을 받지 않는다.
  생성 실패·잘못된 해시·소유권/보관 만료·격리된 자산을 사용 가능으로 바꾸지 않는다.

## 검수 → 저장

1. 기존 selections PUT으로 후보를 직접 선택·확정한다.
2. 기존 framed route의 `format=preview|model`로 최종 체형·shape·손·scope와 카메라를 확인한다.
   bodySelection의 `previewOnly`는 카탈로그 후보 coverage와 분리된 body context이고,
   명시적 수동 후보의 최종 파일 저장을 일괄 차단하는 조건으로 사용하지 않는다.
3. 응답 `X-Standin-Review-Key`를 같은 후보·설정의 `format=fbx`에 보낸다.
   `previewType=model`은 실제 확인한 GLB/FBX 쌍을 사용한다. 기존 Converter의
   `/convert-framed-export` alias와 PNG/model 쌍 검증을 그대로 사용한다.
4. `X-Standin-Artifact-SHA256`는 FBX 해시, `X-Standin-Preview-Artifact-SHA256`는 PNG/GLB 해시다.
   원본 BVH/체형 해시도 반환하며 CORS에서 이 헤더를 노출한다.

직접 `/export?format=fbx`는 수동 후보에 `MANUAL_REVIEW_REQUIRED`를 반환해 최종 검수를 요구한다.
원본 `/export?format=bvh`도 확정 선택이 필요하다. BVH에는 체형/손/메시 크롭을 구워 넣지 않는다.
정확한 체형·손·출력 범위가 필요한 저장은 framed FBX를 사용한다.

소유권·후보·확정 선택을 매번 읽고 실제 원본 GET과 해시를 렌더 및 캐시 반환 시점에 확인한다.
체형 revision·shape/source·손 revision·scope·runtime·카메라·원본/모델 identity가 바뀌면
이전 결과/검수 키를 거절한다. 자동 Converter 카드 렌더를 되살리지 않는다.

## 기존 작업과 DB 일관성

`getOwnedJob`에서 구형 completed presentation 작업을 다시 열면 같은 소유자 조건으로 job 행을
`FOR UPDATE` 잠근다. 손/범위 쓰기도 이 행을 잠그므로 사이에 바뀐 사용자 설정을 덮어쓰지 않는다.
잠금 안에서 최신 JSON과 analysis_people의 비공개 자산을 다시 읽는다. library transport,
pose ID, candidate ID, hash, camera, 원래 정책이 일치하는 행만 수동 후보로 재구성한다.
후보 `analysis_candidates` UPSERT와 result JSON 갱신은 한 transaction으로 완료한다.
선택 PUT도 이 보강을 선행하여 화면에는 보이지만 DB 확정이 실패하는 상태를 만들지 않는다.
새 `manualExportVersion=1`은 이 보강이 끝난 결과를 표시하며 재분석/VLM/Blender 호출을 하지 않는다.

현재 라이브러리 등록·격리·실제 바이트는 최종 render/export의 inference GET에서 다시 검증한다.
비공개 바인딩이 없거나 불일치하는 오래된 행은 권한을 받지 않는다. 구형 semantic 후보 ID는
presentation ID로 통일되므로 이전 확정 선택은 사용자가 다시 확정해야 한다.

## 검증

`npm test`: 기존 회귀 + manual-export 28개 케이스. library/near/geometry/framing/mirror,
semantic PNG/GLB→FBX, 기본/선택 체형, 손 변경, 검색 실패 보존, 명시 확정과 잘못된 reviewKey,
렌더 중 권한·원본·격리·revision 변경, 직접 refine 차단, 요청 권한 주입 차단,
구형 near-only/semantic의 비공개 자산 기반 보강과 소유권/삭제/미완료 거절을 확인한다.
no-body warm cache에서 runtime/캐릭터/model revision 변경 시 재렌더와 이전 검수 키 거절,
원본 BVH를 읽는 중 확정 취소·권한/후보/소유권 철회 시 파일을 버리는 실제 route도 검증한다.
DB transaction 동작은 query double로 검증하며 기존 실제 Postgres 통합 테스트는
테스트 DB를 설정했을 때 실행된다. 로컬 route/fixture 검증은 staging/설치 앱 E2E와 구분한다.


실제 Converter/Blender와 변경 BFF의 Hono route를 연결한 로컬 HTTP 검증에서도
near 원본·semantic 실제 mirror × full 기본 체형·half 선택 체형+fist/relaxed 손의 4개 조합이
PNG 검수→reviewKey→동일 FBX 바이트 다운로드를 통과했다. 각 조합은 Converter 1회 호출,
미확정·이전 reviewKey 409, 원본/체형/손/scope 해시 보존을 확인했다.
작업 소유권/DB 확정은 fixture이며 staging/설치 앱 검증으로 보고하지 않는다.
손의 self_collision_free=false와 검색 partial_error는 그대로 유지했다.
