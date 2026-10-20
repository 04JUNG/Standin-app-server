/** Render the persisted final FBX, never a second conversion of its source. */
import { config } from "../config.js";
import { ConverterError, sha256Hex, type ConverterDeps } from "./client.js";
import type { FramedArtifact } from "./framing.js";
export async function renderFinalPreview(
  artifact: Pick<FramedArtifact, "fbx" | "artifactSha256">,
  aligned: boolean,
  overrides: Partial<ConverterDeps> = {},
  sceneCamera = false,
  signal?: AbortSignal,
) {
  const deps = {
    fetch,
    baseUrl: config.converterBaseUrl.replace(/\/+$/, ""),
    timeoutMs: config.converterTimeoutMs,
    ...overrides,
  };
  const body = new FormData();
  body.set(
    "fbx",
    new Blob([artifact.fbx], { type: "application/octet-stream" }),
    "final.fbx",
  );
  body.set("artifact_sha256", artifact.artifactSha256);
  body.set("aligned", String(aligned));
  body.set("scene_camera", String(sceneCamera));
  let response: Response;
  try {
    response = await deps.fetch(`${deps.baseUrl}/render-final-preview`, {
      method: "POST",
      body,
      signal: AbortSignal.any([
        AbortSignal.timeout(Math.max(deps.timeoutMs, 300_000)),
        ...(signal ? [signal] : []),
      ]),
    });
  } catch {
    throw new ConverterError(
      "CONVERTER_UNAVAILABLE",
      "final preview unavailable",
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ConverterError("CONVERTER_FAILED", "final preview failed");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ConverterError("CONVERTER_INTEGRITY", "empty preview");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4 * 1024 * 1024) throw new Error("preview size");
      chunks.push(value);
    }
    const png = Buffer.concat(chunks);
    if (
      response.headers.get("X-Standin-Artifact-SHA256") !==
        artifact.artifactSha256 ||
      response.headers.get("X-Standin-Preview-Artifact-SHA256") !==
        sha256Hex(png) ||
      !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw new Error("preview lineage");
    return png;
  } catch {
    throw new ConverterError("CONVERTER_INTEGRITY", "final preview mismatch");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
