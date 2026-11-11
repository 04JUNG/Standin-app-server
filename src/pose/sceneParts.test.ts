/** Protocol/handler fixtures, not real Blender, S3 or staging-app verification. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import type { Job } from "../jobs/store.js";
import { sha256Hex } from "../converter/client.js";
import { scenePartsRequest } from "../inference.js";
import { renderFinalPreview } from "../converter/finalPreview.js";
import { createSceneRoutes } from "./sceneRoutes.js";
import { prepareRefinedScene } from "./sceneRefinement.js";
import { encodeSceneReceipt, decodeSceneReceipt } from "./sceneStorage.js";
import { partsCapabilityFixture, partsSelectionFixture } from "./sceneParts.fixture.js";
import { parsePartsSelection, validatePartsCapability, partsCanonicalJson, partsDigest, type PartsRequest } from "./sceneParts.js";
import { storedSceneDescription } from "./scenePartsDescriptions.js";
import { sceneAvailability } from "./sceneAvailability.js";
import { sceneReviewBinding, sceneSourceIdentity } from "./sceneBinding.js";
import { resolveOutputScope } from "../output-scope/model.js";

const fbx = (label: string) => Buffer.from(`Kaydara FBX Binary  \0\x1a\0${label}`);
const original = fbx("CURRENT selected FBX, never historical baseline"), changed = fbx("native applied");
const png = Buffer.from([137,80,78,71,13,10,26,10]);
const mode = { contractVersion: "scene-save-v1", saveMode: "auto-correct-v4" };
function fixture() {
  const job = { id: "job_fixture", status: "completed", updatedAt: "v1", inputSha256: "a".repeat(64), inputS3Key: "owned-image",
    result: { image: { width: 100, height: 200 }, candidatesByPerson: [{ personIndex: 0, box: [0,0,100,200],
      refineAllowed: false, outputScope: resolveOutputScope({ selection: "full" }),
      candidates: [{ id: "selected", poseId: "pose", refineAllowed: false }] }] } } as Job;
  const persons = [{ personIndex: 0, candidateId: "selected", sha256: sha256Hex(original),
    exportPath: "/v1/pose-candidates/pose/framed?jobId=job_fixture&personIndex=0&candidateId=selected&format=fbx&reviewKey=current" }];
  const parts = structuredClone(partsSelectionFixture), cap = structuredClone(partsCapabilityFixture);
  const shared = new Map<string, Uint8Array>();
  const state = { status: "applied", sourceStatus: 200, owned: true, description: "상세 VLM 원문: 위쪽 다리와 교차 위치는 미확인",
    selectionRevision: "confirmation-v1", descriptionError: false, workerDelay: 0, storeDelay: 0, workerCalls: 0, compositions: 0, reads: 0, beforeStore: () => {}, afterSource: () => {},
    mutateResult: (_r: Record<string, unknown>) => {}, beforeWorker: () => {}, upstreamStatus: 200, upstreamCode: "",
    requests: [] as PartsRequest[], rendered: [] as string[], final: Buffer.alloc(0) };
  const fakeFetch: typeof fetch = async (url, init) => {
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer fixture-token");
    if (String(url).endsWith("/parts/capabilities")) {
      assert.equal(init?.method, "GET"); assert.equal(init?.body, undefined);
      return Response.json(cap);
    }
    assert.equal(String(url), "https://private.fixture/parts/refine");
    assert.equal(init?.method, "POST"); assert.equal(init?.redirect, "error");
    const request = JSON.parse(String(init?.body)) as PartsRequest;
    state.requests.push(request); state.workerCalls++; state.beforeWorker();
    await delay(state.workerDelay); // Deliberately ignores AbortSignal: exercise late response safety.
    if (state.upstreamStatus !== 200) return Response.json({ detail: { code: state.upstreamCode, private: "/secret/token/traceback" } }, { status: state.upstreamStatus });
    const applied = state.status === "applied", bytes = applied ? changed : original;
    const result: Record<string, unknown> = { contract_version: request.contract_version, engine_version: request.engine_version,
      engine_executed: true, request_id: request.request_id, request_sha256: partsDigest(request), context_sha256: partsDigest(request.context),
      catalog_sha256: cap.catalog_sha256, status: state.status, applied, reason: applied ? null : "PARTS_REJECTED",
      input_sha256: request.current_asset.sha256, artifact_sha256: sha256Hex(bytes), fbx_base64: bytes.toString("base64"),
      intent: request.intent, operation: request.operation, adjusted_limbs: applied ? request.operation.type === "recipe" ? ["left_arm", "right_arm"] : ["left_leg"] : [],
      saved_verification: applied ? { matrix_error: 1e-6, surface_error_m: 1e-6 } : {},
      artifact_contract: applied ? "verified-parts-fbx-v1" : "retained-current-fbx-v1",
      requires_artifact_review: true, release_allowed: false, score_status: "not_scored" };
    state.mutateResult(result);
    return Response.json(result);
  };
  const request = (operation: "capabilities" | "refine", value: unknown, options: { signal?: AbortSignal } = {}) =>
    scenePartsRequest(operation, value, { baseUrl: "https://private.fixture", token: "fixture-token", fetch: fakeFetch, ...options });
  const makeApp = (timeoutMs = 1000) => {
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => { c.set("installationId", "owner"); c.set("requestId", "req_fixture"); await next(); });
    app.route("/", createSceneRoutes(async () => {
      state.reads++; state.afterSource(); return new Response(original, { status: state.sourceStatus });
    }, { enabled: () => true, refinementEnabled: () => true, budgetMs: () => timeoutMs,
      getOwnedJob: async () => state.owned ? structuredClone(job) : undefined,
      validateConfirmedSelection: async () => true,
      loadSceneSelectionRevisions: async (_owner, _job, refs) => refs.map(r => ({ personIndex: r.personIndex, candidateId: r.candidateId, confirmedAt: state.selectionRevision })),
      loadSceneDescriptions: async () => {
        if (state.descriptionError) throw new Error("/secret/token/traceback");
        return [{ personIndex: 0, description: state.description }];
      },
      getScenePartsCapability: async signal => validatePartsCapability(await request("capabilities", undefined, { signal })),
      prepareRefinedScene: (owner, job, refs, sources, _overrides, artifactOnly, budget, execution) =>
        prepareRefinedScene(owner, job, refs, sources, { request,
          composeRoughScene: async (_id, _image, sources) => {
            state.compositions++;
            assert.deepEqual(Buffer.from(sources[0]!.bytes), state.status === "applied" ? changed : original);
            state.final = fbx(`composed:${sha256Hex(sources[0]!.bytes)}`);
            return { bytes: state.final, sha256: sha256Hex(state.final) };
          } }, artifactOnly, budget, execution),
      composeRoughScene: async () => ({ bytes: original, sha256: sha256Hex(original) }),
      saveSceneReceipt: async (_owner, _job, key, receipt) => { state.beforeStore(); await delay(state.storeDelay); shared.set(key, encodeSceneReceipt(receipt)); },
      loadSceneReceipt: async (_owner, _job, key) => shared.has(key) ? decodeSceneReceipt(shared.get(key)!) : undefined,
      renderFinalPreview: (artifact, aligned, _options, sceneCamera, signal) => renderFinalPreview(artifact, aligned, {
        baseUrl: "https://converter.fixture", fetch: async (url, init) => {
          assert.equal(String(url), "https://converter.fixture/render-final-preview");
          const form = init!.body as FormData;
          const bytes = new Uint8Array(await (form.get("fbx") as File).arrayBuffer());
          assert.equal(sha256Hex(bytes), form.get("artifact_sha256"));
          state.rendered.push(sha256Hex(bytes));
          return new Response(png, { headers: { "X-Standin-Artifact-SHA256": sha256Hex(bytes), "X-Standin-Preview-Artifact-SHA256": sha256Hex(png) } });
        } }, sceneCamera, signal),
    }));
    return app;
  };
  const app = makeApp();
  const send = (extra: Record<string, unknown> = {}, replica = app, signal?: AbortSignal) => replica.request(new Request("http://fixture/job_fixture/scene", {
    method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...mode, parts, persons, ...extra }),
  }));
  return { state, job, persons, parts, cap, shared, app, makeApp, send };
}
async function prepare(f: ReturnType<typeof fixture>) {
  const response = await f.send({ prepare: true, artifactOnly: true, manifestVersion: "csp-scene-manifest-v1" });
  assert.equal(response.status, 200, await response.clone().text());
  return await response.json() as { reviewKey: string; reviewVersion: string; artifactSha256: string; parts: { status: string; applied: boolean; reason: string | null }[]; manifest: { artifact: { parts: unknown[] } } };
}
async function code(response: Response, expected: string, status?: number) {
  if (status) assert.equal(response.status, status, await response.clone().text());
  const body = await response.json() as { error: { code: string; requestId: string; details: { jobId: string; stage: string; retryable: boolean } } };
  assert.equal(body.error.code, expected); assert.equal(body.error.requestId, "req_fixture");
  assert.equal(body.error.details.jobId, "job_fixture");
  assert.ok(!JSON.stringify(body).includes("/secret"));
  return body.error;
}

test("Python canonical request/context SHA vectors include Korean, surrogate pairs, DEL and small exponents", () => {
  const vectors = JSON.parse(readFileSync("src/pose/fixtures/parts-python-json-v1.json", "utf8")).vectors;
  for (const v of vectors) { assert.equal(partsCanonicalJson(v.value), v.canonical); assert.equal(partsDigest(v.value), v.sha256); }
});
test("configuration alone never promises service readiness or request approval", () => {
  const f = fixture();
  const available = sceneAvailability(f.job, { scene: () => true, fbx: () => true, converter: () => true,
    storage: () => true, refinement: () => true, worker: () => true });
  assert.equal(available.autoCorrectV4.configured, true); assert.equal(available.autoCorrectV4.available, false);
  assert.equal(available.autoCorrectV4.parts.serviceReadiness, "unverified");
  const noInput = sceneAvailability({ ...f.job, inputS3Key: null }, { scene: () => true, fbx: () => true, converter: () => true,
    storage: () => true, refinement: () => true, worker: () => true });
  assert.equal(noInput.autoCorrectV4.configured, true);
  assert.ok(noInput.autoCorrectV4.reasons.includes("source_image_unavailable"));
});
test("live discovery is owned, versioned and does not claim a completed execution", async () => {
  const f = fixture(), response = await f.app.request("/job_fixture/scene/parts");
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { executionStatus: string }).executionStatus, "not_attempted");
  assert.equal(f.state.workerCalls, 0);
  f.state.owned = false; assert.notEqual((await f.app.request("/job_fixture/scene/parts")).status, 200);
});
for (const status of ["applied", "retained"]) test(`${status}: exact native input, composed final preview, receipt and replica download SHA stay bound`, async () => {
  const f = fixture(); f.state.status = status;
  const review = await prepare(f), request = f.state.requests[0]!;
  assert.equal(request.current_asset.sha256, sha256Hex(original));
  assert.equal(request.current_asset.fbx_base64, original.toString("base64"));
  assert.equal(request.context.vlm_description, f.state.description);
  assert.equal(request.context.user_instruction, f.parts.edits[0]!.intent.description);
  assert.equal(request.intent.source, "user_confirmed");
  assert.equal(review.parts[0]!.status, status); assert.equal(review.parts[0]!.applied, status === "applied");
  assert.equal(review.manifest.artifact.parts.length, 1);
  const confirm = { reviewKey: review.reviewKey, reviewVersion: review.reviewVersion, artifactSha256: review.artifactSha256, manifestVersion: "csp-scene-manifest-v1" };
  const preview = await f.send({ ...confirm, preview: true }, f.makeApp());
  assert.equal(preview.status, 200, await preview.clone().text());
  const downloaded = await f.send(confirm, f.makeApp());
  assert.equal(downloaded.status, 200, await downloaded.clone().text());
  const downloadedSha = sha256Hex(new Uint8Array(await downloaded.arrayBuffer()));
  assert.equal(downloadedSha, review.artifactSha256); assert.equal(downloadedSha, f.state.rendered[0]);
  assert.equal(preview.headers.get("X-Standin-Artifact-SHA256"), downloadedSha);
  assert.equal(f.state.workerCalls, 1); assert.equal(f.state.compositions, 1);
  assert.equal(f.job.result!.candidatesByPerson[0]!.refineAllowed, false);
});
for (const field of ["engine_version", "request_id", "request_sha256", "context_sha256", "input_sha256", "artifact_sha256", "catalog_sha256", "engine_executed", "limbs", "verification", "not_attempted", "retained_changed"]) {
  test(`invalid native receipt ${field} cannot publish a review`, async () => {
    const f = fixture();
    f.state.mutateResult = r => {
      if (field === "limbs") r.adjusted_limbs = ["screen_left_leg"];
      else if (field === "verification") r.saved_verification = { matrix_error: .001, surface_error_m: 0 };
      else if (field === "not_attempted") r.status = "not_attempted";
      else if (field === "retained_changed") { r.status = "retained"; r.applied = false; r.reason = "PARTS_REJECTED"; r.adjusted_limbs = []; r.artifact_contract = "retained-current-fbx-v1"; }
      else r[field] = field === "engine_executed" ? false : "invalid";
    };
    await code(await f.send({ prepare: true }), "PARTS_INTEGRITY", 502);
    assert.equal(f.shared.size, 0); assert.equal(f.state.compositions, 0);
  });
}
for (const [upstreamCode, upstreamStatus] of [["PARTS_DISABLED",503], ["PARTS_UNAVAILABLE",503], ["PARTS_TIMEOUT",504],
  ["PARTS_RELEASE_CHANGED",503], ["PARTS_CONTRACT_UNSUPPORTED",409], ["PARTS_EXPLICIT_INTENT_REQUIRED",409], ["PARTS_INTENT_MISMATCH",409],
  ["PARTS_WORKER_FAILED",502], ["PARTS_INTEGRITY",502], ["PARTS_INVALID_INPUT",422]] as const) {
  test(`upstream ${upstreamCode} is bounded and never substitutes the original`, async () => {
    const f = fixture(); f.state.upstreamStatus = upstreamStatus; f.state.upstreamCode = upstreamCode;
    const error = await code(await f.send({ prepare: true }), upstreamCode, upstreamStatus);
    assert.equal(error.details.stage, "parts_refine");
    assert.equal(f.shared.size, 0); assert.equal(f.state.compositions, 0);
    const recovery = await f.send({ saveMode: "original-selection", parts: undefined });
    assert.equal(recovery.status, 200); assert.equal(f.state.workerCalls, 1);
  });
}
test("missing intent, old worker, unavailable catalog and cropped current FBX fail before native execution", async () => {
  const f = fixture(); await code(await f.send({ prepare: true, parts: undefined }), "PARTS_EXPLICIT_INTENT_REQUIRED", 409);
  f.cap.engine_version = "scene-refinement-v4" as typeof f.cap.engine_version;
  await code(await f.send({ prepare: true }), "PARTS_CONTRACT_UNSUPPORTED", 409);
  f.cap.engine_version = partsCapabilityFixture.engine_version;
  f.cap.catalog_sha256 = "b".repeat(64);
  await code(await f.send({ prepare: true }), "PARTS_RELEASE_CHANGED", 503);
  f.cap.catalog_sha256 = null;
  f.job.result!.candidatesByPerson[0]!.outputScope = resolveOutputScope({ selection: "half" });
  await code(await f.send({ prepare: true }), "SCENE_PARTS_SCOPE_UNSUPPORTED", 409);
  assert.equal(f.state.workerCalls, 0);
});
for (const change of ["description", "instruction", "operation", "catalog", "inputSha", "jobScope"] as const) test(`changed ${change} invalidates a prepared receipt without rerunning the engine`, async () => {
  const f = fixture(), review = await prepare(f);
  if (change === "description") f.state.description += "new";
  if (change === "instruction") f.parts.edits[0]!.intent.description += "new";
  if (change === "operation") f.parts.edits[0]!.operation = { type: "advance_foot", side: "right", distance_m: .05 };
  if (change === "catalog") f.cap.catalog_sha256 = "b".repeat(64);
  if (change === "inputSha") f.job.inputSha256 = "c".repeat(64);
  if (change === "jobScope") f.job.result!.candidatesByPerson[0]!.outputScope = resolveOutputScope({ selection: "half" });
  const response = await f.send({ reviewKey: review.reviewKey, reviewVersion: review.reviewVersion, artifactSha256: review.artifactSha256 });
  assert.notEqual(response.status, 200); assert.equal(f.state.workerCalls, 1);
});
test("a selection change during execution or receipt publication cannot expose the old result", async () => {
  for (const phase of ["worker", "store"]) {
    const f = fixture();
    const mutate = () => { f.job.inputSha256 = "d".repeat(64); };
    if (phase === "worker") f.state.beforeWorker = mutate; else f.state.beforeStore = mutate;
    await code(await f.send({ prepare: true }), "SCENE_SOURCE_CHANGED", 409);
  }
});
test("deadline/cancel discard late worker results and a fresh retry cannot attach them", async () => {
  for (const cancelled of [false, true]) {
    const f = fixture(), abort = new AbortController();
    f.state.workerDelay = 60;
    const pending = f.send({ prepare: true }, f.makeApp(cancelled ? 1000 : 20), abort.signal);
    if (cancelled) setTimeout(() => abort.abort(), 15);
    const error = await code(await pending, cancelled ? "SCENE_CANCELLED" : "SCENE_TIMEOUT", cancelled ? 409 : 504);
    assert.equal(error.details.stage, "parts_refine");
    await delay(80); assert.equal(f.shared.size, 0); assert.equal(f.state.compositions, 0);
    f.state.workerDelay = 0; f.parts.edits[0]!.intent.description += " retry";
    const review = await prepare(f); assert.equal(review.parts[0]!.status, "applied");
    assert.equal(f.state.requests.length, 2); assert.notEqual(f.state.requests[0]!.request_id, f.state.requests[1]!.request_id);
  }
});
test("untrusted paths and changed current SHA never reach the parts worker", async () => {
  const f = fixture(); f.persons[0]!.exportPath = "https://attacker.test/private.fbx";
  assert.equal((await f.send({ prepare: true })).status, 400); assert.equal(f.state.workerCalls, 0);
  f.persons[0]!.exportPath = "/v1/pose-candidates/pose/framed?jobId=job_fixture&personIndex=0&candidateId=selected&format=fbx";
  f.persons[0]!.sha256 = "b".repeat(64);
  await code(await f.send({ prepare: true }), "SCENE_SOURCE_CHANGED", 409); assert.equal(f.state.workerCalls, 0);
});
test("stored original descriptions preserve both fields and never synthesize missing source text", () => {
  const raw = { bodyDetails: "상세 원문: 인물 자신의 좌우 미확인", searchText: "다리 교차" };
  assert.equal(storedSceneDescription(JSON.stringify({ poseDescription: raw })), JSON.stringify(raw));
  assert.equal(storedSceneDescription(null), null);
  assert.throws(() => storedSceneDescription(JSON.stringify({ poseDescription: { bodyDetails: "a".repeat(4096) } })), { code: "PARTS_INVALID_INPUT" });
  assert.throws(() => parsePartsSelection({ ...partsSelectionFixture, engineVersion: "scene-refinement-v4" }));
});
test("engine/request contract and exact selection are part of the review binding", () => {
  const f = fixture(), identity = sceneSourceIdentity(f.job);
  const a = sceneReviewBinding("owner", f.job.id, identity, f.persons, "auto-correct-v4", [], false, f.parts);
  const changed = structuredClone(f.parts); changed.edits[0]!.intent.reference = "another_user_edit";
  assert.notEqual(a, sceneReviewBinding("owner", f.job.id, identity, f.persons, "auto-correct-v4", [], false, changed));
});

test("description lookup respects job ownership, missing consent and consent withdrawal", async t => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { pool } = await import("../db.js");
  const { loadSceneDescriptions } = await import("./scenePartsDescriptions.js");
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`CREATE TABLE installations(id TEXT, quality_consent_id TEXT, quality_personal_data BOOLEAN,
    quality_content_license BOOLEAN, revoked_at TEXT, deletion_requested_at TEXT);
    CREATE TABLE jobs(id TEXT, installation_id TEXT, quality_consent_id TEXT);
    CREATE TABLE analysis_people(job_id TEXT, person_index INTEGER, person_tags_json TEXT);
    INSERT INTO installations VALUES ('owner','consent',true,true,null,null);
    INSERT INTO jobs VALUES ('job','owner','consent');`);
  const description = { bodyDetails: "원본 상세 설명", searchText: "원래 검색 문장" };
  await db.query("INSERT INTO analysis_people VALUES ($1,$2,$3)", ["job", 0, JSON.stringify({ poseDescription: description })]);
  t.mock.method(pool, "query", (async (sql: string, params?: unknown[]) => {
    const result = await db.query(sql, params); return { rows: result.rows, rowCount: result.rows.length };
  }) as typeof pool.query);
  assert.equal((await loadSceneDescriptions("owner", "job", [0]))[0]!.description, JSON.stringify(description));
  assert.equal((await loadSceneDescriptions("other", "job", [0]))[0]!.description, null);
  await db.exec("UPDATE installations SET quality_personal_data=false");
  assert.equal((await loadSceneDescriptions("owner", "job", [0]))[0]!.description, null);
  await db.exec("UPDATE installations SET quality_personal_data=true, quality_consent_id='new-consent'");
  assert.equal((await loadSceneDescriptions("owner", "job", [0]))[0]!.description, null, "a regrant cannot resurrect an old description");
  const { loadSceneSelectionRevisions } = await import("./sceneSelection.js");
  await db.exec(`ALTER TABLE jobs ADD COLUMN status TEXT DEFAULT 'completed';
    ALTER TABLE jobs ADD COLUMN created_at TEXT DEFAULT (now()::text);
    CREATE TABLE confirmed_selections(job_id TEXT, person_index INTEGER, candidate_id TEXT, installation_id TEXT, confirmed_at TEXT);
    INSERT INTO confirmed_selections VALUES ('job',0,'selected','owner','confirmation-v1');`);
  const refs = [{ personIndex: 0, candidateId: "selected", exportPath: "/protected", sha256: "a".repeat(64) }];
  const firstRevision = await loadSceneSelectionRevisions("owner", "job", refs);
  await db.exec("UPDATE confirmed_selections SET confirmed_at='confirmation-v2'");
  assert.notDeepEqual(await loadSceneSelectionRevisions("owner", "job", refs), firstRevision);
  await assert.rejects(loadSceneSelectionRevisions("other", "job", refs), { code: "SCENE_SOURCE_CHANGED" });
  await db.exec("UPDATE jobs SET created_at=(now() - interval '91 days')::text");
  await assert.rejects(loadSceneSelectionRevisions("owner", "job", refs), { code: "SCENE_SOURCE_CHANGED" });
});

test("timeout during storage never returns a key or reuses a late result on retry", async () => {
  const f = fixture(); f.state.storeDelay = 60;
  const response = await f.send({ prepare: true }, f.makeApp(20));
  await code(response, "SCENE_TIMEOUT", 504);
  await delay(80);
  // A storage operation already dispatched can finish, but its unacknowledged
  // random key is never returned/cached and cannot attach to the next request.
  f.state.storeDelay = 0;
  const review = await prepare(f);
  assert.equal(f.state.workerCalls, 2); assert.equal(f.shared.size, 2);
  assert.equal((await f.send({ reviewKey: review.reviewKey, reviewVersion: review.reviewVersion, artifactSha256: review.artifactSha256 })).status, 200);
});

test("corrupted stored execution metadata is rejected on a new replica", async () => {
  const f = fixture(), review = await prepare(f);
  const stored = JSON.parse(Buffer.from(f.shared.get(review.reviewKey)!).toString("utf8"));
  stored.scene.parts[0].engineVersion = "scene-refinement-v4";
  f.shared.set(review.reviewKey, Buffer.from(JSON.stringify(stored)));
  await code(await f.send({ reviewKey: review.reviewKey, reviewVersion: review.reviewVersion, artifactSha256: review.artifactSha256 }, f.makeApp()), "SCENE_INTEGRITY", 502);
});

test("reconfirming the same candidate invalidates its old receipt even with unchanged job timestamp and FBX", async () => {
  const f = fixture(), review = await prepare(f);
  f.state.selectionRevision = "confirmation-v2";
  await code(await f.send({ reviewKey: review.reviewKey, reviewVersion: review.reviewVersion, artifactSha256: review.artifactSha256 }), "SCENE_SOURCE_CHANGED", 409);
  assert.equal(f.state.workerCalls, 1);
});


test("reviewed arm recipe uses exact catalog/intent and preserves the server's anatomical limb report", async () => {
  const f = fixture();
  f.cap.operations.push("recipe"); f.cap.catalog_sha256 = "b".repeat(64);
  const description = "왼손은 무릎 위, 오른손은 아래";
  f.cap.recipes = [{ id: "arms-reviewed", label: "손 위치 조정", description }];
  f.parts.catalogSha256 = f.cap.catalog_sha256;
  f.parts.edits[0]!.operation = { type: "recipe", recipe_id: "arms-reviewed" };
  f.parts.edits[0]!.intent.description = description;
  const review = await prepare(f);
  assert.deepEqual(f.state.requests[0]!.operation, { type: "recipe", recipe_id: "arms-reviewed" });
  const native = review.manifest.artifact.parts[0] as { adjustedLimbs: string[]; catalogSha256: string };
  assert.deepEqual(native.adjustedLimbs, ["left_arm", "right_arm"]);
  assert.equal(native.catalogSha256, f.cap.catalog_sha256);
  f.parts.edits[0]!.intent.description = "다른 손 지시";
  await code(await f.send({ prepare: true }), "PARTS_INTENT_MISMATCH", 409);
  assert.equal(f.state.workerCalls, 1);
});

test("unsupported recipes, disabled capability and screen-side/inferred intent cannot dispatch native work", async () => {
  const f = fixture();
  f.parts.edits[0]!.operation = { type: "recipe", recipe_id: "unknown" };
  await code(await f.send({ prepare: true }), "PARTS_RECIPE_UNAVAILABLE", 409);
  f.cap.available = false;
  await code(await f.send({ prepare: true }), "PARTS_DISABLED", 503);
  for (const mutate of [
    (v: { edits: { operation: Record<string, unknown>; intent: Record<string, unknown> }[] }) => { v.edits[0].operation.side = "screen_left"; },
    (v: { edits: { operation: Record<string, unknown>; intent: Record<string, unknown> }[] }) => { v.edits[0].intent.source = "vlm_inferred"; },
    (v: { edits: { operation: Record<string, unknown>; intent: Record<string, unknown> }[] }) => { v.edits[0].operation.path = "/private/donor.fbx"; },
    (v: { edits: { operation: Record<string, unknown>; intent: Record<string, unknown> }[] }) => { v.edits.push(v.edits[0]); },
  ]) {
    const selection = structuredClone(partsSelectionFixture); mutate(selection as unknown as { edits: { operation: Record<string, unknown>; intent: Record<string, unknown> }[] });
    assert.throws(() => parsePartsSelection(selection));
  }
  assert.equal(f.state.workerCalls, 0);
});


test("a source-store exception has a bounded failure envelope before any parts dispatch", async () => {
  const f = fixture(); f.state.descriptionError = true;
  const error = await code(await f.send({ prepare: true }), "SCENE_FAILED", 502);
  assert.equal(error.details.stage, "source_validation"); assert.equal(f.state.workerCalls, 0);
});
