import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { AppEnv } from "./env.js";
import type { Job } from "./jobs/store.js";
import type { AnalysisPerson, AnalysisResult, CandidateCamera } from "./types.js";
import type { BodySelection } from "./body-selection/model.js";
import type { HandBake } from "./hands/model.js";
import { makeManualPresentation } from "./body-selection/fixtures.js";
import { createFramingRoutes } from "./output-scope/framingRoutes.js";
import { createReleaseGuard } from "./release-policy.js";
import { createRefineRoutes } from "./refine/routes.js";
import { sha256Hex } from "./converter/client.js";
import { manualExportCandidate } from "./routed-search.js";
import { upgradeManualResult, upgradeOwnedManualResult } from "./manual-export.js";

function fixture(kind = "near_match", semantic = false) {
  const source = Buffer.from("HIERARCHY\nROOT Hips\nMOTION\nFrames: 1\nFrame Time: 0.033\n0\n");
  const p = { personIndex: 0, candidates: [{ id: "old-pick", poseId: "registered", rank: 1,
    camera: { source_bvh_sha256: sha256Hex(source), rotation: [[1,0,0],[0,1,0],[0,0,1]] } as CandidateCamera,
  }] } as unknown as AnalysisPerson;
  makeManualPresentation(p);
  const c = p.candidates[0]!;
  c.manualExportAllowed = true; c.reviewRequired = true; c.releaseAllowed = false;
  c.actualMeshValidated = false; c.presentationKind = kind;
  const presentation = p.posePresentation!;
  const row = presentation.library_candidates[0]!;
  row.kind = kind;
  presentation.search_status = "partial_error";
  presentation.search_reason = "hand_skin_screen_unavailable_no_generation";
  if (kind !== "library_match") {
    presentation.review_candidates = [row]; presentation.library_candidates = [];
  }
  p.outputScope = { selection: "half" } as AnalysisPerson["outputScope"];
  if (semantic) {
    c.source = "semantic";
    c.semantic = { familyId: c.poseId, alternate: false, description: "참고", near: true };
    presentation.version = "semantic-pose-presentation-v1";
  }
  const result = { jobId: "job-" + Math.random(), source: semantic ? "semantic" : "image",
    candidatesByPerson: [p], inferenceMetadata: { poseLibraryVersion: "library" },
  } as AnalysisResult;
  return { source, p, c, row, result };
}
function setup(kind: string, semantic: boolean, bodyMode: boolean, handsMode: boolean) {
  const f = fixture(kind, semantic);
  const state = { owner: true, confirmed: false, available: true, changed: false, calls: 0, late: "", revision: 1, runtime: "c".repeat(64), character: "b".repeat(64), modelRevision: "e".repeat(64), badLineage: false };
  const body = (): BodySelection => ({ schemaVersion: "body-selection.v1", personIndex: 0,
    intent: "manual", manualCharacterId: "chosen", recommendation: { status: "unavailable", body: null, reasonCodes: [] },
    resolvedBody: { bodyId: "body", bodyVersion: "1", assetSha256: state.character, characterId: "chosen", measurementVersion: "1", rigVersion: "1" },
    resolvedSource: "manual", resolutionStatus: "ready", selectionRevision: state.revision, renderingExecuted: false,
    shape: null, shapeSource: null,
  });
  const hands: HandBake | null = handsMode ? { left: "fist", right: "relaxed", library_sha256: "d".repeat(64), library_version: "1", revision: 2 } : null;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("installationId", "owner"); await next(); });
  app.route("/", createFramingRoutes({
    getOwnedJob: async () => state.owner ? { status: "completed", result: structuredClone(f.result) } as Job : undefined,
    validateExportCandidate: async () => true,
    validateConfirmedSelection: async () => state.confirmed,
    resolveExportArtifact: async () => ({ variant: "base", fallbackReason: null }),
    getPoseBvh: async () => new Response(state.changed ? "changed" : f.source, { status: state.available ? 200 : 409 }),
    checkCharacter: async () => "ok", converterEnabled: () => true, recordExport: async () => {},
    handBakeFor: async () => hands,
    modelPreviewIdentity: async () => ({ characterSha256: state.character, modelRevision: state.modelRevision }),
    convertFramed: async (input) => {
      state.calls++;
      assert.equal(input.scope, "half"); assert.deepEqual(Buffer.from(input.bvhBytes), f.source);
      assert.deepEqual(input.cameraRotation, f.row.render_camera.rotation);
      assert.deepEqual(input.hands ?? null, hands);
      if (bodyMode) assert.equal(input.characterId, "chosen");
      const bytes = Buffer.from("FBX exact registered asset " + input.scope);
      const artifact = { fbx: bytes, preview: Buffer.from(input.previewFormat === "model" ? "GLB" : "PNG"),
        conversionId: "test", sourceBvhSha256: sha256Hex(f.source), artifactSha256: sha256Hex(bytes),
        characterSha256: state.character, previewRevision: state.badLineage ? "0".repeat(64) : state.runtime };
      if (state.late === "permission") f.c.manualExportAllowed = false;
      if (state.late === "source") state.changed = true;
      if (state.late === "quarantine") state.available = false;
      if (state.late === "revision") state.revision++;
      if (state.late === "runtime") state.runtime = "f".repeat(64);
      if (state.late === "character") state.character = "a".repeat(64);
      return artifact;
    },
  }, { selection: async () => body(), runtime: async () => ({ schemaVersion: "body-preview-runtime.v1", previewRevision: state.runtime,
    modelVersion: "posed-mesh-v1", modelRevision: state.modelRevision, solverVersion: "solver", framingVersion: "framing" }), enabled: () => true }));
  const request = (extra: Record<string, string> = {}) => app.request("/registered/framed?" + new URLSearchParams({
    jobId: f.result.jobId, personIndex: "0", candidateId: f.c.id, outputScope: "half", format: "preview",
    ...(bodyMode ? { bodySelectionRevision: "1" } : {}), ...(hands ? { handSelectionRevision: "2" } : {}), ...extra,
  }));
  return { ...f, state, request };
}
for (const kind of ["library_match", "near_match", "geometry_review", "framing_reference", "mirror_reference"])
  test(`manual ${kind} reviews and exports without changing failed screen status`, async () => {
    const f = setup(kind, false, true, true);
    const preview = await f.request(); assert.equal(preview.status, 200);
    assert.equal((await f.request({ format: "fbx" })).status, 409);
    f.state.confirmed = true;
    assert.equal((await f.request({ format: "fbx", reviewKey: "a".repeat(64) })).status, 409);
    const download = await f.request({ format: "fbx", reviewKey: preview.headers.get("X-Standin-Review-Key")! });
    assert.equal(download.status, 200);
    assert.equal(await download.text(), "FBX exact registered asset half");
    assert.equal(f.state.calls, 1);
    assert.equal(f.p.posePresentation!.search_reason, "hand_skin_screen_unavailable_no_generation");
    assert.equal(f.c.releaseAllowed, false); assert.equal(f.c.actualMeshValidated, false);
  });
