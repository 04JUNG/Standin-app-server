import type { ShapeRuntime } from "./format.js";
import {
  REGIONS,
  accumulate,
  clip,
  constant,
  constantMap,
  interp,
  smooth,
  type BlenderControls,
  type Landmarks,
} from "./common.js";

/**
 * standin-body-0.6.7(남성) 중립 체형 계산(standin_body.py `compute`)을 그대로 옮긴 것.
 *
 *   body = basis + Σ coef(c)·F           (compose_body, 두 번: 현재 가중치 / 0.6.0 지방 가중치)
 *        + 지방 연결 띠 보정               (fat_connection_offset, 평활 결과는 미리 구움)
 *   → 상체 0.6.0 분포 유지, 근육 1~2 전이 → warp(키·등신·길이·머리·목)
 *
 * 빠진 것: fold_guard(면 뒤집힘 반복 수리). 굽는 쪽 검증 92조합에서 한 번도 동작하지 않았다.
 * 0.6.10(male0610.ts)이 이 단계들(가중치·계수·휴지 몸·warp)을 그대로 다시 쓴다.
 */
export const MALE_067 = "standin-body-0.6.7";
const MASKED = new Set(["BODY_Muscle_Thigh", "BODY_Muscle_Back"]);

const BULK_GAINS: Record<string, number> = {
  Chest: 0.35,
  Back: 1.2,
  Shoulder: 1.2,
  UpperArm: 1.05,
  ForeArm: 1.2,
  Thigh: 0.85,
  Calf: 1.0,
};

/**
 * standin_body.mappings: 체형 키 가중치. 0.6.10의 근육 볼륨(`muscle_bulk`)은 근육 키 가중치를
 * 더 올린다. 0.6.7 자산에는 이 조절이 없어 0으로 계산된다.
 */
export function mappings(runtime: ShapeRuntime, c: BlenderControls) {
  const gains = runtime.header.constants.gains;
  const volumeExtra = constantMap(runtime, "volumeExtra");
  const slim = Math.max(0, -c.physique!);
  const fat = Math.max(0, c.physique!);
  const out: Record<string, number> = {};
  for (const r of ["Torso", "Arms", "Legs"]) {
    const f = clip(fat + c["fat_" + r.toLowerCase()]!, 0, 1.7);
    out["BODY_Slim_" + r] = slim;
    out["BODY_Fat_" + r] = f - 0.15 * smooth(1, 1.7, f);
  }
  const t = c.muscle!;
  const volume = t * (1.12 - 0.22 * t);
  const bulk = 0.75 * (c.muscle_bulk ?? 0) * (1 - 0.8 * smooth(0.4, 1.7, fat));
  for (const r of REGIONS) {
    const v =
      gains[r]! * (volume + (volumeExtra[r] ?? 0) * t * t) +
      c["detail_" + r.toLowerCase()]! +
      bulk * BULK_GAINS[r]!;
    out["BODY_Muscle_" + r] = clip(v, 0, 2.9);
  }
  const level = 0.8 * smooth(0.2, 2, t) + 0.5 * c.definition!;
  out.BODY_Definition = Math.min(level, 1) / (1 + 2 * fat);
  for (const [field, name] of [
    ["chest_width", "ChestWidth"],
    ["chest_depth", "ChestDepth"],
    ["waist", "Waist"],
    ["glute", "Glute"],
    ["thigh", "Thigh"],
    ["calf", "Calf"],
  ] as const)
    out["BODY_" + name] = c[field]!;
  return out;
}

/** compose_body(c, weights)를 굽힌 필드의 계수로 바꾼다. */
export function coefficients(
  runtime: ShapeRuntime,
  c: BlenderControls,
  weights: Record<string, number>,
) {
  const fatArmExtra = constant(runtime, "fatArmExtra");
  const excessStart = constant(runtime, "excessStart");
  const a = new Map<string, number>();
  const add = (name: string, v: number) => {
    if (v !== 0) a.set(name, (a.get(name) ?? 0) + v);
  };
  const fat = Math.max(0, c.physique!);
  const soft = 0.7 * smooth(0.3, 1.5, fat);
  for (const [name, w] of Object.entries(weights)) {
    if (name === "BODY_Fat_Torso" || name === "BODY_Fat_Legs") {
      const b = 0.5 * smooth(1, 1.7, w) + 0.3 * smooth(0.7, 1.7, w);
      if (name === "BODY_Fat_Torso") {
        add("DJ:" + name, w);
        add("EJ:" + name, w * b);
        add("R", -0.85 * smooth(0.3, 1.5, w));
      } else {
        add("D:" + name, w);
        add("E:" + name, w * b);
      }
    } else if (name === "BODY_Fat_Arms") {
      add("D:" + name, w);
      add("DT:" + name, w * fatArmExtra * smooth(0.6, 1.7, w));
    } else if (name.startsWith("BODY_Muscle_")) {
      const e = excessStart;
      if (MASKED.has(name) && w > e) {
        add("D:" + name, e);
        add("SM:" + name, e * soft);
        add("DM:" + name, w - e);
        add("SMM:" + name, (w - e) * soft);
      } else {
        add("D:" + name, w);
        add("SM:" + name, w * soft);
      }
    } else if (name === "BODY_Definition") add("DEF", w);
    else add("D:" + name, w);
  }
  return a;
}

