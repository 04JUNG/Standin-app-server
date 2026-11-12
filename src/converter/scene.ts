/** Composition only: every input is an already authorized final FBX. */
import { readSceneCameraHeader } from "../pose/sceneCamera.js";
import { config } from "../config.js";
import { ConverterError, sha256Hex, type ConverterDeps } from "./client.js";

export interface SceneObservation {
  box: number[];
  keypoints: number[][];
  scores: number[];
}
export interface SceneSource {
  person_index: number;
  observation: SceneObservation;
  bytes: Uint8Array;
}
const MAX = 128 * 1024 * 1024;
export async function composeRoughScene(
  cutId: string,
  image: { width: number; height: number },
  sources: SceneSource[],
  overrides: Partial<
    Pick<ConverterDeps, "fetch" | "baseUrl" | "timeoutMs">
  > & { signal?: AbortSignal } = {},
) {
  const deps = {
    fetch,
    baseUrl: config.converterBaseUrl,
    timeoutMs: config.converterTimeoutMs,
    ...overrides,
  };
  if (!deps.baseUrl)
    throw new ConverterError("CONVERTER_DISABLED", "converter disabled");
  const manifest = JSON.stringify({
    schema_version: 1,
    cut_id: cutId,
    coordinate_system: "threejs-y-up-m",
    rough_layout: { version: "rough-layout-v1", ...image },
    persons: sources.map((s) => ({
      person_index: s.person_index,
      fbx_sha256: sha256Hex(s.bytes),
      observation: s.observation,
    })),
  });
  const body = new FormData();
  body.set("manifest", manifest);
  body.set("response_format", "fbx");
  for (const s of sources)
    body.append("fbx", new Blob([s.bytes]), `person_${s.person_index}.fbx`);
  let response: Response;
  try {
    response = await deps.fetch(
      `${deps.baseUrl.replace(/\/+$/, "")}/compose-scene`,
      {
        method: "POST",
        body,
        redirect: "error",
        signal: AbortSignal.any([AbortSignal.timeout(Math.max(deps.timeoutMs, 120_000)), ...(deps.signal ? [deps.signal] : [])]),
      },
    );
  } catch (e) {
    throw new ConverterError(
      e instanceof Error && ["AbortError", "TimeoutError"].includes(e.name)
        ? "CONVERTER_TIMEOUT"
        : "CONVERTER_UNAVAILABLE",
      "scene converter unavailable",
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ConverterError(
      response.status === 504
        ? "CONVERTER_TIMEOUT"
        : response.status === 503
          ? "CONVERTER_UNAVAILABLE"
          : [400, 409, 413, 422].includes(response.status)
            ? "CONVERTER_REJECTED"
            : "CONVERTER_FAILED",
      "scene composition failed",
      null,
      response.status,
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ConverterError("CONVERTER_INTEGRITY", "empty scene");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX) throw new Error("scene exceeds size limit");
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks);
    const sha256 = sha256Hex(bytes);
    if (
      !bytes
        .subarray(0, 23)
        .equals(Buffer.from("Kaydara FBX Binary  \0\x1a\0")) ||
      response.headers.get("X-Standin-Artifact-SHA256") !== sha256 ||
      response.headers.get("X-Standin-FBX-Artifact-SHA256") !== sha256 ||
      response.headers.get("X-Standin-Scene-Input-SHA256") !==
        sha256Hex(Buffer.from(manifest)) ||
      response.headers.get("X-Standin-Person-Count") !==
        String(sources.length) ||
      response.headers.get("X-Standin-Scene-Version") !== "rough-layout-v1"
    )
      throw new Error("scene lineage mismatch");
    const camera = readSceneCameraHeader(response.headers.get("X-Standin-Scene-Camera"), sha256, image);
    return { bytes, sha256, ...(camera ? { camera } : {}) };
  } catch {
    throw new ConverterError(
      "CONVERTER_INTEGRITY",
      "scene integrity check failed",
    );
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
