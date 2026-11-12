import type { ShapeRuntime } from "./format.js";
import { accumulate, clip, constantMap, smooth, type BlenderControls } from "./common.js";
import { mappingsFemale022, warpFemale022 } from "./female022.js";
import { anatomyLayer, anatomyWarp, normalsBuffer, type Warp } from "./anatomy.js";
import { denseTable, faceNormals, foldGuard, laplacian, table } from "./mesh.js";

/**
 * standin-female-body-0.3.3(여성) 중립 체형 계산. 0.2.2 compute 위에 층이 셋 쌓였다.
 *
 *   1. 해부 보정(anatomy.ts, 0.3.0) — 근육 2 초과 아래팔 받침 포함.
 *   2. 근육 2 초과 다듬기(0.3.1, muscle_refine): 근육 2 결과와의 차이(늘어난 근육)만 팔·아래팔·허벅지
 *      뼈 축의 바깥 방향으로 덜어 내고 28회 평활 쪽으로 섞는다(2.2cm 상한). 팔꿈치 둘레는 16회 평활로
 *      소매처럼 잇는다(3mm 상한). 머리·목·손·발은 고정.
 *   3. 골반 옆선(0.3.3, pelvis_refine): 근육 1.25부터 엉덩이 옆면을 안쪽으로 4~12mm 당긴다.
 * 각 층 끝에 fold_guard(기준 warp(basis))가 있다. 0.2.2 compute의 fold_guard(20회·3고리)도 이제 돈다.
 *
 * 표(scripts/shape-runtime/anatomy.py): MR(팔·아래팔·허벅지 6개 마스크), PIN(고정 정점),
 * EO(팔꿈치 웨이트 2개), PV(골반 옆 마스크), 상수 bones(뼈 휴지 머리·꼬리).
 */
export const FEMALE_033 = "standin-female-body-0.3.3";
/** 0.3.4: 포즈 표면 보정만 바뀌었고 중립 체형 계산은 0.3.3과 같다(22개 조합 0.0 mm). */
export const FEMALE_034 = "standin-female-body-0.3.4";
const LIMBS = [
  ["Arm", 0.48],
  ["ForeArm", 0.44],
  ["UpLeg", 0.4],
] as const;
const SIDES = ["Left", "Right"] as const;

