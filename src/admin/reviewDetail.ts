// 검토 상세(GET /v1/admin/review/jobs/:id)의 순수 변환 — DB row를 화면이 바로 그릴 수
// 있는 모양으로 바꾼다.
//
// 분리한 이유는 `installationList.ts`와 같다. DB를 띄우는 통합 테스트가 없으니 JSON
// 파싱과 결측 처리는 순수 함수로 빼야 `node --test`로 확인할 수 있다.
//
// 지금까지 이 엔드포인트는 `SELECT *` 결과를 그대로 내보냈다. 그래서 관절과 태그가
// **이미 응답에 들어 있었지만** 문자열이라 화면이 쓰지 못했고, 동시에 화면이 쓰지 않는
// 서버측 전용 컬럼(`refine_context_json`, `raw_scores_json`)까지 함께 나갔다. 여기서
// 쓸 것만 파싱해 내보내고 나머지는 뺀다 — 관절 사본이 두 벌 나가지 않는다.

import { resolveOutputScope, type OutputScope } from "../output-scope/model.js";

export interface AnalysisPersonRow {
  person_index: number;
  bbox_json: string | null;
  tags_json: string | null;
  skeleton_json: string | null;
  confidence: string | null;
  candidate_count: number;
  candidate_shortfall_reason: string | null;
  skeleton_state: string | null;
  skeleton_source: string | null;
  coverage_class: string | null;
  fallback_mode: string | null;
  slot_origin: string | null;
  lower_body_observed: boolean | null;
  refine_allowed: boolean | null;
  refinable_limbs_json: string | null;
  raw_scores_json: string | null;
  person_tags_json: string | null;
  output_scope_json: string | null;
  rank_distance: number | null;
  distance_metric: string | null;
  search_stability: string | null;
  confidence_threshold: number | null;
}

export interface ReviewSkeleton {
  schemaVersion: string;
  /** 관절 좌표. 원본 러프의 픽셀 좌표계다(화면은 이미지 크기에 맞춰 스케일한다). */
  keypoints: number[][];
  /** 관절마다 하나씩. 길이가 맞지 않으면 빈 배열로 둔다. */
  scores: number[];
}

/**
 * 관절을 얼마나 흐리게 그릴지 정하는 점수와, 그 값이 어디서 왔는지.
 *
 * `skeleton.scores`를 그냥 쓰면 안 된다. 추론이 refine을 막은 인물은 그 배열을 0으로
 * 덮어쓴다(Standin-server `pipeline.py::_apply_refine_policy`). 그대로 그리면 멀쩡한
 * 추출까지 전부 흐려져 "추출이 망가졌다"로 잘못 읽힌다. 그래서 전부 0이면 마스킹 전
 * 원본 점수(`raw_scores`)로 바꾸고, 그 사실을 화면에 적는다.
 */
export interface JointScores {
  values: number[];
  source: "effective" | "raw" | "none";
}

/**
 * 인물별 VLM 태그(P2). 컷 단위 `tags`와 달리 사람마다 값이 다르다.
 *
 * `source`로 어디서 온 값인지 가른다 — `vlm_person`은 프롬프트가 인물별로 물어 받은
 * 값이고, `legacy_cut`은 1인 컷의 컷 값을 그 사람 것으로 본 값이다. 행 자체가 없으면
 * 인물별로 물어본 적이 없는 Job이다(프롬프트 `p1-scope` 또는 구 추론).
 */
export interface ReviewPersonTags {
  action: string | null;
  view: string | null;
  source: string | null;
}

/** 이 인물이 왜 그 후보를 받았는지 설명하는 검색 신호. */
export interface ReviewSearchSignals {
  rankDistance: number | null;
  distanceMetric: string | null;
  searchStability: string | null;
  confidenceThreshold: number | null;
}

export interface ReviewPerson {
  personIndex: number;
  box: number[] | null;
  tags: Record<string, string>;
  skeleton: ReviewSkeleton | null;
  jointScores: JointScores;
  confidence: string | null;
  candidateCount: number;
  candidateShortfallReason: string | null;
  skeletonState: string | null;
  skeletonSource: string | null;
  coverageClass: string | null;
  fallbackMode: string | null;
  slotOrigin: string | null;
  lowerBodyObserved: boolean;
  refineAllowed: boolean;
  refinableLimbs: string[];
  outputScope: OutputScope | null;
  personTags: ReviewPersonTags | null;
  searchSignals: ReviewSearchSignals;
}

