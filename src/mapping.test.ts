import assert from "node:assert/strict";
import test from "node:test";
import { extractCutSummary, extractPersonSignals, mapCutResult } from "./mapping.js";
import type { CutResult, UpstreamPerson } from "./inference.js";

const METADATA = {
  deployment_version: "sha",
  vlm_provider: "mock",
  vlm_model: "mock",
  pose_backend: "mock",
  pose_model_version: "1",
  pose_library_version: "v1",
  feature_version: 1,
};

function candidate(distance: number) {
  return {
    pose_id: "pose-1",
    view: "front",
    distance,
    tags: { action: "standing" },
    rerank_score: null,
    bvh_url: "/pose/pose-1/bvh",
    thumbnail_url: null,
  };
}

function cut(people: Array<Partial<UpstreamPerson>>, route = "core"): CutResult {
  return {
    route,
    count_confidence: "high",
    detector_count: people.length,
    vlm_count: people.length,
    image: { width: 100, height: 200 },
    inference_metadata: METADATA,
    notes: [],
    people: people.map((p, i) => ({
      index: i,
      box: [0, 0, 10, 20],
      tags: { action: "standing" },
      skeleton: null,
      confidence: "high",
      candidates: [candidate(0.2)],
      ...p,
    })) as UpstreamPerson[],
  };
}

test("mapping preserves skeleton lineage and inference versions", () => {
  const result = mapCutResult(
    "job-1",
    cut([
      {
        skeleton: { schema_version: "coco17-v1", keypoints: [[1, 2]], scores: [0.9] },
      },
    ]),
  );
  assert.equal(result.inferenceMetadata.poseLibraryVersion, "v1");
  assert.deepEqual(result.candidatesByPerson[0]?.skeleton?.scores, [0.9]);
  assert.equal(result.candidatesByPerson[0]?.candidates[0]?.rank, 1);
  assert.equal(result.candidatesByPerson[0]?.candidateCount, 1);
  assert.equal(
    result.candidatesByPerson[0]?.candidateShortfallReason,
    "UPSTREAM_FEWER_THAN_REQUESTED",
  );
});

// BFF-02. 마스킹된 관절이 많을수록 남은 관절의 평균 거리는 작아진다. 거리만 보면 정보가
// 거의 없는 스켈레톤이 "높은 일치"로 올라간다 — 이 테스트가 그 회귀를 막는다.
test("low confidence caps every candidate to matchLevel=low even at a tiny distance", () => {
  const result = mapCutResult(
    "job-1",
    cut([{ confidence: "low", candidates: [candidate(0.01), candidate(0.2)] }]),
  );
  const levels = result.candidatesByPerson[0]?.candidates.map((c) => c.matchLevel);
  assert.deepEqual(levels, ["low", "low"]);
});

test("high confidence keeps the distance bands as display detail", () => {
  const result = mapCutResult(
    "job-1",
    cut([{ confidence: "high", candidates: [candidate(0.2), candidate(0.35), candidate(0.6)] }]),
  );
  const levels = result.candidatesByPerson[0]?.candidates.map((c) => c.matchLevel);
  assert.deepEqual(levels, ["high", "medium", "low"]);
});

// 요구서 §3-2. confidence=low와 candidates=[]는 같은 상태가 아니다.
test("fallbackMode distinguishes none, soft and hard", () => {
  const result = mapCutResult(
    "job-1",
    cut([
      { confidence: "high", candidates: [candidate(0.2)] },
      { confidence: "low", candidates: [candidate(0.2)] },
      { confidence: "low", candidates: [] },
    ]),
  );
  const modes = result.candidatesByPerson.map((p) => p.fallbackMode);
  assert.deepEqual(modes, ["none", "soft", "hard"]);
});

// E2E-12. 구 추론 서버와 순차 배포되는 창에서 신규 필드가 통째로 없을 수 있다.
test("missing quality fields degrade to low confidence and refine off", () => {
  const result = mapCutResult("job-1", cut([{ confidence: null }]));
  const person = result.candidatesByPerson[0]!;
  assert.equal(person.confidence, "low");
  assert.equal(person.refineAllowed, false);
  assert.equal(person.coverageClass, "insufficient");
  assert.deepEqual(person.refinableLimbs, []);
  assert.equal(person.fallbackMode, "soft");
  assert.equal(person.candidates[0]?.matchLevel, "low");
});

test("unknown enum values are narrowed to the safe side", () => {
  const result = mapCutResult(
    "job-1",
    cut([
      {
        confidence: "excellent",
        skeleton_state: "brand_new_state",
        coverage_class: "mostly",
        skeleton_source: "telepathy",
      },
    ]),
  );
  const person = result.candidatesByPerson[0]!;
  assert.equal(person.confidence, "low");
  assert.equal(person.skeletonState, "invalid");
  assert.equal(person.coverageClass, "insufficient");
  assert.equal(person.skeletonSource, "none");
});

test("quality fields flow through when the upstream provides them", () => {
  const result = mapCutResult(
    "job-1",
    cut([
      {
        confidence: "high",
        skeleton_state: "partial",
        skeleton_source: "crop_retry",
        coverage_class: "reduced",
        refine_allowed: true,
        refinable_limbs: ["left_arm"],
      },
    ]),
  );
  const person = result.candidatesByPerson[0]!;
  assert.equal(person.skeletonState, "partial");
  assert.equal(person.skeletonSource, "crop_retry");
  assert.equal(person.coverageClass, "reduced");
  assert.equal(person.refineAllowed, true);
  assert.deepEqual(person.refinableLimbs, ["left_arm"]);
});

