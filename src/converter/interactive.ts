/** Private Converter transport. No inference, pose solving or release authority. */
import { config } from "../config.js";
import {
  InteractiveError,
  hash,
  type Operation,
} from "../interactive-state/model.js";
import type { InteractiveWorker } from "../interactive-state/worker.js";
const MAX = 64 * 1024 * 1024;
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
  ) {
    if (!deps.baseUrl || deps.token.length < 32)
      throw new InteractiveError("INTERACTIVE_CONVERTER_UNAVAILABLE", 503);
    let response: Response;
    try {
      response = await deps.fetch(`${deps.baseUrl}${route}`, {
        method,
        headers: {
          Authorization: `Bearer ${deps.token}`,
          "X-Standin-Owner": binding,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([
          AbortSignal.timeout(deps.timeoutMs),
          ...(signal ? [signal] : []),
        ]),
      });
    } catch {
      throw new InteractiveError("INTERACTIVE_CONVERTER_UNAVAILABLE", 503);
    }
    if (!response.ok) {
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
    const reader = response.body?.getReader();
    if (!reader) throw new InteractiveError("CONVERTER_INTEGRITY");
    let length = 0;
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
      return bytes;
    } finally {
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
  ) => {
    try {
      return JSON.parse(
        (await request(route, method, binding, signal, body)).toString("utf8"),
      ) as Record<string, unknown>;
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
    async solve(selection, op, signal) {
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
      );
      if (
        typeof result.snapshotId !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(result.snapshotId)
      )
        throw new InteractiveError("CONVERTER_INTEGRITY");
      return { snapshotId: result.snapshotId, packet: result.packet };
    },
    model: (op, signal) => request(path(op, "model"), "GET", owner(op), signal),
    export: (op, signal) => json(path(op, "export"), "POST", owner(op), signal),
    file: (op, signal) => request(path(op, "file"), "GET", owner(op), signal),
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
