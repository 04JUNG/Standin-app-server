import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { resolveReplayEnvironment } from "./environment.js";
import { PGlite } from "@electric-sql/pglite";
import { Hono } from "hono";
import { SCHEMA } from "../db.js";
import { deleteJobs, deleteInstallationData } from "../retention.js";
import { writeQualityConsent } from "../installations/qualityConsent.js";
import {
  ReplayService,
  type ReplayDb,
  type RunTransaction,
} from "./service.js";
import { LocalReplayStorage } from "./storage.js";
import {
  hash,
  checkPolicy,
  eventsBytes,
  parse,
  chunkSchema,
} from "./policy.js";
import { createReplayRoutes, createAdminReplayRoutes } from "./routes.js";
import { createRequireInstallation } from "../installations/middleware.js";
import { sanitizeReplay } from "./sanitize.js";
import type { AppEnv } from "../env.js";
import { DASHBOARD_HTML } from "../ops/dashboard.js";
const now = Date.now(),
  id = randomUUID(),
  inst = "inst_replay_test";
const policy = {
  enabled: true,
  captureEnabled: true,
  cspEnabled: true,
  consentMode: "assumed",
  environment: "development",
};
const create = (replayId = id, appSessionId = "app-session") => ({
  protocolVersion: "session-replay.v1",
  replayId,
  appSessionId,
  startedAt: now,
  appVersion: "0.2.0",
  os: "macos",
  authorizationMode: "assumed",
  policyVersion: "2026-10-28",
});
const event = [
  {
    type: 4,
    timestamp: now,
    data: { href: "about:blank", width: 800, height: 600 },
  },
  {
    type: 5,
    timestamp: now + 100,
    data: { tag: "replay_gap", payload: { reason: "canvas_not_recorded" } },
  },
];
const makeChunk = (extra: Record<string, unknown> = {}) => ({
  protocolVersion: "session-replay.v1",
  surface: "app",
  contentHash: hash(Buffer.from(JSON.stringify(event))),
  encoding: "json",
  events: event,
  startedOffsetMs: 0,
  endedOffsetMs: 5000,
  clock: { epochMs: now, monotonicOffsetMs: 0 },
  ...extra,
});
test("missing deployment classification fails closed through actual BFF configuration", () => {
  const env = { ...process.env };
  delete env.NODE_ENV;
  delete env.REPLAY_ENVIRONMENT;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const {config}=await import(${JSON.stringify(new URL("../config.js", import.meta.url).href)}); console.log(config.replayEnvironment);`,
    ],
    { env, encoding: "utf8" },
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "unclassified");
  for (const values of [
    {},
    { NODE_ENV: "production" },
    { NODE_ENV: "beta" },
    { REPLAY_ENVIRONMENT: "" },
    { REPLAY_ENVIRONMENT: "unknown", NODE_ENV: "development" },
  ])
    assert.throws(
      () =>
        checkPolicy(
          { ...policy, environment: resolveReplayEnvironment(values) },
          "assumed",
        ),
      /REPLAY_AUTHORIZATION_DENIED/,
    );
  for (const environment of ["development", "staging"])
    assert.doesNotThrow(() =>
      checkPolicy(
        {
          ...policy,
          environment: resolveReplayEnvironment({
            REPLAY_ENVIRONMENT: environment,
            NODE_ENV: "production",
          }),
        },
        "assumed",
      ),
    );
});
async function fixture() {
  const db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(SCHEMA);
  await db.query(
    `INSERT INTO installations(id,token_hash,consent_version,consented_at,created_at,last_seen_at,app_version,os_name,os_version,architecture,locale) VALUES($1,'not-a-token','2026-08-02',$2,$2,$2,'0.2.0','macos','test','arm64','ko')`,
    [inst, new Date(now).toISOString()],
  );
  const root = await mkdtemp(join(tmpdir(), "replay-test-"));
  const storage = new LocalReplayStorage(root);
  const sql: ReplayDb = {
    query: async <T>(q: string, p?: unknown[]) => ({
      rows: (await db.query<T>(q, p)).rows,
    }),
  };
  const tx: RunTransaction = async (fn) =>
    db.transaction(async (t) =>
      fn({
        query: async <T>(q: string, p?: unknown[]) => ({
          rows: (await t.query<T>(q, p)).rows,
        }),
      }),
    );
  const clock = { now };
  const service = new ReplayService(
    sql,
    tx,
    storage,
    { ...policy },
    () => clock.now,
  );
  return { db, sql, service, root, clock };
}
test("real PostgreSQL schema: assumed preserves consent, idempotency, order gaps, filters, manifest and private storage", async () => {
  const f = await fixture();
  try {
    await f.service.create(inst, create());
    await f.service.create(inst, create());
    const consent = (
      await f.db.query<{
        quality_personal_data: boolean;
        quality_consent_id: string | null;
      }>("SELECT quality_personal_data,quality_consent_id FROM installations")
    ).rows[0];
    assert.equal(consent.quality_personal_data, false);
    assert.equal(consent.quality_consent_id, null);
    assert.equal(
      (await f.db.query("SELECT * FROM quality_consent_receipts")).rows.length,
      0,
    );
    await assert.rejects(
      f.service.create("other", create()),
      /REPLAY_AUTHORIZATION_DENIED/,
    );
    assert.deepEqual(
      await f.service.chunk(
        inst,
        id,
        "main",
        2,
        makeChunk({ failed: true, feature: "capture", saveState: "saved" }),
      ),
      { accepted: true, duplicate: false, sequence: 2 },
    );
    assert.equal(
      (
        await f.service.chunk(
          inst,
          id,
          "main",
          2,
          makeChunk({ failed: true, feature: "capture", saveState: "saved" }),
        )
      ).duplicate,
      true,
    );
    await assert.rejects(
      f.service.chunk(inst, id, "main", 2, makeChunk({ failed: false })),
      /REPLAY_CONFLICT/,
    );
    await assert.rejects(
      f.service.chunk("other", id, "main", 0, makeChunk()),
      /REPLAY_NOT_FOUND/,
    );
    await f.service.chunk(inst, id, "main", 0, makeChunk());
    const manifest = await f.service.manifest(id);
    assert.deepEqual(
      manifest.streams[0].chunks.map((c) => c.sequence),
      [0, 2],
    );
    assert.ok(manifest.gaps.some((g) => g.sequence === 1));
    const read = await f.service.read(id, "chunk", "main", 0);
    assert.deepEqual(JSON.parse(Buffer.from(read.bytes).toString()), event);
    assert.equal(
      (
        await f.service.list({
          feature: "capture",
          failed: "true",
          saveState: "saved",
          os: "macos",
        })
      ).items.length,
      1,
    );
    assert.equal(
      (await f.service.list({ surface: "capture" })).items.length,
      0,
    );
    assert.equal(
      (
        await f.service.finish(inst, id, {
          streams: [{ windowInstanceId: "main", lastSequence: 2 }],
          reason: "completed",
        })
      ).state,
      "incomplete",
    );
    await assert.rejects(
      f.service.chunk(inst, id, "main", 1, makeChunk()),
      /REPLAY_FINISHED/,
    );
    assert.equal(
      (await f.db.query("SELECT * FROM analytics_events")).rows.length,
      0,
    );
  } finally {
    await f.db.close();
  }
});
test("asset byte pinning, MIME/hash/ownership, CSP artifact association and deletion queue", async () => {
  const f = await fixture();
  try {
    await f.service.create(inst, create());
    await f.db.query(
      `INSERT INTO jobs(id,user_id,installation_id,status,source,created_at,updated_at) VALUES('job_test','', $1,'completed','capture',$2,$2)`,
      [inst, new Date(now).toISOString()],
    );
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
      "base64",
    );
    const h = hash(png);
    const a = {
      contentType: "image/png",
      dataBase64: png.toString("base64"),
      kind: "csp_result",
      jobId: "job_test",
      snapshotVersion: "selection-v1",
      artifactHash: "a".repeat(64),
    };
    await assert.rejects(
      f.service.asset(inst, id, h, a),
      /REPLAY_ARTIFACT_UNVERIFIED/,
    );
    await f.service.witnessArtifact(inst, "job_test", "a".repeat(64));
    const saved = await f.service.asset(inst, id, h, a);
    assert.equal(saved.url, `replay-asset://${h}`);
    assert.deepEqual(
      Buffer.from((await f.service.read(id, "asset", h)).bytes),
      png,
    );
    await f.service.storage.put(
      `replays/${id}/assets/${h}`,
      Buffer.from("corrupt"),
      "image/png",
    );
    await assert.rejects(
      f.service.read(id, "asset", h),
      /REPLAY_STORAGE_UNAVAILABLE/,
    );
    await f.service.storage.put(`replays/${id}/assets/${h}`, png, "image/png");
    assert.equal((await f.service.asset(inst, id, h, a)).assetId, h);
    await assert.rejects(
      f.service.asset(inst, id, h, { ...a, jobId: "not_owned" }),
      /REPLAY_ARTIFACT_UNVERIFIED/,
    );
    await assert.rejects(
      f.service.asset(inst, id, "a".repeat(64), a),
      /REPLAY_HASH_MISMATCH/,
    );
    await assert.rejects(
      f.service.asset(inst, id, h, { ...a, contentType: "image/svg+xml" }),
      /REPLAY_INVALID/,
    );
    await f.db.transaction(async (db) =>
      deleteJobs(
        { query: (q, p) => db.query(q, p) },
        { ids: "$1", params: ["job_test"] },
      ),
    );
    await assert.rejects(f.service.manifest(id), /REPLAY_NOT_FOUND/);
    assert.equal(
      (await f.db.query("SELECT * FROM replay_object_deletions")).rows.length,
      1,
    );
    await f.service.sweep();
    await assert.rejects(access(join(f.root, `replays/${id}/assets/${h}`)));
    assert.equal(
      (await f.db.query("SELECT * FROM replay_object_deletions")).rows.length,
      0,
    );
  } finally {
    await f.db.close();
  }
});
test("explicit withdrawal and installation deletion remove recordings; assumed cannot override withdrawal", async () => {
  const f = await fixture();
  try {
    await f.service.create(inst, create());
    await f.db.transaction(async (db) =>
      writeQualityConsent(db as never, inst, {
        version: "2026-10-19",
        personalData: false,
        contentLicense: false,
      }),
    );
    await assert.rejects(
      f.service.create(inst, create(randomUUID(), "later")),
      /REPLAY_AUTHORIZATION_DENIED/,
    );
    assert.equal(
      (await f.db.query("SELECT * FROM replay_sessions")).rows.length,
      0,
    );
    await f.db.query(
      "UPDATE installations SET replay_withdrawn_at=NULL WHERE id=$1",
      [inst],
    );
    await f.service.create(inst, create(randomUUID(), "another"));
    await f.db.transaction(async (db) =>
      deleteInstallationData({ query: (q, p) => db.query(q, p) }, inst),
    );
    assert.equal(
      (await f.db.query("SELECT * FROM replay_sessions")).rows.length,
      0,
    );
  } finally {
    await f.db.close();
  }
});
test("30 days, earlier source expiry, explicit off and production assumed fail closed", async () => {
  const f = await fixture();
  try {
    const s = await f.service.create(inst, create());
    assert.equal(Date.parse(s.expiresAt) - now, 30 * 86400000);
    f.service.policy.enabled = false;
    await assert.rejects(f.service.manifest(id), /REPLAY_DISABLED/);
    assert.equal((await f.service.remove(inst, id)).deleted, true);
    for (const environment of ["production", "beta", "unknown"])
      assert.throws(
        () => checkPolicy({ ...policy, environment }, "assumed"),
        /REPLAY_AUTHORIZATION_DENIED/,
      );
    assert.throws(
      () => checkPolicy({ ...policy, enabled: false }, "assumed"),
      /REPLAY_DISABLED/,
    );
    f.service.policy.enabled = true;
    const freshId = randomUUID();
    await f.service.create(inst, create(freshId));
    await f.db.query("UPDATE replay_sessions SET expires_at=$2 WHERE id=$1", [
      freshId,
      new Date(now - 1).toISOString(),
    ]);
    await assert.rejects(f.service.manifest(freshId), /REPLAY_EXPIRED/);
    await f.service.sweep();
    assert.equal(
      (await f.db.query("SELECT * FROM replay_sessions")).rows.length,
      0,
    );
  } finally {
    await f.db.close();
  }
});
test("30-day boundaries preserve existing expiry and retain CSP receipts until expiry", async () => {
  const f = await fixture();
  const day = 86400000;
  try {
    await f.service.create(inst, create());
    const oldId = randomUUID();
    await f.service.create(inst, create(oldId, "existing-session"));
    const oldExpiry = new Date(now + 14 * day).toISOString();
    await f.db.query("UPDATE replay_sessions SET expires_at=$2 WHERE id=$1", [
      oldId,
      oldExpiry,
    ]);
    assert.equal(
      (await f.service.create(inst, create(oldId, "existing-session")))
        .expiresAt,
      oldExpiry,
    );
    await f.db.query(
      `INSERT INTO jobs(id,user_id,installation_id,status,source,created_at,updated_at) VALUES('job_retention','',$1,'completed','capture',$2,$2)`,
      [inst, new Date(now).toISOString()],
    );
    const artifactHash = "b".repeat(64);
    await f.service.witnessArtifact(inst, "job_retention", artifactHash);
    await f.db.query("UPDATE replay_artifact_receipts SET created_at=$1", [
      new Date(now).toISOString(),
    ]);
    f.clock.now = now + 20 * day;
    await assert.rejects(f.service.manifest(oldId), /REPLAY_EXPIRED/);
    await f.service.sweep();
    assert.equal(
      (await f.db.query("SELECT * FROM replay_artifact_receipts")).rows.length,
      1,
    );
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
      "base64",
    );
    const asset = {
      contentType: "image/png",
      dataBase64: png.toString("base64"),
      kind: "csp_result",
      jobId: "job_retention",
      snapshotVersion: "retention-v1",
      artifactHash,
    };
    await f.service.asset(inst, id, hash(png), asset);
    f.clock.now = now + 30 * day - 1;
    await f.service.manifest(id);
    f.clock.now += 1;
    await assert.rejects(f.service.manifest(id), /REPLAY_EXPIRED/);
    const freshId = randomUUID();
    await f.service.create(inst, {
      ...create(freshId, "new-session"),
      startedAt: f.clock.now,
    });
    await assert.rejects(
      f.service.asset(inst, freshId, hash(png), asset),
      /REPLAY_ARTIFACT_UNVERIFIED/,
    );
    await f.service.sweep();
    assert.equal(
      (await f.db.query("SELECT * FROM replay_artifact_receipts")).rows.length,
      0,
    );
    assert.equal(
      (await f.db.query("SELECT id FROM replay_sessions")).rows.length,
      1,
    );
    await f.service.manifest(freshId);
  } finally {
    await f.db.close();
  }
});
test("bounded gzip, hash, sensitive data and unsafe DOM defense", () => {
  const bytes = Buffer.from(JSON.stringify(event));
  const c = makeChunk({
    encoding: "gzip-base64",
    events: undefined,
    data: gzipSync(bytes).toString("base64"),
  });
  assert.equal(eventsBytes(parse(chunkSchema, c)).toString(), bytes.toString());
  assert.throws(
    () =>
      eventsBytes(
        parse(chunkSchema, makeChunk({ contentHash: "0".repeat(64) })),
      ),
    /REPLAY_HASH_MISMATCH/,
  );
  assert.throws(
    () =>
      eventsBytes(
        parse(
          chunkSchema,
          makeChunk({
            encoding: "gzip-base64",
            events: undefined,
            data: gzipSync(Buffer.alloc(2000000)).toString("base64"),
          }),
        ),
      ),
    /REPLAY_TOO_LARGE/,
  );
  const unsafe = [
    { type: 5, timestamp: now, data: { localPath: "/Users/test/private.png" } },
  ];
  assert.throws(
    () =>
      eventsBytes(
        parse(
          chunkSchema,
          makeChunk({
            events: unsafe,
            contentHash: hash(Buffer.from(JSON.stringify(unsafe))),
          }),
        ),
      ),
    /REPLAY_UNSAFE_CONTENT/,
  );
  const safe = sanitizeReplay(
    {
      tagName: "iframe",
      attributes: {
        src: "https://evil.test/leak",
        onload: "alert(1)",
        href: "tauri://ipc",
        srcdoc: "<script/>",
        style: "background:url(https://evil.test/)",
      },
      childNodes: [{ tagName: "script", attributes: { src: "https://evil" } }],
    },
    {},
  );
  assert.deepEqual(safe, {
    tagName: "div",
    attributes: {
      "data-replay-missing-asset": "true",
      style: 'background:url("about:blank")',
    },
    childNodes: [
      { tagName: "div", attributes: { "data-replay-missing-asset": "true" } },
    ],
  });
});
test("actual HTTP routes enforce installation authentication, admin boundary and body envelopes", async () => {
  const f = await fixture();
  try {
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("requestId", "test");
      await next();
    });
    const auth = createRequireInstallation(async (i, token) =>
      i === inst && token === "fixture"
        ? { id: inst, consentVersion: "2026-08-02", appVersion: "0.2.0" }
        : null,
    );
    app.use("/v1/replays", auth);
    app.use("/v1/replays/*", auth);
    app.route("/v1/replays", createReplayRoutes(f.service));
    app.use("/v1/admin/*", async (c, next) => {
      if (c.req.header("X-Beta-Admin-Token") !== "test-admin")
        return c.json({}, 404);
      c.set("reviewer", "tester");
      await next();
    });
    let audits = 0;
    app.route(
      "/v1/admin/replays",
      createAdminReplayRoutes(f.service, async () => {
        audits++;
      }),
    );
    assert.equal(
      (
        await app.request("/v1/replays", {
          method: "POST",
          body: JSON.stringify(create()),
        })
      ).status,
      401,
    );
    const headers = {
      "X-Installation-Id": inst,
      "X-Device-Token": "fixture",
      "X-App-Version": "0.2.0",
      "Content-Type": "application/json",
    };
    assert.equal(
      (
        await app.request("/v1/replays", {
          method: "POST",
          headers,
          body: JSON.stringify(create()),
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await app.request(`/v1/replays/${id}/streams/main/chunks/0`, {
          method: "PUT",
          headers,
          body: "broken",
        })
      ).status,
      400,
    );
    assert.equal((await app.request("/v1/admin/replays")).status, 404);
    const list = await app.request("/v1/admin/replays", {
      headers: { "X-Beta-Admin-Token": "test-admin" },
    });
    assert.equal(list.status, 200);
    assert.equal(list.headers.get("cache-control"), "private, no-store");
    assert.equal(audits, 1);
  } finally {
    await f.db.close();
  }
});
test("existing dashboard includes journey and replay; scripts parse and display sandbox has no script capability", async () => {
  assert.match(DASHBOARD_HTML, /journeyPanel/);
  assert.match(DASHBOARD_HTML, /replayPanel/);
  assert.match(DASHBOARD_HTML, /sandbox="allow-same-origin"/);
  assert.doesNotMatch(
    DASHBOARD_HTML,
    /sandbox="allow-scripts allow-same-origin"/,
  );
  for (const match of DASHBOARD_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g))
    assert.doesNotThrow(() => new Function(match[1]));
  const bundle = await readFile(
    new URL("./player.bundle.js", import.meta.url),
    "utf8",
  );
  assert.ok(bundle.length > 50000);
  assert.ok(!bundle.includes("https://cdn"));
});
test("daily quotas survive individual recording deletion, stream limits and capture/CSP flags", async () => {
  const f = await fixture();
  try {
    await f.service.create(inst, create());
    await f.service.chunk(inst, id, "main", 0, makeChunk());
    await f.db.query(
      "UPDATE replay_daily_usage SET bytes=$2 WHERE installation_id=$1",
      [inst, 268435456],
    );
    await assert.rejects(
      f.service.chunk(inst, id, "main", 1, makeChunk()),
      /REPLAY_QUOTA_EXCEEDED/,
    );
    await f.service.remove(inst, id);
    await assert.rejects(f.service.create(inst, create()), /REPLAY_EXPIRED/);
    const later = randomUUID();
    await f.service.create(inst, create(later, "later"));
    await assert.rejects(
      f.service.chunk(inst, later, "main", 0, makeChunk()),
      /REPLAY_QUOTA_EXCEEDED/,
    );
    f.service.policy.captureEnabled = false;
    await assert.rejects(
      f.service.chunk(
        inst,
        later,
        "capture",
        0,
        makeChunk({ surface: "capture" }),
      ),
      /REPLAY_DISABLED/,
    );
    await f.db.query(
      "UPDATE replay_daily_usage SET bytes=0 WHERE installation_id=$1",
      [inst],
    );
    for (let n = 0; n < 16; n++)
      await f.service.chunk(inst, later, "window_" + n, 0, makeChunk());
    await assert.rejects(
      f.service.chunk(inst, later, "window_17", 0, makeChunk()),
      /REPLAY_CONFLICT/,
    );
    await f.db.query(
      "UPDATE replay_daily_usage SET sessions=100 WHERE installation_id=$1",
      [inst],
    );
    await assert.rejects(
      f.service.create(inst, create(randomUUID(), "over-count")),
      /REPLAY_QUOTA_EXCEEDED/,
    );
  } finally {
    await f.db.close();
  }
});
test("same bytes can have multiple immutable asset bindings and shorter source expiry wins", async () => {
  const f = await fixture();
  try {
    await f.service.create(inst, create());
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
      "base64",
    );
    const h = hash(png);
    const a = {
      contentType: "image/png",
      dataBase64: png.toString("base64"),
      kind: "rough",
      snapshotVersion: "input-1",
    };
    await f.service.asset(inst, id, h, a);
    const expiry = new Date(now + 3600000).toISOString();
    await f.service.asset(inst, id, h, {
      ...a,
      kind: "thumbnail",
      snapshotVersion: "candidate-2",
      sourceExpiresAt: expiry,
    });
    const m = await f.service.manifest(id);
    assert.deepEqual(
      m.assets.map((a) => a.kind),
      ["rough", "thumbnail"],
    );
    assert.equal(m.session.totalBytes, png.length);
    assert.equal(m.session.expiresAt, expiry);
  } finally {
    await f.db.close();
  }
});
test("actual existing admin router records non-null audit request ID and replay target", async (t) => {
  const f = await fixture();
  try {
    const { config } = await import("../config.js");
    Object.assign(config, {
      betaReviewAdminToken: "local-integration-test",
      replayEnvironment: "development",
    });
    const { pool } = await import("../db.js");
    const { adminRoutes } = await import("../admin/routes.js");
    t.mock.method(pool, "query", async (q: string, p?: unknown[]) => {
      const r = await f.db.query(q, p);
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    });
    t.mock.method(pool, "connect", async () => ({
      query: async (q: string, p?: unknown[]) => {
        const r = await f.db.query(q, p);
        return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
      },
      release() {},
    }));
    await f.service.create(inst, create());
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("requestId", "real-request");
      await next();
    });
    app.route("/v1/admin", adminRoutes);
    const headers = { "X-Beta-Admin-Token": "local-integration-test" };
    assert.equal(
      (await app.request("/v1/admin/replays", { headers })).status,
      200,
    );
    assert.equal(
      (await app.request(`/v1/admin/replays/${id}/manifest`, { headers }))
        .status,
      200,
    );
    const audits = (
      await f.db.query<{
        request_id: string;
        replay_id: string;
        installation_id: string;
      }>("SELECT * FROM admin_access_audit ORDER BY occurred_at")
    ).rows;
    assert.equal(audits.length, 2);
    assert.equal(audits[0].request_id, "real-request");
    assert.equal(audits[1].replay_id, id);
    assert.equal(audits[1].installation_id, inst);
    const bundle = await app.request("/v1/admin/replay-player.js", { headers });
    assert.equal(bundle.status, 200);
    assert.match(await bundle.text(), /createReplayPlayer/);
  } finally {
    await f.db.close();
  }
});
test("stable pagination does not lose equal-time sessions; legacy withdrawal receipts block assumed", async () => {
  const f = await fixture();
  try {
    await f.service.create(inst, create());
    const id2 = randomUUID();
    await f.service.create(inst, create(id2, "session-2"));
    await f.db.query("UPDATE replay_sessions SET created_at=$1", [
      new Date(now).toISOString(),
    ]);
    const first = await f.service.list({ limit: "1" }),
      second = await f.service.list({ limit: "1", before: first.nextBefore! });
    assert.equal(first.items.length, 1);
    assert.equal(second.items.length, 1);
    assert.notEqual(first.items[0].replayId, second.items[0].replayId);
    await f.db.query(
      "INSERT INTO quality_consent_receipts(receipt_id,subject_hash,version,personal_data,content_license,recorded_at,ended_at) VALUES($1,$2,$3,false,false,$4,$4)",
      [
        randomUUID(),
        hash(Buffer.from(inst)),
        "2026-10-19",
        new Date(now).toISOString(),
      ],
    );
    await assert.rejects(f.service.manifest(id), /REPLAY_AUTHORIZATION_DENIED/);
    assert.equal((await f.service.list({})).items.length, 0);
  } finally {
    await f.db.close();
  }
});
test("real export witness binds CSP hashes and a replay failure cannot fail file export", async (t) => {
  const f = await fixture();
  try {
    await f.service.create(inst, create());
    await f.db.query(
      `INSERT INTO jobs(id,user_id,installation_id,status,source,created_at,updated_at) VALUES('job_export','',$1,'completed','capture',$2,$2)`,
      [inst, new Date(now).toISOString()],
    );
    const { replayArtifactWitness } = await import("./witness.js");
    const app = new Hono<AppEnv>();
    let failures = 0;
    app.use("*", async (c, next) => {
      c.set("installationId", inst);
      await next();
    });
    app.use(
      "*",
      replayArtifactWitness(f.service, () => failures++),
    );
    app.get("/v1/pose-candidates/p/framed", (c) => {
      c.header("X-Standin-Artifact-SHA256", "b".repeat(64));
      return c.body("owned synthetic export response");
    });
    assert.equal(
      (
        await app.request(
          "/v1/pose-candidates/p/framed?jobId=job_export&format=fbx",
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await f.db.query(
          "SELECT * FROM replay_artifact_receipts WHERE job_id=$1",
          ["job_export"],
        )
      ).rows.length,
      1,
    );
    t.mock.method(f.service, "witnessArtifact", async () => {
      throw new Error("storage offline");
    });
    const response = await app.request(
      "/v1/pose-candidates/p/framed?jobId=job_export&format=fbx",
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "owned synthetic export response");
    assert.equal(failures, 1);
  } finally {
    await f.db.close();
  }
});
