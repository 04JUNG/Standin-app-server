import type { ShapeRuntime } from "./format.js";

export type BlenderControls = Record<string, number>;
export type Landmarks = ShapeRuntime["header"]["landmarks"];
export const REGIONS = [
  "Chest",
  "Back",
  "Shoulder",
  "UpperArm",
  "ForeArm",
  "Thigh",
  "Calf",
] as const;

export const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
export const clip = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** np.interp(z, src, dst): 양 끝은 끝값으로 고정. */
export function interp(z: number, src: number[], dst: number[]) {
  if (z <= src[0]!) return dst[0]!;
  for (let i = 1; i < src.length; i++)
    if (z <= src[i]!) {
      const t = (z - src[i - 1]!) / (src[i]! - src[i - 1]!);
      return dst[i - 1]! + t * (dst[i]! - dst[i - 1]!);
    }
  return dst[dst.length - 1]!;
}

/** 굽힌 필드의 가중합. out은 basis 기준 변위(Float64, 정점×3)다. */
export function accumulate(runtime: ShapeRuntime, coef: Map<string, number>, out: Float64Array) {
  for (const [name, w] of coef) {
    const f = runtime.fields.get(name);
    if (!f) throw new Error("shape runtime: missing field " + name);
    const s = w * f.scale;
    const { index, values } = f;
    for (let j = 0; j < index.length; j++) {
      const o = index[j]! * 3;
      out[o] += s * values[j * 3]!;
      out[o + 1] += s * values[j * 3 + 1]!;
      out[o + 2] += s * values[j * 3 + 2]!;
    }
  }
}

export function constant(runtime: ShapeRuntime, name: string): number {
  const v = runtime.header.constants[name];
  if (typeof v !== "number") throw new Error("shape runtime: missing constant " + name);
  return v;
}
export function constantMap(runtime: ShapeRuntime, name: string): Record<string, number> {
  const v = runtime.header.constants[name];
  if (!v || typeof v !== "object") throw new Error("shape runtime: missing constant " + name);
  return v;
}
