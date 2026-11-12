import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { EXPECTED_SOLVER_VERSION } from "../converter/client.js";
import { FRAMING_VERSION } from "../converter/framing.js";
import { probeDeadline, probeOnce, type ProbeDeadline } from "../converter/probeDeadline.js";
import { HandAgreement, type HandAgreementDeps } from "./agreement.js";
import { parseCatalog, type HandCatalog } from "./model.js";

const catalog: HandCatalog = parseCatalog({
  schema_version: 1,
  library_version: "hand-library-v1",
  library_sha256: "a".repeat(64),
  default_preset: "relaxed",
  fallback_order: ["relaxed"],
  thumbnails_available: false,
  categories: [{ id: "basic", label: "기본", presets: [{ id: "relaxed", label: "relaxed", description: "relaxed", thumbnails: null }] }],
});
const health = {
  ok: true,
  solver_version: EXPECTED_SOLVER_VERSION,
  framing_version: FRAMING_VERSION,
  output_scopes: ["full", "half", "bust", "head"],
  hand_library: { version: catalog.library_version, sha256: catalog.library_sha256 },
};
const timeoutError = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");
/** Blocks this thread like a synchronous legacy v1 packet validation does. */
function stall(ms: number) {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    /* busy */
  }
}

/**
 * Fake Converter on its own thread. It tells the BFF thread when /healthz arrived,
 * then answers `respondAfterMs` later, while the BFF thread is stalled.
 */
async function fakeConverter(respondAfterMs: number) {
  const worker = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    const http = require("node:http");
    const server = http.createServer((req, res) => {
      parentPort.postMessage("received");
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(workerData.health));
      }, workerData.respondAfterMs);
    });
    server.listen(0, "127.0.0.1", () => parentPort.postMessage(server.address().port));
    parentPort.on("message", (m) => { if (m === "close") server.close(() => process.exit(0)); });
    `,
    { eval: true, workerData: { health, respondAfterMs } },
  );
  const [port] = (await once(worker, "message")) as [number];
  return {
    url: `http://127.0.0.1:${port}/healthz`,
    received: () => once(worker, "message"),
    close: async () => {
      worker.postMessage("close");
      await once(worker, "exit");
    },
  };
}

test("reproduction: a /healthz answer that lands during a BFF stall must not become HANDS_UNAVAILABLE", async () => {
  const wallClock = (ms: number): ProbeDeadline => ({
    signal: AbortSignal.timeout(ms),
    stalledMs: () => 0,
    clear: () => {},
  });
  // Pre-fix probe: wall-clock AbortSignal.timeout. Fixed probe: responsive deadline.
  for (const [name, deadline, expectOk] of [
    ["wall-clock timeout", wallClock, false],
    ["responsive deadline", (ms: number) => probeDeadline(ms), true],
  ] as const) {
    const converter = await fakeConverter(100);
    try {
      const agreement = new HandAgreement(
        {
          enabled: () => true,
          catalog: async () => catalog,
          health: (init) => fetch(converter.url, init),
        },
        { probeTimeoutMs: 600, deadline },
      );
      const received = converter.received();
      const result = agreement.read(true).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      // Stall in an I/O continuation, as v1 parsePacket does after the solve response.
      // The Converter answers 100 ms into the stall, well inside the 600 ms budget. On the
      // next loop turn Node runs expired timers before it reads that socket.
      await received;
      stall(1500);
      const outcome = await result;
      assert.equal(outcome.ok, expectOk, name);
      if (outcome.ok) assert.equal(outcome.value.library_sha256, catalog.library_sha256);
      else assert.equal((outcome.error as { code?: string }).code, "HANDS_UNAVAILABLE");
    } finally {
      await converter.close();
    }
  }
});