export function evaluateFemale033(runtime: ShapeRuntime, c: BlenderControls, out: Float32Array) {
  const parent: Warp = (cc, points, o) => warpFemale022(runtime, cc, points, o);
  const warp = anatomyWarp(runtime, "female", parent);
  const normals = normalsBuffer(runtime);
  const n = out.length;
  // 끝까지 Float64(뒤집힘 판정이 Blender와 같게), 마지막에 out으로 옮긴다.
  const reference = warp(c, runtime.basis, new Float64Array(n));
  const body = anatomy(runtime, warp, c, new Float64Array(n), reference, normals);
  const V = runtime.header.vertexCount;
  const h175 = c.height_cm! / 175;
  const refNormals = () => faceNormals(runtime, reference, reference, normals);

  if (c.muscle! > 2 + 1e-10) {
    const bones = constantMap(runtime, "bones");
    const bone = (name: string, end: "h" | "t") =>
      [0, 1, 2].map((i) => bones[`${name}.${end}${i}`]!) as [number, number, number];
    const masks = denseTable(runtime, "MR", 6);
    const pin = pinned(runtime);
    const low = anatomy(
      runtime,
      warp,
      { ...c, muscle: 2 },
      new Float64Array(n),
      reference,
      normals,
    );
    const added = new Float64Array(n);
    for (let i = 0; i < n; i++) added[i] = body[i]! - low[i]!;
    const smoothAdded = laplacian(runtime, Float64Array.from(added), 28);
    const move = new Float64Array(n);
    const support = new Float64Array(V);
    let k = 0;
    for (const side of SIDES)
      for (const [short, amount] of LIMBS) {
        const name = side + short;
        const ends = warp(c, [...bone(name, "h"), ...bone(name, "t")], new Float64Array(6));
        let ax = ends[3]! - ends[0]!,
          ay = ends[4]! - ends[1]!,
          az = ends[5]! - ends[2]!;
        const len = Math.max(Math.hypot(ax, ay, az), 1e-12);
        ax /= len;
        ay /= len;
        az /= len;
        for (let v = 0; v < V; v++) {
          const m = masks[v * 6 + k]!;
          support[v] += m;
          if (m === 0) continue;
          const o = v * 3;
          const a = added[o]! * ax + added[o + 1]! * ay + added[o + 2]! * az;
          const s = smoothAdded[o]! * ax + smoothAdded[o + 1]! * ay + smoothAdded[o + 2]! * az;
          const axis = [ax, ay, az];
          for (let j = 0; j < 3; j++) {
            const radial = added[o + j]! - a * axis[j]!;
            const smoothRadial = smoothAdded[o + j]! - s * axis[j]!;
            move[o + j] += (-amount * radial + 0.65 * (1 - amount) * (smoothRadial - radial)) * m;
          }
        }
        k++;
      }
    const cand = new Float64Array(n);
    const capMove = 0.022 * h175;
    for (let v = 0; v < V; v++) {
      const o = v * 3;
      let mx = 0,
        my = 0,
        mz = 0;
      if (!pin[v]) {
        const sup = Math.max(support[v]!, 1);
        mx = move[o]! / sup;
        my = move[o + 1]! / sup;
        mz = move[o + 2]! / sup;
        const s = Math.min(1, capMove / Math.max(Math.hypot(mx, my, mz), 1e-12));
        mx *= s;
        my *= s;
        mz *= s;
      }
      cand[o] = body[o]! + mx;
      cand[o + 1] = body[o + 1]! + my;
      cand[o + 2] = body[o + 2]! + mz;
    }
    // 팔꿈치 소매: 기준 몸(reference)에서 아래팔 머리까지 거리로 가중
    const gain = (c.muscle! - 2) / 2;
    const eo = denseTable(runtime, "EO", 2);
    const elbow = new Float64Array(V);
    const radius = 0.075 * h175;
    SIDES.forEach((side, j) => {
      const center = warp(c, bone(side + "ForeArm", "h"), new Float64Array(3));
      for (let v = 0; v < V; v++) {
        const o = v * 3;
        const d =
          Math.hypot(
            reference[o]! - center[0]!,
            reference[o + 1]! - center[1]!,
            reference[o + 2]! - center[2]!,
          ) / radius;
        elbow[v] = Math.max(elbow[v]!, Math.exp(-(d ** 4)) * eo[v * 2 + j]!);
      }
    });
    const smoothCand = laplacian(runtime, Float64Array.from(cand), 16);
    const capSleeve = 0.003 * h175;
    for (let v = 0; v < V; v++) {
      if (pin[v]) continue;
      const o = v * 3;
      const k2 = 0.5 * gain * elbow[v]!;
      let sx = (smoothCand[o]! - cand[o]!) * k2,
        sy = (smoothCand[o + 1]! - cand[o + 1]!) * k2,
        sz = (smoothCand[o + 2]! - cand[o + 2]!) * k2;
      const s = Math.min(1, capSleeve / Math.max(Math.hypot(sx, sy, sz), 1e-12));
      sx *= s;
      sy *= s;
      sz *= s;
      cand[o] += sx;
      cand[o + 1] += sy;
      cand[o + 2] += sz;
    }
    body.set(foldGuard(runtime, reference, cand, refNormals(), 30, 6));
  }

  const activation = smooth(1.25, 2, c.muscle!);
  if (activation >= 1e-12) {
    const gain = clip((c.muscle! - 2) / 2, 0, 1);
    const amount = (0.004 + 0.008 * gain) * activation * h175;
    const pv = denseTable(runtime, "PV", 1);
    const { basis } = runtime;
    for (let v = 0; v < V; v++) body[v * 3] += -Math.sign(basis[v * 3]!) * amount * pv[v]!;
    foldGuard(runtime, reference, body, refNormals(), 30, 6);
  }
  out.set(body);
  return out;
}

/** 0.2.2 compute(가중합 → warp → fold_guard 20회·3고리) + 해부 층. out을 채운다. */
function anatomy(
  runtime: ShapeRuntime,
  warp: Warp,
  c: BlenderControls,
  out: Float64Array,
  reference: Float64Array,
  normals: Float64Array,
) {
  const weights = mappingsFemale022(runtime, c);
  const coef = new Map<string, number>();
  for (const [name, w] of Object.entries(weights)) if (w !== 0) coef.set("D:" + name, w);
  const body = new Float64Array(out.length);
  accumulate(runtime, coef, body);
  const { basis } = runtime;
  for (let i = 0; i < body.length; i++) body[i] += basis[i]!;
  warp(c, body, out);
  foldGuard(runtime, reference, out, faceNormals(runtime, reference, reference, normals), 20, 3);
  return anatomyLayer(runtime, "female", warp, c, out, weights, reference, normals);
}

function pinned(runtime: ShapeRuntime) {
  const [index] = table(runtime, "PIN", 1);
  const pin = new Uint8Array(runtime.header.vertexCount);
  for (const i of index) pin[i] = 1;
  return pin;
}
