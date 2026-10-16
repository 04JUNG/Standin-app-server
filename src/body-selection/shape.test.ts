import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../config.js";
import { parseCatalog } from "./catalog.js";
import { catalog, result } from "./fixtures.js";
import {
  defaultPreferences,
  snapshot,
  resolveBody,
  type BodyCatalog,
  type BodySelection,
} from "./model.js";
import { parseCardChange, parsePreferenceChange, parseSelectionChange } from "./routes.js";
import {
  bodyShape,
  normalizeControls,
  shapeDefault,
  shapeEditable,
  shapeRenderable,
  ShapeInputError,
  type ShapeSpec,
} from "./shape.js";
import {
  BodyError,
  bodyOptions,
  cardsOf,
  CARD_NAME_MAX,
  MIGRATED_CARD_ID,
  presentPreferences,
  writeCards,
  writePreferences,
  writeSelection,
  type BodyDb,
} from "./store.js";

const spec = (): ShapeSpec => ({
  schemaVersion: "body-shape.v1",
  controls: [
    { key: "height", min: 160, max: 195, step: 1, default: 178 },
    { key: "physique", min: -1, max: 1.7, step: 0.05, default: 0 },
  ],
});
function shaped(): BodyCatalog {
  const c = catalog();
  c.assets[1] = { ...c.assets[1], shape: spec() };
  return c;
}
function withFlag<T>(on: boolean, run: () => T): T {
  const previous = config.bodyShapeEditEnabled;
  Object.assign(config, { bodyShapeEditEnabled: on });
  try {
    return run();
  } finally {
    Object.assign(config, { bodyShapeEditEnabled: previous });
  }
}
async function withFlagAsync<T>(on: boolean, run: () => Promise<T>): Promise<T> {
  const previous = config.bodyShapeEditEnabled;
  Object.assign(config, { bodyShapeEditEnabled: on });
  try {
    return await run();
  } finally {
    Object.assign(config, { bodyShapeEditEnabled: previous });
  }
}

test("catalog accepts declared shape specs and rejects malformed ones", () => {
  assert.equal(parseCatalog(shaped()).assets[1].shape?.controls.length, 2);
  for (const bad of [
    { ...spec(), schemaVersion: "body-shape.v0" },
    { ...spec(), controls: [] },
    { ...spec(), controls: [{ key: "Height", min: 0, max: 1, step: 1, default: 0 }] },
    { ...spec(), controls: [{ key: "h", min: 1, max: 1, step: 1, default: 1 }] },
    { ...spec(), controls: [{ key: "h", min: 0, max: 1, step: 0, default: 0 }] },
    { ...spec(), controls: [{ key: "h", min: 0, max: 1, step: 1, default: 2 }] },
    { ...spec(), controls: [spec().controls[0], spec().controls[0]] },
  ]) {
    const c = catalog();
    c.assets[1] = { ...c.assets[1], shape: bad as ShapeSpec };
    assert.throws(() => parseCatalog(c), /invalid shape spec/);
  }
});

test("controls are normalized to the declared grid; unknown, off-range and off-step values fail", () => {
  assert.deepEqual(normalizeControls(spec(), { height: 182 }), {
    height: 182,
    physique: 0,
  });
  assert.deepEqual(normalizeControls(spec(), { physique: 0.30000000001 }), {
    height: 178,
    physique: 0.3,
  });
  for (const bad of [
    { weight: 1 },
    { height: 200 },
    { height: 180.5 },
    { physique: "1" },
    { physique: Number.NaN },
    [],
    null,
  ])
    assert.throws(() => normalizeControls(spec(), bad), ShapeInputError);
});

test("shapes are offered only behind the flag and only for declaring assets", () => {
  const c = shaped();
  withFlag(false, () => {
    assert.deepEqual(shapeEditable(c), []);
    assert.throws(() => bodyShape(c.assets[1], { height: 182 }), /SHAPE_UNSUPPORTED/);
  });
  withFlag(true, () => {
    assert.deepEqual(
      shapeEditable(c).map((e) => e.characterId),
      ["character-1"],
    );
    assert.throws(() => bodyShape(c.assets[0], { height: 182 }), /SHAPE_UNSUPPORTED/);
    const a = bodyShape(c.assets[1], { height: 182 })!;
    const b = bodyShape(c.assets[1], { height: 182, physique: 0 })!;
    assert.equal(a.shapeSha256, b.shapeSha256);
    assert.notEqual(a.shapeSha256, bodyShape(c.assets[1], { height: 183 })!.shapeSha256);
    // Default values are the plain asset, not a forked cache key.
    assert.equal(bodyShape(c.assets[1], {}), null);
  });
});

