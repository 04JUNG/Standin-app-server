import { resolveOutputScope } from "../output-scope/model.js";
import { handBakeFor } from "./service.js";
import { readyHandCatalog } from "./service.js";
import { EXPECTED_SOLVER_VERSION } from "../converter/client.js";
import { FRAMING_VERSION } from "../converter/framing.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { PoolClient } from "pg";
import type { AppEnv } from "../env.js";
import type { AnalysisResult } from "../types.js";
import { transaction } from "../db.js";
import { parseCatalog, readHands, type HandSelection } from "./model.js";
import { createHandStore, parseHandChange } from "./store.js";
import { createHandRoutes, createHandSelectionRoutes } from "./routes.js";

const rawCatalog = {
  schema_version: 1,
  library_version: "hand-library-v1",
  library_sha256: "a".repeat(64),
  default_preset: "relaxed",
  fallback_order: ["relaxed", "fist"],
  thumbnails_available: true,
  categories: [
    {
      id: "basic",
      label: "기본",
      presets: ["relaxed", "fist", "open"].map((id) => ({
        id,
        label: id,
        description: id,
        thumbnails: { left: "internal", right: "internal" },
      })),
    },
  ],
};
const catalog = parseCatalog(rawCatalog);
function fixture() {
  let encoded = JSON.stringify({
    candidatesByPerson: [0, 1].map((personIndex) => ({
      personIndex,
      candidates: [{ id: "candidate" }],
      hands: readHands({
        status: "vlm",
        left: {
          preset: "relaxed",
          visible: false,
          candidates: ["fist", "relaxed"],
        },
        right: {
          preset: "open",
          source: "vlm",
          visible: true,
          confidence: "low",
        },
      }),
    })),
  });
  let gate = Promise.resolve();
  const tx: typeof transaction = async (fn) => {
    const previous = gate;
    let unlock!: () => void;
    gate = new Promise<void>((r) => {
      unlock = r;
    });
    await previous;
    const old = encoded;
    try {
      const client = {
        query: async (sql: string, params: unknown[]) => {
          if (sql.startsWith("SELECT")) {
            assert.match(sql, /installation_id=\$2 FOR UPDATE/);
            return {
              rows:
                params[0] === "job" && params[1] === "owner"
                  ? [{ status: "completed", result_json: encoded }]
                  : [],
            };
          }
          assert.match(sql, /^UPDATE jobs SET result_json/);
          encoded = params[1] as string;
          return { rows: [] };
        },
      } as unknown as PoolClient;
      return await fn(client);
    } catch (e) {
      encoded = old;
      throw e;
    } finally {
      unlock();
    }
  };
  let catalogCalls = 0;
  const deps = { transaction: tx, catalog: async () => { catalogCalls++; return catalog; } };
  return {
    store: createHandStore(deps),
    deps,
    catalogCalls: () => catalogCalls,
    scope: (selection: "full" | "half" | "head" | "shoulder_head" | "bust") => {
      const value = JSON.parse(encoded) as AnalysisResult;
      value.candidatesByPerson[0].outputScope = resolveOutputScope({ selection, detected: "head" });
      encoded = JSON.stringify(value);
    },
    json: () => JSON.parse(encoded) as AnalysisResult,
  };
}
test("catalog rewrites image paths, rejects duplicate IDs and requires a valid default", () => {
  assert.equal(
    catalog.categories[0]!.presets[0]!.thumbnails?.left,
    "/v1/hands/relaxed/thumbnail?side=left",
  );
  assert.throws(() =>
    parseCatalog({ ...rawCatalog, default_preset: "missing" }),
  );
  assert.throws(() =>
    parseCatalog({
      ...rawCatalog,
      categories: [...rawCatalog.categories, ...rawCatalog.categories],
    }),
  );
});
test("hidden hand preset, not first candidate, initializes a persistent per-person selection", async () => {
  const f = fixture();
  const first = await f.store.selection("owner", "job", 0);
  assert.equal(first.left, "relaxed");
  assert.equal(first.observation.left.candidates[0], "fist");
  const saved = await f.store.selection("owner", "job", 0, {
    left: "fist",
    library_sha256: catalog.library_sha256,
    expectedRevision: 0,
  });
  assert.equal(saved.right, "open");
  assert.equal(saved.recommended.left, "relaxed");
  assert.deepEqual(saved.changed, ["left"]);
  assert.equal(
    (await createHandStore(f.deps).selection("owner", "job", 0)).left,
    "fist",
  );
  assert.equal((await f.store.selection("owner", "job", 1)).left, "relaxed");
  assert.equal(f.json().candidatesByPerson[0]!.handSelection!.revision, 1);
});
test("ownership, invalid presets, stale library and concurrent stale writes are rejected", async () => {
  const f = fixture();
  await assert.rejects(f.store.selection("other", "job", 0), {
    code: "NOT_FOUND",
  });
  await assert.rejects(f.store.selection("owner", "job", 12), {
    code: "NOT_FOUND",
  });
  await assert.rejects(
    f.store.selection("owner", "job", 0, {
      left: "missing",
      library_sha256: catalog.library_sha256,
      expectedRevision: 0,
    }),
    { code: "INVALID_HAND_PRESET" },
  );
  await assert.rejects(
    f.store.selection("owner", "job", 0, {
      left: "fist",
      library_sha256: "b".repeat(64),
      expectedRevision: 0,
    }),
    { code: "HAND_LIBRARY_CHANGED" },
  );
  const results = await Promise.allSettled(
    ["fist", "open"].map((left) =>
      f.store.selection("owner", "job", 0, {
        left,
        library_sha256: catalog.library_sha256,
        expectedRevision: 0,
      }),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    (results.find((r) => r.status === "rejected") as PromiseRejectedResult)
      .reason.code,
    "HANDS_CHANGED",
  );
});
test("catalog migration reconciles removed presets and increments the persisted revision", async () => {
  const f = fixture();
  await f.store.selection("owner", "job", 0, {
    left: "fist",
    library_sha256: catalog.library_sha256,
    expectedRevision: 0,
  });
  const newer = {
    ...catalog,
    library_sha256: "b".repeat(64),
    categories: catalog.categories.map((c) => ({
      ...c,
      presets: c.presets.filter((p) => p.id !== "fist"),
    })),
  };
  const store = createHandStore({ ...f.deps, catalog: async () => newer });
  const migrated = await store.selection("owner", "job", 0);
  assert.equal(migrated.left, "relaxed");
  assert.equal(migrated.right, "open");
  assert.equal(migrated.revision, 2);
});
test("PUT accepts only partial side values, hash and revision, and GET restores them", async () => {
  const f = fixture();
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("installationId", "owner");
    c.set("requestId", "req-test");
    await next();
  });
  app.route("/jobs", createHandSelectionRoutes(f.store));
  assert.equal((await app.request("/jobs/job/people/0/hands")).status, 200);
  const response = await app.request("/jobs/job/people/0/hands", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      right: "fist",
      library_sha256: catalog.library_sha256,
      expectedRevision: 0,
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as HandSelection).right, "fist");
  assert.equal((await app.request("/jobs/job/people/-1/hands")).status, 400);
  assert.throws(() => parseHandChange({ left: "fist" }), {
    code: "INVALID_INPUT",
  });
  assert.throws(
    () =>
      parseHandChange({
        left: "fist",
        library_sha256: catalog.library_sha256,
        expectedRevision: 0,
        unsafe: true,
      }),
    { code: "INVALID_INPUT" },
  );
});
test("thumbnail proxy preserves 304 and validates side without exposing internal URLs", async () => {
  const app = createHandRoutes({
    catalog: async () => catalog,
    thumbnail: async (_preset, side, etag) => {
      assert.equal(side, "right");
      assert.equal(etag, '"image"');
      return new Response(null, { status: 304, headers: { ETag: '"image"' } });
    },
  });
  const response = await app.request("/relaxed/thumbnail?side=right", {
    headers: { "If-None-Match": '"image"' },
  });
  assert.equal(response.status, 304);
  assert.equal(response.headers.get("ETag"), '"image"');
  assert.equal(
    (await app.request("/relaxed/thumbnail?side=screen-left")).status,
    400,
  );
});

