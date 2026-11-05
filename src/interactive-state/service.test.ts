/** Real Hono + SQL store + queue, with a controlled worker fixture (not Blender evidence). */
import {
  fixtureSelection,
  fixturePacket,
  fixtureReceipt,
  syntheticFbx,
} from "./fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import { sha256Hex } from "../converter/client.js";
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
    outlineAvailable: false,
    outlineCalls: 0,
    corruptOutlineFile: false,
    outlineHold: undefined as Promise<void> | undefined,
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
    // Controlled postprocess fixture only. Real Converter verification is tested separately.
    outline: {
      check: async () => { if (!state.outlineAvailable) throw new InteractiveError("OUTLINE_NOT_CSP_CERTIFIED", 503); },
      prepare: async (op, _selection, source, signal) => {
        state.outlineCalls++;
        assert.deepEqual(source, syntheticFbx);
        await state.outlineHold;
        if (signal.aborted) throw new Error("aborted");
        return { artifactSha256: sha256Hex(Buffer.concat([syntheticFbx, Buffer.from("!")])), artifactBytes: syntheticFbx.length + 1 };
      },
      file: async () => { await state.fileHold; return state.corruptOutlineFile ? Buffer.from("corrupt outlined bytes") : Buffer.concat([syntheticFbx, Buffer.from("!")]); },
    },
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
    const o = await (
      await s.prepare()
    )
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
    const a = await (
      await s.prepare()
    )
      .json()
      .then((v) => v as ReturnType<typeof publicOperation>);
    const b = await (
      await s.prepare(2, 1)
    )
      .json()
      .then((v) => v as ReturnType<typeof publicOperation>);
    await s.tick("preview");
    assert.deepEqual(s.state.sent, [2]);
    assert.equal((await s.request(`/${a.operationId}`)).status, 409);
    assert.equal((await s.read(b.operationId)).previewState, "authoritative");
    let release!: () => void;
    s.state.hold = new Promise<void>((r) => (release = r));
    const c = await (
      await s.prepare(3, 2)
    )
      .json()
      .then((v) => v as ReturnType<typeof publicOperation>);
    const pending = s.tick("preview");
    while (s.state.solveCalls < 2) await new Promise((r) => setTimeout(r, 1));
    const d = await (
      await s.prepare(4, 3)
    )
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
      const o = await (
        await s.prepare()
      )
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
    const o = await (
      await s.prepare()
    )
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
    const b = await (
      await s.prepare(2, 1)
    )
      .json()
      .then((v) => v as ReturnType<typeof publicOperation>);
    await s.tick("preview");
    await s.request(`/${b.operationId}/export`, "POST");
    await s.tick("export");
    await s.tick("poster");
    assert.ok((await s.read(b.operationId)).poster);
    const old = await s.read(b.operationId);
    const c = await (
      await s.prepare(3, 2)
    )
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

test("lost Converter snapshot revokes durable ready and head recovery permits a new revision", async () => {
  const s = await setup();
  try {
    const op = (await (await s.prepare()).json()) as ReturnType<
      typeof publicOperation
    >;
    await s.tick("preview");
    await s.request(`/${op.operationId}/export`, "POST");
    await s.tick("export");
    assert.equal((await s.read(op.operationId)).exportState, "ready");
    s.service.deps.worker.file = async () => {
      throw new InteractiveError("INTERACTIVE_EXPIRED", 410);
    };
    assert.equal((await s.request(`/${op.operationId}/file`)).status, 410);
    assert.equal((await s.read(op.operationId)).previewState, "superseded");
    const head = (await (await s.request("?candidateId=candidate")).json()) as {
      operation: unknown;
      currentRevision: number;
      currentStateHash: string;
    };
    assert.equal(head.operation, null);
    assert.equal(head.currentRevision, 1);
    assert.equal(
      (
        await s.prepare(2, 1, "restart-recovery", {
          expectedStateHash: head.currentStateHash,
        })
      ).status,
      202,
    );
  } finally {
    await s.pg.close();
  }
});


test("zero keeps legacy identity and mutation reuse; malformed and unsupported appearance fail before work", async () => {
  const s = await setup();
  try {
    const op = await (await s.prepare()).json() as ReturnType<typeof publicOperation>;
    const replay = await s.prepare(1, 0, "mutation-1", { appearance: { version: "fbx-outline-v1", width: 0 } });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json() as typeof op).operationId, op.operationId);
    assert.ok(!("appearance" in op));
    for (const appearance of [null, {}, { version: "v2", width: 1 }, { version: "fbx-outline-v1", width: "1" },
      { version: "fbx-outline-v1", width: true }, { version: "fbx-outline-v1", width: -1 },
      { version: "fbx-outline-v1", width: 2.1 }, { version: "fbx-outline-v1", width: 1, color: "black" }]) {
      assert.equal((await s.prepare(2, 1, "invalid-outline", { appearance })).status, 400);
    }
    assert.equal((await s.prepare(2, 1, "blocked-outline", { appearance: { version: "fbx-outline-v1", width: 1 } })).status, 503);
    assert.equal(s.state.solveCalls, 0);
    assert.equal((await s.read(op.operationId)).previewState, "solving", "failed new preparation retains previous operation");
    const head = await (await s.request("?candidateId=candidate")).json() as { appearanceExport: { available: boolean } };
    assert.equal(head.appearanceExport.available, false);
  } finally { await s.pg.close(); }
});

