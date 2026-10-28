import assert from "node:assert/strict";
import test from "node:test";
import type { Job } from "../jobs/store.js";
import { prepareRefinedScene } from "./sceneRefinement.js";
import { ConverterError, sha256Hex } from "../converter/client.js";
import type { FramedInput } from "../converter/framing.js";
const fbx = Buffer.from("Kaydara FBX Binary  \0\x1a\0full"),
  png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const character = "a".repeat(64),
  bvh = Buffer.from("registered-bvh"),
  image = Buffer.from("image"),
  refined = Buffer.from("refined-bvh");
function fixture(replace = false) {
  const job = {
    id: "j",
    inputS3Key: "owned",
    result: {
      candidatesByPerson: [
        {
          personIndex: 4,
          outputScope: { selection: "half", resolved: "half" },
          candidates: [
            {
              id: "pick",
              poseId: "original",
              camera: {
                source_bvh_sha256: sha256Hex(bvh),
                rotation: [
                  [1, 0, 0],
                  [0, 1, 0],
                  [0, 0, 1],
                ],
              },
            },
          ],
        },
      ],
    },
  } as unknown as Job;
  const refs = [
    {
      personIndex: 4,
      candidateId: "pick",
      exportPath:
        "/v1/pose-candidates/original/framed?jobId=j&personIndex=4&candidateId=pick&format=fbx",
      sha256: sha256Hex(fbx),
    },
  ];
  const sources = [
    {
      person_index: 4,
      bytes: fbx,
      observation: {
        box: [0, 0, 100, 100],
        keypoints: Array.from({ length: 17 }, () => [5, 5]),
        scores: Array(17).fill(1),
      },
    },
  ];
  const calls: FramedInput[] = [];
  const ids: string[] = [];
  const deps = {
    loadInput: async () => new Blob([image]),
    resolveExportArtifact: async () => ({
      variant: "refined" as const,
      bytes: refined,
    }),
    getPoseBvh: async (id: string) => {
      ids.push(id);
      return new Response(bvh);
    },
    handBakeFor: async () => null,
    convertFramed: async (input: FramedInput) => {
      calls.push(input);
      return {
        fbx,
        preview: png,
        conversionId: "conv",
        artifactSha256: sha256Hex(fbx),
        sourceBvhSha256: sha256Hex(input.bvhBytes),
        characterSha256: character,
      };
    },
    request: async (stage: "plan" | "build", value: unknown) => {
      const data = value as any;
      if (stage === "plan") {
        assert.equal(data.image_sha256, sha256Hex(image));
        return {
          version: "scene-refinement-v4",
          image_sha256: sha256Hex(image),
          plan_id: "private",
          character_sha256: character,
          people: [
            { person_index: 4, pose_id: replace ? "new_pose" : "original" },
          ],
        };
      }
      assert.equal(data.artifact_only, true);
      assert.equal(data.persons[0].character_sha256, character);
      return {
        version: "scene-refinement-v4",
        plan_id: "private",
        image_sha256: sha256Hex(image),
        person_count: 1,
        artifact_contract: "verified-scene-fbx-v1",
        fbx_base64: fbx.toString("base64"),
        preview_base64: "",
        artifact_sha256: sha256Hex(fbx),
        preview_sha256: sha256Hex(Buffer.alloc(0)),
        people: [
          {
            person_index: 4,
            pose_id: replace ? "new_pose" : "original",
            output_scope: "full",
            arm_goals: [],
          },
        ],
      };
    },
  };
  return { job, refs, sources, deps, calls, ids };
}
test("retained pose preserves refined BVH and camera while restoring a full source", async () => {
  const f = fixture();
  await prepareRefinedScene("owner", f.job, f.refs, f.sources, f.deps, true);
  assert.deepEqual(f.ids, ["original"]);
  assert.deepEqual(f.calls[0]!.bvhBytes, refined);
  assert.equal(f.calls[0]!.scope, "full");
  assert.ok(f.calls[0]!.cameraRotation);
  assert.equal(f.calls[0]!.expectedCharacterSha256, character);
});
test("replacement fetches registered pose and never copies old pose camera/refine", async () => {
  const f = fixture(true);
  await prepareRefinedScene("owner", f.job, f.refs, f.sources, f.deps, true);
  assert.deepEqual(f.ids, ["new_pose"]);
  assert.deepEqual(Buffer.from(f.calls[0]!.bvhBytes), bvh);
  assert.equal(f.calls[0]!.cameraRotation, undefined);
});
test("quarantined new pose and unexpected body calibration cannot release scenes", async () => {
  const f = fixture(true);
  f.deps.getPoseBvh = async () => new Response(null, { status: 409 });
  await assert.rejects(
    prepareRefinedScene("owner", f.job, f.refs, f.sources, f.deps, true),
  );
  assert.equal(f.calls.length, 0);
  const g = fixture();
  const convert = g.deps.convertFramed;
  g.deps.convertFramed = async (v) => ({
    ...(await convert(v)),
    characterSha256: "b".repeat(64),
  });
  await assert.rejects(
    prepareRefinedScene("owner", g.job, g.refs, g.sources, g.deps, true),
  );
});
test("older clients retain the paired scene preview contract until they opt into readiness", async () => {
  const f = fixture();
  const request = f.deps.request;
  f.deps.request = async (stage, value) => {
    if (stage === "plan") return request(stage, value);
    assert.equal((value as any).artifact_only, undefined);
    const result = await request(stage, { ...(value as object), artifact_only: true });
    const { artifact_contract: _ignored, ...legacy } = result as any;
    return { ...legacy, preview_base64: png.toString("base64"), preview_sha256: sha256Hex(png) };
  };
  const scene = await prepareRefinedScene("owner", f.job, f.refs, f.sources, f.deps);
  assert.equal(scene.artifactContract, undefined);
  assert.equal(scene.preview, png.toString("base64"));
  assert.equal(f.calls[0]!.previewFormat, undefined);
});

