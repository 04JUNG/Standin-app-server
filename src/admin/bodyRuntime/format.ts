import { z } from "zod";

/**
 * `standin-shape-runtime.v1` (.ssr): Blender 체형 컨트롤러의 중립 체형 계산을 앱에서 다시 하기 위한 자산.
 *
 *   "SSR1" | u32 headerBytes | header JSON (UTF-8, 공백으로 4바이트 정렬) | data
 *
 * data에는 기준 메시(basis, faces)와 체형 필드가 들어 있다. 무거운 평활화는 굽는 쪽
 * (scripts/shape-runtime)에서 끝났고, 앱은 필드의 가중합과 정점별 닫힌 식만 계산한다.
 * 형식과 크기를 모두 검사한다 — 검사를 통과하지 못한 자산은 그리지 않는다.
 */
export const SHAPE_RUNTIME_FORMAT = "standin-shape-runtime.v1";
const MAGIC = 0x31525353; // "SSR1" little-endian
const MAX_VERTICES = 65535; // faces/indices are u16

const finite = z.number().finite();
const arraySchema = z.object({
  name: z.string().min(1),
  dtype: z.enum(["float32", "uint16", "int16"]),
  offset: z.number().int().nonnegative(),
  length: z.number().int().nonnegative(),
});
const sourceSchema = z.object({
  blendSha256: z.string().regex(/^[a-f0-9]{64}$/),
  controllerSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const headerSchema = z.object({
  format: z.literal(SHAPE_RUNTIME_FORMAT),
  rules: z.string().min(1),
  asset: z.string().min(1),
  /** 이 자산을 구운 원본 .blend·컨트롤러 해시(2026-10-16부터). 굽기 연동 카탈로그는 이 값을 대조한다. */
  source: sourceSchema.optional(),
  vertexCount: z.number().int().positive().max(MAX_VERTICES),
  faceCount: z.number().int().nonnegative(),
  bandCount: z.number().int().nonnegative(),
  landmarks: z
    .object({
      floor: finite,
      ankle: finite,
      knee: finite,
      hip: finite,
      shoulder: finite,
      chin: finite,
      top: finite,
      head_y: finite,
    })
    .passthrough(),
  baseHeads: finite,
  controls: z.record(z.object({ min: finite, max: finite, default: finite })),
  aliases: z.record(z.string()),
  presets: z.record(z.record(finite)),
  /** 규칙마다 다른 상수. 각 규칙의 계산 모듈이 필요한 값을 다시 검사한다. */
  constants: z.object({ gains: z.record(finite) }).catchall(z.union([finite, z.record(finite)])),
  fields: z.array(
    z.object({
      name: z.string().min(1),
      scale: finite.positive(),
      bandScale: finite.positive(),
      count: z.number().int().nonnegative(),
    }),
  ),
  arrays: z.array(arraySchema),
});
export type ShapeRuntimeHeader = z.infer<typeof headerSchema>;

export type ShapeField = {
  name: string;
  /** 0이 아닌 정점 번호와 xyz 값(int16 × scale). */
  index: Uint16Array;
  values: Int16Array;
  scale: number;
  /** 지방 연결 띠(band) 정점의 36회 평활 차이(int16 × bandScale). */
  band: Int16Array;
  bandScale: number;
};
export type ShapeRuntime = {
  kind: "rules";
  header: ShapeRuntimeHeader;
  basis: Float32Array;
  faces: Uint16Array;
  band: Uint16Array;
  bandConst: Float32Array;
  fields: Map<string, ShapeField>;
  /** 규칙별 추가 표(예: 0.6.10 근육 볼륨 `MB.idx`/`MB.val`). 각 규칙 모듈이 길이를 다시 검사한다. */
  arrays: ReadonlyMap<string, Float32Array | Uint16Array | Int16Array>;
};

const TYPED = { float32: Float32Array, uint16: Uint16Array, int16: Int16Array } as const;

/** v1(규칙을 옮긴 계산) 또는 v2(컨트롤러 출력을 표본으로 굽힌 계산). */
export type AnyShapeRuntime = ShapeRuntime | SampledRuntime;

export function parseShapeRuntime(buffer: ArrayBuffer): AnyShapeRuntime {
  if (buffer.byteLength < 8) throw new Error("shape runtime: too short");
  const view = new DataView(buffer);
  if (view.getUint32(0, true) === MAGIC_V2) return parseSampledRuntime(buffer);
  if (view.getUint32(0, true) !== MAGIC) throw new Error("shape runtime: bad magic");
  const headerBytes = view.getUint32(4, true);
  if (headerBytes % 4 !== 0 || 8 + headerBytes > buffer.byteLength)
    throw new Error("shape runtime: bad header size");
  const header = headerSchema.parse(
    JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, headerBytes))),
  );
  const dataStart = 8 + headerBytes;
  const arrays = new Map<string, Float32Array | Uint16Array | Int16Array>();
  for (const a of header.arrays) {
    const Type = TYPED[a.dtype];
    const start = dataStart + a.offset;
    if (start % Type.BYTES_PER_ELEMENT !== 0)
      throw new Error("shape runtime: misaligned " + a.name);
    if (start + a.length * Type.BYTES_PER_ELEMENT > buffer.byteLength)
      throw new Error("shape runtime: out of bounds " + a.name);
    if (arrays.has(a.name)) throw new Error("shape runtime: duplicate " + a.name);
    arrays.set(a.name, new Type(buffer, start, a.length));
  }
  const take = <T extends Float32Array | Uint16Array | Int16Array>(
    name: string,
    Type: { new (...args: never[]): T },
    length: number,
  ): T => {
    const a = arrays.get(name);
    if (!(a instanceof Type) || a.length !== length) throw new Error("shape runtime: bad " + name);
    return a;
  };
  const V = header.vertexCount;
  const basis = take("basis", Float32Array, V * 3);
  const faces = take("faces", Uint16Array, header.faceCount * 3);
  const band = take("band", Uint16Array, header.bandCount);
  const bandConst = take("bandConst", Float32Array, header.bandCount * 3);
  for (const i of faces) if (i >= V) throw new Error("shape runtime: face index");
  for (const i of band) if (i >= V) throw new Error("shape runtime: band index");
  for (const v of basis) if (!Number.isFinite(v)) throw new Error("shape runtime: basis");
  const fields = new Map<string, ShapeField>();
  for (const f of header.fields) {
    const index = take("F.idx:" + f.name, Uint16Array, f.count);
    for (const i of index) if (i >= V) throw new Error("shape runtime: field index " + f.name);
    fields.set(f.name, {
      name: f.name,
      index,
      values: take("F.val:" + f.name, Int16Array, f.count * 3),
      scale: f.scale,
      band: take("G.val:" + f.name, Int16Array, header.bandCount * 3),
      bandScale: f.bandScale,
    });
  }
  return { kind: "rules", header, basis, faces, band, bandConst, fields, arrays };
}

