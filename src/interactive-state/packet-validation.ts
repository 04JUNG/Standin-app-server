import { Worker } from "node:worker_threads";
import { InteractiveError, type Operation } from "./model.js";
import type { ResolvedSelection } from "./selection.js";
import type { parsePacket } from "./packet.js";

type Proof = ReturnType<typeof parsePacket>["snapshotProof"];
type Result = { stateHash: string; snapshotProof: Proof };
type Job = { run(): void };
const pending: Job[] = [];
let running = false;

function pump() {
  if (running) return;
  const job = pending.shift();
  if (job) { running = true; job.run(); }
}

/** One memory-heavy validation at a time, with bounded admission and cancellable leases. */
export function validatePacketAsync(raw: unknown, op: Operation, selection: ResolvedSelection,
  signal: AbortSignal): Promise<Result> {
  if (signal.aborted) return Promise.reject(new InteractiveError("INTERACTIVE_SUPERSEDED"));
  if (pending.length >= 4) return Promise.reject(new InteractiveError("INTERACTIVE_VALIDATION_BUSY", 503));
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
      try {
        worker = new Worker(new URL("./packet-worker.js", import.meta.url), {
          workerData: { raw,
            op: { operationId: op.operationId, revision: op.revision, personIndex: op.personIndex,
              candidateId: op.candidateId, stateHash: op.stateHash, snapshotProof: op.snapshotProof, skinPreview: op.skinPreview },
            selection: { identity: selection.identity, originalSha: selection.originalSha,
              sourceSha: selection.sourceSha, characterId: selection.characterId, body: selection.body,
              defaultShapeRules: selection.defaultShapeRules, hands: selection.hands,
              scope: selection.scope, camera: selection.camera } },
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
