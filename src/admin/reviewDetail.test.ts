import assert from "node:assert/strict";
import test from "node:test";
import {
  outputScopesFromResult,
  parseBox,
  parseScores,
  parseSkeleton,
  parseTags,
  pickJointScores,
  toReviewPeople,
  toReviewPerson,
  type AnalysisPersonRow,
} from "./reviewDetail.js";

const KEYPOINTS = Array.from({ length: 17 }, (_, index) => [index * 10, index * 5]);
const SCORES = Array.from({ length: 17 }, () => 0.8);

function row(overrides: Partial<AnalysisPersonRow> = {}): AnalysisPersonRow {
  return {
    person_index: 0,
    bbox_json: "[120,80,360,720]",
    tags_json: JSON.stringify({ shot: "full_half", action: "standing" }),
    skeleton_json: JSON.stringify({ schema_version: "coco17-v1", keypoints: KEYPOINTS, scores: SCORES }),
    confidence: "high",
    candidate_count: 5,
    candidate_shortfall_reason: null,
    skeleton_state: "valid",
    skeleton_source: "full_image",
    coverage_class: "full",
    fallback_mode: "none",
    slot_origin: "vlm",
    lower_body_observed: true,
    refine_allowed: true,
    refinable_limbs_json: '["left_arm","right_arm"]',
    raw_scores_json: JSON.stringify(SCORES),
    ...overrides,
  };
}

test("박스는 좌표 4개일 때만 받는다", () => {
  assert.deepEqual(parseBox("[120,80,360,720]"), [120, 80, 360, 720]);
  assert.equal(parseBox("[120,80,360]"), null);
  assert.equal(parseBox('["a","b","c","d"]'), null);
  assert.equal(parseBox(null), null);
});

test("태그는 문자열 값만 남긴다", () => {
  assert.deepEqual(parseTags('{"action":"standing","count":3,"view":"front"}'), {
    action: "standing",
    view: "front",
  });
  assert.deepEqual(parseTags("깨진 JSON"), {});
  assert.deepEqual(parseTags(null), {});
});

test("관절 하나라도 모양이 틀리면 뼈대 전체를 버린다", () => {
  // 중간이 밀리면 어깨가 팔꿈치 자리에 그려진다. 반만 그리느니 안 그린다.
  const broken = JSON.stringify({ keypoints: [[1, 2], [3], [5, 6]] });
  assert.equal(parseSkeleton(broken), null);
  assert.equal(parseSkeleton(JSON.stringify({ keypoints: [] })), null);
  assert.equal(parseSkeleton("{}"), null);
  assert.equal(parseSkeleton(null), null);
});

test("점수 길이가 관절 수와 다르면 점수만 비운다", () => {
  const parsed = parseSkeleton(
    JSON.stringify({ schema_version: "coco17-v1", keypoints: KEYPOINTS, scores: [0.5] }),
  );
  assert.ok(parsed);
  assert.equal(parsed.keypoints.length, 17);
  assert.deepEqual(parsed.scores, []);
  assert.equal(parsed.schemaVersion, "coco17-v1");
});

test("schemaVersion은 camelCase와 snake_case를 모두 받는다", () => {
  const camel = parseSkeleton(JSON.stringify({ schemaVersion: "coco17-v1", keypoints: KEYPOINTS }));
  assert.equal(camel?.schemaVersion, "coco17-v1");
  const missing = parseSkeleton(JSON.stringify({ keypoints: KEYPOINTS }));
  assert.equal(missing?.schemaVersion, "unknown");
});

test("점수가 모두 0이면 마스킹 전 원본으로 바꾼다", () => {
  // 추론은 refine을 막은 인물의 scores를 0으로 덮어쓴다. 그대로 그리면 멀쩡한 추출까지
  // 전부 흐려져 추출 실패로 잘못 읽힌다.
  const zeroed = parseSkeleton(
    JSON.stringify({ keypoints: KEYPOINTS, scores: KEYPOINTS.map(() => 0) }),
  );
  assert.deepEqual(pickJointScores(zeroed, SCORES), { values: SCORES, source: "raw" });
});

