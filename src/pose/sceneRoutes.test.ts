import { config } from "../config.js";
import { encodeSceneReceipt, decodeSceneReceipt, sceneReceiptStorageAvailable, saveSceneReceipt } from "./sceneStorage.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import type { Job } from "../jobs/store.js";
import { SCENE_REVIEW_VERSION, SceneError, sceneSaveContract } from "./sceneContract.js";
import { type SceneReceipt } from "./sceneStorage.js";
import { sha256Hex } from "../converter/client.js";
import { createSceneRoutes } from "./sceneRoutes.js";
import { createRequireInstallation } from "../installations/middleware.js";
import { CLIENT_VERSION_HEADER } from "../client-version/policy.js";

const fbx = Buffer.from("Kaydara FBX Binary  \0\x1a\0person");
const correction = { contractVersion: "scene-save-v1", saveMode: "auto-correct-v4" };
const confirmation = { ...correction, reviewVersion: "scene-review-v1", artifactSha256: sha256Hex(fbx) };
function setup(refinement = false, shared = new Map<string, Uint8Array>(), storedVersion?: string) {
  const state = {
    owner: true,
    installationId: "owner",
    failPrepare: undefined as Error | undefined,
    storageFails: false,
    changeJob: false,
    confirmed: true,
    reviewStatus: 200,
    reads: 0,
    composed: 0,
    changeHands: false,
    preparations: 0,
    tamper: false,
    previewFails: false,
    renders: 0,
    onRender: undefined as (() => void) | undefined,
    sent: [] as number[],
    clientVersion: "0.2.3-dev.392" as string | undefined,
    forwardedVersions: [] as (string | null)[],
  };
  const job = {
    id: "job",
    inputS3Key: "owned-raw-image",
    status: "completed",
    updatedAt: "v1",
    result: {
      image: { width: 765, height: 714 },
      candidatesByPerson: [0, 1].map((i) => ({
        personIndex: i,
        box: [10 + i * 300, 20, 250 + i * 300, 650],
        skeleton: {
          keypoints: Array.from({ length: 17 }, () => [100, 100]),
          scores: Array(17).fill(0.8),
        },
        candidates: [{ id: `pick${i}`, poseId: `pose${i}` }],
      })),
    },
  } as Job;
  const protectedArtifact = new Hono<AppEnv>();
  protectedArtifact.use("*", (c, next) => {
    c.set("requestId", "artifact-req");
    return next();
  });
  protectedArtifact.use("*", createRequireInstallation(async () => ({
    id: state.installationId,
    consentVersion: config.consentVersion,
    appVersion: storedVersion ?? "0.2.0",
  })));
  protectedArtifact.get("*", c => c.body(fbx));
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("requestId", "req");
    c.set("installationId", state.installationId);
    await next();
  });
  app.route(
    "/",
    createSceneRoutes(
      async (request) => {
        state.reads++;
        state.forwardedVersions.push(request.headers.get(CLIENT_VERSION_HEADER));
        if (storedVersion !== undefined) {
          const authorized = await protectedArtifact.fetch(request);
          if (!authorized.ok) return authorized;
        }
        assert.equal(request.headers.get("X-Installation-Id"), state.installationId);
        assert.equal(new URL(request.url).origin, "https://scene.internal");
        if (state.changeHands && state.composed)
          return new Response("changed hands", { status: 409 });
        return new Response(state.tamper ? Buffer.from("wrong") : fbx, {
          status: state.reviewStatus,
        });
      },
      {
        saveSceneReceipt: async (owner, job, key, receipt) => {
          if (state.storageFails) throw new SceneError("SCENE_UNAVAILABLE", "fixture publication failure");
          shared.set(`${owner}/${job}/${key}`, encodeSceneReceipt(receipt));
        },
        loadSceneReceipt: async (owner, job, key) => {
          const value = shared.get(`${owner}/${job}/${key}`);
          return value ? decodeSceneReceipt(value) : undefined;
        },
        renderFinalPreview: async () => {
          state.renders++;
          state.onRender?.();
          if (state.previewFails) throw new Error("render unavailable");
          return Buffer.from([137,80,78,71,13,10,26,10]);
        },
        enabled: () => true,
        refinementEnabled: () => refinement,
        prepareRefinedScene: async () => {
          state.composed++;
          state.preparations++;
          if (state.failPrepare) throw state.failPrepare;
          if (state.changeJob) job.updatedAt = "v2";
          return {
            bytes: fbx,
            sha256: sha256Hex(fbx),
            preview: Buffer.from("preview").toString("base64"),
            previewSha256: sha256Hex(Buffer.from("preview")),
            summary: [],
          };
        },
        getOwnedJob: async () => (state.owner ? structuredClone(job) : undefined),
        validateConfirmedSelection: async () => state.confirmed,
        composeRoughScene: async (_id, image, sources) => {
          state.composed++;
          state.sent = sources.map((s) => s.person_index);
          assert.deepEqual(image, job.result!.image);
          if (sources[1]) assert.equal(sources[1].observation.box[0], 310);
          assert.deepEqual(Buffer.from(sources[0]!.bytes), fbx);
          return { bytes: fbx, sha256: sha256Hex(fbx) };
        },
      },
    ),
  );
  const rows = [0, 1].map((i) => ({
    personIndex: i,
    candidateId: `pick${i}`,
    sha256: sha256Hex(fbx),
    exportPath: `/v1/pose-candidates/pose${i}/framed?jobId=job&personIndex=${i}&candidateId=pick${i}&format=fbx&reviewKey=review`,
  }));
  return {
    state,
    shared,
    job,
    rows,
    send: (extra: Record<string, unknown> = {}) =>
      app.request("/job/scene", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Installation-Id": state.installationId,
          "X-Device-Token": "token",
          ...(state.clientVersion === undefined ? {} : { [CLIENT_VERSION_HEADER]: state.clientVersion }),
        },
        body: JSON.stringify({ persons: rows, ...extra }),
      }),
  };
}
test("upgraded installations retain their version through scene source reads and release checks", async () => {
  const s = setup(false, undefined, "0.1.1-beta.8");
  const response = await s.send();
  assert.equal(response.status, 200);
  assert.equal(s.state.composed, 1);
  assert.deepEqual(s.state.forwardedVersions, Array(4).fill("0.2.3-dev.392"));
});
test("scene dispatch preserves version-policy rejection and legacy headerless fallback", async () => {
  for (const [stored, sent, expected] of [
    ["0.2.0", "0.1.9", 426],
    ["0.1.1-beta.8", undefined, 426],
    ["0.2.0", undefined, 200],
  ] as const) {
    const s = setup(false, undefined, stored);
    s.state.clientVersion = sent;
    assert.equal((await s.send()).status, expected);
    if (expected === 426) assert.equal(s.state.composed, 0);
  }
});
test("reviewed files plus owned observations compose one authenticated scene", async () => {
  const s = setup(),
    res = await s.send();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("X-Standin-Person-Count"), "2");
  assert.deepEqual(s.state.sent, [0, 1]);
  assert.equal(s.state.reads, 4);
});
test("foreign jobs, unconfirmed selections and rejected reviews never compose", async () => {
  for (const key of ["owner", "confirmed", "reviewStatus"] as const) {
    const s = setup();
    if (key === "reviewStatus") s.state.reviewStatus = 409;
    else s.state[key] = false;
    assert.equal((await s.send()).status, 409);
    assert.equal(s.state.composed, 0);
  }
});
test("never dispatches foreign URLs or duplicate identity parameters", async () => {
  for (const path of [
    "https://evil.test/v1/pose-candidates/pose0/framed",
    "/v1/analysis/jobs/job/scene",
    "/v1/pose-candidates/pose0/framed?jobId=job&jobId=other&personIndex=0&candidateId=pick0&format=fbx",
  ]) {
    const s = setup();
    s.rows[0]!.exportPath = path;
    assert.equal((await s.send()).status, 400);
    assert.equal(s.state.reads, 0);
  }
});
test("artifact substitution and body/hand changes during composition fail closed", async () => {
  const a = setup();
  a.state.tamper = true;
  assert.equal((await a.send()).status, 409);
  assert.equal(a.state.composed, 0);
  const b = setup();
  b.state.changeHands = true;
  assert.equal((await b.send()).status, 409);
  assert.equal(b.state.composed, 1);
});

