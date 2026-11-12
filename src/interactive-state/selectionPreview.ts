/** Ephemeral read-only use of the existing canonical solver; no stored/exportable operation. */
import { randomUUID } from "node:crypto";
import {
  hash,
  InteractiveError,
  type Location,
  type Operation,
} from "./model.js";
import type { parsePacket } from "./packet.js";
import { validatePacketAsync } from "./packet-validation.js";
import type { ResolvedSelection } from "./selection.js";
import type { InteractiveWorker } from "./worker.js";

type Running = { abort: AbortController; done: Promise<void> };
export class SelectionPreviewService {
  private current = new Map<string, Running>();
  private active = 0;
  private readonly namespace = randomUUID();
  private revision = 0;
  private inFlight = 0;
  constructor(
    private resolve: (
      location: Location,
      candidate: string,
    ) => Promise<ResolvedSelection>,
    private worker: InteractiveWorker,
  ) {}
  async preview(
    location: Location,
    candidateId: string,
    bodyRevision: number,
    requestSignal: AbortSignal,
  ) {
    const key = hash(location),
      previous = this.current.get(key);
    if (this.inFlight >= 16)
      throw new InteractiveError("INTERACTIVE_BUSY", 429);
    this.inFlight++;
    previous?.abort.abort();
    const abort = new AbortController();
    const signal = AbortSignal.any([
      abort.signal,
      requestSignal,
      AbortSignal.timeout(120_000),
    ]);
    let finish!: () => void;
    const running = {
      abort,
      done: new Promise<void>((resolve) => {
        finish = resolve;
      }),
    };
    this.current.set(key, running);
    let op: Operation | undefined,
      entered = false;
    try {
      // A replacement waits for its predecessor's cancellation/cleanup; never overlaps a body bake.
      await previous?.done;
      signal.throwIfAborted();
      if (this.active >= 2) throw new InteractiveError("INTERACTIVE_BUSY", 429);
      this.active++;
      entered = true;
      const selection = await this.resolve(location, candidateId);
      if (selection.body.selectionRevision !== bodyRevision)
        throw new InteractiveError("BODY_PREVIEW_STALE");
      signal.throwIfAborted();
      // A process/job-specific preview namespace isolates export and keeps owner-bound body caches reusable.
      const isolated = {
        ...location,
        jobId: `selection-preview:${this.namespace}:${location.jobId}`,
      };
      const previewSelection = {
        ...selection,
        identity: { ...selection.identity, ownerBinding: hash(isolated) },
      };
      const now = new Date().toISOString();
      op = {
        ...isolated,
        operationId: `op_${randomUUID()}`,
        candidateId,
        revision: ++this.revision,
        selectionHash: hash(previewSelection.identity),
        stateHash: null,
        previewState: "solving",
        exportState: "not-requested",
        eventSequence: 0,
        createdAt: now,
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
        mutationId: randomUUID(),
        requestHash: hash([key, candidateId, bodyRevision]),
        errorCode: null,
        snapshotProof: null,
        snapshotId: null,
        receipt: null,
        poster: null,
      };
      const solved = await this.worker.solve(previewSelection, op, signal);
      op.snapshotId = solved.snapshotId;
      signal.throwIfAborted();
      await validatePacketAsync(solved.packet, op, previewSelection, signal);
      const current = await this.resolve(location, candidateId);
      if (current.selectionHash !== selection.selectionHash)
        throw new InteractiveError("PREVIEW_CHANGED");
      signal.throwIfAborted();
      return {
        schemaVersion: "standin.selection-preview.v1" as const,
        previewOnly: true as const,
        bodyRevision,
        packet: solved.packet as ReturnType<typeof parsePacket>["packet"],
      };
    } finally {
      if (op) await this.worker.cancel(op).catch(() => undefined);
      if (entered) this.active--;
      this.inFlight--;
      if (this.current.get(key) === running) this.current.delete(key);
      finish();
    }
  }
}
