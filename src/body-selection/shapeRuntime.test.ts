import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalog } from "./fixtures.js";
import { parseCatalog } from "./catalog.js";
import {
  readShapeRuntime,
  shapeRuntimeMetadata,
  validShapeRuntime,
} from "./shapeRuntime.js";
import { sha256Hex } from "../converter/client.js";
import type { ShapeSpec } from "./shape.js";

const spec: ShapeSpec = {
  schemaVersion: "body-shape.v1",
  controls: [{ key: "height", min: 160, max: 195, step: 1, default: 178 }],
};

test("approved shape runtime is bound to shape controls, size and hash", async () => {
  const folder = await mkdtemp(join(tmpdir(), "body-runtime-"));
  try {
    const bytes = Buffer.concat([Buffer.from("SSR1"), Buffer.alloc(60, 1)]);
    const c = catalog(1),
      a = c.assets[0];
    a.shape = spec;
    a.shapeRuntime = {
      path: join(folder, "rt.ssr"),
      sha256: sha256Hex(bytes),
      bytes: bytes.length,
      format: "standin-shape-runtime.v1",
      rules: "standin-body-0.6.7",
      preset: "BASE",
    };
    await writeFile(a.shapeRuntime.path, bytes);
    assert.equal(parseCatalog(c).assets.length, 1);
    const meta = shapeRuntimeMetadata(a)!;
    assert.equal(
      meta.url,
      `/v1/models/${encodeURIComponent(a.characterId)}/shape-runtime/${sha256Hex(bytes)}`,
    );
    assert.equal("path" in meta, false);
    assert.deepEqual(await readShapeRuntime(a), bytes);

    // No numeric controls → nothing to preview live.
    const noShape = structuredClone(c);
    delete noShape.assets[0].shape;
    assert.throws(() => parseCatalog(noShape), /invalid shape runtime/);
    for (const bad of [
      { preset: "base" },
      { format: "standin-shape-runtime.v0" },
      { bytes: 0 },
      { sha256: "x" },
      { path: "relative.ssr" },
    ]) {
      const w = structuredClone(c);
      Object.assign(w.assets[0].shapeRuntime!, bad);
      assert.throws(() => parseCatalog(w), /invalid shape runtime/);
    }
    // Wrong magic or size is never served.
    await writeFile(a.shapeRuntime.path, Buffer.concat([Buffer.from("XXXX"), Buffer.alloc(60)]));
    await assert.rejects(readShapeRuntime(a));
    await writeFile(a.shapeRuntime.path, Buffer.from("SSR1"));
    await assert.rejects(readShapeRuntime(a));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("validShapeRuntime rejects missing input", () => {
  assert.equal(validShapeRuntime(null, spec), false);
  assert.equal(validShapeRuntime(undefined, spec), false);
});
