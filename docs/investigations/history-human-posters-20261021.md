# 작업 기록·대시보드 구형 종이인형 썸네일 조사 (2026-10-21)

## 실제 두 항목

사용자 캡처의 04:01(인물 2명·선택 없음), 04:29(인물 2명·선택 완료)와 일치하는 운영 작업을 읽기 전용 트랜잭션으로 확인했다. 조회는 해당 두 시간대만 제한했으며 입력 이미지·인증정보는 수집하지 않았다.

각 작업에서 기존 작업 기록 SQL과 동일한 ‘확정 선택 우선, 없으면 첫 인물의 1순위’ 규칙으로 대표 후보를 확인했다. 운영 추론 HTTP 응답의 SHA와 보존된 배포 번들의 이미지 SHA가 모두 일치했다. 구형 JPEG를 직접 열어 캡처의 두 종이인형과 동일한 모양을 확인했다.

| 한국 시간 | 대표 pose ID | 기존 `/thumbnail` | 새 `/poster` |
|---|---|---|---|
| 04:01 | `cmu_143_13_00442_mirror` | HTTP 200, JPEG 7,220 bytes | HTTP 200, PNG 31,518 bytes, `default-body` |
| 04:29 | `a1_open_arms_explain` | HTTP 200, JPEG 6,287 bytes | HTTP 200, PNG 17,271 bytes, `default-body` |

## 확인된 원인

- 작업 기록의 `toHistoryItem`은 기존 `/thumbnail?view=...` URL을 반환했다.
- 대시보드 후보 상세와 라이브러리 갤러리도 관리자 `/thumbnail?view=...` 프록시를 사용했다.
- 기존 라이브러리 `thumbs/` JPEG는 보존되어 있었다. 새 인체 PNG는 별도 `pose-posters/`에 있으므로 `/thumbnail`을 계속 요청하면 기존 그림이 정상 HTTP 200으로 반환된다.
- 두 포즈 모두 새 PNG가 실제로 존재하고 `reference-skinning-v1`, 원본 BVH SHA·템플릿·이미지 해시가 정상이다. 누락 자산이나 tar.gz/S3 형식 오류가 아니다.
- 기존 응답의 `Cache-Control: private, max-age=86400`은 구형 그림을 유지할 수 있지만, 캐시 없이 직접 요청해도 종이인형 JPEG를 받았다. 따라서 브라우저 캐시만의 문제로 볼 수 없다. 해당 앱의 개별 캐시 적중 여부까지 판정한 것은 아니다.

## 변경

- 사용자/관리자 인증 아래에 공통 `/reference-thumbnail` 읽기 경로를 추가한다.
- 서버가 등록·격리 검사를 통과한 BVH SHA를 계산하고 기존 검증기로 정면·전신 인체 포스터의 해시·종류를 검증한다.
- `pose-only`와 누락/손상 자산은 404로 처리한다. 구형 JPEG나 관절 그림으로 폴백하지 않는다.
- 작업 기록 URL은 `revision=human-poster-v1`을 사용하고 설정된 이미지/배포 revision도 `assetRevision`으로 추가한다. 기존 URL과 분리되므로 예전 캐시가 재사용되지 않는다.
- 응답은 `private, no-store`; 대시보드 이미지 fetch도 `cache: no-store`로 요청한다.
- 대시보드 후보·라이브러리 갤러리·확대에 인체 참고를 표시한다. 현재 인체 자산은 정면만 있으므로 갤러리 확대는 ‘기본 인체 · 정면 참고’ 한 장으로 명시한다. 기존 시점별 썸네일 API는 유지한다.
- DB·자산·선택 결과를 변경하거나 Converter/렌더 작업을 시작하지 않는다. 이 변경은 최종 산출물의 체형·손·범위를 뜻하지 않는다.

## 운영 응답 증거

### `cmu_143_13_00442_mirror`

- 원본 BVH SHA: `4720b31f8cd339f195c2b04284f7852a6214782e2ada8ff7c063252dd03651ac`
- legacy 이미지 SHA: `6215e9cdcf56a9631d85301f7f30e3b85a62f4af681cfebf2dbc19890e071314`
- poster 이미지 SHA: `d20fd9ece70cf3cb7fbcb66e40541c4689c7cf6ac46eb5d036c952addd085f9c`

### `a1_open_arms_explain`

- 원본 BVH SHA: `6f6b41802707da6e4899439a9f8da326f9d7c4130ca7e7276b7f11bef92b695e`
- legacy 이미지 SHA: `222c853663718cf2d52b70c22165c14a712a9289d024c252cc658673ccd6459e`
- poster 이미지 SHA: `5e5ef71996d5c0f65856a5694ad687a3db435e3e2f92514efd7feb3302257af0`

## 검증의 범위

실제 운영의 기존 이미지·새 포스터 HTTP 비교와 오프라인 이미지 모양 확인을 수행했다. 변경 코드의 네트워크/검증/인증/대시보드 로더 동작은 로컬 테스트로 확인한다. 이 PR을 운영에 적용하거나 설치 앱 E2E를 완료했다는 뜻은 아니다.