test("readiness requires feature flag, framing support and the converter's exact library hash", async () => {
  const health = {
    ok: true,
    solver_version: EXPECTED_SOLVER_VERSION,
    framing_version: FRAMING_VERSION,
    output_scopes: ["full", "half", "bust", "head"],
    hand_library: {
      version: catalog.library_version,
      sha256: catalog.library_sha256,
    },
  };
  const deps = {
    enabled: () => true,
    catalog: async () => catalog,
    health: async () => new Response(JSON.stringify(health)),
  };
  assert.equal(
    (await readyHandCatalog(true, deps)).library_sha256,
    catalog.library_sha256,
  );
  await assert.rejects(
    readyHandCatalog(true, { ...deps, enabled: () => false }),
    { code: "HAND_SELECTION_DISABLED" },
  );
  for (const bad of [
    { ...health, hand_library: null },
    { ...health, output_scopes: ["full"] },
    {
      ...health,
      hand_library: {
        version: catalog.library_version,
        sha256: "b".repeat(64),
      },
    },
  ])
    await assert.rejects(
      readyHandCatalog(true, {
        ...deps,
        health: async () => new Response(JSON.stringify(bad)),
      }),
      { code: "HANDS_UNAVAILABLE" },
    );
});

test("thumbnail requests pin the catalog library and return the PNG with its identity", async () => {
  let calls = 0;
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4b0AAAAASUVORK5CYII=",
    "base64",
  );
  const app = createHandRoutes({
    catalog: async () => catalog,
    thumbnail: async () => {
      calls++;
      return new Response(png, { headers: { ETag: '"png"' } });
    },
  });
  const response = await app.request(
    `/fist/thumbnail?side=left&library=${catalog.library_sha256}`,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "image/png");
  assert.equal(
    response.headers.get("X-Standin-Hand-Library-SHA256"),
    catalog.library_sha256,
  );
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  assert.equal(
    (await app.request(`/fist/thumbnail?side=left&library=${"b".repeat(64)}`))
      .status,
    409,
  );
  assert.equal(
    (await app.request("/fist/thumbnail?side=left&library=invalid")).status,
    400,
  );
  assert.equal(calls, 1);
});
test("unavailable or invalid thumbnail is explicit and never a successful icon response", async () => {
  const unavailable = createHandRoutes({
    catalog: async () => ({ ...catalog, thumbnails_available: false }),
    thumbnail: async () => {
      throw new Error("must not call");
    },
  });
  assert.equal(
    (await unavailable.request("/fist/thumbnail?side=right")).status,
    404,
  );
  const invalid = createHandRoutes({
    catalog: async () => catalog,
    thumbnail: async () => new Response("html error"),
  });
  assert.equal(
    (await invalid.request("/fist/thumbnail?side=right")).status,
    503,
  );
});

for (const scope of ["head", "shoulder_head", "bust"] as const) {
  test(`${scope} hand lookup/write returns not-applicable without library access; saved hands survive the scope round trip`, async () => {
    const f = fixture();
    const saved = await f.store.selection("owner", "job", 0, { left: "fist", library_sha256: catalog.library_sha256, expectedRevision: 0 });
    f.scope(scope);
    const before = f.catalogCalls();
    await assert.rejects(f.store.selection("owner", "job", 0), { code: "HANDS_NOT_APPLICABLE" });
    await assert.rejects(f.store.selection("owner", "job", 0, { left: "open", library_sha256: catalog.library_sha256, expectedRevision: saved.revision }), { code: "HANDS_NOT_APPLICABLE" });
    assert.equal(f.catalogCalls(), before);
    assert.deepEqual(f.json().candidatesByPerson[0].handSelection, saved);
    assert.equal(await handBakeFor(f.json().candidatesByPerson[0]), null);
    f.scope("half");
    const restored = await f.store.selection("owner", "job", 0);
    assert.deepEqual(restored, saved);
    assert.equal((await f.store.selection("owner", "job", 1)).personIndex, 1);
  });
}