for (const body of [false, true]) for (const format of ["preview", "model"])
  test(`semantic manual ${format} review -> FBX, body=${body}`, async () => {
    const f = setup("near_match", true, body, false);
    const preview = await f.request({ format }); assert.equal(preview.status, 200);
    assert.equal(preview.headers.get("X-Standin-Character-SHA256"), "b".repeat(64));
    assert.equal(preview.headers.get("X-Standin-Preview-Artifact-SHA256"), sha256Hex(new Uint8Array(await preview.arrayBuffer())));
    f.state.confirmed = true;
    const output = await f.request({ format: "fbx", ...(format === "model" ? { previewType: "model" } : {}),
      reviewKey: preview.headers.get("X-Standin-Review-Key")!, expectedBvhSha256: f.c.sourceBvhSha256!, expectedCharacterSha256: "b".repeat(64) });
    assert.equal(output.status, 200); assert.equal(f.state.calls, 1);
  });
for (const late of ["permission", "source", "quarantine", "revision", "runtime", "character"])
  test(`manual review rejects ${late} changed during conversion`, async () => {
    const f = setup("near_match", false, true, false); f.state.late = late;
    assert.equal((await f.request()).status, 409);
  });
for (const change of ["runtime", "character", "modelRevision"] as const)
  test(`warm no-body manual preview separates changed ${change} and rejects old receipt`, async () => {
    const f = setup("near_match", true, false, false);
    const first = await f.request(); assert.equal(first.status, 200); assert.equal(f.state.calls, 1);
    const old = first.headers.get("X-Standin-Review-Key")!;
    f.state[change] = "f".repeat(64); f.state.confirmed = true;
    const next = await f.request(); assert.equal(next.status, 200); assert.equal(f.state.calls, 2);
    assert.notEqual(next.headers.get("X-Standin-Review-Key"), old);
    assert.equal((await f.request({ format: "fbx", reviewKey: old })).status, 409);
    assert.equal((await f.request({ format: "fbx", reviewKey: next.headers.get("X-Standin-Review-Key")! })).status, 200);
    assert.equal(f.state.calls, 2);
  });