test("probe deadline credits a stall as one short tick and still times out on a silent Converter", async () => {
  const deadline = probeDeadline(300);
  const wall = AbortSignal.timeout(300);
  stall(1000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await sleep(0);
  assert.equal(wall.aborted, true, "a wall-clock timeout fires as soon as the loop resumes");
  assert.equal(deadline.signal.aborted, false, "the stall is not charged to the Converter");
  assert.ok(deadline.stalledMs() >= 600);
  await sleep(600);
  assert.equal(deadline.signal.aborted, true, "responsive waiting still has a bound");
  assert.equal((deadline.signal.reason as Error).name, "TimeoutError");
  const cleared = probeDeadline(50);
  cleared.clear();
  await sleep(120);
  assert.equal(cleared.signal.aborted, false);
});

function harness(options: { graceMs?: number } = {}) {
  const clock = { now: 0 };
  const calls = { health: 0, catalog: 0 };
  let respond: () => Promise<Response> = async () => Response.json(health);
  let readCatalog: () => Promise<HandCatalog> = async () => catalog;
  const deps: HandAgreementDeps = {
    enabled: () => true,
    catalog: () => {
      calls.catalog++;
      return readCatalog();
    },
    health: () => {
      calls.health++;
      return respond();
    },
  };
  const agreement = new HandAgreement(deps, { now: () => clock.now, ...options });
  return {
    agreement,
    clock,
    calls,
    deps,
    health: (fn: () => Promise<Response>) => (respond = fn),
    catalog: (fn: () => Promise<HandCatalog>) => (readCatalog = fn),
  };
}

test("slow or unavailable Converter reuses an agreement verified within the grace window", async () => {
  for (const failure of [
    async () => {
      throw timeoutError();
    },
    async () => {
      throw new TypeError("fetch failed");
    },
    async () => new Response("busy", { status: 503 }),
    async () => new Response("slow down", { status: 429 }),
  ]) {
    const h = harness();
    assert.equal((await h.agreement.read(true)).library_sha256, catalog.library_sha256);
    h.health(failure);
    h.clock.now = 60_000;
    assert.equal((await h.agreement.read(true)).library_sha256, catalog.library_sha256);
    assert.equal((await h.agreement.read(false)).library_sha256, catalog.library_sha256);
    h.clock.now = 120_001;
    await assert.rejects(h.agreement.read(true), { code: "HANDS_UNAVAILABLE" });
  }
});

test("an inference catalog outage is tolerated the same way, never extended past the grace", async () => {
  const h = harness();
  await h.agreement.read(true);
  h.catalog(async () => {
    throw new Error("inference down");
  });
  h.clock.now = 30_000;
  assert.equal((await h.agreement.read(true)).library_sha256, catalog.library_sha256);
  h.clock.now = 200_000;
  await assert.rejects(h.agreement.read(true), { code: "HANDS_UNAVAILABLE" });
});

test("a Converter that answers with a different library fails closed at once and forgets the agreement", async () => {
  const mismatches = [
    { ...health, hand_library: { ...health.hand_library, sha256: "b".repeat(64) } },
    { ...health, hand_library: null },
    { ...health, output_scopes: ["full"] },
    { ...health, solver_version: "other" },
    { ...health, ok: false },
  ];
  for (const body of mismatches) {
    const h = harness();
    await h.agreement.read(true);
    h.clock.now = 10_000;
    h.health(async () => Response.json(body));
    await assert.rejects(h.agreement.read(true), { code: "HANDS_UNAVAILABLE" });
    // The old agreement is gone: a following timeout is not tolerated.
    h.health(async () => {
      throw timeoutError();
    });
    h.clock.now = 11_000;
    await assert.rejects(h.agreement.read(false), { code: "HANDS_UNAVAILABLE" });
  }
  const h = harness();
  await h.agreement.read(true);
  h.clock.now = 10_000;
  h.health(async () => new Response("not json", { status: 200 }));
  await assert.rejects(h.agreement.read(true), { code: "HANDS_UNAVAILABLE" });
});

test("no prior agreement means no tolerance", async () => {
  const h = harness();
  h.health(async () => {
    throw timeoutError();
  });
  await assert.rejects(h.agreement.read(false), { code: "HANDS_UNAVAILABLE" });
});

test("fresh reads accept 2 s old evidence, listing reads 5 s, and concurrent reads share one probe", async () => {
  const h = harness();
  await h.agreement.read(true);
  assert.equal(h.calls.health, 1);
  h.clock.now = 1_999;
  await h.agreement.read(true);
  assert.equal(h.calls.health, 1);
  h.clock.now = 2_000;
  await h.agreement.read(false);
  assert.equal(h.calls.health, 1, "listing evidence lasts 5 s");
  await h.agreement.read(true);
  assert.equal(h.calls.health, 2, "fresh evidence lasts 2 s");
  h.clock.now = 10_000;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  h.health(async () => {
    await gate;
    return Response.json(health);
  });
  const reads = Promise.all([h.agreement.read(true), h.agreement.read(true), h.agreement.read(false)]);
  release();
  await reads;
  assert.equal(h.calls.health, 3, "three concurrent reads, one probe");
});

test("the feature switch closes readiness even with a fresh agreement", async () => {
  let enabled = true;
  const h = harness();
  const agreement = new HandAgreement({ ...h.deps, enabled: () => enabled }, { now: () => h.clock.now });
  await agreement.read(true);
  enabled = false;
  await assert.rejects(agreement.read(true), { code: "HAND_SELECTION_DISABLED" });
});

/**
 * Fake Converter that, like uvicorn, sends no Keep-Alive hint and closes an idle socket
 * on its own after `idleCloseMs` (uvicorn: 5 s). undici then keeps the socket pooled for
 * its default 4 s and cannot learn of the close while this thread is stalled.
 */
async function keepAliveConverter(idleCloseMs: number) {
  const worker = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    const net = require("node:net");
    const body = JSON.stringify(workerData.health);
    const CRLF = String.fromCharCode(13, 10);
    const server = net.createServer((socket) => {
      let idle;
      socket.on("data", () => {
        clearTimeout(idle);
        socket.write(["HTTP/1.1 200 OK", "Content-Type: application/json",
          "Content-Length: " + Buffer.byteLength(body), "", body].join(CRLF));
        idle = setTimeout(() => socket.destroy(), workerData.idleCloseMs);
      });
      socket.on("error", () => {});
    });
    server.listen(0, "127.0.0.1", () => parentPort.postMessage(server.address().port));
    parentPort.on("message", (m) => { if (m === "close") server.close(() => process.exit(0)); });
    `,
    { eval: true, workerData: { health, idleCloseMs } },
  );
  const [port] = (await once(worker, "message")) as [number];
  return {
    url: `http://127.0.0.1:${port}/healthz`,
    close: async () => {
      worker.postMessage("close");
      await once(worker, "exit");
    },
  };
}