// 요구서 §3-1: 인물 순서는 추론이 왼쪽→오른쪽으로 고정한다. BFF는 다시 정렬하지 않는다.
test("person order and index follow the upstream", () => {
  const result = mapCutResult(
    "job-1",
    cut([{ candidates: [candidate(0.5)] }, { candidates: [candidate(0.1)] }]),
  );
  assert.deepEqual(
    result.candidatesByPerson.map((p) => p.personIndex),
    [0, 1],
  );
});

// raw_scores와 quality_trace는 진단용이라 사용자 응답에 실리면 안 된다(BFF-03).
test("raw scores and quality trace never reach the public result", () => {
  const result = mapCutResult(
    "job-1",
    cut([{ raw_scores: [0.1], quality_trace: { secret: true }, quality_reasons: ["masked"] }]),
  );
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("raw_scores"), false);
  assert.equal(serialized.includes("quality_trace"), false);
  assert.equal(serialized.includes("secret"), false);
});

test("observed upper-body candidates stay soft while a head in the same cut is unsupported", () => {
  const result = mapCutResult("partial", cut([
    { coverage_class: "upper_only", confidence: "low", refine_allowed: false,
      refinable_limbs: [], candidates: [candidate(0.001)] },
    { confidence: "low", candidates: [], quality_reasons: ["head_search_unsupported"] },
  ]));
  const [upper, head] = result.candidatesByPerson;
  assert.equal(upper?.coverageClass, "upper_only");
  assert.equal(upper?.fallbackMode, "soft");
  assert.equal(upper?.candidates[0]?.matchLevel, "low");
  assert.equal(upper?.refineAllowed, false);
  assert.equal(head?.fallbackMode, "hard");
  assert.equal(head?.candidateShortfallReason, "HEAD_SEARCH_UNSUPPORTED");
});

test("person signals keep the inference vocabulary as strings and drop junk", () => {
  const [signals] = extractPersonSignals(
    cut([
      {
        person_tags: { action: "sitting", view: 7, source: "vlm_person" },
        output_scope: { detected: "half", source: "vlm_person" },
        rank_distance: 0.41,
        distance_metric: "pos",
        search_stability: "stable",
        confidence_threshold: Number.NaN,
      },
    ]),
  );
  assert.deepEqual(signals, {
    personIndex: 0,
    personTags: { action: "sitting", view: null, source: "vlm_person" },
    outputScope: { detected: "half", source: "vlm_person" },
    rankDistance: 0.41,
    distanceMetric: "pos",
    searchStability: "stable",
    confidenceThreshold: null,
  });
});

test("an older inference response yields empty signals, not guesses", () => {
  const [signals] = extractPersonSignals(cut([{}]));
  assert.deepEqual(signals.personTags, { action: null, view: null, source: null });
  assert.equal(signals.rankDistance, null);
});

test("the cut summary records what the VLM actually said", () => {
  const summary = extractCutSummary({
    ...cut([{}, {}]),
    vlm_tags: { shot: "full_half", action: null, view: "side", relationship: "talking" },
  });
  assert.deepEqual(summary, {
    route: "core",
    countConfidence: "high",
    detectorCount: 2,
    vlmCount: 2,
    vlmTags: { shot: "full_half", action: null, view: "side", relationship: "talking" },
  });
  assert.equal(extractCutSummary(cut([{}])).vlmTags, null);
});

test("prompt and library hash versions pass through when inference sends them", () => {
  const result = mapCutResult("job-1", {
    ...cut([{}]),
    inference_metadata: {
      ...METADATA,
      vlm_prompt_version: "p2-person-tags",
      pose_library_sha256: "ab".repeat(32),
    },
  });
  assert.equal(result.inferenceMetadata.vlmPromptVersion, "p2-person-tags");
  assert.equal(result.inferenceMetadata.poseLibrarySha256, "ab".repeat(32));
  assert.equal(mapCutResult("job-1", cut([{}])).inferenceMetadata.vlmPromptVersion, null);
});

test("display camera preserves search identity and builds an owned preview URL", () => {
  const camera = {
    version: "candidate-camera-v1" as const, rotation:[[1,0,0],[0,1,0],[0,0,1]],
    source_bvh_sha256: "a".repeat(64), reference: "pelvis-torso-yaw" as const,
    canonical_yaw: 180, display_view: "front", status: "fitted" as const,
    fit_error: 0.1, facing_source: "person_observation" as const, depth_ambiguous:false,
  };
  const input = {...candidate(.2), view:"back", tags:{view:"back"}, camera};
  const result = mapCutResult("owned-job",cut([{candidates:[input]}])).candidatesByPerson[0]!.candidates[0]!;
  assert.equal(result.id,"pose-1::back");
  assert.equal(result.view,"back");
  assert.deepEqual(result.tags,["front"]);
  assert.deepEqual(result.camera,camera);
  assert.match(result.thumbnailUrl!,/aligned\?jobId=owned-job&personIndex=0&candidateId=pose-1%3A%3Aback/);
});
