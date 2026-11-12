import type { Operation, StateEncoding } from "./model.js";
import type { ResolvedSelection } from "./selection.js";
/** Internal adapter only; never grant release permission from this interface. */
export interface InteractiveWorker {
  /**
   * Without options the request is byte-identical to the original v1 call. `stateEncoding`
   * asks the Converter for that encoding; the answer may still be v1 (older Converter or its
   * kill switch). `stateEncoding` in the result echoes the Converter's response header, if any.
   */
  solve(
    selection: ResolvedSelection,
    op: Operation,
    signal: AbortSignal,
    options?: { stateEncoding?: StateEncoding },
  ): Promise<{ snapshotId: string; packet: unknown; stateEncoding?: string }>;
  /** `mediaType` makes the transport reject a response with any other Content-Type. */
  model(op: Operation, signal?: AbortSignal, mediaType?: string): Promise<Uint8Array>;
  export(op: Operation, signal: AbortSignal): Promise<Record<string, unknown>>;
  file(op: Operation, signal?: AbortSignal): Promise<Uint8Array>;
  cancel(op: Operation): Promise<void>;
  variants?(op: Operation, signal?: AbortSignal): Promise<Uint8Array>;
}
