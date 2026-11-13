import { Worker } from "node:worker_threads";
import { InteractiveError, type Operation } from "./model.js";
import type { ResolvedSelection } from "./selection.js";
import type { parsePacket } from "./packet.js";
import type { BinaryPacketMeta } from "./packetV2.js";

type Proof = ReturnType<typeof parsePacket>["snapshotProof"];
type Result = { stateHash: string; snapshotProof: Proof };
type Input = { kind: "v1"; raw: unknown } | { kind: "v2"; meta: BinaryPacketMeta; bytes: Uint8Array };
type Job = { run(): void };
const pending: Job[] = [];
let running = false;

function pump() {
  if (running) return;
  const job = pending.shift();
  if (job) { running = true; job.run(); }
}

/** Both encodings share one memory-heavy validator, four queued slots and a total deadline. */
function validate(input: Input, op: Operation, selection: ResolvedSelection,
  signal: AbortSignal): Promise<Result> {
  if (signal.aborted) return Promise.reject(new InteractiveError("INTERACTIVE_SUPERSEDED"));
  if (pending.length >= 4) return Promise.reject(new InteractiveError("INTERACTIVE_VALIDATION_BUSY", 503));
  const deadline = Date.now() + 120_000;
  return new Promise((resolve, reject) => {
    let worker: Worker | undefined, timer: NodeJS.Timeout | undefined, finished = false;
    const complete = (error?: Error, result?: Result) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener("abort", abort);
      clearTimeout(timer);
      const index = pending.indexOf(job);
      if (index >= 0) pending.splice(index, 1);
      const settle = () => { if (error) reject(error); else resolve(result!); };
      const release = () => { running = false; pump(); settle(); };
      if (worker) void worker.terminate().then(release, release);
      else if (index < 0) release();
      else settle();
    };
    const abort = () => complete(new InteractiveError("INTERACTIVE_SUPERSEDED"));
    const job: Job = { run() {
      if (Date.now() >= deadline) {
        complete(new InteractiveError("INTERACTIVE_VALIDATION_TIMEOUT", 503));
        return;
      }
      try {
        // Transfer a private aligned copy. Never detach the transport/caller's Buffer or
        // retain decoded geometry in the HTTP process. Copy only after admission to run.
        const data = input.kind === "v2"
          ? { kind: input.kind, meta: input.meta, bytes: Uint8Array.from(input.bytes) }
          : input;
        worker = new Worker(new URL("./packet-worker.js", import.meta.url), {
          workerData: { ...data,
            op: { operationId: op.operationId, revision: op.revision, personIndex: op.personIndex,
              candidateId: op.candidateId, stateHash: op.stateHash, snapshotProof: op.snapshotProof, skinPreview: op.skinPreview },
            selection: { identity: selection.identity, originalSha: selection.originalSha,
              sourceSha: selection.sourceSha, characterId: selection.characterId, body: selection.body,
              defaultShapeRules: selection.defaultShapeRules, hands: selection.hands,
              scope: selection.scope, camera: selection.camera } },
          ...(data.kind === "v2" ? { transferList: [data.bytes.buffer] } : {}),
          resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 16 },
        });
        worker.once("message", (value) => {
          if (value.errorCode) complete(new InteractiveError(value.errorCode));
          else complete(undefined, value);
        });
        worker.once("error", () => complete(new InteractiveError("INTERACTIVE_VALIDATION_UNAVAILABLE", 503)));
        worker.once("exit", () => { if (!finished) complete(new InteractiveError("INTERACTIVE_VALIDATION_UNAVAILABLE", 503)); });
      } catch { complete(new InteractiveError("INTERACTIVE_VALIDATION_UNAVAILABLE", 503)); }
    } };
    // Deadline includes queue wait; cancellation cannot leave an orphaned worker.
    timer = setTimeout(() => complete(new InteractiveError("INTERACTIVE_VALIDATION_TIMEOUT", 503)), 120_000);
    signal.addEventListener("abort", abort, { once: true });
    pending.push(job);
    pump();
  });
}

/** Unchanged v1 canonical, geometry, identity and skin checks, off the HTTP event loop. */
export function validatePacketAsync(raw: unknown, op: Operation, selection: ResolvedSelection,
  signal: AbortSignal): Promise<Result> {
  return validate({ kind: "v1", raw }, op, selection, signal);
}

/** Unchanged v2 reader/schema, identity, snapshot proof and skin pins in the same worker. */
export function validateBinaryPacketAsync(meta: BinaryPacketMeta, bytes: Uint8Array, op: Operation,
  selection: ResolvedSelection, signal: AbortSignal): Promise<Result> {
  return validate({ kind: "v2", meta, bytes }, op, selection, signal);
}
