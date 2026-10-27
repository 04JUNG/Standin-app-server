import type { ShapeRuntime } from "./format.js";

/**
 * 메시 위 계산(이웃 평활·면 뒤집힘 수리)과 규칙별 표 읽기. 0.6.10 근육 볼륨과
 * 0.7.1/여성 0.3.3 해부 보정 층이 같이 쓴다. standin_body.py의 `laplacian_smooth`·`fold_guard`와
 * 같은 식이다.
 */

/** 규칙별 표 `<name>.idx`(정점 번호) / `<name>.val`(정점마다 width개). */
export function table(runtime: ShapeRuntime, name: string, width: number) {
  const index = runtime.arrays.get(name + ".idx");
  const values = runtime.arrays.get(name + ".val");
  if (!(index instanceof Uint16Array) || !(values instanceof Float32Array))
    throw new Error("shape runtime: missing " + name);
  if (values.length !== index.length * width) throw new Error("shape runtime: bad " + name);
  const V = runtime.header.vertexCount;
  for (const i of index) if (i >= V) throw new Error("shape runtime: " + name + " index");
  return [index, values] as const;
}

/** 정점마다 값이 있는 표(굽는 쪽이 0..V-1 순서로 쓴다). 정점 순서 그대로의 값 배열을 준다. */
export function denseTable(runtime: ShapeRuntime, name: string, width: number) {
  const [index, values] = table(runtime, name, width);
  const V = runtime.header.vertexCount;
  if (index.length !== V) throw new Error("shape runtime: " + name + " is not per-vertex");
  for (let i = 0; i < V; i++)
    if (index[i] !== i) throw new Error("shape runtime: " + name + " order");
  return values;
}

/** 메시 이웃(면의 변) 목록. standin_body.laplacian_smooth와 같은 변 집합이다. */
const ADJACENCY = new WeakMap<ShapeRuntime, { start: Uint32Array; next: Uint32Array }>();
export function adjacency(runtime: ShapeRuntime) {
  let a = ADJACENCY.get(runtime);
  if (a) return a;
  const V = runtime.header.vertexCount;
  const { faces } = runtime;
  const seen = new Set<number>();
  const pairs: number[] = [];
  for (let f = 0; f < faces.length; f += 3)
    for (let e = 0; e < 3; e++) {
      const p = faces[f + e]!,
        q = faces[f + ((e + 1) % 3)]!;
      const key = p < q ? p * 65536 + q : q * 65536 + p;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push(p, q);
    }
  const start = new Uint32Array(V + 1);
  for (const v of pairs) start[v + 1]++;
  for (let v = 0; v < V; v++) start[v + 1] += start[v]!;
  const fill = start.slice(0, V);
  const next = new Uint32Array(pairs.length);
  for (let i = 0; i < pairs.length; i += 2) {
    const p = pairs[i]!,
      q = pairs[i + 1]!;
    next[fill[p]!++] = q;
    next[fill[q]!++] = p;
  }
  a = { start, next };
  ADJACENCY.set(runtime, a);
  return a;
}

/** standin_body.laplacian_smooth: d += 0.5·(이웃 평균 − d), 제자리. */
export function laplacian(runtime: ShapeRuntime, d: Float64Array, iterations: number) {
  const { start, next } = adjacency(runtime);
  const V = runtime.header.vertexCount;
  const avg = new Float64Array(V * 3);
  for (let it = 0; it < iterations; it++) {
    for (let v = 0; v < V; v++) {
      const a = start[v]!,
        b = start[v + 1]!;
      let sx = 0,
        sy = 0,
        sz = 0;
      for (let e = a; e < b; e++) {
        const u = next[e]! * 3;
        sx += d[u]!;
        sy += d[u + 1]!;
        sz += d[u + 2]!;
      }
      const n = Math.max(b - a, 1);
      avg[v * 3] = sx / n;
      avg[v * 3 + 1] = sy / n;
      avg[v * 3 + 2] = sz / n;
    }
    for (let i = 0; i < d.length; i++) d[i] += 0.5 * (avg[i]! - d[i]!);
  }
  return d;
}

/** 면 법선 두 벌(base, normalRef) — fold_guard의 뒤집힘 기준. out은 면×6. */
export function faceNormals(
  runtime: ShapeRuntime,
  base: ArrayLike<number>,
  normalRef: ArrayLike<number>,
  out: Float64Array = new Float64Array((runtime.faces.length / 3) * 6),
): Float64Array {
  normalsInto(runtime.faces, base, out, 0);
  normalsInto(runtime.faces, normalRef, out, 3);
  return out;
}

function normalsInto(faces: Uint16Array, q: ArrayLike<number>, out: Float64Array, k: number) {
  const nf = faces.length / 3;
  for (let f = 0; f < nf; f++) {
    const a = faces[f * 3]! * 3,
      b = faces[f * 3 + 1]! * 3,
      c = faces[f * 3 + 2]! * 3;
    const ux = q[b]! - q[a]!,
      uy = q[b + 1]! - q[a + 1]!,
      uz = q[b + 2]! - q[a + 2]!,
      vx = q[c]! - q[a]!,
      vy = q[c + 1]! - q[a + 1]!,
      vz = q[c + 2]! - q[a + 2]!;
    out[f * 6 + k] = uy * vz - uz * vy;
    out[f * 6 + k + 1] = uz * vx - ux * vz;
    out[f * 6 + k + 2] = ux * vy - uy * vx;
  }
}