test("shaped selections are never rendered as the plain asset", () => {
  assert.equal(shapeRenderable({ shape: null }), true);
  assert.equal(shapeRenderable({}), true);
  const c = shaped();
  withFlag(true, () => {
    const shape = bodyShape(c.assets[1], { height: 190 });
    assert.equal(shapeRenderable({ shape }), false);
    const policy = snapshot(defaultPreferences(), c);
    const rec = { status: "unavailable" as const, body: null, reasonCodes: [] };
    const manual = resolveBody(0, policy, rec, c, ["pose-a"], "manual", c.assets[1], 1, shape);
    assert.equal(manual.shape?.controls.height, 190);
    // Shapes belong to manual choices only.
    assert.equal(resolveBody(0, policy, rec, c, ["pose-a"], "auto", null, 1, shape).shape, null);
  });
});

test("routes accept shape envelopes only where they make sense", () => {
  const base = { expectedRevision: 0, mutationId: "mutation-1" };
  assert.deepEqual(
    parseSelectionChange({
      ...base,
      intent: "manual",
      characterId: "character-1",
      shape: { controls: { height: 182 } },
    }).shape,
    { controls: { height: 182 } },
  );
  for (const bad of [
    { intent: "auto", shape: { controls: {} } },
    { intent: "manual", characterId: "x", shape: null },
    { intent: "manual", characterId: "x", shape: { controls: [] } },
    { intent: "manual", characterId: "x", shape: { controls: {}, extra: 1 } },
  ])
    assert.throws(() => parseSelectionChange({ ...base, ...bad }), BodyError);
  assert.equal(
    parsePreferenceChange({
      ...base,
      mode: "auto",
      defaultCharacterId: null,
      shapeDefault: null,
    }).shapeDefault,
    null,
  );
  assert.throws(
    () =>
      parsePreferenceChange({
        ...base,
        mode: "auto",
        defaultCharacterId: null,
        shapeDefault: [1],
      }),
    BodyError,
  );
});

test("my-default shapes are validated against the catalog", () => {
  const c = shaped();
  withFlag(true, () => {
    assert.deepEqual(shapeDefault(c, { characterId: "character-1", controls: { height: 170 } }), {
      characterId: "character-1",
      controls: { height: 170, physique: 0 },
    });
    assert.equal(shapeDefault(c, null), null);
    assert.throws(() => shapeDefault(c, { characterId: "character-0", controls: {} }), /SHAPE_UNSUPPORTED/);
    assert.throws(() => shapeDefault(c, { characterId: "character-1" }), /INVALID_SHAPE/);
    assert.throws(() => shapeDefault(c, { characterId: "character-1", controls: {}, x: 1 }), /INVALID_SHAPE/);
  });
  assert.deepEqual(presentPreferences(defaultPreferences(), c).shapeEditable, []);
  assert.equal(presentPreferences(defaultPreferences(), c).shapeDefault, null);
});

test("settings get the name and live-preview runtime of each editable body", () => {
  const c = shaped();
  c.assets[1] = {
    ...c.assets[1],
    displayName: "벌크형",
    shapeRuntime: {
      path: "/srv/body/shape-runtime-0.6.10.ssr",
      sha256: "a".repeat(64),
      bytes: 64,
      format: "standin-shape-runtime.v1",
      rules: "standin-body-0.6.10",
      preset: "BULK",
    },
  };
  withFlag(true, () => {
    const [entry] = presentPreferences(defaultPreferences(), c).shapeEditable!;
    assert.equal(entry!.characterId, "character-1");
    assert.equal(entry!.displayName, "벌크형");
    assert.equal(entry!.shapeRuntime?.rules, "standin-body-0.6.10");
    assert.equal(entry!.shapeRuntime?.preset, "BULK");
    // The server path never leaves the BFF.
    assert.equal("path" in entry!.shapeRuntime!, false);
  });
});

