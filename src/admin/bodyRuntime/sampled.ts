import type { SampledRuntime } from "./format.js";
import type { BlenderControls } from "./common.js";

/** 오름차순 격자에서 x가 든 구간과 그 안의 비율(양 끝 밖은 끝 구간에 고정). */
function locate(grid: number[], x: number): [number, number] {
  const n = grid.length;
  if (x <= grid[0]!) return [0, 0];
  if (x >= grid[n - 1]!) return [n - 2, 1];
  let i = 0;
  while (i < n - 2 && x > grid[i + 1]!) i++;
  return [i, (x - grid[i]!) / (grid[i + 1]! - grid[i]!)];
}

function addRow(table: Float32Array, row: number, weight: number, K: number, out: Float64Array) {
  if (weight === 0) return;
  const o = row * K;
  for (let b = 0; b < K; b++) out[b] += weight * table[o + b]!;
}

/** 프리셋 모델의 기저 계수(Float64, K). */
export function sampledCoefficients(runtime: SampledRuntime, preset: string, c: BlenderControls) {
  const { header, coef } = runtime;
  const model = header.models[preset];
  if (!model) throw new Error("shape runtime: unknown preset model " + preset);
  const K = header.basisCount;
  const out = new Float64Array(K);
  addRow(coef, model.base, 1, K, out);
  for (const axis of model.axes) {
    const [i, t] = locate(axis.knots, c[axis.key]!);
    addRow(coef, axis.offset + i, 1 - t, K, out);
    addRow(coef, axis.offset + i + 1, t, K, out);
  }
  for (const pair of model.pairs) {
    const [i, u] = locate(pair.ga, c[pair.a]!);
    const [j, v] = locate(pair.gb, c[pair.b]!);
    const nb = pair.gb.length;
    const at = (a: number, b: number) => pair.offset + a * nb + b;
    addRow(coef, at(i, j), (1 - u) * (1 - v), K, out);
    addRow(coef, at(i + 1, j), u * (1 - v), K, out);
    addRow(coef, at(i, j + 1), (1 - u) * v, K, out);
    addRow(coef, at(i + 1, j + 1), u * v, K, out);
  }
  return out;
}

/**
 * 계산에 쓸 프리셋 모델과 가중치. 헤더의 `selection`(idw2)이 있으면 지금 값에 가까운 모델들을
 * 섞는다 — 프리셋에서 멀리 움직였을 때 다른 프리셋 둘레의 근사가 더 정확하기 때문이다.
 * 정확히 어느 프리셋 위에 있으면 그 모델 하나만 쓴다(오차 0).
 */
export function modelWeights(
  runtime: SampledRuntime,
  preset: string,
  c: BlenderControls,
): [string, number][] {
  const { header } = runtime;
  if (!header.selection) return [[preset, 1]];
  const keys = Object.keys(header.controls);
  const dist = Object.entries(header.presets).map(([name, values]) => {
    let d = 0;
    for (const k of keys) {
      const range = header.controls[k]!.max - header.controls[k]!.min;
      const diff =
        ((c[k] ?? header.controls[k]!.default) - (values[k] ?? header.controls[k]!.default)) /
        range;
      d += diff * diff;
    }
    return [name, d] as const;
  });
  const dmin = Math.min(...dist.map(([, d]) => d));
  if (dmin < 1e-12) return [[dist.find(([, d]) => d === dmin)![0], 1]];
  const r = header.selection.cutRatio;
  const cut = 1 / (r * r * dmin * dmin);
  const weights = dist
    .map(([name, d]) => [name, Math.max(0, 1 / (d * d) - cut)] as [string, number])
    .filter(([, w]) => w > 0);
  const total = weights.reduce((s, [, w]) => s + w, 0);
  return weights.map(([name, w]) => [name, w / total]);
}

/** Blender z-up 미터 좌표(Float32Array, 정점×3). */
export function evaluateSampled(
  runtime: SampledRuntime,
  preset: string,
  c: BlenderControls,
  out: Float32Array,
) {
  const { header, mean, basis, basisScale } = runtime;
  const n = header.vertexCount * 3;
  // 위치는 계수에 선형이므로 모델을 섞는 것은 계수를 섞는 것과 같다.
  const coef = new Float64Array(header.basisCount);
  for (const [name, w] of modelWeights(runtime, preset, c)) {
    const part = sampledCoefficients(runtime, name, c);
    for (let b = 0; b < coef.length; b++) coef[b] += w * part[b]!;
  }
  const acc = new Float64Array(n);
  for (let i = 0; i < n; i++) acc[i] = mean[i]!;
  for (let b = 0; b < header.basisCount; b++) {
    const s = coef[b]! * basisScale[b]!;
    if (Math.abs(s) < 1e-12) continue;
    const o = b * n;
    for (let i = 0; i < n; i++) acc[i] += s * basis[o + i]!;
  }
  for (let i = 0; i < n; i++) out[i] = acc[i]!;
  return out;
}
