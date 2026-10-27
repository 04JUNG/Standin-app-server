import type { ShapeRuntime } from "./format.js";
import {
  REGIONS,
  accumulate,
  clip,
  interp,
  smooth,
  type BlenderControls,
  type Landmarks,
} from "./common.js";

/**
 * standin-female-body-0.2.2(여성) 중립 체형 계산(standin_body.py `compute`)을 옮긴 것.
 *
 *   body = basis + Σ w(c)·BODY 키 → warp(키·등신·길이·어깨·골반·머리·목)
 *
 * 남성과 달리 평활화·혼합이 없어 굽힌 필드는 원래 BODY 키 그대로다.
 * 빠진 것: fold_guard. 굽는 쪽 검증 109조합에서 한 번도 동작하지 않았다.
 */
export const FEMALE_022 = "standin-female-body-0.2.2";

/** standin_body.mappings(여성 0.2.2). */
export function mappingsFemale022(runtime: ShapeRuntime, c: BlenderControls) {
  const gains = runtime.header.constants.gains;
  const slim = Math.max(0, -c.physique!);
  const fat = Math.max(0, c.physique!);
  const fd = c.fat_distribution!;
  const gain = c.fat_gain!;
  const out: Record<string, number> = {};
  for (const r of ["Torso", "Arms", "Legs"]) {
    out["BODY_Slim_" + r] = slim;
    const f = clip(fat + c["fat_" + r.toLowerCase()]!, 0, 1.4);
    out["BODY_Fat_" + r] =
      f * (r === "Torso" ? 1 - 0.14 * Math.max(fd, 0) : r === "Legs" ? 1 + 0.14 * fd : 1);
  }
  out.BODY_Fat_Abdomen = fat * Math.max(0, -fd) * 0.45;
  const t = Math.min(c.muscle!, 2);
  for (const r of REGIONS)
    out["BODY_Muscle_" + r] = clip(
      gains[r]! * t * (1.05 - 0.2 * t) + c["detail_" + r.toLowerCase()]!,
      0,
      1.8,
    );
  const athletic = Math.max(0, c.muscle! - 2) / 2;
  out.BODY_Definition =
    (0.5 * smooth(0.25, 2, c.muscle!) + 0.7 * c.definition!) / (1 + 2 * fat + 2 * gain);
  out.BODY_WeightGain = gain;
  out.BODY_AthleticVolume = athletic;
  out.BODY_AthleticDefinition = athletic / (1 + fat + 1.5 * gain);
  out.BODY_ProfileFat = gain / 2;
  out.BODY_ProfileAthletic = athletic;
  for (const [field, name] of [
    ["chest_width", "ChestWidth"],
    ["chest_depth", "ChestDepth"],
    ["waist", "Waist"],
    ["glute", "Glute"],
    ["thigh", "Thigh"],
    ["calf", "Calf"],
    ["breast_projection", "BreastProjection"],
    ["breast_spacing", "BreastSpacing"],
    ["breast_height", "BreastHeight"],
    ["breast_width", "BreastWidth"],
  ] as const)
    out["BODY_" + name] = c[field]!;
  out.BODY_BreastSmall = Math.max(0, -c.breast_size!);
  out.BODY_BreastLarge = Math.max(0, c.breast_size!);
  return out;
}

export function evaluateFemale022(runtime: ShapeRuntime, c: BlenderControls, out: Float32Array) {
  const { basis } = runtime;
  const V = runtime.header.vertexCount;
  const coef = new Map<string, number>();
  for (const [name, w] of Object.entries(mappingsFemale022(runtime, c)))
    if (w !== 0) coef.set("D:" + name, w);
  const body = new Float64Array(V * 3);
  accumulate(runtime, coef, body);
  const L = runtime.header.landmarks;
  const w = warpParams(L, c);
  for (let v = 0; v < V; v++) {
    const i = v * 3;
    const p = warpPoint(
      L,
      c,
      w,
      basis[i]! + body[i]!,
      basis[i + 1]! + body[i + 1]!,
      basis[i + 2]! + body[i + 2]!,
    );
    out[i] = p[0]!;
    out[i + 1] = p[1]!;
    out[i + 2] = p[2]!;
  }
  return out;
}

