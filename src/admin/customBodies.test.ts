import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { PGlite } from "@electric-sql/pglite";
import type { AppEnv } from "../env.js";
import type { BodyAsset, BodyCatalog } from "../body-selection/model.js";
import {
  parseShapeRuntime,
  type AnyShapeRuntime,
} from "./bodyRuntime/format.js";
import { evaluateShape, resolveControls } from "./bodyRuntime/evaluate.js";
import {
  checkedRuntime,
  meshSvg,
  renderCustomBody,
} from "./customBodiesPreview.js";
import {
  CustomBodyError,
  customBody,
  parseCustomBodyQuery,
  savedCards,
  type CustomBodyRow,
} from "./customBodies.js";
import { CUSTOM_BODIES_SQL, CUSTOM_BODY_ROW_SQL } from "./customBodiesStore.js";
import { createCustomBodyRoutes } from "./customBodyRoutes.js";

const owner = "inst_11111111-1111-1111-1111-111111111111",
  other = "inst_22222222-2222-2222-2222-222222222222";
const card = {
  cardId: "my-character",
  name: "주인공 A",
  characterId: "male",
  controls: { height: 180 },
  createdAt: "2026-10-27T00:00:00Z",
  updatedAt: "2026-10-27T01:00:00Z",
};
const source = {
  rules: "standin-body-0.7.1",
  blendSha256: "a".repeat(64),
  controllerSha256: "b".repeat(64),
};
function asset(): BodyAsset {
  return {
    bodyId: "male",
    bodyVersion: "1",
    assetSha256: "c".repeat(64),
    rigVersion: "1",
    measurementVersion: "1",
    characterId: "male",
    displayName: "남성 기본형",
    supportedPoseIds: [],
    shape: {
      schemaVersion: "body-shape.v1",
      controls: [{ key: "height", min: 140, max: 210, step: 1, default: 178 }],
    },
    shapeSource: source,
    shapeRuntime: {
      path: "/approved/body.ssr",
      sha256: "d".repeat(64),
      bytes: 123,
      format: "standin-shape-runtime.v1",
      rules: source.rules,
      preset: "BASE",
    },
  };
}
function row(): CustomBodyRow {
  return {
    installation_id: owner,
    last_seen_at: "2026-10-27T01:00:00.000Z",
    app_version: "0.2.3",
    os_name: "macos",
    value: {
      version: "body-preferences.v1",
      scope: "installation",
      mode: "last_used",
      revision: 1,
      cards: [structuredClone(card)],
    },
  };
}
function catalog(): BodyCatalog {
  return { version: "current", defaultCharacterId: "male", assets: [asset()] };
}
function fixture(name: string) {
  return JSON.parse(
    readFileSync(
      new URL(
        `../../src/admin/bodyRuntime/fixtures/${name}.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  );
}
function fixtureBytes(value: { ssr?: string; ssrGzip?: string }) {
  return value.ssrGzip
    ? gunzipSync(Buffer.from(value.ssrGzip, "base64"))
    : Buffer.from(value.ssr!, "base64");
}

test("all reused SSR1 controller families reproduce Blender reference coordinates", () => {
  for (const name of [
    "mini-0.6.7",
    "mini-0.6.10",
    "mini-0.7.1",
    "mini-female-0.2.2",
    "mini-female-0.3.3",
  ]) {
    const f = fixture(name),
      runtime = parseShapeRuntime(Uint8Array.from(fixtureBytes(f)).buffer);
    for (const [caseName, item] of Object.entries(f.cases) as Array<
      [string, { controls: Record<string, number>; positions: number[] }]
    >) {
      const out = evaluateShape(
        runtime,
        resolveControls(runtime, undefined, item.controls),
      );
      const indices =
        f.check ?? Array.from({ length: out.length / 3 }, (_, i) => i);
      let error = 0;
      indices.forEach((v: number, j: number) => {
        for (let k = 0; k < 3; k++)
          error = Math.max(
            error,
            Math.abs(out[v * 3 + k] - item.positions[j * 3 + k]),
          );
      });
      assert.ok(error < 0.00005, `${name} ${caseName} worst error ${error}`);
    }
  }
});

test("saved controls produce a distinct real mesh SVG, views preserve all geometry and contain no raw user markup", () => {
  const runtime = parseShapeRuntime(
    Uint8Array.from(fixtureBytes(fixture("mini-0.7.1"))).buffer,
  );
  const normal = evaluateShape(
    runtime,
    resolveControls(runtime, "BASE", { height: 178 }),
    undefined,
    "BASE",
  );
  const changed = evaluateShape(
    runtime,
    resolveControls(runtime, "BASE", { height: 195, shoulders: 1 }),
    undefined,
    "BASE",
  );
  const front = meshSvg(normal, runtime.faces, "front"),
    custom = meshSvg(changed, runtime.faces, "front"),
    side = meshSvg(changed, runtime.faces, "side");
  assert.match(front, /<path d="M/);
  assert.notEqual(front, custom);
  assert.notEqual(custom, side);
  assert.doesNotMatch(custom, /<script|href=|foreignObject|approved|주인공/);
  assert.throws(
    () =>
      meshSvg(
        new Float32Array([NaN, 0, 0]),
        new Uint16Array([0, 0, 0]),
        "front",
      ),
    CustomBodyError,
  );
  assert.throws(
    () =>
      meshSvg(new Float32Array([0, 0, 0]), new Uint16Array([0, 1, 2]), "front"),
    CustomBodyError,
  );
});

test("SSR2 is parsed and computed with its exact sampled source/preset; changed hashes fail closed", () => {
  const f = fixture("mini-sampled"),
    bytes = fixtureBytes(f),
    runtime = parseShapeRuntime(Uint8Array.from(bytes).buffer);
  const a = asset();
  a.shapeRuntime = {
    ...a.shapeRuntime!,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    format: "standin-shape-runtime.v2",
    rules: runtime.header.rules,
    preset: "BASE",
  };
  a.shapeSource = { rules: runtime.header.rules, ...runtime.header.source! };
  assert.equal(checkedRuntime(a, bytes).kind, "sampled");
  const base = evaluateShape(
    runtime,
    resolveControls(runtime, "BASE", {}),
    undefined,
    "BASE",
  );
  const bulk = evaluateShape(
    runtime,
    resolveControls(runtime, "BULK", {}),
    undefined,
    "BULK",
  );
  assert.notDeepEqual(base, bulk);
  assert.throws(
    () =>
      checkedRuntime(
        { ...a, shapeRuntime: { ...a.shapeRuntime!, sha256: "f".repeat(64) } },
        bytes,
      ),
    CustomBodyError,
  );
  assert.throws(
    () =>
      checkedRuntime(
        {
          ...a,
          shapeSource: { ...a.shapeSource!, blendSha256: "e".repeat(64) },
        },
        bytes,
      ),
    CustomBodyError,
  );
});

test("query validation, legacy cards, changed revisions and unavailable current models are explicit", () => {
  assert.throws(() => parseCustomBodyQuery({ limit: "500" }), CustomBodyError);
  assert.throws(() => parseCustomBodyQuery({ cursor: "bad" }), CustomBodyError);
  assert.throws(
    () => parseCustomBodyQuery({ installationId: "../../secret" }),
    CustomBodyError,
  );
  const r = row(),
    a = customBody(r, card, catalog());
  assert.equal(a.previewStatus, "available");
  assert.equal(a.controls[0].label, "키");
  const modified = { ...card, controls: { height: 181 } };
  assert.notEqual(customBody(r, modified, catalog()).revision, a.revision);
  assert.equal(
    customBody(r, card, { ...catalog(), assets: [] }).previewReason,
    "MODEL_UNAVAILABLE",
  );
  assert.equal(
    customBody(r, { ...card, controls: { height: 999 } }, catalog())
      .previewReason,
    "CONTROLS_INCOMPATIBLE",
  );
  assert.equal(
    customBody(r, card, {
      ...catalog(),
      assets: [{ ...asset(), shapeRuntime: undefined }],
    }).previewReason,
    "RUNTIME_UNAVAILABLE",
  );
  const old = {
    ...r,
    value: {
      ...r.value,
      cards: undefined,
      shapeDefault: { characterId: "male", controls: { height: 170 } },
    },
  };
  assert.equal(savedCards(old)[0].cardId, "my-default");
  assert.deepEqual(
    savedCards({ ...r, value: { ...r.value, cards: {} as never } }),
    [],
  );
});

test("SQL limits listing and direct guesses to currently consenting non-revoked visible installations", async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE quality_review_installations(id text,last_seen_at text,app_version text,os_name text,quality_personal_data boolean,quality_content_license boolean,quality_consent_id text,revoked_at text,deletion_requested_at text);
 CREATE TABLE body_preferences(installation_id text,value jsonb);`);
    for (const [id, personal, revoked, deleted] of [
      [owner, true, null, null],
      [other, false, null, null],
      ["revoked", true, "now", null],
      ["deleted", true, null, "now"],
    ] as const) {
      await db.query(
        "INSERT INTO quality_review_installations VALUES($1,$2,$3,$4,$5,true,$6,$7,$8)",
        [
          id,
          row().last_seen_at,
          "0.2.3",
          "macos",
          personal,
          "consent",
          revoked,
          deleted,
        ],
      );
      await db.query("INSERT INTO body_preferences VALUES($1,$2)", [
        id,
        JSON.stringify(row().value),
      ]);
    }
    const rows = (
      await db.query<CustomBodyRow>(CUSTOM_BODIES_SQL, [null, null, null, 21])
    ).rows;
    assert.deepEqual(
      rows.map((r) => r.installation_id),
      [owner],
    );
    assert.equal((await db.query(CUSTOM_BODY_ROW_SQL, [other])).rows.length, 0);
    assert.equal(
      (await db.query(CUSTOM_BODY_ROW_SQL, ["revoked"])).rows.length,
      0,
    );
    assert.equal(
      (await db.query(CUSTOM_BODY_ROW_SQL, ["deleted"])).rows.length,
      0,
    );
  } finally {
    await db.close();
  }
});

