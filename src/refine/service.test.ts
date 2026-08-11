import assert from "node:assert/strict";
import test from "node:test";
import { InferenceError } from "../inference.js";
import { isRefineFailure, runRefine, type RefineDeps } from "./service.js";
import type { RefinedArtifact } from "./store.js";

const INPUT = {
  installationId: "inst-1",
  jobId: "job-1",
  personIndex: 0,
  candidateId: "pose-1::front",
};

/** 추론이 돌려주는 조정본 본문. 계약상 LF 개행이다. */
const BASE_BVH = "HIERARCHY\nROOT Hips\nMOTION\nFrames: 1\nFrame Time: 0.033333\n0.0\n";

/** 저장된 artifact를 메모리에 모아 두는 기본 deps. 각 테스트가 필요한 것만 덮어쓴다. */
function deps(overrides: Partial<RefineDeps> = {}) {
  const saved: RefinedArtifact[] = [];
  const uploaded: string[] = [];
  const base: RefineDeps = {
    featureEnabled: () => true,
    storageAvailable: () => true,
    loadCandidate: async () => ({ poseId: "pose-1", view: "front", distance: 0.21 }),
    loadRefineContext: async () => ({
      keypoints: Array.from({ length: 17 }, () => [0, 0]),
      scores: Array.from({ length: 17 }, () => 0.9),
      refineAllowed: true,
      refinableLimbs: ["left_arm"],
    }),
    findRefinedArtifact: async () => null,
    saveRefinedArtifact: async (artifact) => {
      saved.push(artifact);
    },
    refineUpstream: async () => ({
      pose_id: "pose-1",
      view: "front",
      refined: true,
      reason: "ok_partial",
      bvh_url: "/pose/pose-1/bvh",
      bvh: BASE_BVH,
      backend: "scipy",
      limbs: ["left_arm"],
      limb_decisions: {},
      loss_base: 1,
      loss_final: 0.5,
      gain: 0.5,
    }),
    putRefinedBvh: async (key) => {
      uploaded.push(key);
    },
    ...overrides,
  };
  return { base, saved, uploaded };
}

async function run(overrides: Partial<RefineDeps> = {}) {
  const { base, saved, uploaded } = deps(overrides);
  const outcome = await runRefine(INPUT, base);
  assert.equal(isRefineFailure(outcome), false, "unexpected candidate mismatch");
  return { outcome: outcome as Exclude<typeof outcome, { error: string }>, saved, uploaded };
}

test("applies refine and persists the artifact under the installation prefix", async () => {
  const { outcome, saved, uploaded } = await run();
  assert.equal(outcome.refined, true);
  assert.equal(outcome.reasonCode, "ok_partial");
  assert.deepEqual(outcome.adjustedLimbs, ["left_arm"]);
  assert.equal(saved[0]?.refined, true);
  assert.equal(
    uploaded[0],
    "installations/inst-1/jobs/job-1/refined/0/pose-1__front.bvh",
    "조정본은 삭제 스윕·lifecycle이 걸린 installations/ prefix 아래에 있어야 한다",
  );
  assert.equal(saved[0]?.objectKey, uploaded[0]);
});

// OPS-02. 추론 endpoint가 살아 있어도 BFF flag가 꺼져 있으면 호출조차 하지 않는다.
test("feature flag off skips without calling the inference server", async () => {
  let called = false;
  const { outcome } = await run({
    featureEnabled: () => false,
    refineUpstream: async () => {
      called = true;
      throw new Error("must not be called");
    },
  });
  assert.equal(outcome.refined, false);
  assert.equal(outcome.reasonCode, "feature_disabled");
  assert.equal(called, false);
});

// E2E-03. 저신뢰 인물은 후보를 고르고 베이스로 저장할 수 있지만 refine은 금지다.
test("refine_allowed=false skips without calling the inference server", async () => {
  let called = false;
  const { outcome } = await run({
    loadRefineContext: async () => ({
      keypoints: Array.from({ length: 17 }, () => [0, 0]),
      scores: null,
      refineAllowed: false,
      refinableLimbs: [],
    }),
    refineUpstream: async () => {
      called = true;
      throw new Error("must not be called");
    },
  });
  assert.equal(outcome.reasonCode, "skeleton_policy");
  assert.equal(called, false);
});

// INF-03. 보관할 곳이 없으면 조정해 봐야 다음 요청에서 사라진다.
test("missing artifact storage skips instead of producing an unreachable refinement", async () => {
  const { outcome } = await run({ storageAvailable: () => false });
  assert.equal(outcome.reasonCode, "storage_unavailable");
});

