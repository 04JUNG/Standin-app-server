import test from "node:test";
import assert from "node:assert/strict";
import { bindInteractiveCamera, createSelectionResolver } from "./selection.js";
import { sha256Hex } from "../converter/client.js";
import type { Job } from "../jobs/store.js";
import type { BodySelection } from "../body-selection/model.js";
import type { HandBake } from "../hands/model.js";
const source = Buffer.from("server-approved-bvh"),
  sha = sha256Hex(source);
function setup(purpose: "export" | "preview" = "export") {
  const s = {
    owner: true,
    confirmed: true,
    previewOnly: false,
    manual: false,
    member: true,
    quarantine: false,
    refined: false,
    hand: null as HandBake | null,
    bodyRevision: 1,
    scope: "full",
    character: "ok",
    runtime: "a".repeat(64),
    catalogSha: "c".repeat(64),
    source: source,
  };
  const body = () =>
    ({
      resolutionStatus: "ready",
      previewOnly: s.previewOnly,
      selectionRevision: s.bodyRevision,
      resolvedBody: {
        characterId: "registered",
        assetSha256: "c".repeat(64),
        rigVersion: "rig-v1",
      },
      shape: null,
      shapeSource: null,
    }) as BodySelection;
  const resolver = createSelectionResolver(
    {
      manualPresentationCamera: (_person, candidate) => s.manual ? { camera: candidate?.camera } as never : null,
      loadBodyCatalog: () => ({ version: "test", defaultCharacterId: null, assets: [{ characterId: "registered", assetSha256: s.catalogSha, shapeRuntime: { rules: "standin-body-0.7.2" } }] }) as never,
      getOwnedJob: async () =>
        s.owner
          ? ({
              status: "completed",
              result: {
                source: "capture",
                candidatesByPerson: [
                  {
                    personIndex: 0,
                    outputScope: { resolved: s.scope },
                    candidates: [
                      {
                        id: "candidate",
                        poseId: "pose",
                        sourceBvhSha256: sha,
                        releaseAllowed: !s.manual,
                        source: s.manual ? "library" : undefined,
                        manualExportAllowed: s.manual,
                        lookupAllowed: s.manual,
                        reviewRequired: s.manual,
                        refineAllowed: false,
                        bvhAvailable: true,
                        camera: {
                          version: "candidate-camera-v2",
                          source_bvh_sha256: sha,
                          projection: "orthographic",
                          rotation: [
                            [1, 0, 0],
                            [0, 1, 0],
                            [0, 0, 1],
                          ],
                          distance_torso: 4,
                        },
                      },
                    ],
                  },
                ],
              },
            } as unknown as Job)
          : undefined,
      validateExportCandidate: async () => s.member,
      validateConfirmedSelection: async () => s.confirmed,
      getPoseBvh: async () =>
        new Response(s.source, { status: s.quarantine ? 409 : 200 }),
      selection: async () => body(),
      checkCharacter: async () => (s.character === "ok" ? "ok" : "unavailable"),
      handBakeFor: async () => s.hand,
      resolveExportArtifact: async () =>
        s.refined
          ? { variant: "refined", bytes: Buffer.from("refine") }
          : { variant: "base", fallbackReason: null },
      findRefinedArtifact: async () => null,
      runtime: async () => ({
        schemaVersion: "body-preview-runtime.v1",
        previewRevision: s.runtime,
        modelVersion: "posed-mesh-v1",
        modelRevision: s.runtime,
        solverVersion: "chain-transport-v3.2.5",
        framingVersion: "skin-regions-v2-shoulder-head",
      }),
      modelPreviewIdentity: async () => ({
        characterSha256: "c".repeat(64),
        modelRevision: s.runtime,
      }),
    },
    purpose,
  );
  return {
    s,
    resolve: (extraLocation: Record<string, unknown> = {}) =>
      resolver(
        { installationId: "inst_owner", jobId: "job_fixture", personIndex: 0, ...extraLocation },
        "candidate",
      ),
  };
}
test("resolver binds real current server source/body/hands/runtime and catches quarantine or revoked choice", async () => {
  const { s, resolve } = setup();
  const first = await resolve();
  assert.equal(first.sourceSha, sha);
  s.bodyRevision++;
  assert.notEqual((await resolve()).selectionHash, first.selectionHash);
  s.hand = {
    left: "fist",
    right: "keep",
    library_version: "hand-library-v1",
    library_sha256: "d".repeat(64),
    revision: 1,
  };
  assert.notEqual((await resolve()).selectionHash, first.selectionHash);
  s.source = Buffer.from("different");
  await assert.rejects(
    resolve(),
    (e) =>
      e instanceof Error && "code" in e && e.code === "PREVIEW_SOURCE_CHANGED",
  );
  s.source = source;
  s.quarantine = true;
  await assert.rejects(resolve());
  s.quarantine = false;
  s.confirmed = false;
  await assert.rejects(resolve(), /SELECTION_REQUIRED/);
  s.confirmed = true;
  s.member = false;
  await assert.rejects(resolve(), /INVALID_SELECTION/);
  s.member = true;
  s.owner = false;
  await assert.rejects(resolve(), /NOT_FOUND/);
});

