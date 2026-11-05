/** NDJSON reader: result/error wins immediately; progress persistence never delays it. */
export class ProgressStreamError extends Error {
  constructor(public status: number, public detail: string) { super("analysis stream error"); }
}
export async function readAnalysisStream<T>(res: Response, onProgress: (value: unknown) => void): Promise<T> {
  if (!res.body) throw new Error("missing analysis stream");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      if (pending.length > 8_000_000) throw new Error("analysis stream record too large");
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0 || (done && pending.length > 0 && (end = pending.length) >= 0)) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (!line.trim()) continue;
        let event: Record<string, unknown>;
        try { event = JSON.parse(line); } catch { continue; }
        if (!event || typeof event !== "object") continue;
        if (event.type === "result") {
          if (!event.result || typeof event.result !== "object") throw new Error("invalid analysis result");
          return event.result as T;
        }
        if (event.type === "error") {
          throw new ProgressStreamError(typeof event.status === "number" ? event.status : 500,
            JSON.stringify({ detail: event.detail }));
        }
        if (event.type === "progress" && line.length <= 128_000) {
          try { onProgress(event.progress); } catch { /* optional telemetry */ }
        }
      }
      if (done) throw new Error("analysis stream ended without result");
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** At most one storage write per Job; keep only the newest cumulative snapshot. */
export function progressWriter(write: (value: unknown) => Promise<unknown>) {
  let writing = false, closed = false;
  let pending: { value: unknown } | undefined;
  async function drain() {
    writing = true;
    try {
      while (!closed && pending) {
        const next = pending; pending = undefined;
        try { await write(next.value); } catch { /* telemetry is best effort */ }
      }
    } finally { writing = false; }
  }
  return {
    push(value: unknown) {
      if (closed) return;
      pending = { value };
      if (!writing) void drain();
    },
    close() { closed = true; pending = undefined; },
  };
}
