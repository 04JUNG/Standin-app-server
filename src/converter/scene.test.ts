import assert from "node:assert/strict";
import test from "node:test";
import { composeRoughScene } from "./scene.js";
import { sha256Hex } from "./client.js";
const bytes = Buffer.from("Kaydara FBX Binary  \0\x1a\0fixture");
const sources = [
  {
    person_index: 2,
    bytes,
    observation: {
      box: [0, 0, 100, 100],
      keypoints: Array.from({ length: 17 }, () => [10, 10]),
      scores: Array(17).fill(0.8) as number[],
    },
  },
];
test("binds the returned scene to exact observations, files and protocol", async () => {
  const result = await composeRoughScene(
    "cut",
    { width: 200, height: 200 },
    sources,
    {
      baseUrl: "https://converter.test",
      fetch: async (url, init) => {
        assert.equal(url, "https://converter.test/compose-scene");
        const form = init!.body as FormData;
        const manifest = String(form.get("manifest"));
        const row = JSON.parse(manifest).persons[0];
        assert.equal(row.person_index, 2);
        assert.equal(row.fbx_sha256, sha256Hex(bytes));
        assert.equal("position" in row, false);
        assert.equal(form.get("response_format"), "fbx");
        return new Response(bytes, {
          headers: {
            "X-Standin-Artifact-SHA256": sha256Hex(bytes),
            "X-Standin-FBX-Artifact-SHA256": sha256Hex(bytes),
            "X-Standin-Scene-Input-SHA256": sha256Hex(Buffer.from(manifest)),
            "X-Standin-Person-Count": "1",
            "X-Standin-Scene-Version": "rough-layout-v1",
          },
        });
      },
    },
  );
  assert.deepEqual(result.bytes, bytes);
});
test("rejects a successful response without bound scene lineage", async () => {
  await assert.rejects(
    composeRoughScene("cut", { width: 200, height: 200 }, sources, {
      baseUrl: "https://converter.test",
      fetch: async () => new Response(bytes),
    }),
    { code: "CONVERTER_INTEGRITY" },
  );
});
