/** Real Hono + SQL store + queue, with a controlled worker fixture (not Blender evidence). */
import {
  fixtureSelection,
  fixturePacket,
  fixtureReceipt,
  syntheticFbx,
} from "./fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { INTERACTIVE_SCHEMA } from "./schema.js";
import { OperationStore, type Db, type Stage } from "./store.js";
import { InteractiveService } from "./service.js";
import { createInteractiveRoutes } from "./routes.js";
import {
  HTTP_SCHEMA,
  InteractiveError,
  hash,
  publicOperation,
  type Operation,
} from "./model.js";
import type { ResolvedSelection } from "./selection.js";
const owner = "inst_owner",
  job = "job_fixture";
async function setup() {
  const pg = new PGlite();
  await pg.exec(
    `CREATE TABLE installations(id TEXT PRIMARY KEY);CREATE TABLE jobs(id TEXT PRIMARY KEY,installation_id TEXT,status TEXT);INSERT INTO installations VALUES('inst_owner'),('inst_other');INSERT INTO jobs VALUES('job_fixture','inst_owner','completed');${INTERACTIVE_SCHEMA}`,
  );
  // PGlite serialises transactions and does not implement advisory locks; all other SQL is real.
  const adapt = (db: {
    query<T>(sql: string, args?: unknown[]): Promise<{ rows: T[] }>;
  }): Db => ({
    query: async <T>(sql: string, args?: unknown[]) =>
      sql.includes("pg_advisory_xact_lock")
        ? { rows: [] }
        : db.query<T>(sql, args),
  });
  let now = Date.now();
  const store = new OperationStore(
    (fn) => pg.transaction((tx) => fn(adapt(tx))),
    () => now,
  );
  const state = {
    selection: "first",
    valid: true,
    solveCalls: 0,
    exportCalls: 0,
    cancelCalls: 0,
    posterFail: false,
    auxiliary: 0,
    corruptFile: false,
    invalidReceipt: false,
    hold: undefined as Promise<void> | undefined,
    fileHold: undefined as Promise<void> | undefined,
    events: [] as string[],
    sent: [] as number[],
  };
  const resolver = async () => {
    if (!state.valid) throw new InteractiveError("NOT_FOUND", 404);
    return fixtureSelection(hash(state.selection));
  };
  const service = new InteractiveService({
    store,
    resolve: resolver,
    worker: {
      solve: async (_s, op, signal) => {
        state.solveCalls++;
        state.sent.push(op.revision);
        await state.hold;
        if (signal.aborted) throw new Error("aborted");
        return { snapshotId: "snapshot", packet: fixturePacket(op) };
      },
      model: async (op) => Buffer.from(JSON.stringify(fixturePacket(op))),
      export: async (op) => {
        state.exportCalls++;
        await state.hold;
        const receipt = fixtureReceipt(op);
        return state.invalidReceipt ? { ...receipt, verified: false } : receipt;
      },
      file: async () => {
        await state.fileHold;
        return state.corruptFile
          ? Buffer.from("unverified bytes")
          : syntheticFbx;
      },
      cancel: async () => {
        state.cancelCalls++;
      },
    },
    posters: {
      publishAuxiliary: async () => {
        state.auxiliary++;
      },
      publish: async () => ({ sha256: hash("png"), renderer: "fixture" }),
      read: async () => Buffer.from("png"),
    },
    renderPoster: async () => {
      if (state.posterFail) throw new Error("capture");
      return Buffer.from("png");
    },
    metric: (e) => state.events.push(e),
  });
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("installationId", c.req.header("X-Owner") ?? owner);
    c.set("requestId", "req_fixture");
    await next();
  });
  app.route(
    "/v1/analysis/jobs",
    createInteractiveRoutes(service, () => true),
  );
  const base = `/v1/analysis/jobs/${job}/people/0/interactive-state`;
  const request = (path = "", method = "GET", body?: unknown, as = owner) =>
    app.request(`${base}${path}`, {
      method,
      headers: { "X-Owner": as, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const prepare = (
    revision = 1,
    expectedRevision = 0,
    mutationId = `mutation-${revision}`,
    extra = {},
  ) =>
    request("", "POST", {
      schemaVersion: HTTP_SCHEMA,
      candidateId: "candidate",
      revision,
      expectedRevision,
      expectedStateHash: null,
      mutationId,
      ...extra,
    });
  const read = (id: string) =>
    store.get({ installationId: owner, jobId: job, personIndex: 0 }, id);
  return {
    app,
    pg,
    store,
    state,
    service,
    prepare,
    request,
    read,
    advance: () => {
      now += 3600001;
    },
    tick: (s: Stage) => service.tick(s),
  };
}
test("prepare is immediate; repeated mutation is idempotent; request does not accept client matrices", async () => {
  const s = await setup();
  try {
    const r = await s.prepare();
    assert.equal(r.status, 202);
    const o = await r
      .json()
      .then((v) => v as ReturnType<typeof publicOperation>);
    assert.equal(o.previewState, "solving");
    assert.equal(o.stateHash, null);
    assert.equal(s.state.solveCalls, 0);
    const replay = await s.prepare();
    assert.equal(replay.status, 200);
    assert.equal(
      (await replay.json().then((v) => v as ReturnType<typeof publicOperation>))
        .operationId,
      o.operationId,
    );
    assert.equal(
      (await s.prepare(1, 0, "mutation-1", { matrices: [] })).status,
      400,
    );
    assert.equal((await s.prepare(2, 0, "mutation-1")).status, 409);
    assert.equal((await s.request(`/${o.operationId}/file`)).status, 409);
    assert.equal(
      (await s.request(`/${o.operationId}/export`, "POST")).status,
      409,
    );
  } finally {
    await s.pg.close();
  }
});
test("full polling/model/export/file path separates preparation, PNG and native save events", async () => {
  const s = await setup();
  try {
    const o = await (await s.prepare())
      .json()
      .then((v) => v as ReturnType<typeof publicOperation>);
    await s.tick("preview");
    let current = await s.read(o.operationId);
    assert.equal(current.previewState, "authoritative");
    assert.equal(current.exportState, "not-requested");
    assert.equal((await s.request(`/${o.operationId}/model`)).status, 200);
    assert.equal((await s.request(`/${o.operationId}/file`)).status, 409);
    assert.equal(
      (await s.request(`/${o.operationId}/export`, "POST")).status,
      202,
    );
    await s.request(`/${o.operationId}/export`, "POST");
    await s.tick("export");
    current = await s.read(o.operationId);
    assert.equal(current.exportState, "ready");
    assert.equal(s.state.exportCalls, 1);
    s.state.posterFail = true;
    await s.tick("poster");
    assert.equal((await s.read(o.operationId)).exportState, "ready");
    const file = await s.request(`/${o.operationId}/file`);
    assert.equal(file.status, 200);
    assert.equal(await file.text(), syntheticFbx.toString());
    assert.match(file.headers.get("Content-Disposition")!, /pose-r1.fbx/);
    assert.equal(file.headers.get("Cache-Control"), "private, no-store");
    assert.ok(s.state.events.includes("artifact_download_delivered"));
    assert.ok(!s.state.events.includes("export_completed"));
    assert.ok(!s.state.events.includes("native_save_completed"));
  } finally {
    await s.pg.close();
  }
});
test("latest wins: queued older revision never runs; late running response cannot publish", async () => {
  const s = await setup();
  try {
    const a = await (await s.prepare())
      .json()
      .then((v) => v as ReturnType<typeof publicOperation>);
    const b = await (await s.prepare(2, 1))
      .json()
      .then((v) => v as ReturnType<typeof publicOperation>);
    await s.tick("preview");
    assert.deepEqual(s.state.sent, [2]);
    assert.equal((await s.request(`/${a.operationId}`)).status, 409);
    assert.equal((await s.read(b.operationId)).previewState, "authoritative");
    let release!: () => void;
    s.state.hold = new Promise<void>((r) => (release = r));
    const c = await (await s.prepare(3, 2))
      .json()
      .then((v) => v as ReturnType<typeof publicOperation>);
    const pending = s.tick("preview");
    while (s.state.solveCalls < 2) await new Promise((r) => setTimeout(r, 1));
    const d = await (await s.prepare(4, 3))
      .json()
      .then((v) => v as ReturnType<typeof publicOperation>);
    release();
    await pending;
    assert.equal((await s.request(`/${c.operationId}`)).status, 409);
    assert.equal((await s.read(d.operationId)).previewState, "solving");
    await s.tick("preview");
    assert.equal((await s.read(d.operationId)).previewState, "authoritative");
    assert.equal((await s.prepare(5, 2)).status, 409);
  } finally {
    await s.pg.close();
  }
});
test("hand/refine/body/scope changes invalidate ready downloads, including changes during delivery", async () => {
  for (const changed of [
    "hands",
    "refine",
    "body",
    "shape",
    "scope",
    "camera",
    "lineage",
  ]) {
    const s = await setup();
    try {
      const o = await (await s.prepare())
        .json()
        .then((v) => v as ReturnType<typeof publicOperation>);
      await s.tick("preview");
      await s.request(`/${o.operationId}/export`, "POST");
      await s.tick("export");
      let release!: () => void;
      s.state.fileHold = new Promise<void>((r) => (release = r));
      const delivery = s.request(`/${o.operationId}/file`);
      await new Promise((r) => setTimeout(r, 5));
      s.state.selection = changed;
      release();
      assert.equal((await delivery).status, 409, changed);
      assert.equal((await s.request(`/${o.operationId}`)).status, 409);
      assert.ok(!s.state.events.includes("artifact_download_delivered"));
    } finally {
      await s.pg.close();
    }
  }
});
test("cross-installation, expiry, cancellation, parent deletion and old poster pointer are fenced", async () => {
  const s = await setup();
  try {
    const o = await (await s.prepare())
      .json()
      .then((v) => v as ReturnType<typeof publicOperation>);
    assert.equal(
      (await s.request(`/${o.operationId}`, "GET", undefined, "inst_other"))
        .status,
      404,
    );
    assert.equal((await s.request(`/${o.operationId}`, "DELETE")).status, 200);
    assert.equal((await s.request(`/${o.operationId}`, "DELETE")).status, 200);
    await s.tick("preview");
    assert.equal(s.state.solveCalls, 0);
    assert.equal((await s.request(`/${o.operationId}/file`)).status, 409);
    const b = await (await s.prepare(2, 1))
      .json()
      .then((v) => v as ReturnType<typeof publicOperation>);
    await s.tick("preview");
    await s.request(`/${b.operationId}/export`, "POST");
    await s.tick("export");
    await s.tick("poster");
    assert.ok((await s.read(b.operationId)).poster);
    const old = await s.read(b.operationId);
    const c = await (await s.prepare(3, 2))
      .json()
      .then((v) => v as ReturnType<typeof publicOperation>);
    assert.equal(
      await s.store.update(old, {
        poster: { sha256: hash("late"), renderer: "late" },
      }),
      null,
    );
    s.advance();
    assert.equal((await s.request(`/${c.operationId}`)).status, 410);
    await s.pg.query(`DELETE FROM jobs WHERE id=$1`, [job]);
    assert.equal((await s.request(`/${c.operationId}`)).status, 404);
  } finally {
    await s.pg.close();
  }
});

test("head recovery and asynchronous history archive survive artifact expiry; client frame is auxiliary only", async () => {
  const s = await setup();
  try {
    const initial = await s.request("?candidateId=candidate");
    assert.equal(
      ((await initial.json()) as { currentRevision: number }).currentRevision,
      0,
    );
    const prepared = await s.prepare(),
      op = (await prepared.json()) as ReturnType<typeof publicOperation>;
    await s.tick("preview");
    const current = await s.read(op.operationId);
    const png = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    png.writeUInt32BE(1, 16);
    png.writeUInt32BE(1, 20);
    const frame = {
      schemaVersion: HTTP_SCHEMA,
      revision: 1,
      stateHash: current.stateHash,
      cameraHash: hash("camera"),
      rendererVersion: "canvas-v1",
      imageSha256: (await import("../converter/client.js")).sha256Hex(png),
      pngBase64: png.toString("base64"),
      source: "client-canvas-ui-auxiliary",
    };
    const uploaded = await s.request(
      `/${op.operationId}/client-frame`,
      "POST",
      frame,
    );
    assert.equal(uploaded.status, 201);
    assert.equal(
      ((await uploaded.json()) as { fileSafetyEvidence: boolean })
        .fileSafetyEvidence,
      false,
    );
    assert.equal((await s.read(op.operationId)).poster, null);
    assert.equal(
      await s.store.frame({
        installationId: owner,
        jobId: job,
        personIndex: 0,
      }),
      null,
    );
    assert.equal(
      (await s.request(`/${op.operationId}/client-frame`, "POST", frame))
        .status,
      201,
    );
    assert.equal(s.state.auxiliary, 1);
    assert.equal(
      (
        await s.request(`/${op.operationId}/client-frame`, "POST", {
          ...frame,
          revision: 2,
        })
      ).status,
      409,
    );
    await s.request(`/${op.operationId}/export`, "POST");
    await s.tick("export");
    await s.tick("poster");
    const location = { installationId: owner, jobId: job, personIndex: 0 };
    assert.ok((await s.service.historyFrame(location)).bytes);
    s.advance();
    assert.equal((await s.request(`/${op.operationId}`)).status, 410);
    assert.ok((await s.service.historyFrame(location)).bytes);
    const head = await s.request("?candidateId=candidate");
    assert.equal(
      ((await head.json()) as { currentRevision: number }).currentRevision,
      1,
    );
    s.state.selection = "new hand";
    await assert.rejects(s.service.historyFrame(location), /NOT_FOUND/);
  } finally {
    await s.pg.close();
  }
});
test("simultaneous prepare compare-and-swap has one winner and distinct people keep their own head", async () => {
  const s = await setup();
  try {
    const attempts = await Promise.all([
      s.prepare(1, 0, "concurrent-a"),
      s.prepare(2, 0, "concurrent-b"),
    ]);
    assert.deepEqual(attempts.map((r) => r.status).sort(), [202, 409]);
    const second = await s.app.request(
      `/v1/analysis/jobs/${job}/people/1/interactive-state`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schemaVersion: HTTP_SCHEMA,
          candidateId: "candidate",
          revision: 1,
          expectedRevision: 0,
          expectedStateHash: null,
          mutationId: "person-two",
        }),
      },
    );
    assert.equal(second.status, 202);
    const head0 = await s.store.currentHead({
        installationId: owner,
        jobId: job,
        personIndex: 0,
      }),
      head1 = await s.store.currentHead({
        installationId: owner,
        jobId: job,
        personIndex: 1,
      });
    assert.notEqual(head0?.operationId, head1?.operationId);
  } finally {
    await s.pg.close();
  }
});

