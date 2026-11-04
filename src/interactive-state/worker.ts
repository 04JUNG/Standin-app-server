import type { Operation } from "./model.js";
import type { ResolvedSelection } from "./selection.js";
/** Internal adapter only; never grant release permission from this interface. */
export interface InteractiveWorker {
  solve(
    selection: ResolvedSelection,
    op: Operation,
    signal: AbortSignal,
  ): Promise<{ snapshotId: string; packet: unknown }>;
  model(op: Operation, signal?: AbortSignal): Promise<Uint8Array>;
  export(op: Operation, signal: AbortSignal): Promise<Record<string, unknown>>;
  file(op: Operation, signal?: AbortSignal): Promise<Uint8Array>;
  cancel(op: Operation): Promise<void>;
}
