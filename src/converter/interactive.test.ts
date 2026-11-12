import { test } from "node:test";
import assert from "node:assert/strict";
import { createInteractiveWorker } from "./interactive.js";
import { log, type LogFields } from "../log.js";
import { hash, type Operation } from "../interactive-state/model.js";
const op = {
  installationId: "owner",
  jobId: "job_test",
  personIndex: 0,
  operationId: "op_test",
  revision: 3,
  snapshotId: "private_nonce",
} as Operation;
const token = "local-test-service-token-32-characters";
test("transport separates Converter work, transfer and JSON parsing with operation correlation", async (t) => {
  const events: LogFields[] = [];
  t.mock.method(log, "info", (fields: LogFields) => events.push(fields));
  let requestId = "";
  const worker = createInteractiveWorker({
    baseUrl: "http://internal.invalid", token,
    fetch: (async (_input, init) => {
      requestId = (init!.headers as Record<string, string>)["X-Request-Id"];
      return new Response("{}", { headers: {
        "X-Standin-Queue-Wait-Ms": "1200.5", "X-Standin-Execution-Ms": "51000",
      } });
    }) as typeof fetch,
  });
  await worker.export(op, new AbortController().signal);
  assert.match(requestId, /^req_[a-f0-9-]{36}$/);
  const transport = events.find(e => e.type === "interactive_converter_transport")!;
  assert.equal(transport.requestId, requestId);
  assert.equal(transport.operationId, op.operationId);
  assert.equal(transport.converterQueueMs, 1200.5);
  assert.equal(transport.converterExecutionMs, 51000);
  assert.equal(transport.responseBytes, 2);
  assert.equal(transport.complete, true);
  assert.equal(transport.route, "/interactive/v1/snapshots/:snapshot/export");
  assert.equal(events.find(e => e.type === "interactive_converter_json")?.operationId, op.operationId);
  assert(!JSON.stringify(events).includes(token));
  assert(!JSON.stringify(events).includes("private_nonce"));
});
test("private transport binds ownership and cancellation revision without URL credentials", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const worker = createInteractiveWorker({
    baseUrl: "http://internal.invalid",
    token,
    fetch: (async (input, init) => {
      calls.push({ url: String(input), init: init! });
      return new Response(JSON.stringify({ cancelled: true }));
    }) as typeof fetch,
  });
  await worker.cancel(op);
  assert.equal(calls[0].url, "http://internal.invalid/interactive/v1/cancel");
  assert(!calls[0].url.includes(token));
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${token}`);
  const owner = hash({
    installationId: op.installationId,
    jobId: op.jobId,
    personIndex: op.personIndex,
  });
  assert.equal(headers["X-Standin-Owner"], owner);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    ownerBinding: owner,
    person: "0",
    revision: 3,
  });
});
test("unconfigured transport and path traversal never issue a request", async () => {
  let count = 0;
  const fetcher = (async () => {
    count++;
    return new Response();
  }) as typeof fetch;
  await assert.rejects(
    createInteractiveWorker({ baseUrl: "", token, fetch: fetcher }).model(op),
    /UNAVAILABLE/,
  );
  await assert.rejects(
    async () =>
      createInteractiveWorker({
        baseUrl: "http://internal.invalid",
        token,
        fetch: fetcher,
      }).model({ ...op, snapshotId: "../other" }),
    /INTEGRITY/,
  );
  assert.equal(count, 0);
});
test("mismatched response length and failed upstream status fail closed", async () => {
  const worker = createInteractiveWorker({
    baseUrl: "http://internal.invalid",
    token,
    fetch: (async () =>
      new Response("{}", {
        headers: { "Content-Length": "99" },
      })) as typeof fetch,
  });
  await assert.rejects(worker.model(op), /INTEGRITY/);
  const forbidden = createInteractiveWorker({
    baseUrl: "http://internal.invalid",
    token,
    fetch: (async () =>
      new Response("private upstream detail", { status: 401 })) as typeof fetch,
  });
  await assert.rejects(
    forbidden.model(op),
    (e) => e instanceof Error && !e.message.includes("private upstream detail"),
  );
});
test("stream size is bounded even without Content-Length", async () => {
  let pulls = 0;
  const chunk = new Uint8Array(8 * 1024 * 1024);
  const worker = createInteractiveWorker({
    baseUrl: "http://internal.invalid",
    token,
    fetch: (async () =>
      new Response(
        new ReadableStream({
          pull(c) {
            pulls++;
            c.enqueue(chunk);
          },
        }),
      )) as typeof fetch,
  });
  await assert.rejects(worker.model(op), /INTEGRITY/);
  assert(pulls <= 11);
});

test("missing or expired snapshot is a recoverable artifact expiry", async () => {
  for (const status of [404, 410]) {
    const worker = createInteractiveWorker({
      baseUrl: "http://internal.invalid",
      token,
      fetch: (async () => new Response("missing", { status })) as typeof fetch,
    });
    await assert.rejects(
      worker.model(op),
      (e) =>
        !!e &&
        typeof e === "object" &&
        "code" in e &&
        e.code === "INTERACTIVE_EXPIRED",
    );
  }
});

test("solve forwards the immutable BFF deadline and exact source bytes",async()=>{
 const expiresAt=new Date(Date.now()+3600000).toISOString();let sent:Record<string,unknown>|undefined;
 const worker=createInteractiveWorker({baseUrl:"http://internal.invalid",token,fetch:(async(_input,init)=>{sent=JSON.parse(String(init?.body));return Response.json({snapshotId:"private_snapshot",packet:{}})}) as typeof fetch});
 const source=new Uint8Array([0,1,2]);
 await worker.solve({identity:{source:"server"},bvhBytes:source} as unknown as Parameters<typeof worker.solve>[0],{...op,expiresAt},new AbortController().signal);
 assert.equal(sent?.expiresAt,expiresAt);assert.deepEqual(Buffer.from(String(sent?.bvhBase64),"base64"),Buffer.from(source));
});
