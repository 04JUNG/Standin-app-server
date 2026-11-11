import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { Hono } from "hono";
import { ACCESS_SCHEMA } from "./schema.js";
import { accessCodeHash, redeemAccessCode } from "./store.js";
import { createAccessRoutes } from "./routes.js";
import { config } from "../config.js";
import { pool } from "../db.js";
import { createRequireInstallation } from "../installations/middleware.js";
import type { AppEnv } from "../env.js";

test("closed access covers old clients, all product routes, atomic redeem and revocation", async () => {
  const db = new PGlite();
  await db.exec("CREATE TABLE installations(id text primary key); INSERT INTO installations VALUES('old'),('supporter'),('operator'),('other')");
  await db.exec(ACCESS_SCHEMA);
  await db.exec(ACCESS_SCHEMA);
  const original = pool.query;
  const flags = [config.accessGateEnabled, config.supporterAccessEnabled, config.accessOperatorInstallations] as const;
  pool.query = db.query.bind(db) as typeof pool.query;
  Object.assign(config, { accessGateEnabled: true, supporterAccessEnabled: true, accessOperatorInstallations: new Set(["operator"]) });
  const authenticate = async (id: string) => id ? {
    id, consentVersion: config.consentVersion, appVersion: "0.2.3",
  } : null;
  const auth = createRequireInstallation(authenticate as Parameters<typeof createRequireInstallation>[0]);
  const app = new Hono<AppEnv>();
  app.use("*", auth);
  app.route("/v1/installations/current/access", createAccessRoutes());
  const paths = ["/v1/analysis/jobs", "/v1/semantic-search", "/v1/models", "/v1/hands/library", "/v1/pose-candidates/p/export"];
  for (const path of paths) app.all(path, c => c.json({ reached: true }));
  app.delete("/v1/installations/current/data", c => c.json({ deleted: true }));
  const call = (id: string, path: string, code?: string) => app.request(path, {
    method: code === undefined ? "GET" : "POST",
    headers: { "X-Installation-Id": id, "X-Device-Token": "test", "Content-Type": "application/json" },
    ...(code === undefined ? {} : { body: JSON.stringify({ code }) }),
  });
  try {
    assert.equal((await call("", paths[0])).status, 401);
    for (const path of paths) {
      assert.equal((await call("old", path)).status, 403);
      assert.equal((await call("operator", path)).status, 200);
    }
    assert.equal((await call("old", "/v1/installations/current/access")).status, 200);
    const code = "STDN-12345678-12345678-12345678-12345678";
    const id = randomUUID();
    await db.query("INSERT INTO supporter_access_codes(id,code_hash,label) VALUES($1,$2,'test')", [id, accessCodeHash(code)]);
    const normalized = " stdn 12345678 12345678 12345678 12345678 ";
    const response = await call("supporter", "/v1/installations/current/access/redeem", normalized);
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { role: string }).role, "supporter");
    assert.equal((await call("supporter", paths[0])).status, 200);
    assert.equal((await call("supporter", "/v1/installations/current/access/redeem", code)).status, 200);
    assert.equal((await call("other", "/v1/installations/current/access/redeem", code)).status, 400);
    await db.query("UPDATE supporter_access_codes SET revoked_at=now() WHERE id=$1", [id]);
    assert.equal((await call("supporter", paths[0])).status, 403);
    Object.assign(config, { supporterAccessEnabled: false });
    assert.equal((await call("other", "/v1/installations/current/access/redeem", code)).status, 403);
    assert.equal((await call("operator", paths[0])).status, 200);
    Object.assign(config, { supporterAccessEnabled: true });
    for (let i=0;i<10;i++) await call("old", "/v1/installations/current/access/redeem", "invalid");
    assert.equal((await call("old", "/v1/installations/current/access/redeem", code)).status, 429);
    const concurrentCode = "STDN-ABCDEF01-ABCDEF01-ABCDEF01-ABCDEF01";
    await db.query("INSERT INTO supporter_access_codes(id,code_hash,label) VALUES($1,$2,'concurrent')", [randomUUID(), accessCodeHash(concurrentCode)]);
    const results = await Promise.all([redeemAccessCode("old",concurrentCode),redeemAccessCode("other",concurrentCode)]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal((await app.request("/v1/installations/current/data", { method: "DELETE",
      headers: { "X-Installation-Id": "old", "X-Device-Token": "test" } })).status, 200);
    const codeRows = (await db.query<{ code_hash: string }>("SELECT code_hash FROM supporter_access_codes")).rows;
    assert.ok(codeRows.every(r => r.code_hash !== concurrentCode && /^[a-f0-9]{64}$/.test(String(r.code_hash))));
    assert.equal(accessCodeHash("invalid"), null);
    assert.equal(accessCodeHash(code), createHash("sha256").update(code.replaceAll("-", "")).digest("hex"));
  } finally {
    pool.query = original;
    Object.assign(config, { accessGateEnabled: flags[0], supporterAccessEnabled: flags[1], accessOperatorInstallations: flags[2] });
    await db.close();
    await pool.end();
  }
});