test("summary compares owned selection with validated final results and strips private worker fields", async () => {
  const f = fixture(true);
  const original = f.deps.request;
  f.deps.request = async (stage, input) => {
    const result = await original(stage, input);
    if (stage === "build") Object.assign(result.people[0], {
      baseline_pose_id: "original", interaction: "reaching",
      direction: { torso_camera_yaw: 45, torso_label: "front_right", head_label: "front",
        head_camera_yaw: 0, head_relative_yaw: -45, head_pitch_degrees: null,
        notes: ["private model reasoning"], path: "/operator/private" },
    });
    return result;
  };
  const result = await prepareRefinedScene("owner", f.job, f.refs, f.sources, f.deps, true);
  assert.deepEqual(result.summary, [{
    personIndex: 4, previousPoseId: "original", poseId: "new_pose",
    previousOutputScope: "half", outputScope: "full", poseChanged: true, outputScopeChanged: true,
    previousDirection: null, directionChanged: null,
    direction: { torso_camera_yaw: 45, torso_label: "front_right", head_label: "front",
      head_camera_yaw: 0, head_relative_yaw: -45, head_pitch_degrees: null },
    interaction: "reaching", armGoalCount: 0,
  }]);
  assert.ok(!JSON.stringify(result.summary).includes("private"));
});
test("unreported direction and interaction stay unknown, not unchanged", async () => {
  const f = fixture();
  const result = await prepareRefinedScene("owner", f.job, f.refs, f.sources, f.deps, true);
  assert.equal(result.summary[0].direction, null);
  assert.equal(result.summary[0].previousDirection, null);
  assert.equal(result.summary[0].directionChanged, null);
  assert.equal(result.summary[0].interaction, null);
  assert.equal(result.summary[0].poseChanged, false);
});
for (const change of ["identity", "duplicate", "pose", "baseline", "scope", "direction", "missing", "previewHash"] as const)
  test(`malformed final ${change} cannot produce a scene review`, async () => {
    const f = fixture();
    const original = f.deps.request;
    f.deps.request = async (stage, input) => {
      const result = await original(stage, input);
      if (stage !== "build") return result;
      const people = result.people as Record<string, unknown>[];
      if (change === "identity") people[0].person_index = 9;
      if (change === "duplicate") people.push(people[0]);
      if (change === "pose") people[0].pose_id = "not_planned";
      if (change === "baseline") people[0].baseline_pose_id = "not_selected";
      if (change === "scope") people[0].output_scope = "invented";
      if (change === "direction") people[0].direction = { head_relative_yaw: "invalid" };
      if (change === "missing") people.splice(0);
      if (change === "previewHash") result.preview_sha256 = "b".repeat(64);
      return result;
    };
    await assert.rejects(prepareRefinedScene("owner", f.job, f.refs, f.sources, f.deps, true),
      (error: unknown) => ["SCENE_INTEGRITY", "CONVERTER_INTEGRITY"].includes((error as { code: string }).code));
  });
test("explicit converter calibration mismatch is unsupported body; other 409 errors are not guessed", async () => {
  const f = fixture();
  f.deps.convertFramed = async () => { throw new ConverterError("CONVERTER_REJECTED", "private", null, 409, "CHARACTER_SHA256_MISMATCH"); };
  await assert.rejects(prepareRefinedScene("owner", f.job, f.refs, f.sources, f.deps, true), { code: "SCENE_UNSUPPORTED_BODY" });
  f.deps.convertFramed = async () => { throw new ConverterError("CONVERTER_REJECTED", "private", null, 409, "SOURCE_BVH_SHA256_MISMATCH"); };
  await assert.rejects(prepareRefinedScene("owner", f.job, f.refs, f.sources, f.deps, true), { code: "CONVERTER_REJECTED" });
});


test("stored input SHA binds the actual v4 original bytes before any worker request", async () => {
  const f = fixture();
  f.job.inputSha256 = sha256Hex(image);
  await prepareRefinedScene("owner", f.job, f.refs, f.sources, f.deps, true);
  f.job.inputSha256 = "b".repeat(64);
  let called = false;
  f.deps.request = async () => { called = true; throw new Error("must not dispatch"); };
  await assert.rejects(prepareRefinedScene("owner", f.job, f.refs, f.sources, f.deps, true), { code: "SCENE_SOURCE_CHANGED" });
  assert.equal(called, false);
});
