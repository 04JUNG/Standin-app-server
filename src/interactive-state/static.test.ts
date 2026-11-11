import { test } from "node:test";
import assert from "node:assert/strict";
import { createStaticPreviews } from "./static.js";
import { sha256Hex } from "../converter/client.js";
import { getOwnedJob } from "../jobs/store.js";
import type { AnalysisPerson } from "../types.js";
import { bodyStore } from "../body-selection/store.js";
const source = new TextEncoder().encode("registered-source"),
  bytes = new TextEncoder().encode("glTF-protocol-fixture");
const eye = Array.from({ length: 16 }, (_, i) => Number(i % 5 === 0));
const asset = {
  schemaVersion: "interactive-static-asset-v1",
  sha256: sha256Hex(bytes),
  bytes: bytes.length,
  sourceSha256: sha256Hex(source),
  characterId: "registered",
  characterSha256: "c".repeat(64),
  scope: "full",
  revision: "test",
  modelVersion: "posed-mesh-v1",
  camera: {
    schemaVersion: "interactive-camera-v1",
    projection: "orthographic",
    viewMatrix: eye,
    projectionMatrix: eye,
    matrixLayout: "column-major",
    basis: "right-handed-Y-up",
    clipSpace: "webgl-minus-one-to-one",
    origin: "hips",
    units: "meters",
    distanceTorso: 12,
    torsoReferenceSha256: "c".repeat(64),
    target: [0, 0, 0],
    referenceAspect: 1,
    framing: "projection-includes-center-scale-crop",
    baked: "none",
  },
};
const person = {
  personIndex: 0,
  candidates: [
    {
      id: "candidate",
      sourceBvhSha256: sha256Hex(source),
      camera: { version: "candidate-camera-v2" },
    },
  ],
} as unknown as AnalysisPerson;
const body:Awaited<ReturnType<typeof bodyStore.selection>> = {
 schemaVersion:"body-selection.v1",personIndex:0,intent:"inherit",manualCharacterId:null,
 recommendation:{status:"unavailable",body:null,reasonCodes:[]},resolvedSource:"catalog_default_fallback",renderingExecuted:false,
 selectionRevision:1,resolutionStatus:"ready",shape:null,
 resolvedBody:{characterId:"registered",assetSha256:"c".repeat(64),bodyId:"registered",bodyVersion:"1",rigVersion:"1",measurementVersion:"1"}
};
function setup() {
  let available = true,
    revoked = false,
    changedScope = false,
    corrupt = false,
    reads = 0;
  let onRead = () => {};
  const service = createStaticPreviews({
    getOwnedJob: async (_job, owner) =>
      owner === "owner" && available
        ? ({
            status: "completed",
            result: {
              candidatesByPerson: [
                changedScope
                  ? { ...person, outputScope: { selection: "head" } }
                  : person,
              ],
            },
          } as unknown as Awaited<ReturnType<typeof getOwnedJob>>)
        : undefined,
    selection: async () => (revoked ? { ...body, selectionRevision: 2 } : body),
    candidateSourceBytes: async () => source,
    transport: {
      staticResolve: async () => [asset],
      staticFile: async () => {
        reads++;
        onRead();
        return corrupt ? new Uint8Array([1]) : bytes;
      },
    },
  });
  return {
    service,
    onRead(fn: () => void) {
      onRead = fn;
    },
    get reads() {
      return reads;
    },
    revoke() {
      revoked = true;
    },
    changeScope() {
      changedScope = true;
    },
    corrupt() {
      corrupt = true;
    },
    remove() {
      available = false;
    },
  };
}
const location = { installationId: "owner", jobId: "job_test", personIndex: 0 };
test("static assets preserve exact source/character/scope and owned download hashes", async () => {
  const s = setup();
  assert.deepEqual(
    await s.service.file(
      location,
      "candidate",
      asset.sha256,
      new AbortController().signal,
    ),
    bytes,
  );
  assert.equal(s.reads, 1);
});
test("cross installation and removed job cannot fetch static bytes", async () => {
  const s = setup();
  await assert.rejects(
    s.service.file(
      { ...location, installationId: "other" },
      "candidate",
      asset.sha256,
      new AbortController().signal,
    ),
    /NOT_FOUND/,
  );
  s.remove();
  await assert.rejects(
    s.service.file(
      location,
      "candidate",
      asset.sha256,
      new AbortController().signal,
    ),
    /NOT_FOUND/,
  );
  assert.equal(s.reads, 0);
});
test("static byte corruption is rejected", async () => {
  const s = setup();
  s.corrupt();
  await assert.rejects(
    s.service.file(
      location,
      "candidate",
      asset.sha256,
      new AbortController().signal,
    ),
    /INTEGRITY/,
  );
});
test("body or scope changes during byte fetch are rejected before delivery", async () => {
  for (const change of ["revoke", "changeScope"] as const) {
    const s = setup();
    s.onRead(s[change]);
    await assert.rejects(
      s.service.file(
        location,
        "candidate",
        asset.sha256,
        new AbortController().signal,
      ),
      /STALE/,
    );
  }
});