test("manual preview requires converter runtime lineage, including no-body PNG", async () => {
  const f = setup("near_match", true, false, false); f.state.badLineage = true;
  assert.equal((await f.request()).status, 409);
});
test("manual capability cannot enable refine or be supplied by request flags", async () => {
  const f = fixture(); const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("installationId", "owner"); await next(); });
  const load = async () => ({ status: "completed", result: f.result } as Job);
  app.route("/", createRefineRoutes({ getOwnedJob: load, validateExportCandidate: async () => true, runRefine: async () => { throw Error("must not run"); } }));
  app.use("/:id/export", createReleaseGuard(load, async () => true)); app.get("/:id/export", (c) => c.text("allowed"));
  const response = await app.request(`/${f.result.jobId}/people/0/refine`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ candidateId: f.c.id }) });
  assert.equal(response.status, 409);
  const query = new URLSearchParams({ jobId: f.result.jobId, personIndex: "0", candidateId: f.c.id, manualExportAllowed: "true" });
  assert.equal((await app.request(`/registered/export?${query}`)).status, 200);
  for (const mutate of [() => { f.c.manualExportAllowed = false; }, () => { f.c.manualExportAllowed = true; f.c.sourceBvhSha256 = "bad"; }, () => { f.c.sourceBvhSha256 = "a".repeat(64); f.c.source = "dynamic"; }]) {
    mutate(); assert.equal(manualExportCandidate(f.c), false);
    assert.equal((await app.request(`/registered/export?${query}`)).status, 409);
  }
});

function oldJob(semantic = false) {
  const f = fixture("near_match", semantic); delete f.c.manualExportAllowed;
  const assets = new Map([[0, { [f.c.id]: { transport: "library_bvh" as const, pose_id: f.c.poseId, bvh_sha256: f.c.sourceBvhSha256! } }]]);
  if (!semantic) f.p.candidates = []; // The old near-only screenshot has no analysis_candidates rows.
  return { ...f, assets };
}
for (const semantic of [false, true]) test(`old ${semantic ? "semantic" : "near-only"} job gains manual choice from private binding without reanalysis`, () => {
  const f = oldJob(semantic), upgraded = upgradeManualResult(f.result, f.assets);
  const pick = upgraded.candidatesByPerson[0].candidates[0];
  assert.equal(pick.id, f.row.candidate_id); assert.equal(pick.manualExportAllowed, true);
  assert.equal(upgraded.candidatesByPerson[0].posePresentation!.search_status, "partial_error");
  assert.equal(pick.releaseAllowed, false); assert.equal(pick.refineAllowed, false);
  assert.equal(f.result.manualExportVersion, undefined);
  f.assets.get(0)![f.row.candidate_id].bvh_sha256 = "a".repeat(64);
  assert.equal(upgradeManualResult(f.result, f.assets).candidatesByPerson[0].candidates.length, 0);
});
test("lazy migration locks owned completed row and commits candidate registration before result JSON", async () => {
  const f = oldJob(), calls: string[] = [];
  const db = { query: async (sql: string, values: unknown[]) => {
    calls.push(sql);
    if (sql.startsWith("SELECT status")) { assert.deepEqual(values, [f.result.jobId, "owner"]); assert.match(sql, /FOR UPDATE/); return { rows: [{ status: "completed", result_json: JSON.stringify(f.result) }] }; }
    if (sql.startsWith("SELECT person")) return { rows: [{ person_index: 0, refine_context_json: JSON.stringify({ posePresentationAssets: f.assets.get(0) }) }] };
    if (sql.startsWith("INSERT")) { assert.equal(values[2], f.row.candidate_id); assert.match(sql, /ON CONFLICT/); }
    if (sql.startsWith("UPDATE")) assert.equal(JSON.parse(values[1] as string).manualExportVersion, 1);
    return { rows: [] };
  } } as unknown as Parameters<typeof upgradeOwnedManualResult>[0];
  const upgraded = await upgradeOwnedManualResult(db, f.result.jobId, "owner");
  assert.equal(upgraded!.candidatesByPerson[0].candidates.length, 1);
  assert.match(calls.at(-1)!, /^UPDATE/); assert.match(calls.at(-2)!, /^INSERT/);
});
for (const status of ["running", "failed", "deleted"])
  test(`lazy migration cannot resurrect ${status} or unowned jobs`, async () => {
    let calls = 0;
    const db = { query: async () => { calls++; return { rows: status === "deleted" ? [] : [{ status, result_json: "{}" }] }; } } as unknown as Parameters<typeof upgradeOwnedManualResult>[0];
    assert.equal(await upgradeOwnedManualResult(db, "job", "other"), null); assert.equal(calls, 1);
  });

