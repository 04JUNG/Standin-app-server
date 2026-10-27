import type { ShapeRuntime } from "./format.js";
import { smooth, type BlenderControls } from "./common.js";
import { coefficients, restBody, warpBody, weightSets } from "./male067.js";
import { faceNormals, foldGuard, laplacian, table } from "./mesh.js";

/**
 * standin-body-0.6.10(남성) 중립 체형 계산. 0.6.7 계산에 근육 볼륨(`muscle_bulk`)이 더해졌다.
 * 근육 볼륨이 0이면 0.6.7과 같은 식이다(0.6.8~0.6.10의 나머지 변경은 자세 보정이라 중립 체형과 무관).
 *
 * 근육 볼륨 > 0일 때 (standin_body.py 0.6.10):
 *   1. compose_body: 근육 키 가중치를 더 올리고, 늘어난 만큼의 변위만 8회 평활(BK: 필드로 미리 구움).
 *   2. muscle_bulk_offset: warp 직전에 팔·다리 뼈 축에서 바깥으로 두께를 더하고 몸통 폭·등을 넓힌 뒤
 *      메시 위에서 6회 평활한다(정점별 표 MB, 평활은 여기서 계산).
 *   3. refine_bulk_profile: 근육 볼륨 0의 결과와의 차이로 다리 앞뒤 두께를 덜고 팔 두께를 더한다(표 RB).
 *
 * fold_guard(면 뒤집힘 수리)도 옮겼다. 근육 볼륨이 크면 실제로 동작한다(벌크형: 오른쪽 어깨 앞,
 * 빼면 최대 8mm 차이와 접힌 면이 남는다). 근육 볼륨 0에서는 굽는 쪽 검증 140조합 중 한 번도
 * 동작하지 않아 0.6.7처럼 검사를 건너뛴다(scripts/shape-runtime의 fold_guard 보고로 확인).
 */
export const MALE_0610 = "standin-body-0.6.10";
const MUSCLE_PARTS = new Set(["D", "SM", "DM", "SMM"]);
const MB_WIDTH = 12; // K, Q(3), 왼쪽 UpLeg k·p(3), 오른쪽 UpLeg k·p(3)
const RB_WIDTH = 2; // y, z 배율

export function evaluateMale0610(runtime: ShapeRuntime, c: BlenderControls, out: Float32Array) {
  const bulk = c.muscle_bulk ?? 0;
  if (!(bulk > 0)) return warpBody(runtime, c, restBodyBulk(runtime, c), out);
  const zeroControls = { ...c, muscle_bulk: 0 };
  // compute(): reference = warp(basis)는 면 방향의 기준, guard_reference = compute(근육 볼륨 0)은
  // 수리와 refine의 기준이다.
  const reference = warpBody(runtime, c, runtime.basis, new Float32Array(out.length));
  const guard = warpBody(
    runtime,
    zeroControls,
    restBodyBulk(runtime, zeroControls),
    new Float32Array(out.length),
  );
  warpBody(runtime, c, restBodyBulk(runtime, c), out);
  const normals = faceNormals(runtime, guard, reference);
  foldGuard(runtime, guard, out, normals);
  refineBulkProfile(runtime, out, guard);
  return foldGuard(runtime, guard, out, normals);
}

/**
 * compute()의 warp 직전 몸(basis 포함, Float64). 근육 볼륨이 있으면 근육 부분은 볼륨 0의 가중치로,
 * 늘어난 만큼은 평활된 BK: 필드로 보내고 muscle_bulk_offset을 더한다. 0.7.1도 이 몸을 쓴다.
 */
export function restBodyBulk(runtime: ShapeRuntime, c: BlenderControls) {
  const zeroControls = { ...c, muscle_bulk: 0 };
  const zero = weightSets(runtime, zeroControls);
  const zeroA = coefficients(runtime, zeroControls, zero.weights);
  const zeroB = coefficients(runtime, zeroControls, zero.legacy);
  if (!((c.muscle_bulk ?? 0) > 0)) return restBody(runtime, c, zeroA, zeroB);
  const { weights, legacy } = weightSets(runtime, c);
  const body = restBody(
    runtime,
    c,
    withBulk(zeroA, coefficients(runtime, c, weights)),
    withBulk(zeroB, coefficients(runtime, c, legacy)),
  );
  bulkOffset(runtime, c, body);
  return body;
}