test("scene refinement requires review, pins exact artifact and rechecks hands on release", async () => {
  const s = setup(true);
  assert.equal((await s.send(confirmation)).status, 409);
  const prepared = await s.send({ ...correction, prepare: true });
  assert.equal(prepared.status, 200);
  const receipt = (await prepared.json()) as {
    reviewKey: string;
    artifactSha256: string;
  };
  assert.equal(receipt.artifactSha256, sha256Hex(fbx));
  const download = await s.send({ ...confirmation, reviewKey: receipt.reviewKey });
  assert.equal(download.status, 200);
  assert.equal(
    download.headers.get("X-Standin-Scene-Version"),
    "scene-refinement-v4",
  );
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), fbx);
  assert.equal(s.state.preparations, 1);
  s.state.changeHands = true;
  assert.equal((await s.send({ ...confirmation, reviewKey: receipt.reviewKey })).status, 409);
});
test("review receipts cannot cross jobs or source references", async () => {
  const a = setup(true);
  const receipt = (await (await a.send({ ...correction, prepare: true })).json()) as {
    reviewKey: string;
  };
  a.rows[0]!.exportPath += "&changed=1";
  assert.equal((await a.send({ ...confirmation, reviewKey: receipt.reviewKey })).status, 409);
  assert.equal((await a.send({ ...confirmation, reviewKey: "unknown" })).status, 409);
});

