/** Private Converter transport. No inference, pose solving or release authority. */
import { config } from "../config.js";
import { randomUUID } from "node:crypto";
import { log } from "../log.js";
import {
  InteractiveError,
  hash,
  type Operation,
} from "../interactive-state/model.js";
import type { InteractiveWorker } from "../interactive-state/worker.js";
const MAX = 64 * 1024 * 1024;
/** BFF opt-in for the Converter's binary state; absent keeps the original v1 request. */
export const STATE_ENCODING_HEADER = "X-Standin-State-Encoding";
interface ExchangeOptions {
  headers?: Record<string, string>;
  /** Reject a successful response whose Content-Type media type differs. */
  mediaType?: string;
  responseHeaders?: (headers: Headers) => void;
}
const mediaTypeOf = (value: string | null) =>
  value === null ? null : value.split(";")[0].trim().toLowerCase();
export interface SnapshotTransport {
  baseUrl: string;
  token: string;
  fetch: typeof fetch;
  timeoutMs: number;
}
export interface StaticTransport {
  staticResolve(requests: unknown[], signal?: AbortSignal): Promise<unknown>;
  staticFile(sha256: string, signal?: AbortSignal): Promise<Uint8Array>;
}
export function createInteractiveWorker(
  overrides: Partial<SnapshotTransport> = {},
): InteractiveWorker & StaticTransport {
  const deps: SnapshotTransport = {
    baseUrl: config.converterBaseUrl.replace(/\/+$/, ""),
    token: config.interactiveConverterToken,
    fetch,
    timeoutMs: config.converterShapeTimeoutMs,
    ...overrides,
  };
  const owner = (op: Operation) =>
    hash({
      installationId: op.installationId,
      jobId: op.jobId,
      personIndex: op.personIndex,
    });
  const path = (op: Operation, suffix: string) => {
    if (!op.snapshotId || !/^[A-Za-z0-9_-]{1,128}$/.test(op.snapshotId))
      throw new InteractiveError("CONVERTER_INTEGRITY");
    return `/interactive/v1/snapshots/${op.snapshotId}/${suffix}`;
  };
  async function request(
    route: string,
    method: string,
    binding: string,
    signal?: AbortSignal,
    body?: unknown,
    operationId?: string,
    options: ExchangeOptions = {},
  ) {
    if (!deps.baseUrl || deps.token.length < 32)
      throw new InteractiveError("INTERACTIVE_CONVERTER_UNAVAILABLE", 503);
    let response: Response;
    const started = performance.now(), requestId = `req_${randomUUID()}`;
    const routePattern = route.replace(/\/snapshots\/[^/]+/, "/snapshots/:snapshot").replace(/\/static\/[^/]+$/, "/static/:sha");
    try {
      response = await deps.fetch(`${deps.baseUrl}${route}`, {
        method,
        headers: {
          Authorization: `Bearer ${deps.token}`,
          "X-Standin-Owner": binding,
          "X-Request-Id": requestId,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...options.headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([
          AbortSignal.timeout(deps.timeoutMs),
          ...(signal ? [signal] : []),
        ]),
      });
    } catch {
      log.warn({ type: "interactive_converter_transport", requestId, operationId, route: routePattern,
        method, durationMs: performance.now() - started, errorCode: "INTERACTIVE_CONVERTER_UNAVAILABLE" });
      throw new InteractiveError("INTERACTIVE_CONVERTER_UNAVAILABLE", 503);
    }
    const headersMs = performance.now() - started;
    const durationHeader = (name: string) => {
      const raw = response.headers.get(name), value = raw === null ? NaN : Number(raw);
      return Number.isFinite(value) && value >= 0 ? value : undefined;
    };
    const diagnostics = {
      type: "interactive_converter_transport", requestId, operationId, route: routePattern, method,
      status: response.status, headersMs,
      converterQueueMs: durationHeader("x-standin-queue-wait-ms"),
      converterExecutionMs: durationHeader("x-standin-execution-ms"),
    };
    if (!response.ok) {
      log.warn({ ...diagnostics, durationMs: performance.now() - started });
      await response.body?.cancel();
      if (
        route.startsWith("/interactive/v1/snapshots/") &&
        (response.status === 404 || response.status === 410)
      )
        throw new InteractiveError("INTERACTIVE_EXPIRED", 410);
      throw new InteractiveError(
        response.status === 409
          ? "CONVERTER_INTEGRITY"
          : "INTERACTIVE_CONVERTER_UNAVAILABLE",
        response.status === 409 ? 409 : 503,
      );
    }
    if (
      options.mediaType !== undefined &&
      mediaTypeOf(response.headers.get("content-type")) !== options.mediaType
    ) {
      log.warn({ ...diagnostics, errorCode: "CONVERTER_INTEGRITY" });
      await response.body?.cancel();
      throw new InteractiveError("CONVERTER_INTEGRITY");
    }
    options.responseHeaders?.(response.headers);
    const reader = response.body?.getReader();
    if (!reader) {
      log.warn({ ...diagnostics, errorCode: "CONVERTER_INTEGRITY" });
      throw new InteractiveError("CONVERTER_INTEGRITY");
    }
    let length = 0;
    let complete = false;
    const parts: Uint8Array[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX) throw new InteractiveError("CONVERTER_INTEGRITY");
        parts.push(value);
      }
      const bytes = Buffer.concat(parts);
      const advertised = response.headers.get("content-length");
      if (
        advertised !== null &&
        (!/^\d+$/.test(advertised) || Number(advertised) !== bytes.length)
      )
        throw new InteractiveError("CONVERTER_INTEGRITY");
      complete = true;
      return bytes;
    } finally {
      log.info({ ...diagnostics, durationMs: performance.now() - started,
        bodyMs: performance.now() - started - headersMs, responseBytes: length, complete });
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  const json = async (
    route: string,
    method: string,
    binding: string,
    signal?: AbortSignal,
    body?: unknown,
    operationId?: string,
    options?: ExchangeOptions,
  ) => {
    try {
      const bytes = await request(route, method, binding, signal, body, operationId, options);
      const started = performance.now();
      try { return JSON.parse(bytes.toString("utf8")) as Record<string, unknown>; }
      finally {
        log.info({ type: "interactive_converter_json", operationId,
          durationMs: performance.now() - started, responseBytes: bytes.length });
      }
    } catch (error) {
      if (error instanceof InteractiveError) throw error;
      throw new InteractiveError("CONVERTER_INTEGRITY");
    }
  };
  return {
    async staticResolve(requests, signal) {
      return JSON.parse(
        (
          await request(
            "/interactive/v1/static/resolve",
            "POST",
            "",
            signal,
            requests,
          )
        ).toString("utf8"),
      ) as unknown;
    },
    staticFile(sha256, signal) {
      if (!/^[a-f0-9]{64}$/.test(sha256))
        throw new InteractiveError("CONVERTER_INTEGRITY");
      return request(`/interactive/v1/static/${sha256}`, "GET", "", signal);
    },
    async solve(selection, op, signal, options) {
      // No requested encoding: send exactly the original v1 request (selection preview, v1 ops).
      const answered: { encoding: string | null } = { encoding: null };
      const negotiated: ExchangeOptions | undefined = options?.stateEncoding
        ? {
            headers: { [STATE_ENCODING_HEADER]: options.stateEncoding },
            responseHeaders: (headers) => { answered.encoding = headers.get(STATE_ENCODING_HEADER); },
          }
        : undefined;
      const result = await json(
        "/interactive/v1/solve",
        "POST",
        owner(op),
        signal,
        {
          selection: selection.identity,
          operation: op.operationId,
          revision: op.revision,
          person: String(op.personIndex),
          expiresAt: op.expiresAt,
          bvhBase64: Buffer.from(selection.bvhBytes).toString("base64"),
        },
        op.operationId,
        negotiated,
      );
      if (
        typeof result.snapshotId !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(result.snapshotId)
      )
        throw new InteractiveError("CONVERTER_INTEGRITY");
      return {
        snapshotId: result.snapshotId,
        packet: result.packet,
        ...(answered.encoding !== null ? { stateEncoding: answered.encoding } : {}),
      };
    },
    model: (op, signal, mediaType) =>
      request(path(op, "model"), "GET", owner(op), signal, undefined, op.operationId,
        mediaType === undefined ? {} : { mediaType }),
    export: (op, signal) => json(path(op, "export"), "POST", owner(op), signal, undefined, op.operationId),
    file: (op, signal) => request(path(op, "file"), "GET", owner(op), signal, undefined, op.operationId),
    variants: (op, signal) =>
      request(path(op, "variants"), "GET", owner(op), signal),
    async cancel(op) {
      await json("/interactive/v1/cancel", "POST", owner(op), undefined, {
        ownerBinding: owner(op),
        person: String(op.personIndex),
        revision: op.revision,
      });
    },
  };
}