/** In-memory stand-in for the few statements the body store issues. */
function memoryDb(selection: BodySelection) {
  const r = result();
  const rows = {
    selection: structuredClone(selection),
    preferences: null as unknown,
    mutations: [] as Array<{ resource: string; id: string; hash: string; response: string }>,
  };
  const db: BodyDb = {
    query: (async (sql: string, params: unknown[] = []) => {
      const empty = { rows: [], rowCount: 0 };
      if (sql.startsWith("SELECT status,result_json,body_policy_json"))
        return {
          rows: [
            {
              status: "completed",
              result_json: JSON.stringify(r),
              body_policy_json: snapshot(defaultPreferences(), shaped()),
            },
          ],
          rowCount: 1,
        };
      if (sql.startsWith("SELECT id FROM installations")) return { rows: [{ id: "owner" }], rowCount: 1 };
      if (sql.startsWith("SELECT payload_hash,response")) {
        const hit = rows.mutations.find((m) => m.resource === params[1] && m.id === params[2]);
        return hit
          ? { rows: [{ payload_hash: hit.hash, response: JSON.parse(hit.response) }], rowCount: 1 }
          : empty;
      }
      if (sql.startsWith("SELECT value FROM body_selections"))
        return { rows: [{ value: rows.selection }], rowCount: 1 };
      if (sql.startsWith("SELECT value FROM body_preferences"))
        return rows.preferences ? { rows: [{ value: rows.preferences }], rowCount: 1 } : empty;
      if (sql.startsWith("UPDATE body_selections")) {
        rows.selection = JSON.parse(params[2] as string);
        return empty;
      }
      if (sql.includes("INSERT INTO body_preferences")) {
        rows.preferences = JSON.parse(params[1] as string);
        return empty;
      }
      if (sql.includes("INSERT INTO body_mutations")) {
        rows.mutations.push({
          resource: params[1] as string,
          id: params[2] as string,
          hash: params[4] as string,
          response: params[5] as string,
        });
        return empty;
      }
      if (sql.includes("DELETE FROM body_mutations")) return empty;
      throw new Error("unexpected sql: " + sql);
    }) as BodyDb["query"],
  };
  return { db, rows };
}
const deps = { catalog: shaped, check: async () => "ok" as const };

test("manual shape writes are stored, replayed and rejected when unsupported", async () => {
  const c = shaped();
  const initial = resolveBody(
    0,
    snapshot(defaultPreferences(), c),
    { status: "unavailable", body: null, reasonCodes: [] },
    c,
    ["pose-a"],
  );
  await withFlagAsync(true, async () => {
    const { db, rows } = memoryDb(initial);
    const change = {
      intent: "manual" as const,
      characterId: "character-1",
      shape: { controls: { height: 186 } },
      expectedRevision: 0,
      mutationId: "mutation-shape-1",
    };
    const saved = await writeSelection(db, "owner", "job_test", 0, change, deps);
    assert.equal(saved.shape?.controls.height, 186);
    assert.equal(rows.selection.shape?.shapeSha256, saved.shape?.shapeSha256);
    assert.equal(saved.selectionRevision, 1);
    // Same mutation id + same payload replays; a different payload conflicts.
    assert.equal(
      (await writeSelection(db, "owner", "job_test", 0, change, deps)).selectionRevision,
      1,
    );
    await assert.rejects(
      writeSelection(db, "owner", "job_test", 0, { ...change, shape: { controls: { height: 187 } } }, deps),
      /IDEMPOTENCY_CONFLICT/,
    );
    await assert.rejects(
      writeSelection(
        db,
        "owner",
        "job_test",
        0,
        { ...change, characterId: "character-0", expectedRevision: 1, mutationId: "mutation-shape-2" },
        deps,
      ),
      /SHAPE_UNSUPPORTED/,
    );
    await assert.rejects(
      writeSelection(
        db,
        "owner",
        "job_test",
        0,
        { ...change, shape: { controls: { height: 999 } }, expectedRevision: 1, mutationId: "mutation-shape-3" },
        deps,
      ),
      /INVALID_SHAPE/,
    );
    // Picking the preset again clears the shape.
    const plain = await writeSelection(
      db,
      "owner",
      "job_test",
      0,
      { intent: "manual", characterId: "character-1", expectedRevision: 1, mutationId: "mutation-shape-4" },
      deps,
    );
    assert.equal(plain.shape, null);
  });
  await withFlagAsync(false, async () => {
    const { db } = memoryDb(initial);
    await assert.rejects(
      writeSelection(
        db,
        "owner",
        "job_test",
        0,
        {
          intent: "manual",
          characterId: "character-1",
          shape: { controls: { height: 186 } },
          expectedRevision: 0,
          mutationId: "mutation-shape-5",
        },
        deps,
      ),
      /SHAPE_UNSUPPORTED/,
    );
  });
});