test("generated sources explicitly require individual files and never enter scene/refinement", async () => {
  const f = setup(true);
  const c = f.job.result!.candidatesByPerson[0].candidates[0];
  c.source = "generation"; c.poseId = null;
  const r = await f.send();
  assert.equal(r.status, 409);
  assert.equal((await r.json() as { error: { code: string } }).error.code, "GENERATED_INDIVIDUAL_ONLY");
  assert.equal(f.state.reads, 0); assert.equal(f.state.composed, 0);
});

test("scene image failure cannot block the verified scene receipt and never rebuilds FBX", async () => {
  const s = setup(true);
  const ready = await s.send({ ...correction, prepare: true });
  assert.equal(ready.status, 200);
  const receipt = await ready.json() as { reviewKey: string };
  assert.equal(s.state.renders, 0);
  s.state.previewFails = true;
  assert.equal((await s.send({ ...confirmation, reviewKey: receipt.reviewKey, preview: true })).status, 502);
  assert.equal((await s.send({ ...confirmation, reviewKey: receipt.reviewKey })).status, 200);
  assert.equal(s.state.preparations, 1);
  s.state.previewFails = false;
  assert.equal((await s.send({ ...confirmation, reviewKey: receipt.reviewKey, preview: true })).status, 200);
  s.state.changeHands = true;
  assert.equal((await s.send({ ...confirmation, reviewKey: receipt.reviewKey, preview: true })).status, 409);
});

test("shared scene receipt roundtrip pins final bytes and rejects corruption", () => {
  const receipt: SceneReceipt = { reviewVersion: SCENE_REVIEW_VERSION, binding: "a".repeat(64), expires: Date.now()+1000, scene: {
    artifactContract: "verified-scene-fbx-v1" as const, bytes: fbx, sha256: sha256Hex(fbx),
    preview: "", previewSha256: sha256Hex(Buffer.alloc(0)), summary: [],
  } };
  assert.deepEqual(decodeSceneReceipt(encodeSceneReceipt(receipt)), receipt);
  const changed = JSON.parse(encodeSceneReceipt(receipt).toString("utf8"));
  changed.scene.bytes = Buffer.from("different").toString("base64");
  assert.throws(() => decodeSceneReceipt(Buffer.from(JSON.stringify(changed))), { code: "CONVERTER_INTEGRITY" });
});

