import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { PoolClient } from "pg";
import type { AppEnv } from "../env.js";
import { mapCutResult } from "../mapping.js";
import type { CutResult } from "../inference.js";
import { resolveOutputScope } from "./model.js";
import { writeOutputScope } from "./store.js";
import { createOutputScopeRoutes } from "./routes.js";

test("manual override preserves detection, auto restores it, old response stays unknown", () => {
  const auto = resolveOutputScope({ detected: "half", detectionSource: "vlm_person" });
  const manual = resolveOutputScope({ ...auto, selection: "head" });
  assert.equal(manual.detected, "half");
  assert.equal(manual.resolved, "head");
  assert.deepEqual(resolveOutputScope({ ...manual, selection: "auto" }), auto);
  assert.equal(resolveOutputScope().resolutionSource, "fallback");
  assert.equal(resolveOutputScope().detected, null);
});

test("mapping preserves per-person scopes including a search-skipped person", () => {
  const cut: CutResult = {
    route: "bust", count_confidence: "n/a", detector_count: 0, vlm_count: 2,
    image: { width: 100, height: 100 }, notes: [],
    inference_metadata: { deployment_version: "test", vlm_provider: "mock", vlm_model: "mock",
      pose_backend: "mock", pose_model_version: "1", pose_library_version: "1", feature_version: 1 },
    people: ["head", "bust"].map((detected, index) => ({
      index, box: null, tags: {}, skeleton: null, confidence: "low", candidates: [],
      output_scope: { detected, source: "vlm_person" }, lower_body_observed: false,
    })),
  };
  const people = mapCutResult("job_test", cut).candidatesByPerson;
  assert.deepEqual(people.map((p) => p.outputScope?.resolved), ["head", "bust"]);
  assert.ok(people.every((p) => !p.refineAllowed && p.fallbackMode === "hard"));
  delete cut.people[0]!.output_scope;
  assert.equal(mapCutResult("job_test", cut).candidatesByPerson[0]?.outputScope?.detected, null);
});

test("storage is owned, locked, preserves other person and policies, and round-trips", async () => {
  let json = JSON.stringify({ candidatesByPerson: [0, 1].map((personIndex) => ({
    personIndex, refineAllowed: false, candidates: [],
    outputScope: resolveOutputScope({ detected: "half", detectionSource: "vlm_person" }),
  })) });
  const query = async (sql: string, params: unknown[]) => {
    assert.deepEqual(params.slice(0, 2), ["job_test", "inst_owner"]);
    if (sql.startsWith("SELECT")) {
      assert.match(sql, /installation_id = \$2 FOR UPDATE$/);
      return { rows: [{ status: "completed", result_json: json }] };
    }
    json = params[2] as string;
    return { rows: [], rowCount: 1 };
  };
  const client = { query } as unknown as Pick<PoolClient, "query">;
  await writeOutputScope(client, "job_test", "inst_owner", 0, "head");
  await writeOutputScope(client, "job_test", "inst_owner", 1, "bust");
  let people = JSON.parse(json).candidatesByPerson;
  assert.deepEqual(people.map((p: { outputScope: { resolved: string } }) => p.outputScope.resolved), ["head", "bust"]);
  await writeOutputScope(client, "job_test", "inst_owner", 0, "auto");
  people = JSON.parse(json).candidatesByPerson;
  assert.equal(people[0].outputScope.resolved, "half");
  assert.equal(people[1].outputScope.resolved, "bust");
  assert.equal(people[0].refineAllowed, false);
  const before = json;
  assert.deepEqual(await writeOutputScope(client, "job_test", "inst_owner", 9, "full"), { ok: false, reason: "person_not_found" });
  assert.equal(json, before);
});

test("storage refuses missing/foreign and unfinished jobs without writing", async () => {
  for (const [rows, reason] of [
    [[], "not_found"], [[{ status: "running", result_json: null }], "not_ready"],
  ] as const) {
    const client = { query: async (sql: string) => {
      assert.ok(sql.startsWith("SELECT")); return { rows };
    } } as unknown as Pick<PoolClient, "query">;
    assert.deepEqual(await writeOutputScope(client, "job", "foreign", 0, "full"), { ok: false, reason });
  }
});

test("HTTP validates selection/index, passes authenticated owner, never accepts forged detection", async () => {
  let calls = 0;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("installationId", "inst_owner"); c.set("requestId", "test"); await next(); });
  app.route("/", createOutputScopeRoutes(async (job, owner, index, selection) => {
    calls++;
    assert.deepEqual([job, owner, index], ["job_test", "inst_owner", 0]);
    return { ok: true, outputScope: resolveOutputScope({ selection }) };
  }));
  const send = (index: string, body: unknown) => app.request(`/job_test/people/${index}/output-scope`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  for (const body of [null, [], {}, { selection: "waist" }, { selection: "half", detected: "full" }]) {
    assert.equal((await send("0", body)).status, 400);
  }
  for (const index of ["-1", "0.1", "NaN", "9007199254740992"]) {
    assert.equal((await send(index, { selection: "full" })).status, 400);
  }
  assert.equal(calls, 0);
  const response = await send("0", { selection: "half" });
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { outputScope: { resolved: string } }).outputScope.resolved, "half");
  assert.equal(calls, 1);
});