/**
 * `standin-shape-runtime.v2` (.ssr, "SSR2"): 버전에 매이지 않는 표본 자산.
 *
 * 굽는 쪽(scripts/shape-runtime/build_sampled_runtime.py)이 Blender에서 컨트롤러 `compute()`를
 * 직접 돌려 프리셋마다 (1) 조절 하나씩 움직인 곡선과 (2) 서로 영향을 크게 주고받는 조절 쌍의
 * 격자를 표본으로 뜨고, 모든 표본을 공통 기저(PCA)로 줄여 담는다. 앱은 컨트롤러 계산을 모른 채
 * 선형 보간과 기저 합만 한다 — 그래서 모델 버전이 바뀌어도 앱 코드는 그대로다.
 *
 *   위치 = mean + Σ_b coef_b · scale_b · basis_b
 *   coef = base(프리셋) + Σ_조절 곡선 보간 + Σ_쌍 이중선형 보간
 *
 * 헤더의 `source`는 이 자산을 만든 .blend·컨트롤러 해시다. 카탈로그가 약속한 source와 다르면
 * 앱은 이 자산을 쓰지 않는다(서버가 굽는 몸과 다른 몸을 보여 주지 않기 위해).
 */
export const SHAPE_RUNTIME_FORMAT_V2 = "standin-shape-runtime.v2";
const MAGIC_V2 = 0x32525353; // "SSR2"
const MAX_BASIS = 512;