async function errorCode(response: Response, code: string, status: number, recovery?: string) {
  assert.equal(response.status, status);
  const body = await response.json() as { error: { code: string; details?: { recovery: string } } };
  assert.equal(body.error.code, code);
  if (recovery) assert.equal(body.error.details?.recovery, recovery);
}
for (const enabled of [false, true]) test(`legacy and explicit original selection stay basic, refinement=${enabled}`, async () => {
  const f = setup(enabled);
  for (const extra of [{}, { contractVersion: "scene-save-v1", saveMode: "original-selection" }]) {
    const r = await f.send(extra);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("X-Standin-Scene-Version"), "rough-layout-v1");
    assert.equal(r.headers.get("X-Standin-Scene-Save-Mode"), "original-selection");
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), fbx);
  }
  assert.equal(f.state.preparations, 0);
});
test("correction requires explicit negotiated mode; missing original/flag never silently downgrades", async () => {
  const f = setup(true);
  for (const request of [
    { prepare: true }, { reviewKey: "a".repeat(48) }, { ...correction, contractVersion: "future" },
    { ...correction, saveMode: "other" }, { contractVersion: "scene-save-v1" },
    { saveMode: "auto-correct-v4" }, { ...confirmation, reviewVersion: "future" },
  ]) await errorCode(await f.send(request), "SCENE_CONTRACT_UNSUPPORTED", 409, "refresh_capabilities");
  assert.equal(f.state.reads, 0);
  await errorCode(await setup(false).send({ ...correction, prepare: true }), "SCENE_UNAVAILABLE", 503, "retry_later");
  f.job.inputS3Key = null;
  await errorCode(await f.send({ ...correction, prepare: true }), "SCENE_UNAVAILABLE", 503);
  assert.equal(f.state.composed, 0);
});
test("prepare publishes review version, expiration and one-file count; requires exact reviewed SHA", async () => {
  const f = setup(true);
  const start = Date.now();
  const r = await f.send({ ...correction, prepare: true });
  const body = await r.json() as { reviewKey: string; reviewVersion: string; expiresAt: string; contractVersion: string; saveMode: string; personCount: number; fileCount: number };
  assert.equal(r.status, 200);
  assert.equal(body.reviewVersion, "scene-review-v1");
  assert.equal(body.contractVersion, "scene-save-v1");
  assert.equal(body.saveMode, "auto-correct-v4");
  assert.equal(body.personCount, 2); assert.equal(body.fileCount, 1);
  assert.ok(Date.parse(body.expiresAt) >= start + 900_000);
  assert.ok(Date.parse(body.expiresAt) <= Date.now() + 900_000);
  await errorCode(await f.send({ ...confirmation, reviewKey: body.reviewKey, artifactSha256: "b".repeat(64) }), "SCENE_INTEGRITY", 502, "prepare_again");
  assert.equal(f.state.preparations, 1);
  await errorCode(await f.send({ ...confirmation, reviewKey: body.reviewKey, artifactSha256: undefined }), "INVALID_INPUT", 400);
});
test("independent BFF replicas load shared scene receipt and preserve exact bytes without rebuilding", async () => {
  const a = setup(true), b = setup(true, a.shared);
  const body = await (await a.send({ ...correction, prepare: true })).json() as { reviewKey: string };
  const result = await b.send({ ...confirmation, reviewKey: body.reviewKey });
  assert.equal(result.status, 200);
  assert.deepEqual(Buffer.from(await result.arrayBuffer()), fbx);
  assert.equal(b.state.preparations, 0);
  b.state.installationId = "other";
  await errorCode(await b.send({ ...confirmation, reviewKey: body.reviewKey }), "SCENE_REVIEW_REQUIRED", 409);
  assert.equal(b.state.preparations, 0);
});
test("replica loss, expired, changed source and corrupted receipts have distinct safe recovery", async () => {
  const a = setup(true);
  const body = await (await a.send({ ...correction, prepare: true })).json() as { reviewKey: string };
  await errorCode(await setup(true).send({ ...confirmation, reviewKey: body.reviewKey }), "SCENE_REVIEW_REQUIRED", 409, "prepare_again");
  const b = setup(true, a.shared);
  b.job.updatedAt = "v2";
  await errorCode(await b.send({ ...confirmation, reviewKey: body.reviewKey }), "SCENE_SOURCE_CHANGED", 409, "review_selection");
  b.job.updatedAt = "v1";
  const storageKey = `owner/job/${body.reviewKey}`;
  const receipt = decodeSceneReceipt(a.shared.get(storageKey)!);
  receipt.expires = Date.now() - 1;
  a.shared.set(storageKey, encodeSceneReceipt(receipt));
  await errorCode(await b.send({ ...confirmation, reviewKey: body.reviewKey }), "SCENE_REVIEW_EXPIRED", 409, "prepare_again");
  const corrupt = JSON.parse(encodeSceneReceipt(receipt).toString());
  corrupt.scene.sha256 = "a".repeat(64);
  a.shared.set(storageKey, Buffer.from(JSON.stringify(corrupt)));
  await errorCode(await b.send({ ...confirmation, reviewKey: body.reviewKey }), "SCENE_INTEGRITY", 502, "prepare_again");
  assert.equal(b.state.preparations, 0);
});
test("publication failure and job changes never release a successful review", async () => {
  const a = setup(true);
  a.state.storageFails = true;
  await errorCode(await a.send({ ...correction, prepare: true }), "SCENE_UNAVAILABLE", 503);
  assert.equal(a.shared.size, 0);
  const b = setup(true);
  b.state.changeJob = true;
  await errorCode(await b.send({ ...correction, prepare: true }), "SCENE_SOURCE_CHANGED", 409);
  assert.equal(b.shared.size, 0);
});
test("correction failures never switch save modes and explicit original recovery still works", async () => {
  for (const [code, status, recovery] of [
    ["SCENE_BUSY", 503, "retry_later"], ["SCENE_TIMEOUT", 504, "prepare_again"],
    ["SCENE_UNSUPPORTED_BODY", 409, "change_selection"], ["SCENE_INTEGRITY", 502, "prepare_again"],
  ] as const) {
    const f = setup(true);
    f.state.failPrepare = new SceneError(code, "fixture");
    const response = await f.send({ ...correction, prepare: true });
    assert.equal(response.status, status);
    const body = await response.json() as { error: { code: string; details: { recovery: string; serverOperationMayContinue: boolean } } };
    assert.equal(body.error.code, code); assert.equal(body.error.details.recovery, recovery);
    assert.equal(body.error.details.serverOperationMayContinue, code === "SCENE_TIMEOUT");
    assert.equal(f.shared.size, 0);
    assert.deepEqual(f.state.sent, []);
    const basic = await f.send({ contractVersion: "scene-save-v1", saveMode: "original-selection" });
    assert.equal(basic.status, 200);
    assert.equal(basic.headers.get("X-Standin-Scene-Version"), "rough-layout-v1");
  }
});
test("capability negotiation exposes only eligible modes and never promises server cancellation", () => {
  assert.deepEqual(sceneSaveContract(true, true).saveModes, ["original-selection", "auto-correct-v4"]);
  assert.deepEqual(sceneSaveContract(true, false).saveModes, ["original-selection"]);
  assert.deepEqual(sceneSaveContract(false, true).saveModes, []);
  assert.deepEqual(sceneSaveContract(true, true).cancellation, { httpRequest: true, serverOperation: false });
});

