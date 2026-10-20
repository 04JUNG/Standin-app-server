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

test("an SSR2 runtime is served only when its header names the catalog's source", async () => {
  const folder = await mkdtemp(join(tmpdir(), "body-runtime-v2-"));
  try {
    const source = { rules: "standin-body-0.7.1", blendSha256: "1".repeat(64), controllerSha256: "2".repeat(64) };
    const ssr2 = (header: object) => {
      let text = Buffer.from(JSON.stringify(header));
      text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 32)]);
      const size = Buffer.alloc(4);
      size.writeUInt32LE(text.length);
      return Buffer.concat([Buffer.from("SSR2"), size, text, Buffer.alloc(16)]);
    };
    const asset = (bytes: Buffer) => {
      const c = catalog(1),
        a = c.assets[0]!;
      a.shape = spec;
      a.shapeSource = source;
      a.shapeRuntime = {
        path: join(folder, "rt2.ssr"),
        sha256: sha256Hex(bytes),
        bytes: bytes.length,
        format: "standin-shape-runtime.v2",
        rules: source.rules,
        preset: "BASE",
      };
      return { c, a };
    };
    const good = ssr2({ rules: source.rules, source: { blendSha256: source.blendSha256, controllerSha256: source.controllerSha256 } });
    const ok = asset(good);
    await writeFile(ok.a.shapeRuntime!.path, good);
    assert.equal(parseCatalog(ok.c).assets.length, 1);
    assert.deepEqual(await readShapeRuntime(ok.a), good);
    const other = ssr2({ rules: source.rules, source: { blendSha256: "9".repeat(64), controllerSha256: source.controllerSha256 } });
    const bad = asset(other);
    await writeFile(bad.a.shapeRuntime!.path, other);
    await assert.rejects(readShapeRuntime(bad.a), /source mismatch/);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("a v1 runtime next to a declared source is served only with the same source in its header", async () => {
  const folder = await mkdtemp(join(tmpdir(), "body-runtime-v1-source-"));
  try {
    const source = { rules: "standin-body-0.7.1", blendSha256: "1".repeat(64), controllerSha256: "2".repeat(64) };
    const ssr1 = (header: object) => {
      let text = Buffer.from(JSON.stringify(header));
      text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 32)]);
      const size = Buffer.alloc(4);
      size.writeUInt32LE(text.length);
      return Buffer.concat([Buffer.from("SSR1"), size, text, Buffer.alloc(16)]);
    };
    const setup = (bytes: Buffer, rules = source.rules) => {
      const c = catalog(1),
        a = c.assets[0]!;
      a.shape = spec;
      a.shapeSource = source;
      a.shapeRuntime = { path: join(folder, "rt1.ssr"), sha256: sha256Hex(bytes), bytes: bytes.length, format: "standin-shape-runtime.v1", rules, preset: "BASE" };
      return { c, a };
    };
    const withSource = ssr1({ rules: source.rules, source: { blendSha256: source.blendSha256, controllerSha256: source.controllerSha256 } });
    const ok = setup(withSource);
    await writeFile(ok.a.shapeRuntime!.path, withSource);
    assert.equal(parseCatalog(ok.c).assets.length, 1);
    assert.deepEqual(await readShapeRuntime(ok.a), withSource);
    const old = ssr1({ rules: source.rules });
    const legacy = setup(old);
    await writeFile(legacy.a.shapeRuntime!.path, old);
    await assert.rejects(readShapeRuntime(legacy.a), /source mismatch/);
    assert.throws(() => parseCatalog(setup(withSource, "standin-body-0.6.10").c), /does not match shape source/);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