test("raw BVH route discards bytes after confirmed choice or manual authority is revoked during fetch", async () => {
  const { createPoseRoutes } = await import("./pose/routes.js");
  for (const change of ["confirmation", "permission", "candidate", "ownership"]) {
    const f = fixture(); let confirmed = true, owned = true, fetched = 0;
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => { c.set("installationId", "owner"); await next(); });
    app.route("/", createPoseRoutes({
      getOwnedJob: async () => owned ? { status: "completed", result: structuredClone(f.result) } as Job : undefined,
      validateConfirmedSelection: async () => confirmed,
      validateExportCandidate: async () => true,
      recordExport: async () => {},
      resolveExportArtifact: async () => ({ variant: "base", fallbackReason: null }),
      getPoseBvh: async () => {
        fetched++;
        if (change === "confirmation") confirmed = false;
        if (change === "permission") f.c.manualExportAllowed = false;
        if (change === "candidate") f.p.candidates = [];
        if (change === "ownership") owned = false;
        return new Response(f.source);
      },
    }));
    const response = await app.request(`/registered/export?${new URLSearchParams({ jobId: f.result.jobId, personIndex: "0", candidateId: f.c.id, format: "bvh" })}`);
    assert.equal(response.status, 409, change); assert.equal(fetched, 1);
    assert.equal(response.headers.get("Content-Disposition"), null);
  }
});

test("raw BVH allows explicitly confirmed manual asset; direct FBX requires paired review", async () => {
  const { createPoseRoutes } = await import("./pose/routes.js");
  const f = fixture(); let confirmed = false, fetched = 0;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("installationId", "owner"); await next(); });
  app.route("/", createPoseRoutes({
    getOwnedJob: async () => ({ status: "completed", result: structuredClone(f.result) } as Job),
    validateConfirmedSelection: async () => confirmed,
    validateExportCandidate: async () => true, recordExport: async () => {},
    resolveExportArtifact: async () => ({ variant: "base", fallbackReason: null }),
    getPoseBvh: async () => { fetched++; return new Response(f.source); },
  }));
  const request = (format: string) => app.request(`/registered/export?${new URLSearchParams({ jobId: f.result.jobId, personIndex: "0", candidateId: f.c.id, format })}`);
  assert.equal((await request("bvh")).status, 409); assert.equal(fetched, 0);
  confirmed = true;
  const bvh = await request("bvh"); assert.equal(bvh.status, 200);
  assert.deepEqual(Buffer.from(await bvh.arrayBuffer()), f.source);
  const fbx = await request("fbx"); assert.equal(fbx.status, 409);
  assert.equal(((await fbx.json()) as { error: { code: string } }).error.code, "MANUAL_REVIEW_REQUIRED");
  assert.equal(fetched, 1);
});