test("options advertise shape specs; preferences keep my-default shape across writes", async () => {
  const c = shaped();
  const initial = resolveBody(
    0,
    snapshot(defaultPreferences(), c),
    { status: "unavailable", body: null, reasonCodes: [] },
    c,
    ["pose-a"],
  );
  await withFlagAsync(true, async () => {
    const { db } = memoryDb(initial);
    const options = await bodyOptions(db, "owner", "job_test", 0, deps);
    assert.deepEqual(
      options.characters.map((o) => ("shape" in o ? o.characterId : null)).filter(Boolean),
      ["character-1"],
    );
    const first = await writePreferences(
      db,
      "owner",
      {
        mode: "auto",
        defaultCharacterId: null,
        shapeDefault: { characterId: "character-1", controls: { height: 170 } },
        expectedRevision: 0,
        mutationId: "pref-shape-1",
      },
      deps,
    );
    assert.equal(first.shapeDefault?.controls.height, 170);
    // Old clients omit the key: the saved shape survives.
    const second = await writePreferences(
      db,
      "owner",
      { mode: "auto", defaultCharacterId: "character-2", expectedRevision: 1, mutationId: "pref-shape-2" },
      deps,
    );
    assert.equal(second.shapeDefault?.controls.height, 170);
    const cleared = await writePreferences(
      db,
      "owner",
      { mode: "auto", defaultCharacterId: null, shapeDefault: null, expectedRevision: 2, mutationId: "pref-shape-3" },
      deps,
    );
    assert.equal(cleared.shapeDefault, null);
  });
  await withFlagAsync(false, async () => {
    const { db } = memoryDb(initial);
    const options = await bodyOptions(db, "owner", "job_test", 0, deps);
    assert.equal(options.characters.some((o) => "shape" in o), false);
  });
});

test("options carry the live shape runtime only with shape editing on, without local paths", async () => {
  const withRuntime = () => {
    const c = shaped();
    c.assets[1] = {
      ...c.assets[1],
      shapeRuntime: {
        path: "/srv/body/shape-runtime-0.6.7.ssr",
        sha256: "a".repeat(64),
        bytes: 3412636,
        format: "standin-shape-runtime.v1",
        rules: "standin-body-0.6.7",
        preset: "IDEAL83",
      },
    };
    return c;
  };
  const c = withRuntime();
  const initial = resolveBody(
    0,
    snapshot(defaultPreferences(), c),
    { status: "unavailable", body: null, reasonCodes: [] },
    c,
    ["pose-a"],
  );
  const runtimeDeps = { catalog: withRuntime, check: async () => "ok" as const };
  await withFlagAsync(true, async () => {
    const { db } = memoryDb(initial);
    const options = await bodyOptions(db, "owner", "job_test", 0, runtimeDeps);
    const shaped1 = options.characters.find((o) => o.characterId === "character-1") as {
      shapeRuntime?: Record<string, unknown>;
    };
    assert.deepEqual(shaped1.shapeRuntime, {
      url: "/v1/models/character-1/shape-runtime/" + "a".repeat(64),
      sha256: "a".repeat(64),
      bytes: 3412636,
      format: "standin-shape-runtime.v1",
      rules: "standin-body-0.6.7",
      preset: "IDEAL83",
    });
  });
  await withFlagAsync(false, async () => {
    const { db } = memoryDb(initial);
    const options = await bodyOptions(db, "owner", "job_test", 0, runtimeDeps);
    assert.equal(options.characters.some((o) => "shapeRuntime" in o), false);
  });
});

test("shape specs may name controls and set how many are basic", () => {
  const c = shaped();
  c.assets[1] = {
    ...c.assets[1],
    shape: { ...spec(), basic: 2, controls: spec().controls.map((x) => ({ ...x, label: "키" })) },
  };
  assert.equal(parseCatalog(c).assets[1].shape?.basic, 2);
  for (const bad of [
    { basic: 0 },
    { basic: 3 }, // more than the declared controls
    { basic: 1.5 },
  ]) {
    const w = shaped();
    w.assets[1] = { ...w.assets[1], shape: { ...spec(), ...bad } };
    assert.throws(() => parseCatalog(w), /invalid shape spec/);
  }
  const long = shaped();
  long.assets[1] = {
    ...long.assets[1],
    shape: { ...spec(), controls: spec().controls.map((x) => ({ ...x, label: "가".repeat(25) })) },
  };
  assert.throws(() => parseCatalog(long), /invalid shape spec/);
});

