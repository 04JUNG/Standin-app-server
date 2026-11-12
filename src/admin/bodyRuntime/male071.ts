import type { ShapeRuntime } from "./format.js";
import type { BlenderControls } from "./common.js";
import { mappings, warpBody } from "./male067.js";
import { refineBulkProfile, restBodyBulk } from "./male0610.js";
import { anatomyLayer, anatomyWarp, normalsBuffer, type Warp } from "./anatomy.js";
import { faceNormals, foldGuard } from "./mesh.js";

/**
 * standin-body-0.7.1(남성) 중립 체형 계산 = 0.6.10 compute(근육 볼륨 포함) + 해부 보정 층(anatomy.ts).
 * 0.7.1의 머리 크기 변경은 프리셋 값(SOFT·FAT_MAX head_scale 0.927)뿐이라 계산식은 0.7.0과 같다.
 *
 * Blender에서는 0.6.10 compute가 새 warp와 새 compute를 전역으로 부르므로:
 *   - 휴지 몸을 새 warp(PCHIP)로 편다.
 *   - 근육 볼륨 > 0의 기준(guard)은 근육 볼륨 0의 "해부 층까지 끝난" 결과다.
 *   - fold_guard를 항상 돌린다(0.7.1은 근육 볼륨 0에서도 TOON64·FAT_MAX 등에서 실제로 동작한다).
 */
export const MALE_071 = "standin-body-0.7.1";
/**
 * 0.7.2는 포즈 표면 보정(correct_pose)만 바뀌었고 중립 체형 계산·웨이트·관절·프리셋은 0.7.1과 같다
 * (2026-10-16 확인: 20개 조합 0.0 mm). 같은 계산을 쓴다 — 자산은 0.7.2 원본으로 다시 굽는다.
 */
export const MALE_072 = "standin-body-0.7.2";

export function evaluateMale071(runtime: ShapeRuntime, c: BlenderControls, out: Float32Array) {
  const parent: Warp = (cc, points, o) => warpBody(runtime, cc, points, o);
  const warp = anatomyWarp(runtime, "male", parent);
  out.set(compute(runtime, warp, c, new Float64Array(out.length), normalsBuffer(runtime)));
  return out;
}

/** 끝까지 Float64로 계산한다 — fold_guard의 뒤집힘 판정(≤ 0)이 거의 납작한 면에서 Blender와 갈리지 않게. */
function compute(
  runtime: ShapeRuntime,
  warp: Warp,
  c: BlenderControls,
  out: Float64Array,
  normals: Float64Array,
): Float64Array {
  const n = out.length;
  const reference = warp(c, runtime.basis, new Float64Array(n));
  const bulk = (c.muscle_bulk ?? 0) > 0;
  const guard = bulk
    ? compute(runtime, warp, { ...c, muscle_bulk: 0 }, new Float64Array(n), normals)
    : reference;
  warp(c, restBodyBulk(runtime, c), out);
  foldGuard(runtime, guard, out, faceNormals(runtime, guard, reference, normals), 30, 6);
  if (bulk) {
    refineBulkProfile(runtime, out, guard);
    foldGuard(runtime, guard, out, faceNormals(runtime, guard, reference, normals), 30, 6);
  }
  return anatomyLayer(runtime, "male", warp, c, out, mappings(runtime, c), reference, normals);
}