test("warm cache is owner-scoped and never releases another installation's review", async () => {
  const f = setup(true);
  const body = await (await f.send({ ...correction, prepare: true })).json() as { reviewKey: string };
  f.state.installationId = "other";
  await errorCode(await f.send({ ...confirmation, reviewKey: body.reviewKey }), "SCENE_REVIEW_REQUIRED", 409);
  assert.equal(f.state.preparations, 1);
});
test("production requires shared scene storage; development may explicitly reprepare after replica loss", async () => {
  const originalEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "production";
    assert.equal(sceneReceiptStorageAvailable(), !!config.betaDataBucket);
    if (!config.betaDataBucket) {
      const receipt: SceneReceipt = { reviewVersion: SCENE_REVIEW_VERSION, binding: "a".repeat(64), expires: Date.now()+900_000,
        scene: { bytes: fbx, sha256: sha256Hex(fbx), preview: "", previewSha256: sha256Hex(Buffer.alloc(0)), summary: [], artifactContract: "verified-scene-fbx-v1" } };
      await assert.rejects(saveSceneReceipt("owner", "job", "a".repeat(48), receipt), { code: "CONVERTER_UNAVAILABLE" });
    }
    process.env.NODE_ENV = "development";
    assert.equal(sceneReceiptStorageAvailable(), true);
  } finally {
    if (originalEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnv;
  }
});

test("worker network loss cannot imply the server stopped computing", async () => {
  const f = setup(true);
  f.state.failPrepare = new SceneError("SCENE_UNAVAILABLE", "fixture network lost after dispatch", true);
  const r = await f.send({ ...correction, prepare: true });
  assert.equal(r.status, 503);
  const body = await r.json() as { error: { details: { serverOperationMayContinue: boolean } } };
  assert.equal(body.error.details.serverOperationMayContinue, true);
});

