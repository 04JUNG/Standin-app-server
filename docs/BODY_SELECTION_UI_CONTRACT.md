# 체형 선택 UI·최종 확인 계약 — 2026-10-08

기반: 기존 푸시 `codex/body-preview-integration@5bdbe2f`. 클라이언트 `codex/body-selection-ui`와 연결한다.
기존 1~2단계 계약은 BODY_PREVIEW_DESIGN.md를 따른다.

## 활성화

`BODY_SELECTION_ENABLED=true`, `BODY_UX_ENABLED=true`, converter 설정이 모두 있어야 전체 UX capability `bodyPreviews`를 켠다.
BODY_UX_ENABLED 기본값은 false. 실제 자산 준비 여부를 보장하는 flag가 아니다.
설정 GET/PUT과 후보 bodyPreviews 및 body 모드 최종 렌더는 동일한 bodyUxAvailable 조건을 사용한다. BODY_SELECTION_ENABLED만 켠 단계에서는 설정 API도 BODY_SELECTION_DISABLED(503)를 반환하고 클라이언트는 구 설정 화면을 유지한다. 저장된 설정을 삭제하지 않으며 내부 Job snapshot/선택 저장 기능은 독립적으로 준비할 수 있다.
result의 후보가 있는 인물에 bodySelection snapshot이 없으면 구 Job으로 취급하여 bodyPreviews=false다.

## 최종 PNG/FBX

기존 인증된 경로를 확장한다.

```
GET /v1/pose-candidates/{poseId}/framed
  ?jobId=...&personIndex=...&candidateId=...
  &outputScope=full|half|bust|head
  &format=preview
  &bodySelectionRevision=N
```

bodySelectionRevision이 있으면 저장된 BodySelection의 revision·ready 상태·BodyRef를 검증한다.
characterId는 서버 resolvedBody에서 가져온다. query에 다른 characterId를 실으면 409다.
camera 계약 없는 후보는 BODY_PREVIEW_UNSUPPORTED로 거절한다.

응답에 추가하는 헤더:

- X-Standin-Review-Key: 현재 소유권·Job·인물·후보·최종 BVH hash·체형 전체 버전·scope·camera·runtime·FBX hash로 계산.
- X-Standin-Body-Revision
- X-Standin-Character-SHA256
- X-Standin-Source-BVH-SHA256
- 기존 X-Standin-Artifact-SHA256는 **FBX bytes** hash다. PNG bytes hash가 아니다.

`format=fbx` 요청은 같은 query와 `reviewKey`가 필수다.
누락은 BODY_REVIEW_REQUIRED(409), 변경은 BODY_PREVIEW_STALE(409)이다.
인증 토큰을 대체하지 않으며 매 요청 소유권과 포즈 확정을 다시 검증한다.

변환에는 expectedCharacterSha256/expectedPreviewRevision을 전달한다.
캐시 적중에도 원본 BVH 격리·hash를 확인하고, 렌더 완료 후 체형·runtime·camera·최종 refine hash·scope·포즈 확정을 재확인한다.
PNG/FBX는 같은 paired artifact cache를 사용한다.
캐시 만료 후 재생성한 FBX의 bytes가 달라지면 재확인을 요구한다.
이 경로는 확인했던 bytes를 다른 결과로 조용히 대체하지 않는다.

bodySelectionRevision이 없는 구 클라이언트 요청은 기존 계약을 유지한다.
새 UX는 이 레거시 경로를 사용하지 않는다. 구 클라이언트까지 저장 계약을 강제하는 마이그레이션은 별도다.

## 차렷 카드

승인 BodyAsset에 optional 메타데이터를 추가한다.

```json
{
  "displayName": "표시할 체형 이름",
  "neutralPreview": {
    "path": "/approved/assets/body-neutral.png",
    "sha256": "<PNG SHA256>",
    "characterSha256": "<동일 BodyAsset.assetSha256>",
    "pose": "attention",
    "framing": "body-comparison.v1"
  }
}
```

운영자가 승인한 절대 경로만 읽으며 path를 클라이언트에 전달하지 않는다.
신규 포즈/모델을 임의 승인하지 않는다.
공통 카메라·바닥선·축척의 차렷 렌더를 준비해야 한다. 체형마다 자동 확대해 키 차이를 지우지 않는다.

body-options에는 displayName과 neutralPreview의 url/sha256/characterSha256/pose/framing을 반환한다.
URL은 `/v1/models/{characterId}/body-preview/{pngSha256}`이며 설치 인증 뒤에서 제공한다.
PNG magic·2MiB 상한·파일 SHA256과 승인 manifest의 일치를 검사한다.
이미지가 없으면 이 필드를 생략한다. 클라이언트는 준비 중으로 표시한다.

## 검증

기존 실제 PostgreSQL 저장/미리보기 테스트 외에 bodyFraming.test.ts를 추가했다.

- 확인한 동일 보정 BVH와 체형으로 다운로드.
- 확인 없는 FBX 요청/다른 체형 query 거절.
- 변환 도중 체형·runtime·refine·소유권 변경 거절.
- 캐시 적중 후 revision·asset hash·runtime·refine·scope·소유권·포즈 확정·격리 변경 거절.
- 실제 렌더는 fixture converter이며 실제 9종 FBX 외형 QA는 포함하지 않는다.

기능 PR에서 검토하며 운영 flag 활성화·배포는 별도다.

최종 검증: 전체 305개 통과, skip 0. typecheck/build 통과.

## 디자인 단서 기반 기본 체형

감지의 `auto_presentation_default`는 mock 아님, 인물 소유권 명확, provider 오류 없음, visible feminine/masculine, compatible_candidates, 관측값/진단값 일치 및 face_design/body_contour 근거를 검증한 후 승인 자산·지원 포즈 조건을 통과해야 추천으로 전달한다. reasonCodes에 `presentation_supported_shape_default`를 남긴다. 일반 auto_default는 기존처럼 추천으로 승격하지 않는다. manual/fixed_default는 우선하고 명시적 auto는 추천을 선택한다.