const axisSchema = z.object({
  key: z.string().min(1),
  knots: z.array(finite).min(2).max(64),
  offset: z.number().int().nonnegative(),
});
const pairSchema = z.object({
  a: z.string().min(1),
  b: z.string().min(1),
  ga: z.array(finite).min(2).max(16),
  gb: z.array(finite).min(2).max(16),
  offset: z.number().int().nonnegative(),
});
const sampledHeaderSchema = z.object({
  format: z.literal(SHAPE_RUNTIME_FORMAT_V2),
  rules: z.string().min(1).max(64),
  source: sourceSchema,
  asset: z.string().min(1),
  vertexCount: z.number().int().positive().max(MAX_VERTICES),
  faceCount: z.number().int().nonnegative(),
  basisCount: z.number().int().positive().max(MAX_BASIS),
  coefCount: z.number().int().positive(),
  controls: z.record(z.object({ min: finite, max: finite, default: finite })),
  aliases: z.record(z.string()),
  presets: z.record(z.record(finite)),
  models: z.record(
    z.object({
      base: z.number().int().nonnegative(),
      axes: z.array(axisSchema),
      pairs: z.array(pairSchema),
    }),
  ),
  /**
   * 어느 프리셋 모델로 계산할지. 모든 모델은 같은 함수(컨트롤러 compute)를 서로 다른 점(프리셋)
   * 둘레에서 근사한다. `idw2`: 조절 범위로 정규화한 거리 d로 가까운 모델들을 1/d² 가중 평균한다
   * (d가 가장 가까운 것의 `cutRatio`배를 넘는 모델은 0, 연속). 없으면 고른 프리셋 모델만 쓴다.
   */
  selection: z.object({ mode: z.literal("idw2"), cutRatio: finite.min(1).max(16) }).optional(),
  /** 굽을 때 잰 오차(mm). 앱은 쓰지 않고 기록용으로만 둔다. */
  quality: z.record(z.unknown()).optional(),
  arrays: z.array(arraySchema),
});
export type SampledHeader = z.infer<typeof sampledHeaderSchema>;
export type SampledModel = SampledHeader["models"][string];
export type SampledRuntime = {
  kind: "sampled";
  header: SampledHeader;
  faces: Uint16Array;
  mean: Float32Array;
  basis: Int16Array;
  basisScale: Float32Array;
  coef: Float32Array;
};

function parseSampledRuntime(buffer: ArrayBuffer): SampledRuntime {
  const view = new DataView(buffer);
  const headerBytes = view.getUint32(4, true);
  if (headerBytes % 4 !== 0 || 8 + headerBytes > buffer.byteLength)
    throw new Error("shape runtime: bad header size");
  const header = sampledHeaderSchema.parse(
    JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, headerBytes))),
  );
  const dataStart = 8 + headerBytes;
  const arrays = new Map<string, Float32Array | Uint16Array | Int16Array>();
  for (const a of header.arrays) {
    const Type = TYPED[a.dtype];
    const start = dataStart + a.offset;
    if (start % Type.BYTES_PER_ELEMENT !== 0)
      throw new Error("shape runtime: misaligned " + a.name);
    if (start + a.length * Type.BYTES_PER_ELEMENT > buffer.byteLength)
      throw new Error("shape runtime: out of bounds " + a.name);
    if (arrays.has(a.name)) throw new Error("shape runtime: duplicate " + a.name);
    arrays.set(a.name, new Type(buffer, start, a.length));
  }
  const take = <T extends Float32Array | Uint16Array | Int16Array>(
    name: string,
    Type: { new (...args: never[]): T },
    length: number,
  ): T => {
    const a = arrays.get(name);
    if (!(a instanceof Type) || a.length !== length) throw new Error("shape runtime: bad " + name);
    return a;
  };
  const V = header.vertexCount;
  const K = header.basisCount;
  const faces = take("faces", Uint16Array, header.faceCount * 3);
  const mean = take("mean", Float32Array, V * 3);
  const basis = take("basis", Int16Array, K * V * 3);
  const basisScale = take("basisScale", Float32Array, K);
  const coef = take("coef", Float32Array, header.coefCount * K);
  for (const i of faces) if (i >= V) throw new Error("shape runtime: face index");
  for (const a of [mean, basisScale, coef])
    for (const v of a) if (!Number.isFinite(v)) throw new Error("shape runtime: not finite");
  // 모든 표·격자가 자산 안을 가리키고, 조절 이름이 헤더에 있고, 격자가 오름차순인가.
  const ascending = (xs: number[]) => xs.every((x, i) => i === 0 || x > xs[i - 1]!);
  for (const [name, model] of Object.entries(header.models)) {
    if (!(name in header.presets)) throw new Error("shape runtime: model without preset " + name);
    const within = (offset: number, count: number) => {
      if (offset + count > header.coefCount) throw new Error("shape runtime: coef offset " + name);
    };
    within(model.base, 1);
    for (const axis of model.axes) {
      if (!(axis.key in header.controls) || !ascending(axis.knots))
        throw new Error("shape runtime: axis " + axis.key);
      within(axis.offset, axis.knots.length);
    }
    for (const pair of model.pairs) {
      if (
        !(pair.a in header.controls) ||
        !(pair.b in header.controls) ||
        pair.a === pair.b ||
        !ascending(pair.ga) ||
        !ascending(pair.gb)
      )
        throw new Error("shape runtime: pair " + pair.a + "×" + pair.b);
      within(pair.offset, pair.ga.length * pair.gb.length);
    }
  }
  for (const preset of Object.keys(header.presets))
    if (!header.models[preset]) throw new Error("shape runtime: preset without model " + preset);
  return { kind: "sampled", header, faces, mean, basis, basisScale, coef };
}