/** compute()가 쓰는 두 가중치: 현재 / 상체 0.6.0 지방 분포(legacy). */
export function weightSets(runtime: ShapeRuntime, c: BlenderControls) {
  const weights = mappings(runtime, c);
  const legacy = { ...weights };
  for (const r of ["Torso", "Arms", "Legs"])
    legacy["BODY_Fat_" + r] = clip(Math.max(0, c.physique!) + c["fat_" + r.toLowerCase()]!, 0, 1.7);
  return { weights, legacy };
}

/** Blender z-up 미터 좌표의 정점 위치(Float32Array, 정점×3). */
export function evaluateMale067(runtime: ShapeRuntime, c: BlenderControls, out: Float32Array) {
  const { weights, legacy } = weightSets(runtime, c);
  const body = restBody(
    runtime,
    c,
    coefficients(runtime, c, weights),
    coefficients(runtime, c, legacy),
  );
  return warpBody(runtime, c, body, out);
}

/**
 * compute()의 warp 직전 몸(basis + 변위, Float64). A·B는 현재·legacy 가중치의 필드 계수다.
 * 지방 연결 띠는 A의 필드만 본다(Blender도 현재 가중치의 compose 결과만 띠 보정한다).
 */
export function restBody(
  runtime: ShapeRuntime,
  c: BlenderControls,
  A: Map<string, number>,
  B: Map<string, number>,
) {
  const { basis, band, bandConst } = runtime;
  const V = runtime.header.vertexCount;
  const body = new Float64Array(V * 3);
  const prior = new Float64Array(V * 3);
  accumulate(runtime, A, body);
  accumulate(runtime, B, prior);

  // fat_connection_offset: 허리–엉덩이–허벅지 띠만. body는 아직 basis 기준 변위다.
  const fat2 = Math.max(0, c.physique! + 0.5 * (c.fat_torso! + c.fat_legs!));
  const strength = smooth(0.55, 1.65, fat2);
  if (strength > 0 && band.length) {
    const off = new Float64Array(band.length * 3);
    for (let i = 0; i < off.length; i++) off[i] = bandConst[i]!;
    for (const [name, w] of A) {
      const f = runtime.fields.get(name)!;
      const s = 0.85 * w * f.bandScale;
      for (let i = 0; i < off.length; i++) off[i] += s * f.band[i]!;
    }
    for (let j = 0; j < band.length; j++) {
      const v = band[j]!;
      const x = basis[v * 3]!,
        y = basis[v * 3 + 1]!,
        z = basis[v * 3 + 2]!;
      const mask =
        smooth(0.68, 0.81, z) *
        (1 - smooth(1.09, 1.2, z)) *
        smooth(0.025, 0.095, Math.abs(x)) *
        (0.45 + 0.55 * smooth(-0.04, 0.07, y));
      const ox = off[j * 3]!,
        oy = off[j * 3 + 1]!,
        oz = off[j * 3 + 2]!;
      const k = (strength * mask) / Math.max(1, Math.hypot(ox, oy, oz) / 0.012);
      body[v * 3] += k * ox;
      body[v * 3 + 1] += k * oy;
      body[v * 3 + 2] += k * oz;
    }
  }

  const muscle = 1 - smooth(1, 2, c.muscle!);
  for (let v = 0; v < V; v++) {
    const keep = smooth(1.18, 1.3, basis[v * 3 + 2]!);
    for (let k = 0; k < 3; k++) {
      const i = v * 3 + k;
      let d = body[i]! + (prior[i]! - body[i]!) * keep;
      d = prior[i]! + (d - prior[i]!) * muscle;
      body[i] = basis[i]! + d;
    }
  }
  return body;
}