test("a probe after a stall that outlives the Converter's idle close still verifies", async (t) => {
  // Sequence from the skin investigation (node:20-slim + uvicorn, 6-10 s stalls): a second
  // request just before a stall that outlives the Converter's idle close (uvicorn 5 s).
  // In node:20-slim the single attempt failed with UND_ERR_SOCKET 8/8 and HandAgreement
  // failed 3/3 without probeOnce. Whether the closed socket is reused depends on host timing
  // (Windows and some CI runners notice the close first), so only the fixed path is asserted.
  const outcomes: Record<string, string> = {};
  for (const fixed of [false, true]) {
    const converter = await keepAliveConverter(300);
    try {
      await (await fetch(converter.url)).text();
      const inflight = fetch(converter.url).then((r) => r.text());
      await sleep(50);
      stall(800);
      const agreement = new HandAgreement(
        { enabled: () => true, catalog: async () => catalog, health: (init) => fetch(converter.url, init) },
        { freshMs: 0 },
      );
      outcomes[fixed ? "fixed" : "single attempt"] = await (fixed
        ? agreement.read(true).then(() => "ok", (e: { code?: string }) => e.code ?? "error")
        : fetch(converter.url).then(
            (r) => r.text().then(() => "ok"),
            (e: { cause?: { code?: string } }) => e.cause?.code ?? "error",
          ));
      await inflight.catch(() => {});
    } finally {
      await converter.close();
    }
  }
  t.diagnostic(`single attempt without retry: ${outcomes["single attempt"]}`);
  assert.equal(outcomes.fixed, "ok");
});

test("only a stale connection is retried, once, inside the same deadline", async () => {
  const socketError = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: { code } });
  const h = harness();
  let calls = 0;
  h.health(async () => {
    calls++;
    if (calls === 1) throw socketError("UND_ERR_SOCKET");
    return Response.json(health);
  });
  assert.equal((await h.agreement.read(true)).library_sha256, catalog.library_sha256);
  assert.equal(calls, 2);
  for (const code of ["ECONNREFUSED", "ENOTFOUND"]) {
    const other = harness();
    let attempts = 0;
    other.health(async () => {
      attempts++;
      throw socketError(code);
    });
    await assert.rejects(other.agreement.read(true), { code: "HANDS_UNAVAILABLE" });
    assert.equal(attempts, 1, code);
  }
  const twice = harness();
  let attempts = 0;
  twice.health(async () => {
    attempts++;
    throw socketError("UND_ERR_SOCKET");
  });
  await assert.rejects(twice.agreement.read(true), { code: "HANDS_UNAVAILABLE" });
  assert.equal(attempts, 2);
});
