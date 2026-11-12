import { log } from "../log.js";
import type { Operation } from "../interactive-state/model.js";

export type ConverterTrace = { op: Operation; phase: "solve" | "export" | "model" | "variants" | "file" | "skin" | "outline" };
function timingHeader(response: Response, name: string) {
  const value = response.headers.get(name);
  if (value === null || !/^\d+(\.\d+)?$/.test(value)) return undefined;
  const ms = Number(value);
  return Number.isFinite(ms) ? ms : undefined;
}

export function reportConverterTiming(
  trace: ConverterTrace | undefined,
  startedAt: number,
  response?: Response,
  headersMs?: number,
  payloadBytes = 0,
) {
  if (!trace) return;
  const converterHandlerMs = response && timingHeader(response, "x-standin-interactive-handler-ms");
  log.info({
    type: "interactive_converter_call",
    phase: trace.phase,
    jobId: trace.op.jobId,
    operationId: trace.op.operationId,
    revision: trace.op.revision,
    durationMs: performance.now() - startedAt,
    headersMs,
    payloadBytes,
    status: response?.status,
    converterHandlerMs,
    // Older workers emitted zero-valued generic headers on this route
    // without measuring the interactive Blender work.
    ...(converterHandlerMs !== undefined && response ? {
      converterQueueMs: timingHeader(response, "x-standin-queue-wait-ms"),
      converterWorkerMs: timingHeader(response, "x-standin-execution-ms"),
    } : {}),
  });
}
