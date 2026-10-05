import assert from "node:assert/strict";
import test from "node:test";
import {
  CURSOR_TTL_MS,
  decodeCursor,
  encodeCursor,
  exportSalt,
  parseExportDays,
  privacyProblems,
  pseudonym,
  startExport,
  toObservation,
  windowStart,
  type GapObservationRow,
} from "./gapExport.js";

const KEY = "test-gap-export-key";
const JOB = "job_0f8e9a3c-1b2d-4e5f-8a9b-0c1d2e3f4a5b";
const INST = "inst_7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d";
const KEYPOINTS = Array.from({ length: 17 }, (_, i) => [100.04 + i, 200.06 + i * 2]);
const MASK = Array.from({ length: 17 }, (_, i) => i !== 3);

function row(overrides: Partial<GapObservationRow> = {}): GapObservationRow {
  return {
    job_id: JOB,
    person_index: 1,
    installation_id: INST,
    created_at: "2026-10-05T23:59:59.000Z",
    inference_metadata_json: JSON.stringify({
      deploymentVersion: "abc1234",
      vlmModel: "gemini-2.5-flash",
      poseModelVersion: "humanart-m",
      poseLibraryVersion: "v1",
      featureVersion: 1,
      vlmPromptVersion: "p2-person-tags",
      // 64자리 hex는 입력 해시 모양이라 export에 실리면 안 된다.
      poseLibrarySha256: "ab".repeat(32),
    }),
    cut_summary_json: JSON.stringify({
      route: "core",
      countConfidence: "high",
      detectorCount: 2,
      vlmCount: 2,
      vlmTags: { shot: "full_half", action: null, view: "side", relationship: "talking" },
    }),
    tags_json: JSON.stringify({ shot: "full_half", action: "other", view: "front", relationship: "talking" }),
    skeleton_json: JSON.stringify({ keypoints: KEYPOINTS, scores: new Array(17).fill(0) }),
    raw_scores_json: JSON.stringify(new Array(17).fill(0.912345)),
    refine_context_json: JSON.stringify({
      keypoints: KEYPOINTS,
      scores: new Array(17).fill(0.5),
      qualityReasons: ["lower_body_hidden"],
      qualityTrace: {
        search_scope: "full_body",
        evidence_valid_joint_mask: MASK,
        search_valid_joint_mask: MASK,
        crop_mapping: { x1: 10, y1: 20 },
        assigned_rtm_index: 0,
      },
    }),
    person_tags_json: JSON.stringify({ action: "sitting", view: "side", source: "vlm_person" }),
    output_scope_json: JSON.stringify({ detected: "full", source: "vlm_person" }),
    coverage_class: "full",
    skeleton_state: "valid",
    skeleton_source: "full_image",
    slot_origin: "vlm",
    lower_body_observed: true,
    confidence: "low",
    fallback_mode: "soft",
    rank_distance: 0.41,
    distance_metric: "pos",
    search_stability: "not_required",
    confidence_threshold: 0.45,
    candidates: [
      { pose_id: "sit_chair_03", view: "side", rank: 1, distance: 0.41, match_level: "low", pose_library_version: "lib-20261002-91b57d0f" },
      { pose_id: "sit_floor_01", view: "front", rank: 2, distance: 0.44, match_level: "low", pose_library_version: "lib-20261002-91b57d0f" },
    ],
    selected_rank: null,
    exported: false,
    selected_refined: null,
    job_feedback: "candidates_irrelevant",
    ...overrides,
  };
}

test("an observation carries the contract fields and nothing that links back", () => {
  const item = toObservation(row(), exportSalt(KEY, "export-1"));
  assert.ok(item);
  assert.deepEqual(privacyProblems(item), []);

  const text = JSON.stringify(item);
  for (const leaked of [JOB, INST, "ab".repeat(32), "crop_mapping", "assigned_rtm_index"]) {
    assert.ok(!text.includes(leaked), leaked);
  }
  assert.match(String(item.obs), /^o_[A-Za-z0-9_-]{22}$/);
  assert.match(String(item.inst), /^i_[A-Za-z0-9_-]{22}$/);
  assert.equal(item.observed_on, "2026-10-05");
  assert.equal(item.expires_on, "2027-10-05");
  assert.deepEqual(item.versions, {
    pose_library: "lib-20261002-91b57d0f",
    feature: 1,
    pose_model: "humanart-m",
    vlm_model: "gemini-2.5-flash",
    vlm_prompt: "p2-person-tags",
    deployment: "abc1234",
  });
  // VLM이 실제로 말한 컷 태그를 쓴다. 기본값으로 채운 tags_json의 action·view가 아니다.
  assert.deepEqual(item.cut, {
    route: "core",
    count_confidence: "high",
    person_count: 2,
    detector_count: 2,
    tags: { shot: "full_half", action: null, view: "side", relationship: "talking" },
  });
  const person = item.person as Record<string, unknown>;
  assert.deepEqual((person.keypoints as number[][])[0], [100, 200.1]);
  assert.deepEqual(person.raw_scores, new Array(17).fill(0.9123));
  // skeleton_json.scores는 refine이 막히면 0이다. 유효 점수는 refine 입력에서 읽는다.
  assert.deepEqual(person.effective_scores, new Array(17).fill(0.5));
  assert.deepEqual(person.evidence_mask, MASK);
  assert.equal(person.search_scope, "full_body");
  assert.deepEqual(person.tags, { action: "sitting", view: "side", source: "vlm_person" });
  assert.deepEqual(person.scope, { detected: "full", source: "vlm_person" });
  assert.deepEqual(item.candidates, [
    { pose_id: "sit_chair_03", view: "side", rank: 1, distance: 0.41, match_level: "low" },
    { pose_id: "sit_floor_01", view: "front", rank: 2, distance: 0.44, match_level: "low" },
  ]);
  assert.deepEqual(item.behavior, {
    selected_rank: null,
    exported: false,
    selected_refined: null,
    job_feedback: "candidates_irrelevant",
  });
});

