import assert from "node:assert/strict";
import test from "node:test";
import { DASHBOARD_HTML } from "./dashboard.js";
import {
  COCO17_EDGES,
  COCO17_KEYPOINT_NAMES,
  JOINT_SCORE_FAINT,
  PERSON_COLORS,
} from "./skeleton.js";

test("관절 이름은 COCO-17 개수와 같다", () => {
  assert.equal(COCO17_KEYPOINT_NAMES.length, 17);
});

test("모든 뼈가 존재하는 관절을 잇는다", () => {
  for (const edge of COCO17_EDGES) {
    assert.ok(edge.a >= 0 && edge.a < 17, `관절 번호 밖: ${edge.a}`);
    assert.ok(edge.b >= 0 && edge.b < 17, `관절 번호 밖: ${edge.b}`);
    assert.notEqual(edge.a, edge.b);
  }
});

test("같은 뼈를 두 번 그리지 않는다", () => {
  const keys = COCO17_EDGES.map((edge) => [edge.a, edge.b].sort((x, y) => x - y).join("-"));
  assert.equal(new Set(keys).size, keys.length);
});

test("몸통 뼈대가 이어져 있다", () => {
  // 어깨-엉덩이가 끊기면 사람 모양이 아니라 떠 있는 팔다리로 보인다.
  const has = (a: number, b: number) =>
    COCO17_EDGES.some((edge) => (edge.a === a && edge.b === b) || (edge.a === b && edge.b === a));
  assert.ok(has(5, 6), "어깨");
  assert.ok(has(11, 12), "엉덩이");
  assert.ok(has(5, 11), "왼쪽 몸통");
  assert.ok(has(6, 12), "오른쪽 몸통");
});

test("좌우 뼈 수가 같다", () => {
  const left = COCO17_EDGES.filter((edge) => edge.side === "left").length;
  const right = COCO17_EDGES.filter((edge) => edge.side === "right").length;
  assert.equal(left, right);
});

test("흐리게 그리는 기준은 0과 1 사이다", () => {
  assert.ok(JOINT_SCORE_FAINT > 0 && JOINT_SCORE_FAINT < 1);
});

test("인물 색은 서로 다르다", () => {
  assert.equal(new Set(PERSON_COLORS).size, PERSON_COLORS.length);
});

test("대시보드가 그 상수를 그대로 심는다", () => {
  // 화면용 사본을 따로 적으면 관절 순서가 조용히 어긋난다.
  assert.ok(DASHBOARD_HTML.includes(JSON.stringify(COCO17_EDGES)));
  assert.ok(DASHBOARD_HTML.includes(JSON.stringify(COCO17_KEYPOINT_NAMES)));
  assert.ok(DASHBOARD_HTML.includes(JSON.stringify(PERSON_COLORS)));
});

test("대시보드는 토큰을 심지 않는다", () => {
  assert.ok(!DASHBOARD_HTML.includes("X-Beta-Admin-Token: "));
  assert.ok(DASHBOARD_HTML.includes("sessionStorage"));
});
