/**
 * Read-only Converter probe deadline that does not count this process's own stalls.
 *
 * `AbortSignal.timeout(ms)` measures wall-clock time. When synchronous work blocks the
 * event loop (for example a legacy v1 packet validation that takes ~30 s), the timer
 * phase runs before the poll phase on the next loop turn, so the timeout aborts a
 * response that the Converter already sent and that is waiting in the socket buffer.
 * The probe then reports a Converter timeout for the BFF's own pause.
 *
 * This deadline advances in short ticks and credits at most `maxCreditMs` per tick, so a
 * stalled interval counts as a few hundred milliseconds instead of its full length.
 * The budget still bounds time the process actually spent waiting for the Converter.
 * Use it only for read-only probes. Mutations keep their wall-clock timeouts.
 */
export interface ProbeDeadline {
  signal: AbortSignal;
  /** Wall-clock time that was not credited to the budget (event-loop stalls). */
  stalledMs(): number;
  /** Stop the tick chain after the probe settles. */
  clear(): void;
}

export interface ProbeDeadlineOptions {
  tickMs?: number;
  maxCreditMs?: number;
  now?: () => number;
}

export function probeDeadline(
  budgetMs: number,
  { tickMs = 100, maxCreditMs = tickMs * 2, now = () => performance.now() }: ProbeDeadlineOptions = {},
): ProbeDeadline {
  const controller = new AbortController();
  const started = now();
  let last = started;
  let credited = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = () => {
    const current = now();
    credited += Math.min(current - last, maxCreditMs);
    last = current;
    if (credited >= budgetMs) {
      timer = undefined;
      controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
      return;
    }
    timer = setTimeout(tick, Math.min(tickMs, budgetMs - credited));
    timer.unref?.();
  };
  timer = setTimeout(tick, Math.min(tickMs, budgetMs));
  timer.unref?.();
  return {
    signal: controller.signal,
    stalledMs: () => Math.max(0, now() - started - credited),
    clear: () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
