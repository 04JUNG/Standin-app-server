import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { defaultPreferences, normalizePreferences } from "./model.js";
import { parsePreferenceChange } from "./routes.js";
import {
  readPreferences,
  writePreferences,
  presentPreferences,
  type BodyDb,
} from "./store.js";

test("visibility is additive, bounded and separate from mode/card deletion", () => {
  const common = { expectedRevision: 2, mutationId: "picker-write-001" };
  const pickerVisibility = {
    hiddenPresetIds: ["male-base"],
    hiddenCardIds: ["card-a"],
  };
  assert.deepEqual(
    parsePreferenceChange({ ...common, pickerVisibility }).pickerVisibility,
    pickerVisibility,
  );
  for (const value of [
    null,
    {},
    { ...pickerVisibility, deleteCards: true },
    { ...pickerVisibility, hiddenPresetIds: ["x", "x"] },
    {
      ...pickerVisibility,
      hiddenCardIds: Array.from({ length: 49 }, (_, i) => "card-" + i),
    },
  ])
    assert.throws(() =>
      parsePreferenceChange({ ...common, pickerVisibility: value }),
    );
  assert.throws(() => parsePreferenceChange(common));
  const old = defaultPreferences();
  assert.deepEqual(normalizePreferences(old), old);
  assert.deepEqual(
    presentPreferences(old, {
      version: "test",
      defaultCharacterId: null,
      assets: [],
    }).pickerVisibility,
    { hiddenPresetIds: [], hiddenCardIds: [] },
  );
});

test("real SQL persists hidden lists per installation, keeps cards/last-used, rejects stale writes and replays safely", async () => {
  const sql = new PGlite();
  try {
    await sql.exec(`CREATE TABLE installations (id text PRIMARY KEY);
      CREATE TABLE body_preferences (installation_id text PRIMARY KEY, value jsonb NOT NULL);
      CREATE TABLE body_mutations (installation_id text, resource text, mutation_id text, job_id text, payload_hash text, response jsonb, created_at timestamptz);
      INSERT INTO installations VALUES ('owner'), ('other');`);
    const card = {
      cardId: "card-a",
      characterId: "male-base",
      name: "주인공 A",
      controls: { height: 178 },
      createdAt: "",
      updatedAt: "",
    };
    const initial = {
      ...defaultPreferences(),
      cards: [card],
      lastUsed: {
        characterId: "male-base",
        controls: { height: 178 },
        usedAt: "2026-11-07",
      },
    };
    await sql.query("INSERT INTO body_preferences VALUES ($1,$2)", [
      "owner",
      JSON.stringify(initial),
    ]);
    const db = {
      query: (query: string, values?: unknown[]) => sql.query(query, values),
    } as unknown as BodyDb;
    const change = parsePreferenceChange({
      expectedRevision: 0,
      mutationId: "picker-write-001",
      pickerVisibility: {
        hiddenPresetIds: ["male-base"],
        hiddenCardIds: ["card-a"],
      },
    });
    const saved = await writePreferences(db, "owner", change);
    assert.equal(saved.revision, 1);
    assert.equal(saved.mode, initial.mode);
    assert.deepEqual(saved.cards, initial.cards);
    assert.deepEqual(saved.lastUsed, initial.lastUsed);
    assert.deepEqual(
      (await readPreferences(db, "owner")).pickerVisibility,
      change.pickerVisibility,
    );
    assert.equal(
      (await readPreferences(db, "other")).pickerVisibility,
      undefined,
    );
    assert.deepEqual(await writePreferences(db, "owner", change), saved);
    await assert.rejects(
      writePreferences(db, "owner", {
        ...change,
        mutationId: "picker-write-002",
      }),
      { code: "BODY_PREFERENCE_CONFLICT" },
    );
    await assert.rejects(
      writePreferences(db, "owner", {
        ...change,
        pickerVisibility: { hiddenPresetIds: [], hiddenCardIds: [] },
      }),
      { code: "IDEMPOTENCY_CONFLICT" },
    );
    const mode = await writePreferences(db, "owner", {
      mode: "auto",
      expectedRevision: 1,
      mutationId: "old-mode-write",
    });
    assert.deepEqual(mode.pickerVisibility, saved.pickerVisibility);
    assert.deepEqual(mode.cards, initial.cards);
    await assert.rejects(writePreferences(db, "missing", change), {
      code: "NOT_FOUND",
    });
    const restored = await writePreferences(db, "owner", {
      expectedRevision: 2,
      mutationId: "picker-restore",
      pickerVisibility: { hiddenPresetIds: [], hiddenCardIds: [] },
    });
    assert.deepEqual(restored.cards, initial.cards);
    assert.deepEqual(restored.pickerVisibility, {
      hiddenPresetIds: [],
      hiddenCardIds: [],
    });
  } finally {
    await sql.close();
  }
});