test("유효한 점수가 하나라도 있으면 그 점수를 쓴다", () => {
  const partial = KEYPOINTS.map((_, index) => (index === 3 ? 0.4 : 0));
  const skeleton = parseSkeleton(JSON.stringify({ keypoints: KEYPOINTS, scores: partial }));
  assert.deepEqual(pickJointScores(skeleton, SCORES), { values: partial, source: "effective" });
});

test("둘 다 없으면 점수 없음으로 둔다", () => {
  const skeleton = parseSkeleton(JSON.stringify({ keypoints: KEYPOINTS }));
  assert.deepEqual(pickJointScores(skeleton, null), { values: [], source: "none" });
  assert.deepEqual(pickJointScores(null, null), { values: [], source: "none" });
});

test("원본 점수는 관절 수와 길이가 같을 때만 받는다", () => {
  assert.deepEqual(parseScores(JSON.stringify(SCORES), 17), SCORES);
  assert.equal(parseScores(JSON.stringify([0.1, 0.2]), 17), null);
  assert.equal(parseScores(null, 17), null);
});

test("row를 화면이 쓰는 모양으로 바꾼다", () => {
  const person = toReviewPerson(row());
  assert.equal(person.personIndex, 0);
  assert.deepEqual(person.box, [120, 80, 360, 720]);
  assert.deepEqual(person.tags, { shot: "full_half", action: "standing" });
  assert.equal(person.skeleton?.keypoints.length, 17);
  assert.equal(person.jointScores.source, "effective");
  assert.deepEqual(person.refinableLimbs, ["left_arm", "right_arm"]);
  assert.equal(person.refineAllowed, true);
  assert.equal(person.lowerBodyObserved, true);
  assert.equal(person.outputScope, null);
});

test("refine 입력과 원본 점수 배열은 응답에 넣지 않는다", () => {
  // refine_context_json에는 관절 사본이 또 들어 있다. 같은 좌표를 두 벌 내보내지 않는다.
  const person = toReviewPerson(row()) as unknown as Record<string, unknown>;
  assert.equal("refineContext" in person, false);
  assert.equal("rawScores" in person, false);
});

test("불리언 컬럼이 비어 있으면 거짓으로 좁힌다", () => {
  const person = toReviewPerson(row({ refine_allowed: null, lower_body_observed: null }));
  assert.equal(person.refineAllowed, false);
  assert.equal(person.lowerBodyObserved, false);
});

test("출력 범위는 result_json에서 꺼내 다시 계산한다", () => {
  const resultJson = JSON.stringify({
    candidatesByPerson: [
      // resolved를 믿지 않는다는 것을 보이려고 일부러 틀린 값을 넣는다.
      { personIndex: 0, outputScope: { selection: "auto", detected: "bust", detectionSource: "vlm_person", resolved: "full" } },
      { personIndex: 1, outputScope: { selection: "half", detected: null, detectionSource: "unknown" } },
    ],
  });
  const scopes = outputScopesFromResult(resultJson);
  assert.equal(scopes.get(0)?.resolved, "bust");
  assert.equal(scopes.get(0)?.resolutionSource, "auto");
  assert.equal(scopes.get(1)?.resolved, "half");
  assert.equal(scopes.get(1)?.resolutionSource, "user");
});

test("result_json이 없거나 깨져도 사람 목록은 나온다", () => {
  assert.equal(outputScopesFromResult(null).size, 0);
  assert.equal(outputScopesFromResult("{").size, 0);
  const people = toReviewPeople([row(), row({ person_index: 1 })], null);
  assert.equal(people.length, 2);
  assert.equal(people[1].outputScope, null);
});

test("사람 순서마다 제 출력 범위가 붙는다", () => {
  const resultJson = JSON.stringify({
    candidatesByPerson: [
      { personIndex: 1, outputScope: { selection: "auto", detected: "head", detectionSource: "vlm_person" } },
    ],
  });
  const people = toReviewPeople([row(), row({ person_index: 1 })], resultJson);
  assert.equal(people[0].outputScope, null);
  assert.equal(people[1].outputScope?.resolved, "head");
});