/** warp(키·등신·길이·머리·목)를 모든 정점에 적용한다. */
export function warpBody<T extends Float32Array | Float64Array>(
  runtime: ShapeRuntime,
  c: BlenderControls,
  body: ArrayLike<number>,
  out: T,
): T {
  const L = runtime.header.landmarks;
  const w = warpParams(L, c);
  const V = Math.floor(body.length / 3); // 보통 정점 전체, 해부 층은 뼈 끝점 몇 개도 넘긴다
  for (let v = 0; v < V; v++)
    warpPoint(L, c, w, body[v * 3]!, body[v * 3 + 1]!, body[v * 3 + 2]!, out, v * 3);
  return out;
}

function warpParams(L: Landmarks, c: BlenderControls) {
  const h = L.hip + 0.085 * c.leg_length!;
  const sh = h + (L.shoulder - L.hip) * (1 + 0.12 * c.torso_length!);
  const ch = sh + (L.chin - L.shoulder) + 0.02 * c.neck_length!;
  const headH = (ch - L.floor) / (c.heads! - 1);
  const newTop = ch + headH;
  const kn =
    L.ankle + (h - L.ankle) * ((L.knee - L.ankle) / (L.hip - L.ankle) - 0.065 * c.leg_ratio!);
  const src = [L.floor, L.ankle, L.knee, L.hip, L.shoulder, L.chin, L.top];
  const dst = [L.floor, L.ankle, kn, h, sh, ch, newTop];
  const hs = headH / (L.top - L.chin);
  const fat = Math.max(0, c.physique!);
  return {
    ch,
    headH,
    newTop,
    src,
    dst,
    hs,
    fat,
    hx: hs ** 0.82 * (1 + 0.04 * fat) * (1 + 0.15 * c.head_width!),
    hy: hs ** 0.65 * (1 + 0.018 * fat) * (1 + 0.18 * c.head_depth!),
    fatNeck: smooth(0, 0.5, fat),
    fullness: 0.07 * fat + 0.025 * c.muscle! + 0.2 * c.neck_width! + 0.2 * Math.max(0, hs - 1),
    scale: c.height_cm! / 100 / (newTop - L.floor),
  };
}

/**
 * standin_body.warp — 한 점. 마스크의 z는 기준 메시가 아니라 체형 변위가 들어간 점의 z다
 * (Blender도 compose 결과를 그대로 warp한다).
 */
function warpPoint(
  L: Landmarks,
  c: BlenderControls,
  w: ReturnType<typeof warpParams>,
  x: number,
  y: number,
  z: number,
  out: Float32Array | Float64Array,
  o: number,
) {
  const ax = Math.abs(x);
  const sign = Math.sign(x);
  let qz = interp(z, w.src, w.dst);
  if (z > L.top) qz = w.newTop + ((z - L.top) * w.headH) / (L.top - L.chin);
  if (z < L.floor) qz = L.floor + (z - L.floor);
  const upper = smooth(1.07, 1.34, z) * (1 - smooth(1.48, 1.56, z));
  let qx = x;
  qx += sign * 0.028 * c.shoulders! * smooth(0.025, 0.165, ax) * upper;
  qx += sign * 0.014 * c.pelvis! * smooth(0.015, 0.075, ax) * (1 - smooth(0.92, 1.17, z));
  qx += sign * clip(ax - 0.165, 0, 0.701 - 0.165) * 0.13 * c.arm_length! * upper;
  const hf = smooth(L.chin - 0.06, L.chin, z);
  qx *= 1 + hf * (w.hx - 1);
  let qy = y + (y - L.head_y) * hf * (w.hy - 1);
  const neckEnd =
    (1 - w.fatNeck) * (1 - smooth(L.chin - 0.015, L.chin + 0.055, z)) +
    w.fatNeck * (1 - smooth(L.chin - 0.085, L.chin - 0.005, z));
  const neck =
    smooth(L.shoulder - 0.015, L.shoulder + 0.075, z) * neckEnd * (1 - smooth(0.075, 0.145, ax));
  qx *= 1 + neck * w.fullness;
  qy += (y - L.head_y) * neck * w.fullness;
  const s = w.scale;
  qx *= s;
  qy *= s;
  qz = qz * s - L.floor * s;
  const blend = (1 - c.head_scale!) * smooth(L.chin - 0.075, L.chin - 0.005, z);
  qx += (0 - qx) * blend;
  qy += (L.head_y * s - qy) * blend;
  qz += ((w.ch - L.floor) * s - qz) * blend;
  out[o] = qx;
  out[o + 1] = qy;
  out[o + 2] = qz;
}