test("scene preview rechecks job and source revisions after a slow render", async () => {
  for (const change of ["job", "hands"] as const) for (const previewFails of [false, true]) {
    const f = setup(true);
    f.state.previewFails = previewFails;
    const review = await (await f.send({ ...correction, prepare: true })).json() as { reviewKey: string };
    f.state.onRender = () => {
      if (change === "job") f.job.updatedAt = "v2";
      else f.state.changeHands = true;
    };
    const response = await f.send({ ...confirmation, reviewKey: review.reviewKey, preview: true });
    assert.equal(response.status, 409, `stale ${change} preview must not be published`);
    assert.notEqual(response.headers.get("Content-Type"), "image/png");
    assert.equal(f.state.preparations, 1, "rechecking never rebuilds the reviewed file");
  }
});

const manifestMode = { contractVersion: "scene-save-v1", saveMode: "original-selection", manifestVersion: "csp-scene-manifest-v1" };
type ManifestReview = { reviewKey: string; artifactSha256: string; reviewVersion: string;
  manifest: import("./sceneManifest.js").SceneManifest };
function releaseFields(review: ManifestReview) {
  return { ...manifestMode, reviewKey: review.reviewKey, reviewVersion: review.reviewVersion,
    artifactSha256: review.artifactSha256 };
}
test("unselected generated alternative preserves scene capability and export; selected generation remains blocked", async () => {
  const f = setup();
  f.job.result!.candidatesByPerson[0]!.candidates.push({ id: "generated", poseId: "other", source: "generation" } as never);
  assert.equal((await f.send()).status, 200);
  f.rows[0]!.candidateId = "generated";
  await errorCode(await f.send(), "GENERATED_INDIVIDUAL_ONLY", 409, "change_selection");
  assert.equal(f.state.composed, 1);
});
test("original manifest prepare works with v4 off; metadata and replica release share exact source, SHA, and expiry", async () => {
  const a = setup(false), b = setup(false, a.shared);
  for (const f of [a, b]) Object.assign(f.job, { inputOriginalName: "T001.png", inputSha256: "a".repeat(64), inputWidth: 765, inputHeight: 714 });
  const response = await a.send({ ...manifestMode, prepare: true });
  assert.equal(response.status, 200, await response.clone().text());
  const review = await response.json() as ManifestReview;
  assert.equal(review.manifest.sourceImage.originalName, "T001.png");
  assert.equal(review.manifest.sourceImage.sha256, "a".repeat(64));
  assert.equal(review.manifest.sourceImage.identity, "job:input");
  assert.equal(review.manifest.sourceImage.captureMapping.status, "unavailable");
  assert.equal(review.manifest.camera.recipe, null);
  assert.equal(review.manifest.camera.cspValidation, "unverified");
  assert.deepEqual(review.manifest.people.includedIds, [0, 1]);
  assert.equal(review.manifest.people.partial, false);
  const metadata = await b.send({ ...releaseFields(review), metadataOnly: true });
  assert.equal(metadata.status, 200);
  assert.deepEqual((await metadata.json() as { manifest: unknown }).manifest, review.manifest);
  const download = await b.send(releaseFields(review));
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("X-Standin-Artifact-SHA256"), review.manifest.artifact.sha256);
  assert.equal(download.headers.get("X-Standin-Scene-Snapshot-SHA256"), review.manifest.snapshotSha256);
  assert.equal(download.headers.get("X-Standin-File-Count"), "1");
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), fbx);
  assert.equal(b.state.composed, 0, "release/metadata do not rebuild");
});
for (const reason of ["no_candidates", "user_excluded", "not_requested"] as const)
  test(`partial ${reason} is explicit and only releases with the prepared snapshot`, async () => {
    const f = setup();
    if (reason === "no_candidates") f.job.result!.candidatesByPerson[1]!.candidates = [];
    const selection = { persons: [f.rows[0]], ...(reason === "user_excluded" ? { excludedPersonIds: [1] } : {}) };
    await errorCode(await f.send(selection), "SCENE_PARTIAL_CONFIRMATION_REQUIRED", 409);
    const response = await f.send({ ...manifestMode, ...selection, prepare: true });
    assert.equal(response.status, 200, await response.clone().text());
    const review = await response.json() as ManifestReview;
    assert.deepEqual(review.manifest.people.detectedIds, [0, 1]);
    assert.deepEqual(review.manifest.people.requestedIds, [0]);
    assert.deepEqual(review.manifest.people.includedIds, [0]);
    assert.deepEqual(review.manifest.people.missing, [{ personIndex: 1, reason }]);
    const release = { ...releaseFields(review), ...selection };
    await errorCode(await f.send(release), "SCENE_PARTIAL_CONFIRMATION_REQUIRED", 409, "confirm_partial");
    await errorCode(await f.send({ ...release, partialConfirmation: { snapshotSha256: "0".repeat(64) } }), "SCENE_PARTIAL_CONFIRMATION_REQUIRED", 409);
    const saved = await f.send({ ...release, partialConfirmation: { snapshotSha256: review.manifest.snapshotSha256 } });
    assert.equal(saved.status, 200);
    assert.equal(saved.headers.get("X-Standin-Person-Count"), "1");
    assert.equal(f.state.composed, 1);
  });
