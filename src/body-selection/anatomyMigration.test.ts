import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { SCHEMA } from "../db.js";
import { catalog, result } from "./fixtures.js";
import { bodyRef, currentLastUsed, currentPresetAssets, defaultPreferences, resolveBody, snapshot } from "./model.js";
import { readSelection, writeSelection, bodyOptions, presentPreferences, type BodyDb } from "./store.js";

const rec = { status: "disabled" as const, body: null, reasonCodes: [] };
test("all 18 preset templates upgrade only after their matching new preset exists", () => {
  for (const [gender, oldVersion, newVersion, names] of [
    ["male", "0-7-6", "0-8-0", ["ideal83", "ideal70", "toon64", "muscular", "muscle-max", "bulk", "soft", "fat-max"]],
    ["female", "0-3-9", "0-4-0", ["slim", "ideal83", "ideal70", "toon64", "muscular", "muscle-max", "soft", "fat-max", "new-fat", "new-muscular"]],
  ] as const) for (const name of names) {
    const c = catalog(2), oldId = `${gender}-${name}-v${oldVersion}`, newId = `${gender}-${name}-v${newVersion}`;
    Object.assign(c.assets[0], { characterId: oldId, role: "preset", gender });
    Object.assign(c.assets[1], { characterId: newId, role: "preset", gender });
    const remembered = { body: bodyRef(c.assets[0]), shape: null };
    assert.equal(currentLastUsed(remembered, c)?.body.characterId, newId);
    const preferences = { ...defaultPreferences(), pickerVisibility: { hiddenPresetIds: [oldId, newId], hiddenCardIds: ["saved-card"] } };
    assert.deepEqual(presentPreferences(preferences, c).pickerVisibility, { hiddenPresetIds: [newId], hiddenCardIds: ["saved-card"] });
    assert.deepEqual(preferences.pickerVisibility.hiddenPresetIds, [oldId, newId]);
    assert.deepEqual(currentPresetAssets(c).map(a => a.characterId), [newId]);
    assert.deepEqual(currentPresetAssets(c, [oldId]).map(a => a.characterId), [oldId, newId]);
    assert.equal(currentLastUsed(remembered, { ...c, assets: [c.assets[0]] }), remembered);
    const edited = { ...remembered, shape: { controls: { muscle: 1 } } } as never;
    assert.equal(currentLastUsed(edited, c), edited);
    assert.equal(resolveBody(0, { preferences: defaultPreferences(), lastUsed: remembered }, rec, c, ["pose-a"], "manual", remembered.body).resolvedBody?.characterId, oldId);
  }
});
function release(gender: "male" | "female" = "male") {
  const c = catalog(2);
  c.assets[0].characterId = gender === "male" ? "male-base-v0-7-2" : "female-base-v0-3-4";
  Object.assign(c.assets[1], {
    characterId: gender === "male" ? "male-base-v0-8-0" : "female-base-v0-4-0",
    role: "default", gender,
  });
  c.defaultCharacterId = c.assets[1].characterId;
  const preferences = { ...defaultPreferences(), lastUsed: { characterId: c.assets[0].characterId, controls: null, usedAt: "then" } };
  const policy = { preferences, lastUsed: { body: bodyRef(c.assets[0]), shape: null } };
  return { c, preferences, policy };
}

test("approved male and female bases replace only plain inherited last-used selections", () => {
  for (const gender of ["male", "female"] as const) {
    const { c, preferences, policy } = release(gender);
    const expected = c.assets[1].characterId;
    assert.equal(snapshot(preferences, c).lastUsed?.body.characterId, expected);
    assert.equal(resolveBody(0, policy, rec, c, ["pose-a"]).resolvedBody?.characterId, expected);
    assert.equal(presentPreferences(preferences, c).lastUsed?.characterId, expected);
    assert.equal(preferences.lastUsed.characterId, c.assets[0].characterId);
    assert.deepEqual(resolveBody(0, policy, rec, c, ["pose-a"], "manual", policy.lastUsed.body).resolvedBody, policy.lastUsed.body);
    const shaped = { ...policy.lastUsed, shape: { schemaVersion: "body-shape.v1", rules: "legacy", controls: { height: 180 } } };
    assert.equal(currentLastUsed(shaped as never, c), shaped);
    const customized = { ...preferences, lastUsed: { ...preferences.lastUsed, controls: { height: 180 } } };
    assert.deepEqual(presentPreferences(customized, c).lastUsed, customized.lastUsed);
    c.assets[1].role = "preset";
    assert.deepEqual(currentLastUsed(policy.lastUsed, c), policy.lastUsed);
  }
});

test("reopening the reported old-base path persists one revision and rejects stale export selections", async t => {
  const pg = new PGlite(); t.after(() => pg.close()); await pg.exec(SCHEMA);
  const db = pg as unknown as BodyDb;
  const { c, policy } = release();
  const analysis = result(), now = new Date().toISOString();
  await pg.query(`INSERT INTO installations
    (id,token_hash,consent_version,consented_at,created_at,last_seen_at,app_version,os_name,os_version,architecture,locale)
    VALUES ('owner','hash','test',$1,$1,$1,'test','test','test','test','ko')`, [now]);
  await pg.query("INSERT INTO jobs(id,status,created_at,updated_at,installation_id,result_json,body_policy_json) VALUES ($1,'completed',$2,$2,'owner',$3,$4)",
    [analysis.jobId, now, JSON.stringify(analysis), JSON.stringify(policy)]);
  const oldCatalog = { ...c, assets: [c.assets[0]] };
  const old = resolveBody(0, policy, rec, oldCatalog, ["pose-a"], "inherit", null, 7);
  await pg.query("INSERT INTO body_selections(job_id,person_index,value) VALUES ($1,0,$2)", [analysis.jobId, JSON.stringify(old)]);
  const migrated = await readSelection(db, "owner", analysis.jobId, 0, c);
  assert.equal(migrated.resolvedBody?.characterId, "male-base-v0-8-0");
  assert.equal(migrated.selectionRevision, 8);
  assert.equal((await readSelection(db, "owner", analysis.jobId, 0, c)).selectionRevision, 8);
  assert.equal((await pg.query<{ value: typeof old }>("SELECT value FROM body_selections")).rows[0].value.selectionRevision, 8);
  const deps = { catalog: () => c, check: async () => "ok" as const };
  assert.deepEqual((await bodyOptions(db, "owner", analysis.jobId, 0, deps)).characters.map(a => a.characterId), ["male-base-v0-8-0"]);
  await assert.rejects(writeSelection(db, "owner", analysis.jobId, 0, { intent: "inherit", expectedRevision: 7, mutationId: "stale" }, deps), /BODY_SELECTION_CONFLICT/);
  await assert.rejects(readSelection(db, "foreign", analysis.jobId, 0, c), /NOT_FOUND/);
  // An explicit historic choice survives later reads.
  await writeSelection(db, "owner", analysis.jobId, 0, { intent: "manual", characterId: c.assets[0].characterId, expectedRevision: 8, mutationId: "manual" }, deps);
  assert.equal((await readSelection(db, "owner", analysis.jobId, 0, c)).resolvedBody?.characterId, c.assets[0].characterId);
  assert.equal((await bodyOptions(db, "owner", analysis.jobId, 0, deps)).characters.length, 2);
});