/**
 * standin_body.fold_guard(max_iterations, max_rings, normal_reference): 기준(base)이나 normalRef와
 * 방향이 반대인 면을 찾아, 그 둘레(2고리, 안 되면 1고리씩 넓힘)의 변위를 이웃 평균 쪽으로 풀고 필요하면
 * 기준 쪽으로 줄인다. body를 제자리에서 고친다. 바뀌는 건 구역 정점뿐이라 검사도 구역에 닿는
 * 면만 다시 한다(Blender의 전체 검사와 결과가 같다). normals = faceNormals(base, normalRef)
 * (normal_reference가 없는 규칙은 faceNormals(base, base)).
 */
export function foldGuard<T extends Float32Array | Float64Array>(
  runtime: ShapeRuntime,
  base: ArrayLike<number>,
  body: T,
  normals: Float64Array,
  maxIterations = 30,
  maxRings = 6,
): T {
  const { faces } = runtime;
  const V = runtime.header.vertexCount;
  const nf = faces.length / 3;
  const p = Float64Array.from(body);
  // 면 법선 · 기준 법선 ≤ 0 이면 뒤집힘. 매 체형 변경마다 5만 면을 보므로 풀어서 쓴다.
  const flipped = (f: number) => {
    const a = faces[f * 3]! * 3,
      b = faces[f * 3 + 1]! * 3,
      c = faces[f * 3 + 2]! * 3;
    const ux = p[b]! - p[a]!,
      uy = p[b + 1]! - p[a + 1]!,
      uz = p[b + 2]! - p[a + 2]!,
      vx = p[c]! - p[a]!,
      vy = p[c + 1]! - p[a + 1]!,
      vz = p[c + 2]! - p[a + 2]!;
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    const o = f * 6;
    return (
      normals[o]! * nx + normals[o + 1]! * ny + normals[o + 2]! * nz <= 0 ||
      normals[o + 3]! * nx + normals[o + 4]! * ny + normals[o + 5]! * nz <= 0
    );
  };
  const zone = new Uint8Array(V);
  let bad: number[] = [];
  for (let f = 0; f < nf; f++) if (flipped(f)) bad.push(f);
  if (!bad.length) return body;

  const { start, next } = adjacency(runtime);
  const grow = (rings: number) => {
    for (let i = 0; i < rings; i++) {
      const add: number[] = [];
      for (let v = 0; v < V; v++)
        if (!zone[v])
          for (let e = start[v]!; e < start[v + 1]!; e++)
            if (zone[next[e]!]) {
              add.push(v);
              break;
            }
      for (const v of add) zone[v] = 1;
    }
  };
  const mark = (fs: number[]) => {
    for (const f of fs) for (let k = 0; k < 3; k++) zone[faces[f * 3 + k]!] = 1;
  };
  mark(bad);
  grow(2);
  const d = new Float64Array(V * 3);
  for (let i = 0; i < d.length; i++) d[i] = body[i]! - base[i]!;
  const sync = (members: number[]) => {
    for (const v of members)
      for (let k = 0; k < 3; k++) p[v * 3 + k] = base[v * 3 + k]! + d[v * 3 + k]!;
  };
  for (let i = 0; i < p.length; i++) p[i] = base[i]! + d[i]!;
  let members: number[] = [],
    checked: number[] = [];
  const refresh = () => {
    members = [];
    for (let v = 0; v < V; v++) if (zone[v]) members.push(v);
    checked = [];
    for (let f = 0; f < nf; f++)
      if (zone[faces[f * 3]!] || zone[faces[f * 3 + 1]!] || zone[faces[f * 3 + 2]!])
        checked.push(f);
  };
  refresh();
  const avg = new Float64Array(V * 3);
  const half = Math.floor(maxIterations / 2);
  for (let ring = 0; ring < maxRings; ring++) {
    for (let it = 0; it < maxIterations; it++) {
      if (ring > 0 || it >= half)
        for (const v of members) for (let k = 0; k < 3; k++) d[v * 3 + k] *= 0.9;
      for (const v of members) {
        const a = start[v]!,
          b = start[v + 1]!,
          cnt = Math.max(b - a, 1);
        for (let k = 0; k < 3; k++) {
          let s = 0;
          for (let e = a; e < b; e++) s += d[next[e]! * 3 + k]!;
          avg[v * 3 + k] = s / cnt;
        }
      }
      for (const v of members)
        for (let k = 0; k < 3; k++) d[v * 3 + k] += 0.5 * (avg[v * 3 + k]! - d[v * 3 + k]!);
      sync(members);
      bad = checked.filter(flipped);
      if (!bad.length) break;
    }
    if (!bad.length) break;
    mark(bad);
    grow(1);
    refresh();
  }
  for (let i = 0; i < body.length; i++) body[i] = p[i]!;
  return body;
}
