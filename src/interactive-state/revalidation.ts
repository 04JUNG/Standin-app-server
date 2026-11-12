import { setTimeout as sleep } from "node:timers/promises";
import { ConverterError } from "../converter/client.js";
import { InteractiveError } from "./model.js";

/** Retry only read-only runtime validation, never solve/export or failed integrity checks. */
export async function recoverValidation<T>(
  validate: () => Promise<T>, signal: AbortSignal, expiresAt: string,
  retried: (code: string) => void,
  timing = { now: Date.now, sleep: (ms: number, signal: AbortSignal) => sleep(ms, undefined, { signal }) },
): Promise<T> {
  const deadline = Math.min(timing.now() + 120_000, Date.parse(expiresAt));
  let failures = 0;
  for (;;) {
    signal.throwIfAborted();
    if (timing.now() >= deadline) throw new InteractiveError("BODY_PREVIEW_UNAVAILABLE", 503);
    try {
      const result = await validate();
      signal.throwIfAborted();
      return result;
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof InteractiveError || error instanceof ConverterError) ||
          error.code !== "BODY_PREVIEW_UNAVAILABLE") throw error;
      const remaining = deadline - timing.now();
      if (remaining <= 0) throw error;
      retried(error.code);
      await timing.sleep(Math.min(remaining, 1000 * 2 ** Math.min(failures++, 3)), signal);
    }
  }
}
