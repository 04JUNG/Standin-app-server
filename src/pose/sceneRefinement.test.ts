import assert from "node:assert/strict";
import test from "node:test";
import type { Job } from "../jobs/store.js";
import { prepareRefinedScene } from "./sceneRefinement.js";
import { sha256Hex } from "../converter/client.js";
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
          outputScope: { resolved: "half" },
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
      assert.equal(data.persons[0].character_sha256, character);
      return {
        version: "scene-refinement-v4",
        plan_id: "private",
        image_sha256: sha256Hex(image),
        person_count: 1,
        fbx_base64: fbx.toString("base64"),
        preview_base64: png.toString("base64"),
        artifact_sha256: sha256Hex(fbx),
        preview_sha256: sha256Hex(png),
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
  await prepareRefinedScene("owner", f.job, f.refs, f.sources, f.deps);
  assert.deepEqual(f.ids, ["original"]);
  assert.deepEqual(f.calls[0]!.bvhBytes, refined);
  assert.equal(f.calls[0]!.scope, "full");
  assert.ok(f.calls[0]!.cameraRotation);
  assert.equal(f.calls[0]!.expectedCharacterSha256, character);
});
test("replacement fetches registered pose and never copies old pose camera/refine", async () => {
  const f = fixture(true);
  await prepareRefinedScene("owner", f.job, f.refs, f.sources, f.deps);
  assert.deepEqual(f.ids, ["new_pose"]);
  assert.deepEqual(Buffer.from(f.calls[0]!.bvhBytes), bvh);
  assert.equal(f.calls[0]!.cameraRotation, undefined);
});
test("quarantined new pose and unexpected body calibration cannot release scenes", async () => {
  const f = fixture(true);
  f.deps.getPoseBvh = async () => new Response(null, { status: 409 });
  await assert.rejects(
    prepareRefinedScene("owner", f.job, f.refs, f.sources, f.deps),
  );
  assert.equal(f.calls.length, 0);
  const g = fixture();
  const convert = g.deps.convertFramed;
  g.deps.convertFramed = async (v) => ({
    ...(await convert(v)),
    characterSha256: "b".repeat(64),
  });
  await assert.rejects(
    prepareRefinedScene("owner", g.job, g.refs, g.sources, g.deps),
  );
});
