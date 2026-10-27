import type { ShapeRuntime } from "./format.js";
import { interp, smooth, type BlenderControls } from "./common.js";
import { denseTable, faceNormals, foldGuard, laplacian } from "./mesh.js";

/**
 * 남성 0.7.1 · 여성 0.3.3의 해부 보정 층(standin_body.py `ANATOMY_*`). 앞 버전 compute를 감싼다.
 *
 * - warp: 앞 버전 warp + 다리·몸통 구간 높이 재배치를 C1(단조 PCHIP)로 잇는다.
 *   leg_length · leg_ratio · torso_length가 모두 0이면 앞 버전과 같다.
 * - anatomyLayer: 체형 키마다 굽힌 `AD:` 필드(해부 평활 − 원래 키)를 가중합해 basis에 더하고,
 *   warp한 차이(정점마다 12mm 상한)를 앞 결과에 얹은 뒤 fold_guard. 지방이 크면(> 0.6) 합친 변위를
 *   8회 평활한 쪽으로 조금 당기고(3mm 상한) 다시 fold_guard. 여성은 근육 2 초과 아래팔 받침(`FA`)과
 *   마지막 fold_guard(기준 warp(basis))가 더 있다.
 *
 * 굽는 쪽: scripts/shape-runtime/anatomy.py. 표: VN(휴지 정점 법선), PM(머리·목·손·발 보호 마스크).
 */
export type AnatomySex = "male" | "female";
export type Warp = <T extends Float32Array | Float64Array>(
  c: BlenderControls,
  points: ArrayLike<number>,
  out: T,
) => T;

const GAINS = {
  male: { leg: 0.085, torso: 0.12, ratio: 0.065, neck: 0.02 },
  female: { leg: 0.065, torso: 0.1, ratio: 0.055, neck: 0.015 },
} as const;

/** 해부 층의 warp: parent(앞 버전 warp) 결과의 z에 PCHIP − 선형 차이를 더한다. 마스크의 z는 입력 점의 z. */
export function anatomyWarp(runtime: ShapeRuntime, sex: AnatomySex, parent: Warp): Warp {
  return (c, points, out) => {
    parent(c, points, out);
    if (![c.leg_length!, c.leg_ratio!, c.torso_length!].some((v) => Math.abs(v) > 1e-9)) return out;
    const L = runtime.header.landmarks;
    const g = GAINS[sex];
    const h = L.hip + g.leg * c.leg_length!;
    const sh = h + (L.shoulder - L.hip) * (1 + g.torso * c.torso_length!);
    const kn =
      L.ankle + (h - L.ankle) * ((L.knee - L.ankle) / (L.hip - L.ankle) - g.ratio * c.leg_ratio!);
    const ch = sh + L.chin - L.shoulder + g.neck * c.neck_length!;
    const newTop = ch + (ch - L.floor) / (c.heads! - 1);
    const knots = [L.floor, L.ankle, L.knee, L.hip, L.shoulder];
    const values = [L.floor, L.ankle, kn, h, sh];
    const curve = pchip(knots, values);
    const scale = c.height_cm! / 100 / (newTop - L.floor);
    for (let i = 2; i < points.length; i += 3) {
      const z = points[i]!;
      const mask =
        smooth(L.floor, L.floor + 0.04, z) * (1 - smooth(L.shoulder - 0.075, L.shoulder, z));
      if (mask === 0) continue;
      out[i] += (curve(z) - interp(z, knots, values)) * mask * scale;
    }
    return out;
  };
}

/** standin_body.anatomy_pchip: 단조 C1 Hermite, 양 끝 밖은 기울기 1로 이어 간다. */
export function pchip(knots: number[], values: number[]) {
  const n = knots.length;
  const h: number[] = [],
    d: number[] = [];
  for (let j = 0; j < n - 1; j++) {
    h.push(knots[j + 1]! - knots[j]!);
    d.push((values[j + 1]! - values[j]!) / h[j]!);
  }
  const slopes = new Array<number>(n).fill(0);
  slopes[0] = d[0]!;
  slopes[n - 1] = d[n - 2]!;
  for (let j = 1; j < n - 1; j++)
    if (d[j - 1]! * d[j]! > 0) {
      const w1 = 2 * h[j]! + h[j - 1]!,
        w2 = h[j]! + 2 * h[j - 1]!;
      slopes[j] = (w1 + w2) / (w1 / d[j - 1]! + w2 / d[j]!);
    }
  return (x: number) => {
    if (x < knots[0]!) return values[0]! + x - knots[0]!;
    if (x > knots[n - 1]!) return values[n - 1]! + x - knots[n - 1]!;
    // np.searchsorted(side="right") − 1, 0..n−2로 자름
    let i = 0;
    while (i < n - 2 && knots[i + 1]! <= x) i++;
    const t = Math.min(1, Math.max(0, (x - knots[i]!) / h[i]!));
    const t2 = t * t,
      t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * values[i]! +
      (t3 - 2 * t2 + t) * h[i]! * slopes[i]! +
      (-2 * t3 + 3 * t2) * values[i + 1]! +
      (t3 - t2) * h[i]! * slopes[i + 1]!
    );
  };
}