// E2E-02, E2E-07. 안전 게이트가 베이스를 유지한 것은 오류가 아니다.
test("refined=false from the safety gate is a normal base result", async () => {
  const { outcome, saved, uploaded } = await run({
    refineUpstream: async () => ({
      pose_id: "pose-1",
      view: "front",
      refined: false,
      reason: "entangled_set",
      bvh_url: "/pose/pose-1/bvh",
      backend: "none",
      limbs: [],
      limb_decisions: {},
      loss_base: null,
      loss_final: null,
      gain: null,
    }),
  });
  assert.equal(outcome.refined, false);
  assert.equal(outcome.reasonCode, "entangled_set");
  assert.equal(uploaded.length, 0);
  assert.equal(saved[0]?.refined, false);
});

// BFF-07. timeout·5xx는 사용자 작업을 실패시키지 않고 베이스로 수렴한다.
test("upstream failure falls back to base without throwing", async () => {
  const { outcome } = await run({
    refineUpstream: async () => {
      throw new InferenceError(503, "unavailable");
    },
  });
  assert.equal(outcome.refined, false);
  assert.equal(outcome.reasonCode, "upstream_unavailable");
});

// BFF-06. 조정은 됐지만 보관에 실패했다면 거짓 성공을 남기면 안 된다.
test("failure to persist the artifact is never recorded as refined", async () => {
  const { outcome, saved } = await run({
    putRefinedBvh: async () => {
      throw new Error("s3 down");
    },
  });
  assert.equal(outcome.refined, false);
  assert.equal(outcome.reasonCode, "artifact_store_failed");
  assert.equal(saved[0]?.refined, false);
  assert.equal(saved[0]?.objectKey, null);
});

// REFINE_HANDOFF §3 4단계. 조정본을 얻는 경로는 응답 본문 하나뿐이다. refined=true인데
// 본문이 없으면 계약 위반이고, 지어낼 방법이 없으므로 베이스로 안전 전환해야 한다.
test("refined=true without a bvh body falls back to base instead of throwing", async () => {
  const { outcome, saved, uploaded } = await run({
    refineUpstream: async () => ({
      pose_id: "pose-1",
      view: "front",
      refined: true,
      reason: "ok",
      bvh_url: "/pose/pose-1/bvh",
      backend: "scipy",
      limbs: ["left_arm"],
      limb_decisions: {},
      loss_base: 1,
      loss_final: 0.5,
      gain: 0.5,
    }),
  });
  assert.equal(outcome.refined, false);
  assert.equal(outcome.reasonCode, "upstream_missing_bvh");
  assert.equal(uploaded.length, 0, "본문이 없으면 아무것도 올리지 않는다");
  assert.equal(saved[0]?.refined, false);
  assert.equal(saved[0]?.objectKey, null);
});

// 응답 본문이 조정본을 얻는 유일한 경로다. 받은 바이트가 그대로 보관돼야 한다.
test("the inlined bvh body is stored byte-for-byte", async () => {
  const stored: Uint8Array[] = [];
  const { outcome, saved } = await run({
    putRefinedBvh: async (_key, bytes) => {
      stored.push(bytes);
    },
  });
  assert.equal(outcome.refined, true);
  assert.equal(saved[0]?.refined, true);
  assert.equal(new TextDecoder().decode(stored[0]), BASE_BVH);
  assert.ok(!new TextDecoder().decode(stored[0]).includes("\r\n"), "CRLF가 섞이면 안 된다");
});

// BFF-07. 같은 선택을 다시 눌러도 추론 재호출도, S3 객체 중복 생성도 없다.
test("an existing artifact short-circuits the whole flow", async () => {
  let called = false;
  const { outcome, saved, uploaded } = await run({
    findRefinedArtifact: async () => ({
      jobId: "job-1",
      personIndex: 0,
      candidateId: INPUT.candidateId,
      poseId: "pose-1",
      refined: true,
      reason: "ok",
      objectKey: "installations/inst-1/jobs/job-1/refined/0/pose-1__front.bvh",
      limbs: ["left_arm"],
    }),
    refineUpstream: async () => {
      called = true;
      throw new Error("must not be called");
    },
  });
  assert.equal(outcome.refined, true);
  assert.equal(outcome.reasonCode, "ok");
  assert.equal(called, false);
  assert.equal(uploaded.length, 0);
  assert.equal(saved.length, 0);
});

test("an unknown candidate is reported as a mismatch", async () => {
  const { base } = deps({ loadCandidate: async () => null });
  const outcome = await runRefine(INPUT, base);
  assert.equal(isRefineFailure(outcome), true);
});

// 저장된 스켈레톤이 17개가 아니면 추론 계약을 못 맞춘다 → 호출하지 않고 베이스로 간다.
test("a missing refine context skips instead of guessing", async () => {
  const { outcome } = await run({ loadRefineContext: async () => null });
  assert.equal(outcome.reasonCode, "context_unavailable");
});
