import test from "node:test";
import assert from "node:assert/strict";
import { SelectionPreviewService } from "./selectionPreview.js";
import { fixturePacket, fixtureSelection } from "./fixture.js";
import { sha256Hex } from "../converter/client.js";
import type { InteractiveWorker } from "./worker.js";
import type { Operation } from "./model.js";
const location = { installationId: "owner", jobId: "job_test", personIndex: 0 };
function setup() {
  let revision = 1,
    count = 0,
    delay = false;
  const operations: Operation[] = [],
    cancelled: Operation[] = [];
  const selection = () => {
    const s = fixtureSelection(String(revision));
    s.body.selectionRevision = revision;
    return s;
  };
  const worker: InteractiveWorker = {
    async solve(s, op, signal) {
      operations.push(op);
      count++;
      if (delay && count === 1)
        await new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(Error("aborted")), {
            once: true,
          }),
        );
      const packet = fixturePacket(op),
        typed = JSON.parse(packet.canonicalState);
      typed.identity.ownerBinding = s.identity.ownerBinding;
      packet.canonicalState = JSON.stringify(typed);
      packet.stateHash = sha256Hex(Buffer.from(packet.canonicalState));
      return { snapshotId: "preview_snapshot", packet };
    },
    cancel: async (op) => {
      cancelled.push(op);
    },
    export: async () => {
      throw Error("preview must never export");
    },
    file: async () => {
      throw Error("preview must never read files");
    },
    model: async () => {
      throw Error("preview uses canonical solve packet");
    },
  };
  const service = new SelectionPreviewService(async () => selection(), worker);
  return {
    service,
    operations,
    cancelled,
    setRevision: (r: number) => {
      revision = r;
    },
    delay: () => {
      delay = true;
    },
  };
}
test("unconfirmed preview uses isolated namespace, never exports, and cleans every snapshot", async () => {
  const t = setup();
  const result = await t.service.preview(
    location,
    "candidate",
    1,
    new AbortController().signal,
  );
  assert.equal(result.previewOnly, true);
  assert.equal(result.bodyRevision, 1);
  assert.equal(result.packet.exportState, "not-requested");
  assert.notEqual(t.operations[0].jobId, location.jobId);
  assert.equal(t.operations[0].receipt, null);
  assert.deepEqual(t.cancelled, t.operations);
});
test("stale body revision is rejected before any solver call", async () => {
  const t = setup();
  t.setRevision(2);
  await assert.rejects(
    () =>
      t.service.preview(location, "candidate", 1, new AbortController().signal),
    /BODY_PREVIEW_STALE/,
  );
  assert.equal(t.operations.length, 0);
});
test("rapid replacement aborts and drains old request before the latest request runs", async () => {
  const t = setup();
  t.delay();
  const first = t.service.preview(
    location,
    "candidate",
    1,
    new AbortController().signal,
  );
  const rejected = assert.rejects(first, /aborted/);
  while (!t.operations.length)
    await new Promise((resolve) => setImmediate(resolve));
  const latest = t.service.preview(
    location,
    "candidate",
    1,
    new AbortController().signal,
  );
  await rejected;
  assert.equal((await latest).previewOnly, true);
  assert.equal(t.cancelled.length, 2);
  assert.equal(t.operations[0].jobId, t.operations[1].jobId);
  assert(t.operations[1].revision > t.operations[0].revision);
});
test("body mutation during solve revokes response and still cleans snapshot", async () => {
  const t = setup();
  const pending = t.service.preview(
    location,
    "candidate",
    1,
    new AbortController().signal,
  );
  queueMicrotask(() => t.setRevision(2));
  await assert.rejects(pending, /PREVIEW_CHANGED/);
  assert.equal(t.cancelled.length, 1);
});

test("HTTP endpoint is gated, bounds payloads, and creates no exportable stored operation", async () => {
  const { Hono } = await import("hono");
  const { createInteractiveRoutes } = await import("./routes.js");
  const { InteractiveError } = await import("./model.js");
  let enabled = false;
  const t = setup();
  const app = new Hono<import("../env.js").AppEnv>();
  app.use("*", async (c, next) => {
    c.set("installationId", "owner");
    c.set("requestId", "preview-test");
    await next();
  });
  const exportService = {
    current: async () => {
      throw new InteractiveError("NOT_FOUND", 404);
    },
  } as unknown as import("./service.js").InteractiveService;
  app.route(
    "/v1/analysis/jobs",
    createInteractiveRoutes(exportService, () => enabled, t.service),
  );
  const path = "/v1/analysis/jobs/job_test/people/0/selection-preview";
  const post = (body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await post({ candidateId: "candidate", bodyRevision: 1 })).status,
    503,
  );
  enabled = true;
  assert.equal(
    (await post({ candidateId: "x".repeat(5000), bodyRevision: 1 })).status,
    413,
  );
  assert.equal(
    (await post({ candidateId: "candidate", bodyRevision: 1, export: true }))
      .status,
    400,
  );
  const response = await post({ candidateId: "candidate", bodyRevision: 1 });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(
    ((await response.json()) as { previewOnly: boolean }).previewOnly,
    true,
  );
  const operation = t.operations[0].operationId;
  assert.equal(
    (
      await app.request(
        `/v1/analysis/jobs/job_test/people/0/interactive-state/${operation}/file`,
      )
    ).status,
    404,
  );
});
