# 손 라이브러리·직접 문장 검색 통합 (2026-10-18)

기존 로컬 통합 커밋 5699953을 develop 2aca771 위에서 이어갔다.
최신 추론 PR #96(develop 6411c129)과 기존 손 PR #89 계약을 사용한다.
기존 체형 수치 굽기·동적 표시 계약·구버전 서버 동작을 보존한다.

문장 입력→정식/근접 후보 표시→실제 BVH 관절 미리보기→인물 기준 손 선택→조회 전용 손 렌더가 새 흐름이다.
신규 후보의 자동 적용·refine·export·release 금지는 유지한다. 손 선택은 이 권한을 승격하지 않는다.
기존 안전한 구형 후보의 최종 FBX 손 선택 흐름은 기존 정책 아래에서 유지한다.

- 손 카탈로그·좌우 PNG·선택 저장은 기존 hands 모듈을 재사용한다.
- 추론·converter의 library version/SHA/solver/framing 일치 후 capability를 연다.
- 손 reference PNG는 기본 체형·정면 참고 렌더다. 원래 검색 카메라·실메시 안전 인증으로 표시하지 않는다.
- 생성 BVH는 inline 원본을 사용하고 라이브러리 pose ID를 만들지 않는다.
- 쿼리·새 개인 데이터·자격증명·비공개 BVH 자산을 로그나 Git에 넣지 않는다.
- feature flags는 기본 false다. staging readiness 확인 후 staging GitHub environment 변수로만 활성화한다.

상세 계약은 HAND_SELECTION_INTEGRATION.md, SEMANTIC_SEARCH_INTEGRATION.md에 있다.