test("preview resolver permits unconfirmed browsing while retaining ownership and quarantine checks", async () => {
  const { s, resolve } = setup("preview");
  s.confirmed = false;
  await resolve();
  s.owner = false;
  await assert.rejects(resolve, /NOT_FOUND/);
  s.owner = true;
  s.quarantine = true;
  await assert.rejects(resolve);
});

test("preview-only body permission never becomes export authority", async () => {
  const preview = setup("preview"),
    exporting = setup("export");
  preview.s.previewOnly = exporting.s.previewOnly = true;
  await preview.resolve();
  await assert.rejects(exporting.resolve, /BODY_PREVIEW_STALE/);
});

test("operation metadata cannot change the exact location ownership binding during revalidation", async () => {
  const { resolve } = setup();
  const initial = await resolve();
  const revalidated = await resolve({ operationId: "op_existing", revision: 7,
    selectionHash: initial.selectionHash, stateHash: "f".repeat(64), snapshotId: "snapshot", appearance: { version: "fbx-outline-v1", width: 1 } });
  assert.equal(revalidated.identity.ownerBinding, initial.identity.ownerBinding);
  assert.equal(revalidated.selectionHash, initial.selectionHash);
  assert.notEqual((await resolve({ installationId: "inst_other" })).identity.ownerBinding, initial.identity.ownerBinding);
  assert.notEqual((await resolve({ jobId: "job_other" })).identity.ownerBinding, initial.identity.ownerBinding);
});

test("manual preview camera receives exact validated source without changing its projection", () => {
  const camera = { version: "pose-preview-camera-v1", projection: "perspective", distance_torso: 8, rotation: [[1,0,0],[0,1,0],[0,0,1]] };
  assert.deepEqual(bindInteractiveCamera(camera, sha), { ...camera, source_bvh_sha256: sha });
  assert.equal("source_bvh_sha256" in camera, false);
});

test("default shape rules are bound only from an exact trusted catalog body", async () => {
 const {s,resolve}=setup("preview");
 const first=await resolve();
 assert.equal(first.defaultShapeRules,"standin-body-0.7.2");
 assert.equal(first.identity.defaultShapeRules,"standin-body-0.7.2");
 s.catalogSha="d".repeat(64);
 const changed=await resolve();
 assert.equal(changed.defaultShapeRules,null);
 assert.notEqual(first.selectionHash,changed.selectionHash);
});

test("confirmed hash-bound manual review exports a presentation body without upgrading preview authority", async () => {
  const { s, resolve } = setup("export");
  s.previewOnly = true;
  s.manual = true;
  await resolve();
  s.confirmed = false;
  await assert.rejects(resolve, /SELECTION_REQUIRED/);
  s.confirmed = true;
  s.quarantine = true;
  await assert.rejects(resolve);
  s.quarantine = false;
  s.catalogSha = "d".repeat(64);
  // The selected body must still resolve to the actual registered model identity.
  s.character = "unavailable";
  await assert.rejects(resolve, /CHARACTER_UNAVAILABLE/);
});
