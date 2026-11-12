// Real BFF route/serialization contract; all repositories, input and Converter bytes are synthetic.
import { writeFile } from "node:fs/promises";
import { createSceneIntegrationFixture } from "../dist/pose/sceneIntegration.fixture.js";
import { sceneAvailability } from "../dist/pose/sceneAvailability.js";
import { sha256Hex } from "../dist/converter/client.js";
if (!process.argv[2]) throw new Error("An explicit fixture output path is required");
const headers = response => Object.fromEntries(response.headers);
async function example(kind) {
  const f = createSceneIntegrationFixture();
  Object.assign(f.job, { inputOriginalName: "T001.png", inputSha256: sha256Hex(Buffer.from("synthetic original image")), inputWidth: 1000, inputHeight: 768 });
  const all = await f.references();
  if (kind === "no_candidates") f.job.result.candidatesByPerson[1].candidates = [];
  const persons = kind === "full" ? all : all.slice(0, 1);
  const common = { contractVersion: "scene-save-v1", saveMode: "original-selection", manifestVersion: "csp-scene-manifest-v1", persons,
    ...(kind === "user_excluded" ? { excludedPersonIds: [1] } : {}) };
  const prepareRequest = { ...common, prepare: true };
  const prepared = await f.send(prepareRequest);
  if (!prepared.ok) throw new Error(await prepared.text());
  const prepareResponse = await prepared.json();
  const releaseRequest = { ...common, reviewVersion: prepareResponse.reviewVersion, reviewKey: prepareResponse.reviewKey, artifactSha256: prepareResponse.artifactSha256,
    ...(kind !== "full" ? { partialConfirmation: { snapshotSha256: prepareResponse.manifest.snapshotSha256 } } : {}) };
  const withoutConfirmation = kind === "full" ? null : await f.send({ ...releaseRequest, partialConfirmation: undefined });
  const saved = await f.send(releaseRequest, f.makeReplica());
  if (!saved.ok) throw new Error(await saved.text());
  const bytes = new Uint8Array(await saved.arrayBuffer());
  if (sha256Hex(bytes) !== prepareResponse.artifactSha256) throw new Error("fixture artifact mismatch");
  return { prepareRequest, prepareResponse,
    unconfirmedResponse: withoutConfirmation ? { status: withoutConfirmation.status, json: await withoutConfirmation.json() } : null,
    metadataRequest: { ...releaseRequest, metadataOnly: true }, releaseRequest,
    releaseResponse: { status: saved.status, headers: headers(saved), bodyBase64: Buffer.from(bytes).toString("base64") },
    capabilities: sceneAvailability(f.job, { scene: () => true, fbx: () => true, converter: () => true, storage: () => true, refinement: () => false, worker: () => false }) };
}
const examples = {};
for (const kind of ["full", "no_candidates", "user_excluded", "not_requested"]) examples[kind] = await example(kind);
const fixture = { status: "implemented-local-fixture", version: "csp-scene-manifest-v1", generatedAt: new Date().toISOString(),
  baseCommit: "264da73294695da800345dc1e814d11fced7b20b", endpoint: "POST /v1/analysis/jobs/{jobId}/scene",
  provenance: { actualHandlers: ["createFramingRoutes", "createSceneRoutes", "composeRoughScene", "encodeSceneReceipt", "decodeSceneReceipt"],
    synthetic: ["owned repositories", "Converter", "input image", "FBX bytes"], realS3: false, nativeSave: false, cspImport: false },
  prepareRequest: examples.full.prepareRequest, prepareResponse: examples.full.prepareResponse,
  releaseRequest: examples.full.releaseRequest, releaseResponse: examples.full.releaseResponse, examples,
  constraints: { cameraRecipe: "unavailable until Converter supplies artifact-bound scene-camera-v1", automaticCspCamera: "unsupported", cspValidation: "unverified",
    legacyFullBinary: "preserved", legacyPartial: "409 SCENE_PARTIAL_CONFIRMATION_REQUIRED", selectionValidation: "always required before and after composition/download/metadata", ttlSeconds: 900,
    originalName: "sourceImage on GET result; null on older jobs, use jobId fallback", captureMapping: "unavailable/not_recorded" },
  failureExamples: { analysis: { code: "ANALYSIS_TIMEOUT", phase: "analysis", recovery: "explicit_retry", serverOperationMayContinue: true },
    scene: { code: "SCENE_TIMEOUT", details: { phase: "scene_prepare", recovery: "prepare_again", allowedActions: ["prepare_again"], serverOperationMayContinue: true } } } };
await writeFile(process.argv[2], JSON.stringify(fixture, null, 2) + "\n");
console.log(JSON.stringify({ output: process.argv[2], status: fixture.status, examples: Object.keys(examples) }));