function appFixture() {
  let stored: CustomBodyRow | undefined = row();
  const audits: string[] = [];
  let renderCalls = 0;
  const deps = {
    find: async (id: string) => (id === owner ? stored : undefined),
    list: async () => (stored ? [stored] : []),
    catalog,
    render: async () => {
      renderCalls++;
      return '<svg xmlns="http://www.w3.org/2000/svg"/>';
    },
  };
  const app = new Hono<AppEnv>();
  app.route(
    "/v1/admin/review/custom-bodies",
    createCustomBodyRoutes(async (_c, action) => {
      audits.push(action);
    }, deps),
  );
  return {
    app,
    deps,
    audits,
    clear: () => {
      stored = undefined;
    },
    change: () => {
      stored!.value.cards![0].controls.height = 181;
    },
    calls: () => renderCalls,
  };
}
test("read-only list/detail/preview have audit, no-store, safe metadata and reject foreign/stale cards", async () => {
  const { app, audits, calls } = appFixture(),
    base = "/v1/admin/review/custom-bodies";
  const list = await app.request(base);
  assert.equal(list.status, 200);
  assert.equal(list.headers.get("cache-control"), "private, no-store");
  const text = await list.text();
  assert.doesNotMatch(
    text,
    /approved|blendSha256|shapeRuntime|\.ssr|quality_consent/,
  );
  const detail = await app.request(`${base}/${owner}/${card.cardId}`),
    body = (await detail.json()) as {
      name: string;
      previewUrl: string;
      revision: string;
    };
  assert.equal(body.name, card.name);
  assert.ok(body.previewUrl);
  const preview = await app.request(body.previewUrl);
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get("content-type")!, /image\/svg\+xml/);
  assert.equal(preview.headers.get("x-content-type-options"), "nosniff");
  assert.equal(
    (await app.request(body.previewUrl.replace(body.revision, "e".repeat(64))))
      .status,
    409,
  );
  assert.equal(
    (await app.request(`${base}/${other}/${card.cardId}`)).status,
    404,
  );
  assert.equal(
    (await app.request(`${base}/${owner}/${card.cardId}`, { method: "DELETE" }))
      .status,
    404,
  );
  assert.equal(calls(), 1);
  assert.deepEqual(audits, [
    "review_custom_body_list",
    "review_custom_body",
    "review_custom_body_preview",
  ]);
});
test("revocation/deletion or card changes during rendering suppress completed and cached preview responses", async () => {
  for (const mode of ["delete", "change"] as const) {
    const f = appFixture(),
      base = "/v1/admin/review/custom-bodies";
    const body = (await (
      await f.app.request(`${base}/${owner}/${card.cardId}`)
    ).json()) as { previewUrl: string };
    f.deps.render = async () => {
      mode === "delete" ? f.clear() : f.change();
      return "<svg/>";
    };
    const result = await f.app.request(body.previewUrl);
    assert.equal(result.status, mode === "delete" ? 404 : 409);
    assert.doesNotMatch(await result.text(), /<svg/);
  }
});

test("admin entry requires header auth; query tokens never authorize body content", async () => {
  const { adminRoutes } = await import("./routes.js");
  for (const path of [
    "/review/custom-bodies",
    `/review/custom-bodies/${owner}/${card.cardId}?token=not-a-token`,
    `/review/custom-bodies/${owner}/${card.cardId}/preview?revision=${"a".repeat(64)}`,
  ]) {
    assert.equal((await adminRoutes.request(path)).status, 404);
  }
});

test("vendored mesh evaluators retain the pinned client source without silent numerical edits", () => {
  const base = new URL("../../src/admin/bodyRuntime/", import.meta.url);
  const manifest = JSON.parse(
    readFileSync(new URL("SOURCE.json", base), "utf8"),
  );
  for (const [name, sha] of Object.entries(manifest.sha256)) {
    const source = readFileSync(new URL(name, base), "utf8").replace(
      /from "(\.\/[^"\n]+)\.js"/g,
      'from "$1"',
    );
    assert.equal(createHash("sha256").update(source).digest("hex"), sha, name);
  }
});
