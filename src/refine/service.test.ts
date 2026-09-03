import assert from "node:assert/strict";
import test from "node:test";
import { InferenceError, type RefineUpstreamRequest } from "../inference.js";
import { isRefineFailure, runRefine, type RefineDeps } from "./service.js";
import type { RefinedArtifact, StoredRefineContext } from "./store.js";

/**
 * `/analyze`가 저장해 둔 정상 인물 하나.
 *
 * lineage 네 값은 추론의 `structural_refine_allowed`가 통과시키는 **유일한** 조합이다
 * (`slot_origin="vlm"`, `skeleton_source="full_image"`). 여기서 값을 바꾸면 추론이
 * fail-closed로 떨어뜨리므로 테스트가 실제 계약을 흉내내지 못한다.
 */
const CONTEXT: StoredRefineContext = {
  keypoints: Array.from({ length: 17 }, () => [0, 0]),
  scores: Array.from({ length: 17 }, () => 0.9),
  refineAllowed: true,
  refinableLimbs: ["left_arm"],
  skeletonState: "valid",
  coverageClass: "full",
  slotOrigin: "vlm",
  skeletonSource: "full_image",
  lowerBodyObserved: true,
};

const INPUT = {
  installationId: "inst-1",
  jobId: "job-1",
  personIndex: 0,
  candidateId: "pose-1::front",
};

/** 추론이 돌려주는 조정본 본문. 계약상 LF 개행이다. */
const BASE_BVH = "HIERARCHY\nROOT Hips\nMOTION\nFrames: 1\nFrame Time: 0.033333\n0.0\n";

/** 계약대로 base64 인라인된 1×1 PNG. 시그니처가 맞아야 통과한다. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const THUMBNAIL = {
  view: "front",
  media_type: "image/png",
  encoding: "base64",
  data: PNG_BASE64,
  width: 256,
  height: 256,
  renderer_version: "warm-mannequin-v1",
};

/** 저장된 artifact를 메모리에 모아 두는 기본 deps. 각 테스트가 필요한 것만 덮어쓴다. */
function deps(overrides: Partial<RefineDeps> = {}) {
  const saved: RefinedArtifact[] = [];
  const uploaded: string[] = [];
  const thumbnails: Array<{ key: string; bytes: Uint8Array }> = [];
  const base: RefineDeps = {
    featureEnabled: () => true,
    storageAvailable: () => true,
    loadCandidate: async () => ({ poseId: "pose-1", view: "front", distance: 0.21 }),
    loadRefineContext: async () => ({ ...CONTEXT }),
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
    putRefinedThumbnail: async (key, bytes) => {
      thumbnails.push({ key, bytes });
    },
    ...overrides,
  };
  return { base, saved, uploaded, thumbnails };
}

async function run(overrides: Partial<RefineDeps> = {}) {
  const { base, saved, uploaded, thumbnails } = deps(overrides);
  const outcome = await runRefine(INPUT, base);
  assert.equal(isRefineFailure(outcome), false, "unexpected candidate mismatch");
  return {
    outcome: outcome as Exclude<typeof outcome, { error: string }>,
    saved,
    uploaded,
    thumbnails,
  };
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
      ...CONTEXT,
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
      thumbnailKey: "installations/inst-1/jobs/job-1/refined/0/pose-1__front.png",
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
  // 재진입에서 그림이 나오는 근거. 추론을 다시 부르지 않으므로 보관해 둔 것만 있다.
  assert.equal(outcome.thumbnailAvailable, true);
});

// ── 확인 화면 미리보기(ADR-010) ──────────────────────────────────────────────
// 추론은 PNG를 저장하지 않는다. 여기서 보관하지 않으면 작업 기록에서 다시 열었을 때
// 그림이 사라진다 — 멱등 캐시가 추론 재호출을 막기 때문이다.

test("the refined thumbnail is stored beside the bvh under the same prefix", async () => {
  const { outcome, thumbnails } = await run({
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
      thumbnail: THUMBNAIL,
    }),
  });
  assert.equal(outcome.thumbnailAvailable, true);
  assert.equal(
    thumbnails[0]?.key,
    "installations/inst-1/jobs/job-1/refined/0/pose-1__front.png",
    "BVH와 같은 prefix라야 삭제 스윕과 lifecycle이 그대로 걸린다",
  );
  assert.deepEqual(
    thumbnails[0]?.bytes,
    new Uint8Array(Buffer.from(PNG_BASE64, "base64")),
    "받은 PNG 바이트가 그대로 보관돼야 한다",
  );
});

// refined=false여도 그림은 있다 — 추론이 실제로 저장될 베이스 BVH를 같은 렌더러로 그린다.
// 확인 화면은 조정 여부와 무관하게 "저장될 것"을 보여줘야 하므로 이쪽도 보관한다.
test("a base result still persists its thumbnail", async () => {
  const { outcome, uploaded, thumbnails } = await run({
    refineUpstream: async () => ({
      pose_id: "pose-1",
      view: "front",
      refined: false,
      reason: "no_gain",
      bvh_url: "/pose/pose-1/bvh",
      backend: "none",
      limbs: [],
      limb_decisions: {},
      loss_base: null,
      loss_final: null,
      gain: null,
      thumbnail: THUMBNAIL,
    }),
  });
  assert.equal(outcome.refined, false);
  assert.equal(outcome.thumbnailAvailable, true);
  assert.equal(uploaded.length, 0, "조정본이 없으므로 BVH는 올리지 않는다");
  assert.equal(thumbnails.length, 1);
});

