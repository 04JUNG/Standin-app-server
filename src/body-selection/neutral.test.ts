import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalog } from "./fixtures.js";
import { parseCatalog } from "./catalog.js";
import { neutralMetadata, readNeutral } from "./neutral.js";
import { sha256Hex } from "../converter/client.js";
test("approved neutral preview binds body hash and does not expose local path", async () => {
  const folder = await mkdtemp(join(tmpdir(), "body-neutral-"));
  try {
    const c = catalog(1),
      a = c.assets[0];
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2]);
    a.neutralPreview = {
      path: join(folder, "card.png"),
      sha256: sha256Hex(bytes),
      characterSha256: a.assetSha256,
      pose: "attention",
      framing: "body-comparison.v1",
    };
    await writeFile(a.neutralPreview.path, bytes);
    assert.equal(parseCatalog(c).assets.length, 1);
    assert.equal(
      neutralMetadata(a)?.url,
      `/v1/models/${encodeURIComponent(a.characterId)}/body-preview/${sha256Hex(bytes)}`,
    );
    assert.equal("path" in neutralMetadata(a)!, false);
    assert.deepEqual(await readNeutral(a), bytes);
    const wrong = structuredClone(c);
    wrong.assets[0].neutralPreview!.characterSha256 = "f".repeat(64);
    assert.throws(() => parseCatalog(wrong));
    await writeFile(a.neutralPreview.path, "not a PNG");
    await assert.rejects(readNeutral(a));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