test("body cards: create, rename, reshape and delete, each a new revision", async () => {
  const c = shaped();
  const initial = resolveBody(
    0,
    snapshot(defaultPreferences(), c),
    { status: "unavailable", body: null, reasonCodes: [] },
    c,
    ["pose-a"],
  );
  await withFlagAsync(true, async () => {
    const { db, rows } = memoryDb(initial);
    const m = (n: number) => ({ expectedRevision: n, mutationId: `card-mutation-${n}` });
    const created = await writeCards(
      db,
      "owner",
      { ...m(0), op: "create", name: "  주인공 A ", characterId: "character-1", controls: { height: 186 } },
      deps,
    );
    assert.equal(created.revision, 1);
    const [card] = created.cards!;
    assert.equal(card!.name, "주인공 A");
    assert.deepEqual(card!.controls, { height: 186, physique: 0 });
    assert.match(card!.cardId, /^card_/);
    // Replays return the stored answer instead of adding a second card.
    const again = await writeCards(
      db,
      "owner",
      { ...m(0), op: "create", name: "  주인공 A ", characterId: "character-1", controls: { height: 186 } },
      deps,
    );
    assert.equal(again.cards!.length, 1);

    const renamed = await writeCards(db, "owner", { ...m(1), op: "update", cardId: card!.cardId, name: "주인공 B" }, deps);
    assert.equal(renamed.cards![0]!.name, "주인공 B");
    assert.deepEqual(renamed.cards![0]!.controls, card!.controls);
    const reshaped = await writeCards(
      db,
      "owner",
      { ...m(2), op: "update", cardId: card!.cardId, controls: { physique: 0.5 } },
      deps,
    );
    assert.deepEqual(reshaped.cards![0]!.controls, { height: 178, physique: 0.5 });
    assert.equal(reshaped.cards![0]!.name, "주인공 B");

    for (const [change, code] of [
      [{ ...m(3), op: "update", cardId: card!.cardId, name: " " }, /INVALID_CARD_NAME/],
      [{ ...m(3), op: "update", cardId: card!.cardId, name: "가".repeat(CARD_NAME_MAX + 1) }, /INVALID_CARD_NAME/],
      [{ ...m(3), op: "update", cardId: "card_missing", name: "x" }, /CARD_NOT_FOUND/],
      // Presets (no shape) are not cards.
      [{ ...m(3), op: "create", name: "x", characterId: "character-0", controls: {} }, /SHAPE_UNSUPPORTED/],
      [{ ...m(3), op: "create", name: "x", characterId: "character-1", controls: { height: 999 } }, /INVALID_SHAPE/],
      [{ expectedRevision: 2, mutationId: "card-stale-1", op: "delete", cardId: card!.cardId }, /BODY_PREFERENCE_CONFLICT/],
    ] as const)
      await assert.rejects(writeCards(db, "owner", change as never, deps), code);

    const deleted = await writeCards(db, "owner", { ...m(3), op: "delete", cardId: card!.cardId }, deps);
    assert.deepEqual(deleted.cards, []);
    assert.equal((rows.preferences as { revision: number }).revision, 4);
  });
});

test("an older 내 기본값 shows up as a card and deleting it clears the old value", async () => {
  const c = shaped();
  const legacy = {
    ...defaultPreferences(),
    mode: "auto" as const,
    shapeDefault: { characterId: "character-1", controls: { height: 170, physique: 0 } },
    revision: 3,
  };
  assert.deepEqual(cardsOf(defaultPreferences()), []);
  assert.equal(cardsOf(legacy)[0]!.cardId, MIGRATED_CARD_ID);
  assert.equal(cardsOf(legacy)[0]!.controls.height, 170);
  const initial = resolveBody(0, snapshot(legacy, c), { status: "unavailable", body: null, reasonCodes: [] }, c, ["pose-a"]);
  await withFlagAsync(true, async () => {
    const { db, rows } = memoryDb(initial);
    rows.preferences = legacy;
    const renamed = await writeCards(
      db,
      "owner",
      { expectedRevision: 3, mutationId: "legacy-card-1", op: "update", cardId: MIGRATED_CARD_ID, name: "주인공" },
      deps,
    );
    assert.deepEqual(renamed.cards!.map((x) => x.name), ["주인공"]);
    const gone = await writeCards(
      db,
      "owner",
      { expectedRevision: 4, mutationId: "legacy-card-2", op: "delete", cardId: MIGRATED_CARD_ID },
      deps,
    );
    assert.deepEqual(gone.cards, []);
    assert.equal(gone.shapeDefault, null);
    assert.deepEqual(cardsOf(gone), []);
  });
});