for (const change of ["job", "hands", "selection", "exclusion", "owner", "expiry", "sha", "metadata"] as const)
  test(`original manifest and partial confirmation reject changed ${change}`, async () => {
    const f = setup();
    const selection = { persons: [f.rows[0]], excludedPersonIds: [1] };
    const review = await (await f.send({ ...manifestMode, ...selection, prepare: true })).json() as ManifestReview;
    const request = { ...releaseFields(review), ...selection, partialConfirmation: { snapshotSha256: review.manifest.snapshotSha256 } };
    if (change === "job") f.job.updatedAt = "new";
    if (change === "hands") f.state.changeHands = true;
    if (change === "selection") f.state.confirmed = false;
    if (change === "exclusion") request.excludedPersonIds = [];
    if (change === "owner") f.state.installationId = "other";
    if (change === "sha") request.artifactSha256 = "b".repeat(64);
    // New replica forces shared decode and checks metadata integrity too.
    const b = setup(false, f.shared);
    b.job.result!.candidatesByPerson = f.job.result!.candidatesByPerson;
    const key = `owner/job/${review.reviewKey}`;
    if (change === "expiry" || change === "metadata") {
      const receipt = decodeSceneReceipt(f.shared.get(key)!);
      if (change === "expiry") receipt.expires = Date.now() - 1;
      else receipt.manifest!.people.includedIds = [0, 1];
      f.shared.set(key, encodeSceneReceipt(receipt));
    }
    const result = await (change === "expiry" || change === "metadata" ? b : f).send(request);
    assert.equal(result.status, change === "sha" || change === "metadata" ? 502 : 409, await result.clone().text());
    assert.notEqual(result.headers.get("Content-Type"), "application/octet-stream");
  });
test("v4 partial prepare cannot bypass confirmation and rejected selections are not counted as saved", async () => {
  const f = setup(true);
  f.job.result!.candidatesByPerson[1]!.candidates = [];
  const persons = [f.rows[0]];
  const review = await (await f.send({ ...correction, persons, prepare: true })).json() as ManifestReview;
  await errorCode(await f.send({ ...confirmation, persons, reviewKey: review.reviewKey }), "SCENE_PARTIAL_CONFIRMATION_REQUIRED", 409);
  const release = { ...confirmation, persons, reviewKey: review.reviewKey, partialConfirmation: { snapshotSha256: review.manifest.snapshotSha256 } };
  assert.equal((await f.send(release)).status, 200);
  f.state.reviewStatus = 409;
  assert.equal((await f.send(release)).status, 409);
});
test("manifest contract rejects unknown versions and invalid exclusions", async () => {
  for (const extra of [{ manifestVersion: "future" }, { excludedPersonIds: [0] }, { excludedPersonIds: [7] },
    { excludedPersonIds: [1, 1] }, { metadataOnly: true }, { partialConfirmation: true }]) {
    const f = setup();
    const response = await f.send({ ...manifestMode, prepare: true, ...extra });
    assert.ok(response.status >= 400, JSON.stringify(extra));
    assert.equal(f.state.composed, 0);
  }
});