/** refine_bulk_profile: 근육 볼륨 0 결과(같은 키·비율)와의 차이로만 고친다(표 RB). out을 바꾼다. */
export function refineBulkProfile<T extends Float32Array | Float64Array>(
  runtime: ShapeRuntime,
  out: T,
  guard: ArrayLike<number>,
): T {
  const [index, values] = table(runtime, "RB", RB_WIDTH);
  for (let j = 0; j < index.length; j++) {
    const v = index[j]! * 3;
    const y = out[v + 1]!,
      z = out[v + 2]!;
    out[v + 1] = y + (y - guard[v + 1]!) * values[j * RB_WIDTH]!;
    out[v + 2] = z + (z - guard[v + 2]!) * values[j * RB_WIDTH + 1]!;
  }
  return out;
}

/** 근육 부분은 볼륨 0의 가중치로, 늘어난 가중치는 평활된 BK: 필드로 보낸다. */
function withBulk(zero: Map<string, number>, full: Map<string, number>) {
  const out = new Map(zero);
  for (const key of new Set([...zero.keys(), ...full.keys()])) {
    if (!key.includes("BODY_Muscle_") || !MUSCLE_PARTS.has(key.split(":", 1)[0]!)) continue;
    const d = (full.get(key) ?? 0) - (zero.get(key) ?? 0);
    if (d !== 0) out.set("BK:" + key, d);
  }
  return out;
}

/** standin_body.muscle_bulk_offset — body(Blender 휴지 공간, basis 포함)를 제자리에서 바꾼다. */
function bulkOffset(runtime: ShapeRuntime, c: BlenderControls, body: Float64Array) {
  const bulk = 0.75 * c.muscle_bulk! * (1 - 0.8 * smooth(0.4, 1.7, Math.max(0, c.physique!)));
  if (bulk === 0) return;
  const { basis } = runtime;
  const V = runtime.header.vertexCount;
  const off = new Float64Array(V * 3);
  const [index, mb] = table(runtime, "MB", MB_WIDTH);
  for (let j = 0; j < index.length; j++) {
    const v = index[j]!;
    const o = j * MB_WIDTH;
    const bx = body[v * 3]!,
      by = body[v * 3 + 1]!,
      bz = body[v * 3 + 2]!;
    const K = mb[o]!;
    let ox = K * bx - mb[o + 1]!,
      oy = K * by - mb[o + 2]!,
      oz = K * bz - mb[o + 3]!;
    const x0 = basis[v * 3]!;
    for (let s = o + 4; s <= o + 8; s += 4) {
      const k = mb[s]!;
      if (k === 0) continue;
      let dx = (bx - mb[s + 1]!) * k;
      // 허벅지 안쪽이 몸 가운데를 넘지 않게: 안쪽으로 가는 x만 줄인다.
      if (dx * x0 < 0) dx *= smooth(0.018, 0.065, Math.abs(x0));
      ox += dx;
      oy += (by - mb[s + 2]!) * k;
      oz += (bz - mb[s + 3]!) * k;
    }
    off[v * 3] = ox;
    off[v * 3 + 1] = oy;
    off[v * 3 + 2] = oz;
  }
  for (let v = 0; v < V; v++) {
    const ax = Math.abs(basis[v * 3]!),
      z = basis[v * 3 + 2]!;
    const torso = smooth(1.02, 1.23, z) * (1 - smooth(1.43, 1.5, z)) * (1 - smooth(0.14, 0.24, ax));
    if (torso === 0) continue;
    off[v * 3] += body[v * 3]! * 0.13 * torso;
    off[v * 3 + 1] += Math.max(body[v * 3 + 1]! - 0.025, 0) * 0.08 * torso;
  }
  laplacian(runtime, off, 6);
  for (let v = 0; v < V; v++) {
    const z = basis[v * 3 + 2]!;
    const k = bulk * (1 - smooth(1.43, 1.49, z)) * smooth(0.12, 0.2, z);
    if (k === 0) continue;
    body[v * 3] += k * off[v * 3]!;
    body[v * 3 + 1] += k * off[v * 3 + 1]!;
    body[v * 3 + 2] += k * off[v * 3 + 2]!;
  }
}
