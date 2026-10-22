/** Local contract harness: real BFF handlers/orchestration, synthetic repositories,
 * worker/Converter and binary payloads. Never an installed-app or real-worker E2E. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import type { Job } from "../jobs/store.js";
import type { AnalysisPerson, AnalysisResult, CandidateCamera } from "../types.js";
import type { BodySelection } from "../body-selection/model.js";
import type { HandBake } from "../hands/model.js";
import type { FramedInput } from "../converter/framing.js";
import { config } from "../config.js";
import { appCors } from "../cors.js";
import { sha256Hex } from "../converter/client.js";
import { composeRoughScene } from "../converter/scene.js";
import { renderFinalPreview } from "../converter/finalPreview.js";
import { createFramingRoutes } from "../output-scope/framingRoutes.js";
import { resolveOutputScope } from "../output-scope/model.js";
import { sceneRefinementRequest } from "../inference.js";
import { createSceneRoutes } from "./sceneRoutes.js";
import { prepareRefinedScene, type SceneRef } from "./sceneRefinement.js";
import { encodeSceneReceipt, decodeSceneReceipt } from "./sceneStorage.js";

export const fixtureFbx = (label: string) => Buffer.from(`Kaydara FBX Binary  \0\x1a\0${label}`);
// A valid 1px PNG; the FBX header+payload is synthetic and unsuitable for native import.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=", "base64");
const character = "a".repeat(64), runtime = "b".repeat(64), model = "c".repeat(64);
const owner = "fixture-owner";
export function createSceneIntegrationFixture() {
  // Framed receipts use the existing per-person cache. Refuse any external S3 IO.
  if (config.betaDataBucket || process.env.NODE_ENV === "production")
    throw new Error("Scene fixture requires no BETA_DATA_BUCKET and non-production NODE_ENV");
  const jobId = `scene-fixture-${randomUUID()}`;
  const state = {
    confirmed: true, owned: true, bodyRevision: [1, 1], handRevision: [1, 1],
    character, runtime, sourceChanged: false, renderFails: false, beforeRender: undefined as (() => void) | undefined,
    planCalls: 0, buildCalls: 0, composeCalls: 0, renderCalls: 0, conversions: 0, receiptLoads: 0,
  };
  const baseBvh = (id: string) => Buffer.from(`${state.sourceChanged ? "changed" : "registered"} BVH ${id}`);
  const people = [0, 1].map((i) => ({
    personIndex: i, box: [i * 400, 10, i * 400 + 300, 700],
    skeleton: { keypoints: Array.from({ length: 17 }, () => [50, 50]), scores: Array(17).fill(.9) },
    outputScope: resolveOutputScope({ selection: "half" }),
    candidates: [{ id: `pick${i}`, poseId: `pose${i}`, rank: 1,
      sourceBvhSha256: sha256Hex(baseBvh(`pose${i}`)),
      camera: { version: "candidate-camera-v2", reference: "search-fit", canonical_yaw: 0,
        display_view: "front", status: "fitted", fit_error: .1, facing_source: "geometry_only",
        depth_ambiguous: true, projection: "perspective", distance_torso: 4, labels_swapped: false,
        pose_id: `pose${i}`, query_sha256: "e".repeat(64), observed_joint_mask: Array(17).fill(true),
        source_bvh_sha256: sha256Hex(baseBvh(`pose${i}`)), rotation: [[1,0,0],[0,1,0],[0,0,1]],
      } as CandidateCamera }],
  } as AnalysisPerson));
  const job = { id: jobId, inputS3Key: "fixture-original", status: "completed", updatedAt: "fixture-v1",
    result: { jobId, source: "image", image: { width: 1000, height: 768 }, candidatesByPerson: people } as AnalysisResult,
  } as Job;
  const load = async (id: string, installation: string) =>
    state.owned && id === jobId && installation === owner ? structuredClone(job) : undefined;
  const confirmed = async () => state.confirmed;
  const body = async (_owner: string, _job: string, index: number): Promise<BodySelection> => ({
    schemaVersion: "body-selection.v1", personIndex: index, intent: "manual", manualCharacterId: "chosen",
    recommendation: { status: "unavailable", body: null, reasonCodes: [] },
    resolvedBody: { bodyId: "body", bodyVersion: "1", characterId: "chosen", assetSha256: state.character,
      measurementVersion: "1", rigVersion: "1" }, resolvedSource: "manual", resolutionStatus: "ready",
    selectionRevision: state.bodyRevision[index]!, renderingExecuted: false, shape: null, shapeSource: null,
  });
  const hands = async (person: { personIndex?: number; handSelection?: unknown; outputScope?: unknown; posePresentation?: unknown } | undefined): Promise<HandBake> => ({
    left: "fist", right: "relaxed", library_version: "fixture-v1", library_sha256: "d".repeat(64),
    revision: state.handRevision[person?.personIndex ?? 0]!,
  });
  const getPoseBvh = async (id: string) => new Response(baseBvh(id));
  const resolveArtifact = async () => ({ variant: "base" as const, fallbackReason: null });
  const convert = async (input: FramedInput) => {
    state.conversions++;
    assert.equal(input.characterId, "chosen");
    assert.equal(input.expectedCharacterSha256, state.character);
    assert.ok(input.hands, "selected hands reach both scoped and full source conversions");
    const fbx = fixtureFbx(`${Buffer.from(input.bvhBytes)}:${input.scope}:${input.hands.left}:${input.hands.right}`);
    return { ...(input.previewFormat === "none" ? { artifactContract: "verified-fbx-v1" as const } : {}),
      fbx, preview: input.previewFormat === "none" ? Buffer.alloc(0) : png,
      conversionId: "fixture-conversion", sourceBvhSha256: sha256Hex(input.bvhBytes), artifactSha256: sha256Hex(fbx),
      characterSha256: state.character, previewRevision: state.runtime,
    };
  };
  let planPeople: Record<string, unknown>[] = [];
  let imageSha = "";
  const finalFbx = fixtureFbx("corrected integrated scene: two persons");
  const originalFbx = fixtureFbx("original-selection integrated scene: two persons");
  const workerFetch: typeof fetch = async (url, init) => {
    const input = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer fixture-only-not-a-credential");
    if (String(url).endsWith("/plan")) {
      state.planCalls++;
      const persons = input.persons as Record<string, unknown>[];
      assert.equal(persons.length, 2);
      for (const p of persons) assert.equal(sha256Hex(Buffer.from(String(p.fbx_base64), "base64")), p.fbx_sha256);
      imageSha = String(input.image_sha256);
      planPeople = persons.map(p => ({ person_index: p.person_index,
        pose_id: p.person_index === 0 ? p.pose_id : "registered_replacement",
        baseline_pose_id: p.pose_id, output_scope: "full", arm_goals: [], interaction: "preserve",
        direction: { torso_camera_yaw: 45, torso_label: "front_right", head_label: "front",
          head_camera_yaw: 0, head_relative_yaw: -45, head_pitch_degrees: null },
      }));
      return Response.json({ version: "scene-refinement-v4", plan_id: "f".repeat(48),
        image_sha256: imageSha, character_sha256: character, people: planPeople });
    }
    state.buildCalls++;
    assert.equal(input.plan_id, "f".repeat(48));
    for (const p of input.persons as Record<string, unknown>[]) {
      assert.equal(p.character_sha256, character);
      assert.equal(sha256Hex(Buffer.from(String(p.fbx_base64), "base64")), p.fbx_sha256);
    }
    const artifactOnly = input.artifact_only === true;
    const preview = artifactOnly ? Buffer.alloc(0) : png;
    return Response.json({ version: "scene-refinement-v4", plan_id: input.plan_id, image_sha256: imageSha,
      person_count: 2, people: planPeople, ...(artifactOnly ? { artifact_contract: "verified-scene-fbx-v1" } : {}),
      fbx_base64: finalFbx.toString("base64"), artifact_sha256: sha256Hex(finalFbx),
      preview_base64: preview.toString("base64"), preview_sha256: sha256Hex(preview) });
  };
  const shared = new Map<string, Uint8Array>();
  const makeReplica = () => {
    const app = new Hono<AppEnv>();
    app.use("*", appCors(["tauri://localhost", "http://tauri.localhost"]));
    app.use("*", async (c, next) => {
      c.set("installationId", c.req.header("X-Installation-Id") ?? "");
      c.set("requestId", "fixture-request");
      await next();
    });
    app.route("/v1/pose-candidates", createFramingRoutes({ getOwnedJob: load,
      validateExportCandidate: confirmed, validateConfirmedSelection: confirmed, resolveExportArtifact: resolveArtifact,
      getPoseBvh, converterEnabled: () => true, checkCharacter: async () => "ok", recordExport: async () => {},
      modelPreviewIdentity: async () => ({ characterSha256: state.character, modelRevision: model }),
      convertFramed: convert, handBakeFor: hands,
    }, { selection: body, enabled: () => true, runtime: async () => ({
      schemaVersion: "body-preview-runtime.v1", previewRevision: state.runtime, modelVersion: "posed-mesh-v1",
      modelRevision: model, solverVersion: "fixture-solver", framingVersion: "fixture-framing",
    }) }));
    app.route("/v1/analysis/jobs", createSceneRoutes(request => app.fetch(request), {
      enabled: () => true, refinementEnabled: () => true, getOwnedJob: load, validateConfirmedSelection: confirmed,
      saveSceneReceipt: async (installation, id, key, receipt) => { shared.set(`${installation}/${id}/${key}`, encodeSceneReceipt(receipt)); },
      loadSceneReceipt: async (installation, id, key) => {
        state.receiptLoads++;
        const stored = shared.get(`${installation}/${id}/${key}`);
        return stored ? decodeSceneReceipt(stored) : undefined;
      },
      prepareRefinedScene: (installation, sourceJob, refs, sources, _overrides, artifactOnly) =>
        prepareRefinedScene(installation, sourceJob, refs, sources, {
          loadInput: async () => new Blob(["synthetic original image"]), selection: body, handBakeFor: hands,
          getPoseBvh, resolveExportArtifact: resolveArtifact, convertFramed: convert,
          request: (stage, input) => sceneRefinementRequest(stage, input, {
            baseUrl: "https://worker.fixture", token: "fixture-only-not-a-credential", fetch: workerFetch,
          }),
        }, artifactOnly),
      composeRoughScene: (id, image, sources) => composeRoughScene(id, image, sources, {
        baseUrl: "https://converter.fixture", fetch: async (_url, init) => {
          state.composeCalls++;
          const form = init?.body as FormData, manifest = String(form.get("manifest"));
          const parsed = JSON.parse(manifest) as { persons: Record<string, unknown>[] };
          const files = form.getAll("fbx") as File[];
          for (let i = 0; i < files.length; i++) assert.equal(sha256Hex(new Uint8Array(await files[i]!.arrayBuffer())), parsed.persons[i]!.fbx_sha256);
          return new Response(originalFbx, { headers: { "X-Standin-Artifact-SHA256": sha256Hex(originalFbx),
            "X-Standin-FBX-Artifact-SHA256": sha256Hex(originalFbx), "X-Standin-Scene-Input-SHA256": sha256Hex(Buffer.from(manifest)),
            "X-Standin-Person-Count": "2", "X-Standin-Scene-Version": "rough-layout-v1" } });
        },
      }),
      renderFinalPreview: (artifact, aligned, _overrides, sceneCamera, signal) => renderFinalPreview(artifact, aligned, {
        baseUrl: "https://converter.fixture", fetch: async (_url, init) => {
          state.renderCalls++;
          const form = init?.body as FormData;
          assert.equal(form.get("artifact_sha256"), sha256Hex(finalFbx));
          assert.equal(form.get("scene_camera"), "true");
          assert.deepEqual(Buffer.from(await (form.get("fbx") as File).arrayBuffer()), finalFbx);
          state.beforeRender?.();
          if (state.renderFails) return new Response("fixture render unavailable", { status: 503 });
          return new Response(png, { headers: { "X-Standin-Artifact-SHA256": sha256Hex(finalFbx),
            "X-Standin-Preview-Artifact-SHA256": sha256Hex(png) } });
        },
      }, sceneCamera, signal),
    }));
    return app;
  };
  const app = makeReplica();
  const headers = { "X-Installation-Id": owner, "Content-Type": "application/json", Origin: "tauri://localhost" };
  const send = (body: unknown, replica = app) => replica.request(`/v1/analysis/jobs/${jobId}/scene`, {
    method: "POST", headers, body: JSON.stringify(body),
  });
  const individuals: { personIndex: number; reference: SceneRef; readyPath: string;
    readyResponse: { status: number; headers: Record<string, string>; bodyBase64: string };
    response: { status: number; headers: Record<string, string>; bodyBase64: string } }[] = [];
  const references = async (): Promise<SceneRef[]> => {
    const refs: SceneRef[] = [];
    for (const person of people) {
      const i = person.personIndex;
      const path = `/v1/pose-candidates/pose${i}/framed?` + new URLSearchParams({ jobId, personIndex: String(i),
        candidateId: `pick${i}`, outputScope: "half", format: "ready", characterId: "chosen",
        bodySelectionRevision: "1", handSelectionRevision: "1" });
      const ready = await app.request(path, { headers });
      assert.equal(ready.status, 200, await ready.clone().text());
      const key = ready.headers.get("X-Standin-Review-Key")!;
      assert.match(key, /^[a-f0-9]{64}$/);
      const url = new URL(path, "https://bff.fixture");
      url.searchParams.set("format", "fbx"); url.searchParams.set("reviewKey", key); url.searchParams.set("artifactReceipt", key);
      const exportPath = url.pathname + url.search;
      const download = await app.request(exportPath, { headers });
      assert.equal(download.status, 200, await download.clone().text());
      const bytes = Buffer.from(await download.arrayBuffer());
      const sha256 = sha256Hex(bytes);
      assert.equal(sha256, ready.headers.get("X-Standin-Artifact-SHA256"));
      const reference = { personIndex: i, candidateId: `pick${i}`, exportPath, sha256 };
      refs.push(reference);
      individuals.push({ personIndex: i, reference, readyPath: path,
        readyResponse: { status: ready.status, headers: Object.fromEntries(ready.headers), bodyBase64: Buffer.from(await ready.arrayBuffer()).toString("base64") },
        response: { status: download.status, headers: Object.fromEntries(download.headers), bodyBase64: bytes.toString("base64") } });
    }
    return refs;
  };
  return { app, makeReplica, state, job, shared, references, send, originalFbx, finalFbx, individuals };
}

export async function captureSceneWireFixture() {
  const f = createSceneIntegrationFixture();
  const persons = await f.references();
  const originalRequest = { persons, contractVersion: "scene-save-v1", saveMode: "original-selection" };
  const prepareRequest = { persons, contractVersion: "scene-save-v1", saveMode: "auto-correct-v4", prepare: true, artifactOnly: true };
  const original = await f.send(originalRequest);
  assert.equal(original.status, 200, await original.clone().text());
  const legacyOriginal = await f.send({ persons });
  assert.equal(legacyOriginal.status, 200);
  assert.deepEqual(Buffer.from(await legacyOriginal.clone().arrayBuffer()), f.originalFbx);
  assert.equal(f.state.planCalls, 0, "legacy original request never enters correction even with its flag ON");
  const prepared = await f.send(prepareRequest);
  assert.equal(prepared.status, 200, await prepared.clone().text());
  const review = await prepared.clone().json() as {
    reviewKey: string; artifactSha256: string; reviewVersion: string; expiresAt: string;
    summary: { personIndex: number; poseChanged: boolean; outputScopeChanged: boolean }[];
    fileCount: number; personCount: number;
  };
  assert.equal(review.personCount, 2); assert.equal(review.fileCount, 1);
  assert.equal(review.summary.length, 2);
  assert.equal(review.summary[0]!.poseChanged, false);
  assert.equal(review.summary[1]!.poseChanged, true);
  assert.ok(review.summary.every(p => p.outputScopeChanged));
  const confirmRequest = { persons, contractVersion: "scene-save-v1", saveMode: "auto-correct-v4",
    reviewVersion: review.reviewVersion, reviewKey: review.reviewKey, artifactSha256: review.artifactSha256 };
  const previewRequest = { ...confirmRequest, preview: true };
  const preview = await f.send(previewRequest);
  assert.equal(preview.status, 200, await preview.clone().text());
  const confirmed = await f.send(confirmRequest, f.makeReplica());
  assert.equal(confirmed.status, 200, await confirmed.clone().text());
  assert.equal(review.artifactSha256, confirmed.headers.get("X-Standin-Artifact-SHA256"));
  assert.deepEqual(Buffer.from(await confirmed.clone().arrayBuffer()), f.finalFbx);
  assert.equal(preview.headers.get("X-Standin-Artifact-SHA256"), review.artifactSha256);
  assert.deepEqual(Buffer.from(await original.clone().arrayBuffer()), f.originalFbx);
  assert.equal(f.state.planCalls, 1); assert.equal(f.state.buildCalls, 1);
  assert.equal(f.state.receiptLoads, 1, "a second BFF instance reads the serialized shared receipt");
  f.state.beforeRender = () => { f.state.bodyRevision[0]++; };
  const invalidatedBodyPreview = await f.send(previewRequest);
  assert.equal(invalidatedBodyPreview.status, 409);
  assert.equal((await invalidatedBodyPreview.clone().json() as { error: { code: string } }).error.code, "BODY_PREVIEW_STALE");
  f.state.beforeRender = undefined;
  f.state.bodyRevision[0] = 1;
  f.state.runtime = "e".repeat(64);
  const invalidatedRuntimePreview = await f.send(previewRequest);
  assert.equal(invalidatedRuntimePreview.status, 503);
  assert.equal((await invalidatedRuntimePreview.clone().json() as { error: { code: string } }).error.code, "PREVIEW_NOT_READY");
  const snapshot = async (response: Response) => ({ status: response.status,
    headers: Object.fromEntries(response.headers), bodyBase64: Buffer.from(await response.arrayBuffer()).toString("base64") });
  return {
    version: "bff-scene-wire-fixture-v1", generatedAt: new Date().toISOString(),
    provenance: { kind: "local-fixture", bffBaseCommit: "8cc692d638de1d08844260b9530f60e087bf8ad6",
      actualHandlers: ["createFramingRoutes", "createSceneRoutes", "prepareRefinedScene", "sceneRefinementRequest", "composeRoughScene", "renderFinalPreview"],
      synthetic: ["owned repositories", "worker responses", "Converter responses", "FBX bytes", "original image"],
      receiptStore: "serialized scene receipts shared by independent Hono route instances; not live S3",
      installationAuthentication: "fixture identity header; not real installation credential validation",
      realWorker: false, installedApp: false, nativeSave: false,
    },
    jobId: f.job.id, persons, individuals: f.individuals,
    requests: { original: originalRequest, prepare: prepareRequest, preview: previewRequest, confirm: confirmRequest },
    responses: { original: await snapshot(original), legacyOriginal: await snapshot(legacyOriginal), prepare: { ...await snapshot(prepared), json: review },
      preview: await snapshot(preview), confirm: await snapshot(confirmed),
      invalidatedBodyPreview: await snapshot(invalidatedBodyPreview), invalidatedRuntimePreview: await snapshot(invalidatedRuntimePreview) },
    observed: { workerPlans: f.state.planCalls, workerBuilds: f.state.buildCalls, composeCalls: f.state.composeCalls,
      previewRenders: f.state.renderCalls, conversions: f.state.conversions, sceneReceiptLoads: f.state.receiptLoads },
  };
}