test("a hand-picked body becomes the next job's starting body without a revision bump", async () => {
  const c = shaped();
  const rec = { status: "available" as const, body: snapshot(defaultPreferences(), c).catalogDefault, reasonCodes: [] };
  const initial = resolveBody(0, snapshot(defaultPreferences(), c), rec, c, ["pose-a"]);
  await withFlagAsync(true, async () => {
    const { db, rows } = memoryDb(initial);
    rows.preferences = { ...defaultPreferences(), revision: 7 };
    const at = new Date("2026-10-16T00:00:00Z");
    await writeSelection(
      db,
      "owner",
      "job_test",
      0,
      {
        intent: "manual",
        characterId: "character-1",
        shape: { controls: { height: 190 } },
        expectedRevision: 0,
        mutationId: "last-used-1",
      },
      deps,
      () => at,
    );
    const prefs = rows.preferences as ReturnType<typeof defaultPreferences>;
    assert.equal(prefs.revision, 7);
    assert.deepEqual(prefs.lastUsed, {
      characterId: "character-1",
      controls: { height: 190, physique: 0 },
      usedAt: at.toISOString(),
    });

    // Next job: starts with that body and its controls.
    const next = resolveBody(1, snapshot(prefs, c), rec, c, ["pose-a"]);
    assert.equal(next.resolvedSource, "last_used");
    assert.equal(next.resolvedBody?.characterId, "character-1");
    assert.equal(next.shape?.controls.height, 190);
    assert.equal(next.intent, "inherit");
    // Auto mode keeps the recommendation.
    assert.equal(resolveBody(1, snapshot({ ...prefs, mode: "auto" }, c), rec, c, ["pose-a"]).resolvedSource, "auto_recommendation");
    // A body these poses cannot use is skipped (here nothing else fits either).
    assert.equal(resolveBody(1, snapshot(prefs, c), rec, c, ["pose-z"]).resolvedSource, null);
    // Controls the catalog no longer accepts are dropped, never rendered as the plain asset.
    const stale = { ...prefs, lastUsed: { ...prefs.lastUsed!, controls: { weight: 1 } } };
    assert.equal(snapshot(stale, c).lastUsed, null);
  });
  // Shape editing off: a shaped last-used body is not offered.
  const prefs = { ...defaultPreferences(), lastUsed: { characterId: "character-1", controls: { height: 190 }, usedAt: "x" } };
  assert.equal(snapshot(prefs, c).lastUsed, null);
  const plain = { ...prefs, lastUsed: { ...prefs.lastUsed, characterId: "character-2", controls: null } };
  assert.equal(resolveBody(0, snapshot(plain, c), rec, c, ["pose-a"]).resolvedSource, "last_used");
});

test("card routes accept only their envelopes", () => {
  const base = { expectedRevision: 0, mutationId: "mutation-1" };
  assert.equal(
    parseCardChange("create", { ...base, name: "A", characterId: "character-1", controls: {} }).op,
    "create",
  );
  assert.deepEqual(parseCardChange("update", { ...base, name: "B" }, "card_1"), {
    ...base,
    op: "update",
    cardId: "card_1",
    name: "B",
  });
  assert.equal(parseCardChange("delete", base, "my-default").op, "delete");
  for (const [op, raw, id] of [
    ["create", { ...base, name: "A", characterId: "character-1" }, undefined],
    ["create", { ...base, name: "A", characterId: "character-1", controls: [] }, undefined],
    ["create", { ...base, name: 1, characterId: "character-1", controls: {} }, undefined],
    ["update", { ...base }, "card_1"],
    ["update", { ...base, name: "B", extra: 1 }, "card_1"],
    ["update", { ...base, name: "B" }, "../x"],
    ["delete", { ...base, name: "B" }, "card_1"],
    ["delete", { ...base }, undefined],
  ] as const)
    assert.throws(() => parseCardChange(op, raw, id), BodyError);
  assert.equal(parsePreferenceChange({ ...base, mode: "last_used", defaultCharacterId: null }).mode, "last_used");
});
