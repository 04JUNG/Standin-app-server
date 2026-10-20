// 뼈대 그리기에 쓰는 COCO-17 상수. 대시보드 HTML에 그대로 심어 브라우저가 쓴다.
//
// 추론 응답의 `skeleton.schema_version`은 `coco17-v1`이고 관절 순서는 COCO의 표준
// 순서다. 순서가 틀리면 사람 모양이 아니라 엉킨 선이 나오므로 이름표를 함께 둔다 —
// 화면에서 관절에 마우스를 올리면 이 이름이 뜬다.

export const COCO17_SCHEMA = "coco17-v1";

export const COCO17_KEYPOINT_NAMES = [
  "코",
  "왼눈",
  "오른눈",
  "왼귀",
  "오른귀",
  "왼어깨",
  "오른어깨",
  "왼팔꿈치",
  "오른팔꿈치",
  "왼손목",
  "오른손목",
  "왼엉덩이",
  "오른엉덩이",
  "왼무릎",
  "오른무릎",
  "왼발목",
  "오른발목",
] as const;

/**
 * 뼈 하나는 관절 두 개를 잇는다. `side`는 색을 가르는 용도다.
 *
 * 좌우를 색으로 가르는 이유: 러프에서 좌우가 뒤집힌 추출은 거리가 멀어 보이지 않고
 * "그럴듯한 다른 포즈"로 보인다. 왼쪽이 한 색으로 모여 있지 않으면 눈에 띈다.
 */
export const COCO17_EDGES: ReadonlyArray<{ a: number; b: number; side: "left" | "right" | "center" }> = [
  { a: 15, b: 13, side: "left" },
  { a: 13, b: 11, side: "left" },
  { a: 16, b: 14, side: "right" },
  { a: 14, b: 12, side: "right" },
  { a: 11, b: 12, side: "center" },
  { a: 5, b: 11, side: "left" },
  { a: 6, b: 12, side: "right" },
  { a: 5, b: 6, side: "center" },
  { a: 5, b: 7, side: "left" },
  { a: 6, b: 8, side: "right" },
  { a: 7, b: 9, side: "left" },
  { a: 8, b: 10, side: "right" },
  { a: 0, b: 1, side: "left" },
  { a: 0, b: 2, side: "right" },
  { a: 1, b: 2, side: "center" },
  { a: 1, b: 3, side: "left" },
  { a: 2, b: 4, side: "right" },
  { a: 3, b: 5, side: "left" },
  { a: 4, b: 6, side: "right" },
];

/**
 * 이 점수 아래의 관절은 흐리게 그린다. 지우지는 않는다.
 *
 * 추출이 애매한 관절이야말로 공백의 단서라서, 보이지 않으면 "왜 이 후보가 나왔는지"를
 * 설명하지 못한다. 검색이 쓰는 임계값과는 무관한 **표시 전용** 값이다.
 */
export const JOINT_SCORE_FAINT = 0.3;

/** 인물마다 다른 색. 한 컷에 여러 명이 겹칠 때 누구의 뼈대인지 가른다. */
export const PERSON_COLORS = ["#4dabf7", "#f783ac", "#38d9a9", "#ffd43b", "#b197fc", "#ff922b"];