// 그림이 없다고 저장이 막히면 안 된다(요구서 §3). BVH 보관 실패와는 성격이 다르다.
test("a thumbnail upload failure does not change the refine result", async () => {
  const { outcome, saved } = await run({
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
      thumbnail: THUMBNAIL,
    }),
    putRefinedThumbnail: async () => {
      throw new Error("s3 down");
    },
  });
  assert.equal(outcome.refined, true, "그림을 못 올렸다고 조정을 버리지 않는다");
  assert.equal(outcome.thumbnailAvailable, false);
  assert.equal(saved[0]?.refined, true);
  assert.equal(saved[0]?.thumbnailKey, null);
});

// 미리보기는 "저장될 포즈가 이것"이라고 주장하는 그림이다. 계약에 어긋나면 보여주지 않는다.
test("a thumbnail that violates the contract is dropped, not stored", async () => {
  for (const [label, thumbnail] of [
    ["PNG가 아닌 바이트", { ...THUMBNAIL, data: Buffer.from("not a png").toString("base64") }],
    ["다른 media_type", { ...THUMBNAIL, media_type: "image/jpeg" }],
    ["다른 encoding", { ...THUMBNAIL, encoding: "hex" }],
    ["빈 data", { ...THUMBNAIL, data: "" }],
  ] as const) {
    const { outcome, thumbnails } = await run({
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
        thumbnail,
      }),
    });
    assert.equal(outcome.refined, true, label);
    assert.equal(outcome.thumbnailAvailable, false, label);
    assert.equal(thumbnails.length, 0, label);
  }
});

// 구 추론(썸네일 이전 버전)과도 붙어야 한다. 필드가 없는 것은 오류가 아니다.
test("an upstream response without a thumbnail is still a normal result", async () => {
  const { outcome, thumbnails } = await run();
  assert.equal(outcome.refined, true);
  assert.equal(outcome.thumbnailAvailable, false);
  assert.equal(thumbnails.length, 0);
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


// ── v2.5 policy lineage ─────────────────────────────────────────────────────
// 추론의 structural_refine_allowed는 skeleton_state·coverage_class·slot_origin·
// skeleton_source를 전부 검사하고, 하나라도 빠지면 fail-closed로 reason="skeleton_policy"를
// 돌려준다. 그건 **오류가 아니라 정상 스킵**이라 5xx로도, 로그로도 안 잡힌다.
// 즉 이 전달이 끊기면 refine 기능 전체가 아무 신호 없이 사라진다. 그래서 계약을 못으로 박는다.
test("forwards the full policy lineage to the inference server", async () => {
  let sent: RefineUpstreamRequest | null = null;
  const { base } = deps({
    refineUpstream: async (req) => {
      sent = req;
      return {
        pose_id: "pose-1",
        view: "front",
        refined: false,
        reason: "no_gain",
        bvh_url: "/pose/pose-1/bvh",
        backend: "none",
        limbs: [],
        limb_decisions: {},
        loss_base: null,
        loss_final: null,
        gain: null,
      };
    },
  });
  await runRefine(INPUT, base);

  const req = sent as RefineUpstreamRequest | null;
  assert.ok(req, "refineUpstream이 호출되지 않았다");
  assert.equal(req.skeleton_state, "valid");
  assert.equal(req.coverage_class, "full");
  assert.equal(req.slot_origin, "vlm");
  assert.equal(req.skeleton_source, "full_image");
  assert.equal(req.lower_body_observed, true);
});

// 마이그레이션 직전에 저장된 job은 lineage 컬럼이 NULL이다. 값을 지어내지 않고 그대로
// 보내서 추론이 fail-closed로 판단하게 둔다 — 여기서 기본값을 채우면 그게 곧 fail-open이다.
test("missing lineage is forwarded as null instead of being invented", async () => {
  let sent: RefineUpstreamRequest | null = null;
  const { base } = deps({
    loadRefineContext: async () => ({
      ...CONTEXT,
      skeletonState: null,
      coverageClass: null,
      slotOrigin: null,
      skeletonSource: null,
      lowerBodyObserved: false,
    }),
    refineUpstream: async (req) => {
      sent = req;
      return {
        pose_id: "pose-1",
        view: "front",
        refined: false,
        reason: "skeleton_policy",
        bvh_url: "/pose/pose-1/bvh",
        backend: "none",
        limbs: [],
        limb_decisions: {},
        loss_base: null,
        loss_final: null,
        gain: null,
      };
    },
  });
  await runRefine(INPUT, base);

  const req = sent as RefineUpstreamRequest | null;
  assert.ok(req);
  assert.equal(req.slot_origin, null);
  assert.equal(req.skeleton_source, null);
  assert.equal(req.lower_body_observed, false);
});

// 추론은 refined=false일 때 `bvh: null`을 **명시적으로** 보낸다(undefined가 아니다).
// null이 새어 나가면 TextEncoder가 문자열 "null"을 조정본으로 만들어 S3에 올린다.
test("an explicit null bvh body is treated as a contract violation, not encoded", async () => {
  const stored: Uint8Array[] = [];
  const { outcome, saved } = await run({
    refineUpstream: async () => ({
      pose_id: "pose-1",
      view: "front",
      refined: true,
      reason: "ok",
      bvh_url: "/pose/pose-1/bvh",
      bvh: null,
      backend: "scipy",
      limbs: ["left_arm"],
      limb_decisions: {},
      loss_base: 1,
      loss_final: 0.5,
      gain: 0.5,
    }),
    putRefinedBvh: async (_key, bytes) => {
      stored.push(bytes);
    },
  });
  assert.equal(outcome.refined, false);
  assert.equal(outcome.reasonCode, "upstream_missing_bvh");
  assert.equal(stored.length, 0, '"null" 문자열을 조정본으로 올리면 안 된다');
  assert.equal(saved[0]?.objectKey, null);
});
