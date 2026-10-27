import type { AnyShapeRuntime, ShapeRuntime } from "./format.js";
import { evaluateSampled } from "./sampled.js";
import { clip, type BlenderControls } from "./common.js";
import { evaluateMale067, MALE_067 } from "./male067.js";
import { evaluateMale0610, MALE_0610 } from "./male0610.js";
import { evaluateFemale022, FEMALE_022 } from "./female022.js";
import { evaluateMale071, MALE_071, MALE_072 } from "./male071.js";
import { evaluateFemale033, FEMALE_033, FEMALE_034 } from "./female033.js";

export type { BlenderControls } from "./common.js";

/**
 * 규칙(`rules`)별 중립 체형 계산. 규칙은 Blender 컨트롤러 버전과 1:1이다 — 컨트롤러 계산이
 * 바뀌면 새 규칙 모듈을 더하고 scripts/shape-runtime/build_runtime.py도 함께 고친다.
 */
const EVALUATORS: Record<
  string,
  (runtime: ShapeRuntime, c: BlenderControls, out: Float32Array) => Float32Array
> = {
  [MALE_067]: evaluateMale067,
  [MALE_0610]: evaluateMale0610,
  [FEMALE_022]: evaluateFemale022,
  [MALE_071]: evaluateMale071,
  [FEMALE_033]: evaluateFemale033,
  [MALE_072]: evaluateMale071,
  [FEMALE_034]: evaluateFemale033,
};
export const SUPPORTED_RULES: ReadonlySet<string> = new Set(Object.keys(EVALUATORS));

/**
 * 앱의 조절 값(`body-shape.v1` key) → Blender 컨트롤러 값.
 * 기본값 ← 고른 프리셋 ← 사용자가 바꾼 값 순서로 덮고, 범위 밖 값은 자른다.
 */
export function resolveControls(
  runtime: AnyShapeRuntime,
  preset: string | undefined,
  controls: Record<string, number> | null | undefined,
): BlenderControls {
  const h = runtime.header;
  const out: BlenderControls = {};
  for (const [key, spec] of Object.entries(h.controls)) out[key] = spec.default;
  if (preset) {
    const values = h.presets[preset];
    if (!values) throw new Error("shape runtime: unknown preset " + preset);
    Object.assign(out, values);
  }
  for (const [key, value] of Object.entries(controls ?? {})) {
    const target = h.aliases[key] ?? key;
    const spec = h.controls[target];
    if (!spec || !Number.isFinite(value)) continue; // 모르는 key는 렌더에 쓰지 않는다
    out[target] = value;
  }
  for (const [key, spec] of Object.entries(h.controls))
    out[key] = clip(out[key]!, spec.min, spec.max);
  return out;
}

/**
 * Blender z-up 미터 좌표의 정점 위치(Float32Array, 정점×3).
 * v2(표본) 자산은 프리셋마다 모델이 따로라 `preset`이 필요하다.
 */
export function evaluateShape(
  runtime: AnyShapeRuntime,
  c: BlenderControls,
  out = new Float32Array(runtime.header.vertexCount * 3),
  preset?: string,
) {
  if (runtime.kind === "sampled") {
    if (!preset) throw new Error("shape runtime: sampled runtime needs a preset");
    return evaluateSampled(runtime, preset, c, out);
  }
  const run = EVALUATORS[runtime.header.rules];
  if (!run) throw new Error("shape runtime: unsupported rules " + runtime.header.rules);
  return run(runtime, c, out);
}
