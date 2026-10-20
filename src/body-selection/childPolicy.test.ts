import test from "node:test";
import assert from "node:assert/strict";
import { catalog, fixture, result } from "./fixtures.js";
import { bodyRef, defaultPreferences, resolveBody, snapshot } from "./model.js";
import { mapBodyRecommendations } from "./recommendation.js";
import { automaticRecommendation, CHILD_SELECTION_REASON } from "./childPolicy.js";
import { readSelection, type BodyDb } from "./store.js";

function scene() {
  const c = catalog();
  c.assets[1].bodyId = "child";
  c.assets[1].characterId = "body-child";
  const child = bodyRef(c.assets[1]);
  const rec = { status: "available" as const, body: child, reasonCodes: [] };
  return { c, child, rec };
}

test("a valid old inference sidecar cannot automatically recommend a child", () => {
  const { c, child } = scene();
  const cut = fixture();
  for (const row of (cut.body_matching as { people: Record<string, unknown>[] }).people) {
    row.auto_body_id = row.applied_body_id = child.bodyId;
    (row.selected_asset as { body_id: string }).body_id = child.bodyId;
  }
  const rec = mapBodyRecommendations(cut, c).get(0)!;
  assert.equal(rec.status, "unavailable");
  assert.equal(rec.body, null);
  assert.ok(rec.reasonCodes.includes(CHILD_SELECTION_REASON));
});

test("untrusted/cached child recommendation uses existing adult default and explicit auto stays unavailable", () => {
  const { c, rec } = scene();
  const policy = snapshot(defaultPreferences(), c);
  const state = resolveBody(0, policy, rec, c, ["pose-a"]);
  assert.equal(state.resolvedBody?.characterId, c.defaultCharacterId);
  assert.equal(state.resolvedSource, "catalog_default_fallback");
  assert.equal(state.recommendation.body, null);
  assert.equal(resolveBody(0, policy, rec, c, ["pose-a"], "auto").resolvedBody, null);
  c.defaultCharacterId = "body-child";
  assert.equal(resolveBody(0, snapshot(defaultPreferences(), c), rec, c, ["pose-a"]).resolvedBody, null);
});

test("explicit manual, fixed default, saved user default and last-used child choices remain usable", () => {
  const { c, child, rec } = scene();
  const pref = defaultPreferences();
  let policy = snapshot(pref, c);
  assert.equal(resolveBody(0, policy, rec, c, ["pose-a"], "manual", child).resolvedSource, "manual");
  pref.mode = "fixed_default";
  pref.defaultCharacterId = "body-child";
  policy = snapshot(pref, c);
  assert.equal(resolveBody(0, policy, rec, c, ["pose-a"]).resolvedSource, "fixed_default");
  pref.mode = "auto";
  policy = snapshot(pref, c);
  assert.equal(resolveBody(0, policy, rec, c, ["pose-a"]).resolvedSource, "user_default_fallback");
  pref.mode = "last_used";
  pref.lastUsed = { characterId: "body-child", controls: null, usedAt: "2026-10-20" };
  policy = snapshot(pref, c);
  const used = resolveBody(0, policy, rec, c, ["pose-a"]);
  assert.equal(used.resolvedSource, "last_used");
  assert.equal(used.resolvedBody?.characterId, "body-child");
  assert.equal(used.resolutionStatus, "ready");
});

test("ordinary and compact adult recommendation objects pass through unchanged", () => {
  const { c } = scene();
  for (const id of ["adult-base", "adult-toon64"]) {
    const rec = { status: "available" as const, body: { ...c.assets[0], bodyId: id }, reasonCodes: [] };
    assert.equal(automaticRecommendation(rec, c), rec);
  }
});

for (const source of ["auto_recommendation", "catalog_default_fallback", "manual", "last_used", "fixed_default", "user_default_fallback"] as const) {
  test(`history revalidation protects ${source} provenance without writes`, async () => {
    const { c, child, rec } = scene();
    const analysis = result();
    const state = resolveBody(0, snapshot(defaultPreferences(), c), rec, c, ["pose-a"], "manual", child, 7);
    state.resolvedSource = source;
    state.intent = source === "manual" ? "manual" : "inherit";
    state.recommendation = rec; // a pre-policy automatic record
    const stored = structuredClone(state);
    let writes = 0;
    const db = { query: async (sql: string) => {
      if (sql.includes("SELECT status,result_json,body_policy_json")) return { rows: [{ status: "completed", result_json: JSON.stringify(analysis), body_policy_json: snapshot(defaultPreferences(), c) }] };
      if (sql.startsWith("SELECT value FROM body_selections")) return { rows: [{ value: structuredClone(stored) }] };
      writes++; throw new Error("unexpected write");
    } } as unknown as BodyDb;
    const value = await readSelection(db, "owner", analysis.jobId, 0, c);
    const blocked = source === "auto_recommendation" || source === "catalog_default_fallback";
    assert.equal(value.resolvedBody?.characterId ?? null, blocked ? null : "body-child");
    assert.equal(value.resolutionStatus, blocked ? "needs_selection" : "ready");
    assert.equal(value.recommendation.body, null);
    assert.equal(value.selectionRevision, 7);
    assert.equal(writes, 0);
    assert.deepEqual(state, stored);
  });
}