/** fold_guard 법선 버퍼: 평가 한 번 안에서 차례로 다시 쓴다. */
export function normalsBuffer(runtime: ShapeRuntime): Float64Array {
  return new Float64Array((runtime.faces.length / 3) * 6);
}

/**
 * 해부 층. out(앞 compute 결과, Float64 — 뒤집힘 판정이 Blender와 같도록 끝까지 64비트로 계산)을 제자리에서 바꾼다. weights는 그 compute의 mappings(c)
 * (BODY 키 → 가중치), reference = warp(basis).
 */
export function anatomyLayer(
  runtime: ShapeRuntime,
  sex: AnatomySex,
  warp: Warp,
  c: BlenderControls,
  out: Float64Array,
  weights: Record<string, number>,
  reference: Float64Array,
  normals: Float64Array,
) {
  const { basis } = runtime;
  const V = runtime.header.vertexCount;
  const offset = new Float64Array(V * 3);
  const add = (name: string, w: number) => {
    const f = runtime.fields.get(name);
    if (!f) return;
    const s = w * f.scale;
    const { index, values } = f;
    for (let j = 0; j < index.length; j++) {
      const o = index[j]! * 3;
      offset[o] += s * values[j * 3]!;
      offset[o + 1] += s * values[j * 3 + 1]!;
      offset[o + 2] += s * values[j * 3 + 2]!;
    }
  };
  for (const [name, w] of Object.entries(weights)) if (Math.abs(w) > 1e-12) add("AD:" + name, w);
  if (sex === "female" && c.muscle! > 2) {
    if (!runtime.fields.has("FA")) throw new Error("shape runtime: missing field FA");
    add("FA", (c.muscle! - 2) / 2);
  }
  let peak = 0;
  for (let i = 0; i < offset.length; i++) peak = Math.max(peak, Math.abs(offset[i]!));
  if (peak < 1e-12) return out;

  // delta = warp(basis + offset) − warp(basis), 정점마다 12mm 상한
  for (let i = 0; i < offset.length; i++) offset[i] += basis[i]!;
  const moved = warp(c, offset, new Float64Array(V * 3));
  const cand = new Float64Array(out.length);
  for (let v = 0; v < V; v++) {
    const o = v * 3;
    const dx = moved[o]! - reference[o]!,
      dy = moved[o + 1]! - reference[o + 1]!,
      dz = moved[o + 2]! - reference[o + 2]!;
    const k = Math.min(1, 0.012 / Math.max(Math.hypot(dx, dy, dz), 1e-15));
    cand[o] = out[o]! + dx * k;
    cand[o + 1] = out[o + 1]! + dy * k;
    cand[o + 2] = out[o + 2]! + dz * k;
  }
  // 남성은 normal_reference=reference, 여성 fold_guard는 기준 하나뿐이다.
  const second = sex === "male" ? reference : out;
  foldGuard(runtime, out, cand, faceNormals(runtime, out, second, normals), 30, 6);

  const fat = Math.max(0, c.physique!) + 0.4 * (c.fat_gain ?? 0);
  if (fat > 0.6) {
    const disp = new Float64Array(V * 3);
    for (let i = 0; i < disp.length; i++) disp[i] = cand[i]! - reference[i]!;
    const sm = laplacian(runtime, Float64Array.from(disp), 8);
    const vn = denseTable(runtime, "VN", 3);
    let den = 0,
      num = 0;
    for (let i = 0; i < disp.length; i++) {
      den += sm[i]! * vn[i]!;
      num += disp[i]! * vn[i]!;
    }
    if (Math.abs(den) > 1e-8 && num * den > 0) {
      const r = Math.min(1.05, Math.max(0.95, num / den));
      for (let i = 0; i < sm.length; i++) sm[i] *= r;
    }
    const pm = denseTable(runtime, "PM", 1);
    const amount = 0.42 * smooth(0.6, 1.7, fat);
    const next = Float64Array.from(cand);
    for (let v = 0; v < V; v++) {
      const o = v * 3;
      const k = amount * pm[v]!;
      if (k === 0) continue;
      const ex = (sm[o]! - disp[o]!) * k,
        ey = (sm[o + 1]! - disp[o + 1]!) * k,
        ez = (sm[o + 2]! - disp[o + 2]!) * k;
      const s = Math.min(1, 0.003 / Math.max(Math.hypot(ex, ey, ez), 1e-15));
      next[o] += ex * s;
      next[o + 1] += ey * s;
      next[o + 2] += ez * s;
    }
    foldGuard(
      runtime,
      cand,
      next,
      faceNormals(runtime, cand, sex === "male" ? reference : cand, normals),
      30,
      6,
    );
    cand.set(next);
  }
  if (sex === "female")
    foldGuard(runtime, reference, cand, faceNormals(runtime, reference, reference, normals), 30, 6);
  out.set(cand);
  return out;
}