test("running cancellation aborts and fences late response; byte corruption never delivers", async () => {
  const s = await setup();
  try {
    const op = (await (await s.prepare()).json()) as ReturnType<
      typeof publicOperation
    >;
    let release!: () => void;
    s.state.hold = new Promise<void>((r) => (release = r));
    const running = s.tick("preview");
    while (!s.state.solveCalls) await new Promise((r) => setTimeout(r, 1));
    assert.equal((await s.request(`/${op.operationId}`, "DELETE")).status, 200);
    release();
    await running;
    assert.equal((await s.read(op.operationId)).previewState, "cancelled");
    assert.ok(!s.state.events.includes("artifact_prepare_ready"));
    s.state.hold = undefined;
    const next = (await (await s.prepare(2, 1)).json()) as ReturnType<
      typeof publicOperation
    >;
    await s.tick("preview");
    s.state.invalidReceipt = true;
    await s.request(`/${next.operationId}/export`, "POST");
    await s.tick("export");
    const failed = await s.read(next.operationId);
    assert.equal(failed.previewState, "authoritative");
    assert.equal(failed.exportState, "failed");
    assert.equal((await s.request(`/${next.operationId}/model`)).status, 200);
    s.state.invalidReceipt = false;
    await s.request(`/${next.operationId}/export`, "POST");
    await s.tick("export");
    s.state.corruptFile = true;
    assert.equal((await s.request(`/${next.operationId}/file`)).status, 409);
    assert.ok(!s.state.events.includes("artifact_download_delivered"));
  } finally {
    await s.pg.close();
  }
});
test("a reclaimed lease rejects an old worker publication even without a new revision", async () => {
  const s = await setup();
  try {
    await s.prepare();
    const first = await s.store.claim("preview");
    assert.ok(first);
    await s.pg.query(
      `UPDATE interactive_operations SET lease_until=now()-interval '1 second' WHERE id=$1`,
      [first.op.operationId],
    );
    const second = await s.store.claim("preview");
    assert.ok(second);
    assert.notEqual(first.leaseId, second.leaseId);
    assert.equal(
      await s.store.update(first.op, { previewState: "error" }, first.leaseId),
      null,
    );
    assert.ok(
      await s.store.update(
        second.op,
        { previewState: "error" },
        second.leaseId,
      ),
    );
  } finally {
    await s.pg.close();
  }
});
