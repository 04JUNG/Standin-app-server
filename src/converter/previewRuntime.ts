/** Lightweight immutable render identity; never probes Blender or starts a bake. */
import { config } from "../config.js";
import { ConverterError, EXPECTED_SOLVER_VERSION } from "./client.js";
import { FRAMING_VERSION } from "./framing.js";
export interface PreviewRuntime {
  schemaVersion: "body-preview-runtime.v1";
  previewRevision: string;
  modelVersion: "posed-mesh-v1";
  modelRevision: string;
  solverVersion: string;
  framingVersion: string;
}
export async function getPreviewRuntime(
  fetcher = fetch,
): Promise<PreviewRuntime> {
  try {
    const response = await fetcher(
      `${config.converterBaseUrl.replace(/\/+$/, "")}/preview-contract`,
      {
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("unavailable");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("empty contract");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 8192) throw new Error("contract too large");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (
      v.schema_version !== "body-preview-runtime.v1" ||
      v.model_version !== "posed-mesh-v1" ||
      v.solver_version !== EXPECTED_SOLVER_VERSION ||
      v.framing_version !== FRAMING_VERSION ||
      typeof v.preview_revision !== "string" ||
      !/^[a-f0-9]{64}$/.test(v.preview_revision) ||
      typeof v.model_revision !== "string" ||
      !/^[a-f0-9]{64}$/.test(v.model_revision)
    )
      throw new Error("unsupported contract");
    return {
      schemaVersion: v.schema_version,
      previewRevision: v.preview_revision,
      modelVersion: v.model_version,
      modelRevision: v.model_revision,
      solverVersion: v.solver_version,
      framingVersion: v.framing_version,
    };
  } catch {
    throw new ConverterError(
      "BODY_PREVIEW_UNAVAILABLE",
      "preview runtime contract unavailable",
    );
  }
}