function parseJson(raw: string | null | undefined): unknown {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // 깨진 한 줄 때문에 상세 화면 전체가 500으로 닫히면 곤란하다. 그 칸만 비운다.
    return null;
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** `[x1, y1, x2, y2]`만 받는다. 길이가 다르면 박스를 그리지 않는다. */
export function parseBox(raw: string | null | undefined): number[] | null {
  const value = parseJson(raw);
  if (!Array.isArray(value) || value.length !== 4 || !value.every(isFiniteNumber)) return null;
  return value;
}

/** 값이 문자열인 항목만 남긴다. 화면은 어휘를 해석하지 않고 그대로 보여 준다. */
export function parseTags(raw: string | null | undefined): Record<string, string> {
  const value = parseJson(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string" && item.length > 0) out[key] = item;
  }
  return out;
}

/**
 * 관절을 꺼낸다. `[x, y]` 쌍이 아닌 항목이 하나라도 있으면 뼈대 전체를 버린다.
 *
 * 일부만 살리지 않는 이유: 관절 번호는 COCO-17 순서에 묶여 있어 중간이 밀리면 어깨가
 * 팔꿈치 자리에 그려진다. 틀린 그림을 보여 주느니 "뼈대 없음"이 낫다.
 */
export function parseSkeleton(raw: string | null | undefined): ReviewSkeleton | null {
  const value = parseJson(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keypointsRaw = record.keypoints;
  if (!Array.isArray(keypointsRaw) || keypointsRaw.length === 0) return null;
  const keypoints: number[][] = [];
  for (const point of keypointsRaw) {
    if (!Array.isArray(point) || point.length < 2 || !isFiniteNumber(point[0]) || !isFiniteNumber(point[1])) {
      return null;
    }
    keypoints.push([point[0], point[1]]);
  }
  const scoresRaw = record.scores;
  const scores =
    Array.isArray(scoresRaw) && scoresRaw.length === keypoints.length && scoresRaw.every(isFiniteNumber)
      ? (scoresRaw as number[])
      : [];
  const schemaVersion =
    typeof record.schemaVersion === "string"
      ? record.schemaVersion
      : typeof record.schema_version === "string"
        ? record.schema_version
        : "unknown";
  return { schemaVersion, keypoints, scores };
}

/** 길이가 관절 수와 같은 숫자 배열만 받는다. */
export function parseScores(raw: string | null | undefined, expectedLength: number): number[] | null {
  const value = parseJson(raw);
  if (!Array.isArray(value) || value.length !== expectedLength || !value.every(isFiniteNumber)) {
    return null;
  }
  return value as number[];
}

export function pickJointScores(
  skeleton: ReviewSkeleton | null,
  rawScores: number[] | null,
): JointScores {
  const effective = skeleton?.scores ?? [];
  if (effective.length > 0 && effective.some((score) => score > 0)) {
    return { values: effective, source: "effective" };
  }
  if (rawScores && rawScores.length > 0) {
    return { values: rawScores, source: "raw" };
  }
  return { values: [], source: "none" };
}

/**
 * 인물별 태그를 꺼낸다. 값이 하나도 없으면 `null` — "묻지 않았다"와 "물었는데 모른다"를
 * 구분해야 하므로 빈 껍데기를 만들지 않는다.
 */
export function parsePersonTags(raw: string | null | undefined): ReviewPersonTags | null {
  const value = parseJson(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const tags = {
    action: typeof record.action === "string" ? record.action : null,
    view: typeof record.view === "string" ? record.view : null,
    source: typeof record.source === "string" ? record.source : null,
  };
  return tags.action === null && tags.view === null && tags.source === null ? null : tags;
}

/**
 * 출력 범위는 두 곳에 있다. `jobs.result_json`에는 사용자가 고른 값까지 반영된 형태가,
 * `analysis_people.output_scope_json`에는 추론이 판정한 원본이 있다. 앞의 것을 먼저 쓰고,
 * 없을 때만 뒤의 것으로 메운다 — 사용자가 바꾼 구도를 추론 판정으로 덮지 않기 위해서다.
 */
export function scopeFromColumn(raw: string | null | undefined): OutputScope | null {
  const value = parseJson(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.detected === undefined && record.source === undefined) return null;
  return resolveOutputScope({
    selection: "auto",
    detected: record.detected as OutputScope["detected"],
    detectionSource: record.source as OutputScope["detectionSource"],
  });
}

function parseLimbs(raw: string | null | undefined): string[] {
  const value = parseJson(raw);
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * 인물별 출력 범위는 `analysis_people`에 컬럼이 없다. 분석 응답 전체를 담은
 * `jobs.result_json` 안에만 있어서 거기서 꺼낸다.
 *
 * 저장된 값을 그대로 믿지 않고 `resolveOutputScope`로 다시 계산한다 — 파생 필드를
 * 두 곳에서 다르게 해석하지 않기 위해서다.
 */
export function outputScopesFromResult(raw: string | null | undefined): Map<number, OutputScope> {
  const out = new Map<number, OutputScope>();
  const value = parseJson(raw);
  if (!value || typeof value !== "object") return out;
  const people = (value as Record<string, unknown>).candidatesByPerson;
  if (!Array.isArray(people)) return out;
  for (const person of people) {
    if (!person || typeof person !== "object") continue;
    const record = person as Record<string, unknown>;
    if (!isFiniteNumber(record.personIndex)) continue;
    const scope = record.outputScope;
    if (!scope || typeof scope !== "object") continue;
    out.set(record.personIndex, resolveOutputScope(scope as Partial<OutputScope>));
  }
  return out;
}

export function toReviewPerson(row: AnalysisPersonRow, scope?: OutputScope | null): ReviewPerson {
  const skeleton = parseSkeleton(row.skeleton_json);
  const rawScores = skeleton ? parseScores(row.raw_scores_json, skeleton.keypoints.length) : null;
  return {
    personIndex: row.person_index,
    box: parseBox(row.bbox_json),
    tags: parseTags(row.tags_json),
    skeleton,
    jointScores: pickJointScores(skeleton, rawScores),
    confidence: row.confidence,
    candidateCount: row.candidate_count,
    candidateShortfallReason: row.candidate_shortfall_reason,
    skeletonState: row.skeleton_state,
    skeletonSource: row.skeleton_source,
    coverageClass: row.coverage_class,
    fallbackMode: row.fallback_mode,
    slotOrigin: row.slot_origin,
    lowerBodyObserved: row.lower_body_observed === true,
    refineAllowed: row.refine_allowed === true,
    refinableLimbs: parseLimbs(row.refinable_limbs_json),
    outputScope: scope ?? scopeFromColumn(row.output_scope_json),
    personTags: parsePersonTags(row.person_tags_json),
    searchSignals: {
      rankDistance: isFiniteNumber(row.rank_distance) ? row.rank_distance : null,
      distanceMetric: row.distance_metric,
      searchStability: row.search_stability,
      confidenceThreshold: isFiniteNumber(row.confidence_threshold)
        ? row.confidence_threshold
        : null,
    },
  };
}

/**
 * 컷 요약(`jobs.cut_summary_json`). `vlmTags`는 VLM이 **실제로 말한** 값이라, 추론이
 * `other`·`front`로 좁힌 `people[].tags`와 다를 수 있다. 그 차이가 프롬프트가 얼마나
 * 답을 채우는지 보여 준다.
 */
export interface ReviewCutSummary {
  route: string | null;
  countConfidence: string | null;
  detectorCount: number | null;
  vlmCount: number | null;
  vlmTags: Record<string, string> | null;
}

export function parseCutSummary(raw: string | null | undefined): ReviewCutSummary | null {
  const value = parseJson(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const rawTags = record.vlmTags;
  let vlmTags: Record<string, string> | null = null;
  if (rawTags && typeof rawTags === "object" && !Array.isArray(rawTags)) {
    const kept: Record<string, string> = {};
    for (const [key, item] of Object.entries(rawTags as Record<string, unknown>)) {
      if (typeof item === "string" && item.length > 0) kept[key] = item;
    }
    vlmTags = Object.keys(kept).length > 0 ? kept : null;
  }
  return {
    route: typeof record.route === "string" ? record.route : null,
    countConfidence: typeof record.countConfidence === "string" ? record.countConfidence : null,
    detectorCount: isFiniteNumber(record.detectorCount) ? record.detectorCount : null,
    vlmCount: isFiniteNumber(record.vlmCount) ? record.vlmCount : null,
    vlmTags,
  };
}

export function toReviewPeople(
  rows: AnalysisPersonRow[],
  resultJson: string | null | undefined,
): ReviewPerson[] {
  const scopes = outputScopesFromResult(resultJson);
  return rows.map((row) => toReviewPerson(row, scopes.get(row.person_index) ?? null));
}
