import { createHash } from "node:crypto";
import type { BodyAsset } from "../body-selection/model.js";
import { readShapeRuntime } from "../body-selection/shapeRuntime.js";
import { sameShapeSource } from "../body-selection/shape.js";
import {
  parseShapeRuntime,
  type AnyShapeRuntime,
} from "./bodyRuntime/format.js";
import { evaluateShape, resolveControls } from "./bodyRuntime/evaluate.js";
import { CustomBodyError } from "./customBodies.js";

export type BodyView = "front" | "side" | "back";
/** Hashes and source binding are identical to the app; never fall back to an unshaped model. */
export function checkedRuntime(
  asset: BodyAsset,
  bytes: Uint8Array,
): AnyShapeRuntime {
  const ref = asset.shapeRuntime;
  if (
    !ref ||
    bytes.byteLength !== ref.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== ref.sha256
  )
    throw new CustomBodyError("RUNTIME_INTEGRITY", 409);
  const runtime = parseShapeRuntime(Uint8Array.from(bytes).buffer);
  if (
    runtime.header.rules !== ref.rules ||
    !(ref.preset in runtime.header.presets) ||
    (runtime.kind === "sampled") !==
      (ref.format === "standin-shape-runtime.v2") ||
    !sameShapeSource(asset.shapeSource, {
      rules: runtime.header.rules,
      ...runtime.header.source,
    }) ||
    runtime.faces.length > 600000
  )
    throw new CustomBodyError("RUNTIME_INTEGRITY", 409);
  return runtime;
}
/** Orthographic mesh projection of the app's evaluated vertices, not an illustrative mannequin. */
export function meshSvg(
  positions: Float32Array,
  faces: Uint16Array,
  view: BodyView,
): string {
  if (
    !positions.length ||
    !faces.length ||
    positions.length % 3 ||
    faces.length % 3 ||
    ![...positions].every(Number.isFinite)
  )
    throw new CustomBodyError("MESH_INVALID", 409);
  const angle = view === "side" ? Math.PI / 2 : view === "back" ? Math.PI : 0,
    c = Math.cos(angle),
    s = Math.sin(angle);
  const projected: Array<[number, number, number]> = [];
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i] * c - positions[i + 1] * s,
      y = positions[i + 2],
      depth = positions[i] * s + positions[i + 1] * c;
    projected.push([x, y, depth]);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const scale = Math.min(
    432 / Math.max(0.01, maxX - minX),
    592 / Math.max(0.01, maxY - minY),
  );
  const px = (x: number) => 240 + (x - (minX + maxX) / 2) * scale,
    py = (y: number) => 320 - (y - (minY + maxY) / 2) * scale;
  const triangles: Array<{ depth: number; path: string; color: number }> = [];
  for (let i = 0; i < faces.length; i += 3) {
    const a = projected[faces[i]],
      b = projected[faces[i + 1]],
      d = projected[faces[i + 2]];
    if (!a || !b || !d) throw new CustomBodyError("MESH_INVALID", 409);
    const ux = b[0] - a[0],
      uy = b[1] - a[1],
      uz = b[2] - a[2],
      vx = d[0] - a[0],
      vy = d[1] - a[1],
      vz = d[2] - a[2];
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx,
      length = Math.hypot(nx, ny, nz);
    if (length < 1e-12) continue;
    const light = Math.abs((-nx * 0.25 + ny * 0.45 - nz * 0.85) / length),
      color = Math.round(132 + 100 * Math.min(1, light));
    triangles.push({
      depth: (a[2] + b[2] + d[2]) / 3,
      color,
      path: `M${px(a[0]).toFixed(2)},${py(a[1]).toFixed(2)}L${px(b[0]).toFixed(2)},${py(b[1]).toFixed(2)}L${px(d[0]).toFixed(2)},${py(d[1]).toFixed(2)}Z`,
    });
  }
  triangles.sort((a, b) => b.depth - a.depth);
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 640" role="img" aria-label="저장된 조절값을 반영한 중립 체형"><rect width="480" height="640" fill="#39414b"/>' +
    triangles
      .map(
        (t) =>
          `<path d="${t.path}" fill="rgb(${t.color},${t.color},${t.color})"/>`,
      )
      .join("") +
    "</svg>";
  if (Buffer.byteLength(svg) > 8 * 1024 * 1024)
    throw new CustomBodyError("PREVIEW_TOO_LARGE", 409);
  return svg;
}
const cache = new Map<string, { expires: number; svg: string }>();
const inflight = new Map<string, Promise<string>>();
export async function renderCustomBody(
  asset: BodyAsset,
  controls: Record<string, number>,
  revision: string,
  view: BodyView,
  read = readShapeRuntime,
) {
  const key = revision + ":" + view,
    old = cache.get(key);
  if (old && old.expires > Date.now()) return old.svg;
  const pending = inflight.get(key);
  if (pending) return pending;
  if (inflight.size >= 2) throw new CustomBodyError("PREVIEW_BUSY", 429);
  const work = (async () => {
    try {
      const runtime = checkedRuntime(asset, await read(asset));
      const svg = meshSvg(
        evaluateShape(
          runtime,
          resolveControls(runtime, asset.shapeRuntime!.preset, controls),
          undefined,
          asset.shapeRuntime!.preset,
        ),
        runtime.faces,
        view,
      );
      cache.set(key, { expires: Date.now() + 120000, svg });
      while (cache.size > 4) cache.delete(cache.keys().next().value!);
      return svg;
    } catch (e) {
      if (e instanceof CustomBodyError) throw e;
      throw new CustomBodyError("PREVIEW_UNAVAILABLE", 503);
    }
  })().finally(() => inflight.delete(key));
  inflight.set(key, work);
  return work;
}