test("nonzero appearance versions final artifact and head; repeated export reuses the current result", async () => {
  const s = await setup();
  try {
    s.state.outlineAvailable = true;
    const appearance = { version: "fbx-outline-v1", width: 1 };
    const op = await (await s.prepare(1, 0, "outline-first", { appearance })).json() as ReturnType<typeof publicOperation>;
    assert.deepEqual(op.appearance, appearance);
    await s.tick("preview");
    await s.request(`/${op.operationId}/export`, "POST");
    await s.tick("export");
    const current = await s.read(op.operationId);
    assert.equal(current.exportState, "ready");
    const ready = publicOperation(current);
    assert.equal(ready.exportReceipt?.artifactSha256, sha256Hex(Buffer.concat([syntheticFbx, Buffer.from("!")])));
    assert.equal(ready.exportReceipt?.artifactBytes, syntheticFbx.length + 1);
    const file = await s.request(`/${op.operationId}/file`);
    assert.equal(file.status, 200);
    assert.equal(await file.text(), syntheticFbx.toString() + "!");
    assert.equal(file.headers.get("X-Standin-Artifact-Contract"), "outlined-fbx-v1");
    assert.equal(file.headers.get("X-Standin-Artifact-SHA256"), sha256Hex(Buffer.concat([syntheticFbx, Buffer.from("!")])));
    await s.request(`/${op.operationId}/export`, "POST");
    await s.tick("export");
    assert.equal(s.state.exportCalls, 1);
    assert.equal(s.state.outlineCalls, 1);
    s.state.corruptOutlineFile = true;
    assert.equal((await s.request(`/${op.operationId}/file`)).status, 409);
    s.state.corruptOutlineFile = false;
    const legacyHead = await (await s.request("?candidateId=candidate")).json() as { operation: unknown };
    assert.equal(legacyHead.operation, null);
    const matchingHead = await (await s.request("?" + new URLSearchParams({ candidateId: "candidate", appearance: JSON.stringify(appearance) }))).json() as { operation: { operationId: string } };
    assert.equal(matchingHead.operation.operationId, op.operationId);
    assert.equal((await s.prepare(2, 1, "outline-first", { appearance: { ...appearance, width: 2 } })).status, 409);
    const next = await s.prepare(2, 1, "outline-next", { appearance: { ...appearance, width: 2 } });
    assert.equal(next.status, 202);
    assert.equal((await s.request(`/${op.operationId}/file`)).status, 409);
  } finally { await s.pg.close(); }
});

test("appearance changes or cancel fence late postprocessing and download responses", async () => {
  for (const cancel of [false, true]) {
    const s = await setup();
    try {
      s.state.outlineAvailable = true;
      const appearance = { version: "fbx-outline-v1", width: 1 };
      const op = await (await s.prepare(1, 0, "late-outline", { appearance })).json() as ReturnType<typeof publicOperation>;
      await s.tick("preview");
      await s.request(`/${op.operationId}/export`, "POST");
      let release!: () => void;
      s.state.outlineHold = new Promise<void>(r => release = r);
      const pending = s.tick("export");
      while (!s.state.outlineCalls) await new Promise(r => setTimeout(r, 1));
      if (cancel) await s.request(`/${op.operationId}`, "DELETE");
      else assert.equal((await s.prepare(2, 1, "new-outline", { appearance: { ...appearance, width: 2 } })).status, 202);
      release(); await pending;
      assert.equal((await s.request(`/${op.operationId}/file`)).status, 409);
      assert.ok(!s.state.events.includes("artifact_download_delivered"));
    } finally { await s.pg.close(); }
  }
  const s = await setup();
  try {
    s.state.outlineAvailable = true;
    const appearance = { version: "fbx-outline-v1", width: .5 };
    const op = await (await s.prepare(1, 0, "download-old", { appearance })).json() as ReturnType<typeof publicOperation>;
    await s.tick("preview"); await s.request(`/${op.operationId}/export`, "POST"); await s.tick("export");
    let release!: () => void;
    s.state.fileHold = new Promise<void>(r => release = r);
    const pending = s.request(`/${op.operationId}/file`);
    await new Promise(r => setTimeout(r, 5));
    await s.prepare(2, 1, "download-new", { appearance: { ...appearance, width: 2 } });
    release(); assert.equal((await pending).status, 409);
    assert.ok(!s.state.events.includes("artifact_download_delivered"));
  } finally { await s.pg.close(); }
});

test("operation export validates snapshot body and refuses ignored appearance fields or URL overrides", async () => {
  const s = await setup();
  try {
    const op = await (await s.prepare()).json() as ReturnType<typeof publicOperation>;
    await s.tick("preview");
    const ready = await s.read(op.operationId);
    assert.equal((await s.request(`/${op.operationId}/export`, "POST", { revision: ready.revision, stateHash: ready.stateHash })).status, 202);
    for (const body of [
      { revision: ready.revision, stateHash: ready.stateHash, appearance: { version: "fbx-outline-v1", width: 1 } },
      { outlineWidth: 1 }, { unsupportedField: true },
    ]) assert.equal((await s.request(`/${op.operationId}/export`, "POST", body)).status, 400);
    assert.equal((await s.request(`/${op.operationId}/export`, "POST", { revision: 2, stateHash: ready.stateHash })).status, 409);
    await s.tick("export");
    assert.equal((await s.request(`/${op.operationId}/file?appearance=` + encodeURIComponent(JSON.stringify({ version: "fbx-outline-v1", width: 1 })))).status, 400);
    assert.equal((await s.request(`/${op.operationId}/file`)).status, 200);
  } finally { await s.pg.close(); }
});