test("actual PostgreSQL schema: old near/semantic jobs gain owned manual rows and confirmations without quality consent or reanalysis", async (t) => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { pool, SCHEMA, transaction } = await import("./db.js");
  const { getOwnedJob } = await import("./jobs/store.js");
  const { confirmSelections, validateConfirmedSelection } = await import("./analytics/store.js");
  const db = new PGlite(); t.after(() => db.close()); await db.exec(SCHEMA);
  const query = async (sql: string, values?: unknown[]) => {
    const r = await db.query(sql, values);
    return { rows: r.rows, rowCount: r.rows.length || r.affectedRows || 0, fields: [], command: "", oid: 0 };
  };
  t.mock.method(pool, "query", query as typeof pool.query);
  t.mock.method(pool, "connect", (async () => ({ query, release() {} })) as unknown as typeof pool.connect);
  const now = new Date().toISOString();
  await db.query(`INSERT INTO installations
    (id,token_hash,consent_version,consented_at,created_at,last_seen_at,app_version,os_name,os_version,architecture,locale)
    VALUES ('owner','hash','test',$1,$1,$1,'test','test','test','test','ko')`, [now]);
  async function insertOld(semantic: boolean, createdAt = now) {
    const f = oldJob(semantic);
    f.p.handSelection = { revision: 7, left: "fist", right: "relaxed" } as NonNullable<AnalysisPerson["handSelection"]>;
    if (semantic) f.c.id = "registered::front"; // The previous text contract used this ID.
    await db.query(`INSERT INTO jobs (id,status,created_at,updated_at,result_json,installation_id)
      VALUES ($1,'completed',$2,$2,$3,'owner')`, [f.result.jobId, createdAt, JSON.stringify(f.result)]);
    await db.query(`INSERT INTO analysis_people (job_id,person_index,tags_json,refine_context_json)
      VALUES ($1,0,'{}',$2)`, [f.result.jobId, JSON.stringify({ posePresentationAssets: f.assets.get(0) })]);
    return f;
  }
  for (const semantic of [false, true]) {
    const f = await insertOld(semantic);
    assert.equal(await getOwnedJob(f.result.jobId, "other"), undefined);
    const job = (await getOwnedJob(f.result.jobId, "owner"))!;
    const p = job.result!.candidatesByPerson[0], c = p.candidates[0];
    assert.equal(c.manualExportAllowed, true); assert.equal(c.id, f.row.candidate_id);
    assert.equal(c.releaseAllowed, false); assert.equal(c.refineAllowed, false);
    assert.equal(p.posePresentation!.search_reason, "hand_skin_screen_unavailable_no_generation");
    assert.equal(p.handSelection!.revision, 7); assert.equal(p.outputScope!.selection, "half");
    const saved = await db.query<{ candidate_id: string; pose_id: string }>("SELECT candidate_id,pose_id FROM analysis_candidates WHERE job_id=$1", [f.result.jobId]);
    assert.deepEqual(saved.rows, [{ candidate_id: c.id, pose_id: "registered" }]);
    assert.equal(await validateConfirmedSelection("owner", f.result.jobId, 0, c.id), false);
    assert.equal(await confirmSelections("owner", f.result.jobId, [{ personIndex: 0, candidateId: c.id }]), true);
    assert.equal(await validateConfirmedSelection("owner", f.result.jobId, 0, c.id), true);
    assert.equal(await validateConfirmedSelection("other", f.result.jobId, 0, c.id), false);
    const second = await getOwnedJob(f.result.jobId, "owner");
    assert.deepEqual(second!.result, job.result, "second read preserves body/hands and result without another migration");
    const rowCount = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM analysis_candidates WHERE job_id=$1", [f.result.jobId]);
    assert.equal(rowCount.rows[0].n, 1);
  }
  const review = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM quality_review_jobs");
  assert.equal(review.rows[0].n, 0, "manual file use does not opt the user into quality review");
  const expired = await insertOld(false, new Date(Date.now() - 91 * 86_400_000).toISOString());
  assert.equal(await getOwnedJob(expired.result.jobId, "owner"), undefined);
  assert.equal(await transaction((client) => upgradeOwnedManualResult(client, expired.result.jobId, "owner")), null);
  assert.equal((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM analysis_candidates WHERE job_id=$1", [expired.result.jobId])).rows[0].n, 0);
  const stored = (await db.query<{ result_json: string }>("SELECT result_json FROM jobs WHERE id=$1", [expired.result.jobId])).rows[0];
  assert.equal(JSON.parse(stored.result_json).manualExportVersion, undefined, "expired work is not migrated or revived");
});