test("rows stored before the person signals existed still export", () => {
  const item = toObservation(
    row({ cut_summary_json: null, person_tags_json: null, output_scope_json: null }),
    exportSalt(KEY, "export-1"),
  );
  assert.ok(item);
  const cut = item.cut as Record<string, unknown>;
  assert.deepEqual(cut.tags, { shot: "full_half", action: "other", view: "front", relationship: "talking" });
  assert.equal(cut.route, null);
  assert.deepEqual((item.person as Record<string, unknown>).tags, {});
});

test("people without joints are not observations", () => {
  const salt = exportSalt(KEY, "export-1");
  assert.equal(toObservation(row({ refine_context_json: null, skeleton_json: null }), salt), null);
  assert.equal(
    toObservation(row({ refine_context_json: JSON.stringify({ keypoints: [[1, 2]] }), skeleton_json: null }), salt),
    null,
  );
});

test("pseudonyms repeat inside one export and change between exports", () => {
  const first = exportSalt(KEY, "export-1");
  const second = exportSalt(KEY, "export-2");
  assert.equal(pseudonym(first, "i", INST), pseudonym(first, "i", INST));
  assert.notEqual(pseudonym(first, "i", INST), pseudonym(second, "i", INST));
  assert.notEqual(pseudonym(first, "o", `${JOB}:0`), pseudonym(first, "o", `${JOB}:1`));
  assert.notEqual(pseudonym(exportSalt("other-key", "export-1"), "i", INST), pseudonym(first, "i", INST));
});

test("cursors round-trip, hide the sort key, and reject tampering or age", () => {
  const now = Date.parse("2026-10-06T00:00:00.000Z");
  const state = {
    ...startExport(now, 90),
    after: { createdAt: "2026-10-05T23:59:59.000Z", jobId: JOB, personIndex: 1 },
  };
  const cursor = encodeCursor(KEY, state);

  assert.deepEqual(decodeCursor(KEY, cursor, now + 1000), state);
  const decodedParts = cursor.split(".").slice(1).map((part) => Buffer.from(part, "base64url").toString("latin1"));
  assert.ok(!cursor.includes("job_") && !decodedParts.some((part) => part.includes("job_")));

  const parts = cursor.split(".");
  const body = Buffer.from(parts[2], "base64url");
  body[0] ^= 1;
  parts[2] = body.toString("base64url");
  assert.equal(decodeCursor(KEY, parts.join("."), now), null);
  assert.equal(decodeCursor("other-key", cursor, now), null);
  assert.equal(decodeCursor(KEY, cursor, now + CURSOR_TTL_MS + 1), null);
  assert.equal(decodeCursor(KEY, "v1.not.a.cursor", now), null);
  assert.equal(decodeCursor(KEY, "garbage", now), null);
});

test("days defaults to 90 and stays inside the retention window", () => {
  assert.equal(parseExportDays(undefined), 90);
  assert.equal(parseExportDays("1"), 1);
  assert.equal(parseExportDays("365"), 365);
  for (const bad of ["0", "366", "-1", "1.5", "abc", "9999"]) assert.equal(parseExportDays(bad), null, bad);
  const state = startExport(Date.parse("2026-10-06T00:00:00.000Z"), 90);
  assert.equal(windowStart(state), "2026-07-08T00:00:00.000Z");
});

test("the privacy check catches every identifier shape it guards", () => {
  assert.deepEqual(privacyProblems({ person: { tags: { action: "sitting" } } }), []);
  const cases: unknown[] = [
    { job_id: "x" },
    { nested: [{ installationId: "x" }] },
    { note: INST },
    { pose_id: `combat_${JOB}` },
    { pose_id: "combat_composition_user_b31d5ee761e5_p0" },
    { path: "installations/abc/jobs/1/input.png" },
    { sha: "cd".repeat(32) },
    { [INST]: 1 },
  ];
  for (const value of cases) assert.ok(privacyProblems(value).length > 0, JSON.stringify(value));
});
