import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import type { QualityConsent } from "./qualityConsent.js";
import type { CutResult } from "../inference.js";

process.env.BETA_REVIEW_ADMIN_TOKEN = "quality-test-admin";
const { extractPersonSignals, mapCutResult } = await import("../mapping.js");
const { config } = await import("../config.js");
const { qualityReviewGuard } = await import("../admin/qualityAccess.js");
const { pool, SCHEMA } = await import("../db.js");
const { installationRoutes } = await import("./routes.js");
const { adminRoutes } = await import("../admin/routes.js");
const { analyticsRoutes } = await import("../analytics/routes.js");
const { requireInstallation } = await import("./middleware.js");
const { createJob, getOwnedJob, listJobHistory, persistAnalysisRecords } =
  await import("../jobs/store.js");
const { confirmSelections, recordExport, saveFeedback } =
  await import("../analytics/store.js");
const { deleteExpiredRows } = await import("../retention.js");

test("actual PostgreSQL schema/routes: optional consent, future jobs only, withdrawal and regrant", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(SCHEMA);
  await db.exec(SCHEMA); // repeated deployment is safe
  const query = async (sql: string, values?: unknown[]) => {
    const r = await db.query(sql, values);
    return {
      rows: r.rows,
      rowCount: r.rows.length || r.affectedRows || 0,
      fields: [],
      command: "",
      oid: 0,
    };
  };
  t.mock.method(pool, "query", query as typeof pool.query);
  t.mock.method(pool, "connect", (async () => ({
    query,
    release() {},
  })) as unknown as typeof pool.connect);
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("requestId", "consent-test");
    await next();
  });
  app.route("/v1/installations", installationRoutes);
  app.use("/v1/events/*", requireInstallation);
  app.route("/v1/events", analyticsRoutes);
  app.route("/v1/admin", adminRoutes);
  const optional = {
    version: "2026-10-19",
    personalData: false,
    contentLicense: false,
  };
  const registration = await app.request("/v1/installations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      consentVersion: config.consentVersion,
      consentedAt: new Date().toISOString(),
      appVersion: "0.2.0",
      osName: "windows",
      osVersion: "test",
      architecture: "x64",
      locale: "ko",
    }),
  });
  assert.equal(registration.status, 201);
  const registered = (await registration.json()) as {
    installationId: string;
    deviceToken: string;
    qualityConsent: QualityConsent;
  };
  assert.equal(
    registered.qualityConsent.consentId,
    null,
    "old clients/defaults never opt in",
  );
  const installationId = registered.installationId as string;
  const headers = {
    "Content-Type": "application/json",
    "X-Installation-Id": installationId,
    "X-Device-Token": registered.deviceToken as string,
  };
  const adminHeaders = { "X-Beta-Admin-Token": "quality-test-admin" };
  const consentUrl = "/v1/installations/current/quality-consent";
  const setConsent = async (personalData: boolean, contentLicense: boolean) => {
    const res = await app.request(consentUrl, {
      method: "PUT",
      headers,
      body: JSON.stringify({ ...optional, personalData, contentLicense }),
    });
    assert.equal(res.status, 200);
    return res.json() as Promise<QualityConsent>;
  };
  const job = () =>
    createJob(null, null, {
      installationId,
      source: "file",
      mime: "image/png",
      size: 100,
      width: 10,
      height: 10,
    });
  const count = async (table: string) =>
    (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`))
      .rows[0].n;
  const before = await job();
  assert.ok(
    await getOwnedJob(before.id, installationId),
    "basic analysis is available without quality consent",
  );
  assert.equal(await count("quality_review_jobs"), 0);
  await db.query(
    `INSERT INTO analytics_events (event_id,installation_id,sequence_number,event_name,occurred_at,received_at,properties_json)
     VALUES ('legacy-event',$1,1,'app_started',$2,$2,'{}')`,
    [installationId, new Date().toISOString()],
  );
  await db.exec(SCHEMA);
  assert.equal(
    await count("analytics_events"),
    0,
    "migration removes telemetry without optional consent evidence",
  );
  assert.ok(
    await getOwnedJob(before.id, installationId),
    "migration retains basic jobs",
  );
  assert.equal((await setConsent(true, false)).consentId, null);
  await job();
  assert.equal(
    await count("quality_review_jobs"),
    0,
    "partial permission is insufficient",
  );
  const granted = await setConsent(true, true);
  assert.ok(granted.consentId);
  assert.equal(
    await count("quality_review_jobs"),
    0,
    "regrant never includes historical uploads",
  );
  const eligible = await job();
  assert.equal(await count("quality_review_jobs"), 1);
  const describedCut: CutResult = {
    route: "core", count_confidence: "high", detector_count: 1, vlm_count: 1,
    image: { width: 10, height: 10 }, notes: [],
    inference_metadata: {
      deployment_version: "test", vlm_provider: "mock", vlm_model: "mock",
      pose_backend: "mock", pose_model_version: "test", pose_library_version: "test", feature_version: 1,
    },
    people: [{ index: 0, box: [0, 0, 10, 10], tags: {}, skeleton: null,
      confidence: "low", candidates: [], search_routing: { semantic_evidence: {
        status: "valid", description: { search_text: "오른팔을 머리 위로 올린 자세" },
      } },
    }],
  };
  for (const target of [before, eligible]) {
    await persistAnalysisRecords(target.id, mapCutResult(target.id, describedCut), [], extractPersonSignals(describedCut));
  }
  const privateTags = await db.query<{ job_id: string; person_tags_json: string | null }>(
    "SELECT job_id, person_tags_json FROM analysis_people WHERE job_id IN ($1,$2)", [before.id, eligible.id],
  );
  assert.equal(privateTags.rows.find((row) => row.job_id === before.id)?.person_tags_json, null);
  assert.equal(JSON.parse(privateTags.rows.find((row) => row.job_id === eligible.id)!.person_tags_json!)
    .poseDescription.searchText, "오른팔을 머리 위로 올린 자세");
  const sameGrant = await setConsent(true, true);
  assert.equal(
    sameGrant.consentId,
    granted.consentId,
    "idempotent retry preserves the grant",
  );
  await db.query(
    `INSERT INTO analysis_candidates (job_id,person_index,candidate_id,pose_id,rank,view,match_level,tags_json,pose_library_version)
    VALUES ($1,0,'candidate','pose',1,'front','high','{}','test')`,
    [eligible.id],
  );
  assert.equal(
    await confirmSelections(installationId, eligible.id, [
      { personIndex: 0, candidateId: "candidate" },
    ]),
    true,
  );
  await recordExport({
    installationId,
    jobId: eligible.id,
    personIndex: 0,
    candidateId: "candidate",
    status: "completed",
  });
  assert.equal(
    await saveFeedback(installationId, eligible.id, "good", null),
    false,
  );
  assert.equal(
    await saveFeedback(installationId, before.id, "good", granted.consentId),
    false,
  );
  assert.equal(
    await saveFeedback(installationId, eligible.id, "good", granted.consentId),
    true,
  );
  const sendEvent = async (
    epoch: string | null,
    jobId = eligible.id,
    occurredAt = new Date().toISOString(),
  ) => {
    const res = await app.request("/v1/events/batch", {
      method: "POST",
      headers,
      body: JSON.stringify({
        qualityConsentId: epoch,
        events: [
          {
            eventId: `evt_${crypto.randomUUID()}`,
            name: "results_viewed",
            sequence: 1,
            occurredAt,
            jobId,
            properties: {},
          },
        ],
      }),
    });
    assert.equal(res.status, 200);
    return ((await res.json()) as { accepted: number }).accepted;
  };
  assert.equal(
    await sendEvent(null),
    0,
    "legacy clients cannot submit optional telemetry",
  );
  assert.equal(await sendEvent(granted.consentId, before.id), 0);
  assert.equal(
    await sendEvent(granted.consentId, eligible.id, "2020-01-01T00:00:00Z"),
    0,
  );
  assert.equal(await sendEvent(granted.consentId), 1);
  for (const path of [
    "/overview",
    "/product",
    "/timeseries",
    "/review/jobs",
    "/review/installations",
    "/gallery/folders?group=date",
    "/review/jobs/" + eligible.id,
  ]) {
    const res = await app.request("/v1/admin" + path, {
      headers: adminHeaders,
    });
    assert.equal(res.status, 200, path + ": " + (await res.text()));
  }
  assert.equal(
    (
      await app.request("/v1/admin/review/jobs/" + before.id, {
        headers: adminHeaders,
      })
    ).status,
    404,
  );
  const detail = await app.request("/v1/admin/review/jobs/" + eligible.id, {
    headers: adminHeaders,
  });
  assert.match(detail.headers.get("cache-control") ?? "", /no-store/);
  const reviewed = await detail.json() as { people: Array<{ poseDescription: { searchText: string } }> };
  assert.equal(reviewed.people[0].poseDescription.searchText, "오른팔을 머리 위로 올린 자세");
  const expiredBasic = await job();
  await db.query("UPDATE jobs SET created_at=$2 WHERE id=$1", [
    expiredBasic.id,
    new Date(Date.now() - 91 * 86_400_000).toISOString(),
  ]);
  assert.equal(await getOwnedJob(expiredBasic.id, installationId), undefined);
  assert.equal(
    (
      await app.request("/v1/admin/review/jobs/" + expiredBasic.id + "/input", {
        headers: adminHeaders,
      })
    ).status,
    404,
  );
  await setConsent(false, true);
  assert.equal(
    (await db.query("SELECT id FROM jobs WHERE id=$1", [expiredBasic.id])).rows
      .length,
    0,
    "withdrawal immediately removes review jobs whose basic retention already expired",
  );
  for (const table of [
    "quality_review_jobs",
    "quality_review_confirmed_selections",
    "analytics_events",
    "export_events",
    "job_feedback",
  ])
    assert.equal(await count(table), 0, table);
  assert.ok(await getOwnedJob(eligible.id, installationId));
  assert.equal((await db.query<{ person_tags_json: string | null }>(
    "SELECT person_tags_json FROM analysis_people WHERE job_id=$1", [eligible.id],
  )).rows[0].person_tags_json, null, "withdrawal clears the stored natural-language description");
  assert.equal(
    await count("confirmed_selections"),
    1,
    "the owner's saved export selection survives",
  );
  assert.ok(
    (
      await listJobHistory(installationId, {
        limit: 20,
        cursor: null,
        status: null,
      })
    ).length,
  );
  for (const suffix of [
    "",
    "/input",
    "/refined/0/bvh?candidateId=candidate",
    "/refined/0/thumbnail?candidateId=candidate",
    "/refined/0/fbx?candidateId=candidate",
  ]) {
    assert.equal(
      (
        await app.request("/v1/admin/review/jobs/" + eligible.id + suffix, {
          headers: adminHeaders,
        })
      ).status,
      404,
      suffix,
    );
  }
  assert.equal(await sendEvent(granted.consentId), 0);
  const again = await setConsent(true, true);
  assert.notEqual(again.consentId, granted.consentId);
  assert.equal(await sendEvent(granted.consentId), 0);
  assert.equal(
    await sendEvent(again.consentId),
    0,
    "old jobs remain excluded after regrant",
  );
  assert.equal(await count("quality_review_jobs"), 0);
  assert.ok(await job());
  assert.equal(await count("quality_review_jobs"), 1);
  assert.ok(await count("quality_consent_receipts"));
  await setConsent(false, false);
  await db.query("UPDATE jobs SET created_at = $1", [
    new Date(Date.now() - 91 * 86_400_000).toISOString(),
  ]);
  await db.transaction(async (tx) => {
    await deleteExpiredRows({ query: (sql, values) => tx.query(sql, values) });
  });
  assert.equal(
    await count("jobs"),
    0,
    "withdrawn/basic data does not inherit the 365-day review retention",
  );
});

test("review guard denies every direct file route and rechecks after slow work", async () => {
  let active = true;
  let visited = false;
  const app = new Hono<AppEnv>();
  app.use(
    "*",
    qualityReviewGuard(async () => active),
  );
  app.get("/v1/admin/review/jobs/:id/refined/:index/fbx", async (c) => {
    visited = true;
    active = false; // withdrawal commits while Converter is running
    return c.text("private file");
  });
  const response = await app.request(
    "/v1/admin/review/jobs/job_test/refined/0/fbx",
  );
  assert.equal(visited, true);
  assert.equal(response.status, 404);
  assert.doesNotMatch(await response.text(), /private file/);
  visited = false;
  assert.equal(
    (await app.request("/v1/admin/review/jobs/job_test/refined/0/fbx")).status,
    404,
  );
  assert.equal(visited, false);
});

test("staging switch: review views ignore consent but still hide revoked installations", async (t) => {
  const { qualityReviewViews } = await import("./qualityConsent.js");
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(SCHEMA);
  const now = new Date().toISOString();
  const install = (id: string, revokedAt: string | null) =>
    db.query(
      `INSERT INTO installations (id, token_hash, consent_version, consented_at, created_at, last_seen_at,
         app_version, os_name, os_version, architecture, locale, revoked_at)
       VALUES ($1, 'h', 'v', $2, $2, $2, '0', 'windows', '11', 'x64', 'ko', $3)`,
      [id, now, revokedAt],
    );
  await install("inst_open", null);
  await install("inst_revoked", now);
  for (const [id, installationId] of [["job_open", "inst_open"], ["job_revoked", "inst_revoked"]]) {
    await db.query(
      "INSERT INTO jobs (id, installation_id, status, created_at, updated_at) VALUES ($1, $2, 'completed', $3, $3)",
      [id, installationId, now],
    );
  }
  const visible = async () =>
    (await db.query<{ id: string }>("SELECT id FROM quality_review_jobs ORDER BY id")).rows.map((r) => r.id);

  assert.deepEqual(await visible(), [], "default: no consent, nothing to review");
  await db.exec(qualityReviewViews(true));
  assert.deepEqual(await visible(), ["job_open"]);
  assert.equal(
    (await db.query("SELECT 1 FROM quality_review_installations WHERE id = 'inst_revoked'")).rows.length,
    0,
  );
  await db.exec(qualityReviewViews(false));
  assert.deepEqual(await visible(), [], "turning the switch off restores the consent scope");
});

test("count views include unconsented installations but expose no content columns", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(SCHEMA);
  const now = new Date().toISOString();
  for (const [id, revoked] of [["inst_plain", null], ["inst_gone", now]] as const) {
    await db.query(
      `INSERT INTO installations (id, token_hash, consent_version, consented_at, created_at, last_seen_at,
         app_version, os_name, os_version, architecture, locale, revoked_at)
       VALUES ($1, 'h', 'v', $2, $2, $2, '0', 'windows', '11', 'x64', 'ko', $3)`,
      [id, now, revoked],
    );
    await db.query(
      "INSERT INTO jobs (id, installation_id, status, created_at, updated_at, input_s3_key) VALUES ($1, $2, 'completed', $3, $3, 'k')",
      ["job_" + id, id, now],
    );
  }
  assert.equal((await db.query("SELECT 1 FROM quality_review_jobs")).rows.length, 0, "review scope is unchanged");
  assert.deepEqual((await db.query<{ id: string }>("SELECT id FROM ops_count_installations")).rows.map((r) => r.id), ["inst_plain"]);
  assert.deepEqual((await db.query<{ id: string }>("SELECT id FROM ops_count_jobs")).rows.map((r) => r.id), ["job_inst_plain"]);
  const columns = (await db.query<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'ops_count_jobs' ORDER BY column_name",
  )).rows.map((r) => r.column_name);
  assert.deepEqual(columns, ["created_at", "id", "installation_id", "status"]);
});

test("internal installations are hidden from review and count views while the switch is on", async (t) => {
  const { qualityReviewViews } = await import("./qualityConsent.js");
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(SCHEMA);
  await db.exec(qualityReviewViews(true));
  const now = new Date().toISOString();
  for (const id of ["inst_dev", "inst_user"]) {
    await db.query(
      `INSERT INTO installations (id, token_hash, consent_version, consented_at, created_at, last_seen_at,
         app_version, os_name, os_version, architecture, locale)
       VALUES ($1, 'h', 'v', $2, $2, $2, '0', 'windows', '11', 'x64', 'ko')`,
      [id, now],
    );
    await db.query(
      "INSERT INTO jobs (id, installation_id, status, created_at, updated_at) VALUES ($1, $2, 'completed', $3, $3)",
      ["job_" + id, id, now],
    );
  }
  const ids = async (sql: string) => (await db.query<{ id: string }>(sql)).rows.map((r) => r.id).sort();
  await db.query("INSERT INTO internal_installations (id, label, added_at) VALUES ('inst_dev', NULL, $1)", [now]);

  // 스위치 행이 없으면 켜진 것: 개발자를 뺀다.
  assert.deepEqual(await ids("SELECT id FROM quality_review_jobs"), ["job_inst_user"]);
  assert.deepEqual(await ids("SELECT id FROM ops_count_installations"), ["inst_user"]);

  await db.query(
    "INSERT INTO service_flags (key, value, updated_at) VALUES ('hide_internal_installations', 'false', $1)",
    [now],
  );
  assert.deepEqual(await ids("SELECT id FROM quality_review_jobs"), ["job_inst_dev", "job_inst_user"], "switch off shows developers again");
  assert.deepEqual(await ids("SELECT id FROM ops_count_jobs"), ["job_inst_dev", "job_inst_user"]);
});

test("the operator-provided developer seed is inserted only once", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(SCHEMA);
  const count = async () => (await db.query("SELECT 1 FROM internal_installations")).rows.length;
  assert.equal(await count(), 3);
  await db.query("DELETE FROM internal_installations WHERE id = 'inst_cc6832df-05a9-450f-9fb5-1e5f69b1e38c'");
  await db.exec(SCHEMA); // 다음 배포
  assert.equal(await count(), 2, "an unmarked developer must not come back on redeploy");
});
