# 최종 미리보기·FBX 준비 조회 복구

## 관찰과 수정 범위

사용자가 전달한 운영 2.10.2 검수 결과: 준비 접수는 202, 중간 상태 조회는 503,
서버 준비는 약 180초에 완료(503 이후 약 51초). 기본 스킨에서도 재현되며
완성 FBX는 다운로드·해시·Blender 재로드 검사를 통과했다고 보고되었다.
CloudWatch에서 같은 사례를 확인했다. 2026-11-12 09:24:52.788Z 준비 시작,
09:27:01.614Z 상태 GET 3건 503, 09:27:52.525Z preview 준비 완료(179869ms)다.

확인한 코드에서 `InteractiveController.run`은 상태 GET 실패를 최상위 catch로
전달해 화면의 `exportState`를 `failed`로 만든다. BFF `current`는 매 조회마다
선택·원본·체형·런타임을 재검증하며, 외부 의존성 실패는 503이 될 수 있다.
503만으로 서버 작업의 실패나 취소를 판단할 수 없다.

운영 릴리스 `v2.10.2`는 클라이언트 `165f7ddf86ad4996dad9f5a9245a3d3c658e873d`다.
실행 중인 BFF task revision 68은 `6acf5afd9166d3f657d4e24465b4b306cf62bb57`,
Converter task revision 12는 `8087bdabbd868de5bcd07cb954bf35032858eacc`다.
처음의 로컬 수정 기준(`b4096d8`/`7a3dbcf`)과 차이를 검토하고 위 운영 커밋에
수정을 이식했다. 최신 modelBinding/poseBinding, skin 및 protocol gate를 보존한다.
클라이언트 배포 버전은 기존 릴리스를 덮어쓰지 않는 2.10.3이다.

503 시점 BFF CPU 최대 99.8%, 메모리 최대 60.9%였으며 다음 준비 중에는
CPU 평균 97.1%/최대 99.8%도 관측됐다. solve 응답 시작 후 BFF ready까지
약 38초의 간격이 있어 패킷 파싱/검증 부하를 의심하나, 단계 계측 없이
그 간격 전체를 한 함수의 계산 시간으로 단정하지 않는다.

## 클라이언트 복구 계약

- 접수된 operation의 GET만 429/502/503/504 및 정규화된 네트워크 오류에서 재시도한다.
- 동일 operationId, revision, selectionHash를 유지하며 prepare POST나 cancel을 보내지 않는다.
- 1→2→4→8초 백오프에 ±20% 지터를 적용하고 Retry-After를 존중한다.
- 단일 조회는 15초, 연속 조회 복구는 120초, 전체 폴링은 10분 또는 operation 만료까지다.
  시간 초과는 서버 작업을 취소하지 않고 재시도 가능한 안내를 표시한다.
- 복구 상한 이후 사용자가 재시도하면 head를 조회해 기존 작업을 우선 이어받는다.
- 선택 변경·취소는 대기와 요청을 중단한다. 인증/권한/409/410, 기능 비활성화,
  무결성 오류, 서버가 명시한 실패·superseded 상태는 자동 재시도하지 않는다.

## 관측 필드

모든 시간은 밀리초다. 데이터 본문·토큰·BVH·3D 패킷은 로그에 기록하지 않는다.

| 이벤트 | 의미 |
| --- | --- |
| `interactive_poll` | BFF 상태 GET 전체 시간, status, requestId, operationId |
| `interactive_request_failed` | BFF 오류 응답의 코드와 requestId/operationId |
| `artifact_revalidate` | 원본·체형·런타임 및 소유권 재검증 시간, operationId/revision |
| `artifact_converter_solve/export` | Converter 호출과 응답 파싱을 포함한 BFF 대기 시간 |
| `interactive_converter_transport` | headersMs, bodyMs, responseBytes, complete 및 Converter의 queue/execution 헤더 |
| `interactive_converter_json` | 응답 JSON 파싱 시간과 바이트 수 |
| `artifact_packet_validation` | BFF의 canonical 패킷 검증 시간 |
| `artifact_prepare_started/ready/failed/cancelled` | 작업 단계 시간과 operationId/revision |

Converter는 기존 WorkMiddleware에서 `X-Standin-Queue-Wait-Ms`와
`X-Standin-Execution-Ms`를 반환한다. BFF는 이를 `converterQueueMs`,
`converterExecutionMs`로 기록하며, 헤더가 없거나 유효하지 않으면 생략한다.
0으로 대체하거나 headersMs 전체를 Blender 계산 시간으로 해석하지 않는다.
BFF가 보내는 `req_<uuid>` 형식의 X-Request-Id로 Converter 측 로그와 연결한다.
성공한 상태 조회에는 `Server-Timing: bff_poll;dur=...`, 503에는 `Retry-After: 1`을 반환한다.

큰 패킷 파싱·반복 재검증이 병목이라는 가설은 아직 확정하지 않았다.
이 변경은 검증을 생략하거나 캐시 유효성·선택 계보 검사를 약화하지 않는다.
우선 operationId별 위 시간을 비교해 대기열/계산/전송/파싱/검증을 구분한다.

## 검증 및 운영 재검수

클라이언트: `npm run typecheck`, `npm test -- src/features/pose-viewer/interactive/controller.test.ts src/features/pose-viewer/interactive/pollRecovery.test.ts src/features/pose-viewer/interactive/http.test.ts src/shared/api/errors.test.ts`.
BFF: `npm run typecheck`, `npm run test:interactive`.

회귀 사례에는 180초 준비 중 129초 시점부터 51초간 503, 조회 중 선택 변경,
연속 장애 상한, 응답하지 않는 transport, Retry-After, 만료, 수동 복구,
BFF 503 이후 동일 작업 완료가 포함된다. 시간 기반 사례는 fake timer/fixture 검증이다.

배포 후 기본 스킨과 살색 각각에서 실제 요청으로 다음을 확인해야 한다.

1. 준비 POST 한 번 후 상태 조회에 503을 주입해도 기존 operation을 유지한다.
2. 서버 완료 뒤 미리보기와 FBX가 같은 revision/해시로 제공된다.
3. 작업별 BFF/Converter 시간을 수집하고 503 코드·requestId와 연결한다.
4. 다운로드 해시 및 Blender 재로드를 다시 검사한다.

로컬 회귀 통과만으로 운영 최종 검수를 합격으로 바꾸지 않는다.