/** 여성 warp를 점 묶음(정점×3, 체형 변위가 들어간 점)에 적용한다. 0.3.3 해부 층도 이 warp를 쓴다. */
export function warpFemale022<T extends Float32Array | Float64Array>(
  runtime: ShapeRuntime,
  c: BlenderControls,
  points: ArrayLike<number>,
  out: T,
): T {
  const L = runtime.header.landmarks;
  const w = warpParams(L, c);
  for (let i = 0; i + 2 < points.length; i += 3) {
    const p = warpPoint(L, c, w, points[i]!, points[i + 1]!, points[i + 2]!);
    out[i] = p[0]!;
    out[i + 1] = p[1]!;
    out[i + 2] = p[2]!;
  }
  return out;
}

function warpParams(L: Landmarks, c: BlenderControls) {
  const h = L.hip + 0.065 * c.leg_length!;
  const sh = h + (L.shoulder - L.hip) * (1 + 0.1 * c.torso_length!);
  const ch = sh + (L.chin - L.shoulder) + 0.015 * c.neck_length!;
  const hh = (ch - L.floor) / (c.heads! - 1);
  const newTop = ch + hh;
  const kn =
    L.ankle + (h - L.ankle) * ((L.knee - L.ankle) / (L.hip - L.ankle) - 0.055 * c.leg_ratio!);
  const hs = hh / (L.top - L.chin);
  return {
    ch,
    hh,
    newTop,
    src: [L.floor, L.ankle, L.knee, L.hip, L.shoulder, L.chin, L.top],
    dst: [L.floor, L.ankle, kn, h, sh, ch, newTop],
    hx: hs ** 0.74 * (1 + 0.12 * c.head_width!),
    hy: hs ** 0.68 * (1 + 0.14 * c.head_depth!),
    scale: c.height_cm! / 100 / (newTop - L.floor),
  };
}

/** 여성 warp — 한 점(체형 변위가 들어간 점). 남성과 달리 바닥 아래 보정이 없다. */
function warpPoint(
  L: Landmarks,
  c: BlenderControls,
  w: ReturnType<typeof warpParams>,
  x: number,
  y: number,
  z: number,
) {
  const ax = Math.abs(x);
  const sign = Math.sign(x);
  let qz = interp(z, w.src, w.dst);
  if (z > L.top) qz = w.newTop + ((z - L.top) * w.hh) / (L.top - L.chin);
  const upper =
    smooth(L.hip + 0.08, L.shoulder - 0.07, z) * (1 - smooth(L.shoulder + 0.06, L.chin, z));
  let qx = x + sign * 0.022 * c.shoulders! * smooth(0.025, 0.16, ax) * upper;
  const pelvis = (1 - smooth(L.hip + 0.02, L.hip + 0.15, z)) * smooth(0.02, 0.14, z);
  qx += sign * 0.013 * c.pelvis! * smooth(0.015, 0.075, ax) * pelvis;
  qx += sign * clip(ax - 0.165, 0, 0.52) * 0.12 * c.arm_length! * upper;
  const hf = smooth(L.chin - 0.035, L.chin + 0.015, z);
  qx *= 1 + hf * (w.hx - 1);
  let qy = y + (y - L.head_y) * hf * (w.hy - 1);
  const neck =
    smooth(L.shoulder + 0.005, L.shoulder + 0.065, z) *
    (1 - smooth(L.chin - 0.05, L.chin - 0.005, z)) *
    (1 - smooth(0.055, 0.105, ax));
  qx *= 1 + 0.15 * c.neck_width! * neck;
  qy += (y - L.head_y) * 0.15 * c.neck_width! * neck;
  const s = w.scale;
  qx *= s;
  qy *= s;
  qz = qz * s - L.floor * s;
  const f = (c.head_scale! - 1) * smooth(L.chin - 0.06, L.chin - 0.005, z);
  qx += qx * f;
  qy += (qy - L.head_y * s) * f;
  qz += (qz - (w.ch - L.floor) * s) * f;
  return [qx, qy, qz];
}
