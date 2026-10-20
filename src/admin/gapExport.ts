// 라이브러리 공백 분석용 비식별 export(GET /v1/admin/gaps/observations).
//
// 받는 쪽은 Standin-server의 `pose_gaps`다. 계약은 그 저장소의 docs/POSE_GAP_LOOP.md
// 「BFF export 계약 (schema 1)」, 읽는 코드는 pose_gaps/observations.py에 있다.
// 이 파일에는 DB를 모르는 순수 함수만 둔다: 가명, 커서, 행 → 항목 변환, 금지 값 검사.
// 조회는 gapExportStore.ts, 접근 통제와 감사는 admin/routes.ts가 맡는다.
//
// 항목에 넣지 않는 것: 작업·설치 ID, 입력 해시, S3 key, bbox, 이미지 크기.
// 날짜는 일 단위, 관절은 0.1px로 반올림한다. 가명(obs·inst)은 export마다 새 salt로 만든
// HMAC이라 같은 export 안에서만 같고, export끼리나 운영 ID와는 이을 수 없다.
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
} from "node:crypto";

export const GAP_EXPORT_SCHEMA_VERSION = 1;
export const GAP_EXPORT_PAGE_SIZE = 500;
export const DEFAULT_EXPORT_DAYS = 90;
/** 작업에 연결된 데이터의 보관 기한(retention.ts의 RETENTION_DAYS)과 같다. */
export const MAX_EXPORT_DAYS = 365;
/** 받는 쪽(pose_gaps/ttl.py)이 지키는 로컬 보관 기한. 응답에 실어 계약으로 남긴다. */
export const RETENTION_HINT = { localTtlDays: 14, maxSnapshotAgeDays: 7 } as const;
/** 첫 페이지 뒤 이 시간이 지난 커서는 받지 않는다. 오래된 export를 이어 붙이지 못하게 한다. */
export const CURSOR_TTL_MS = 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ExportState {
  exportId: string;
  generatedAt: string;
  days: number;
  /** 마지막으로 읽은 행의 정렬 키. 첫 페이지는 null. 작업 ID가 들어 있어 커서는 암호화한다. */
  after: { createdAt: string; jobId: string; personIndex: number } | null;
}

/** gap_observations_v1 한 행(db.ts). JSON 칸은 TEXT 그대로, candidates는 jsonb다. */
export interface GapObservationRow {
  job_id: string;
  person_index: number;
  installation_id: string;
  created_at: string;
  inference_metadata_json: string | null;
  cut_summary_json: string | null;
  tags_json: string | null;
  skeleton_json: string | null;
  raw_scores_json: string | null;
  refine_context_json: string | null;
  person_tags_json: string | null;
  output_scope_json: string | null;
  coverage_class: string | null;
  skeleton_state: string | null;
  skeleton_source: string | null;
  slot_origin: string | null;
  lower_body_observed: boolean | null;
  confidence: string | null;
  fallback_mode: string | null;
  rank_distance: number | null;
  distance_metric: string | null;
  search_stability: string | null;
  confidence_threshold: number | null;
  candidates: unknown;
  selected_rank: number | null;
  exported: boolean | null;
  selected_refined: boolean | null;
  job_feedback: string | null;
}

/** `days` 쿼리. 없으면 90, 1~365 정수만 받는다. 잘못된 값이면 null. */
export function parseExportDays(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return DEFAULT_EXPORT_DAYS;
  if (!/^\d{1,3}$/.test(raw)) return null;
  const days = Number(raw);
  return days >= 1 && days <= MAX_EXPORT_DAYS ? days : null;
}

export function startExport(now: number, days: number): ExportState {
  return { exportId: randomUUID(), generatedAt: new Date(now).toISOString(), days, after: null };
}

/** 창의 시작. 생성 시각에서 고정하므로 페이지를 넘겨도 같은 범위를 읽는다. */
export function windowStart(state: ExportState): string {
  return new Date(Date.parse(state.generatedAt) - state.days * DAY_MS).toISOString();
}

function derivedKey(key: string, purpose: string): Buffer {
  return createHmac("sha256", key).update(`gap-export/${purpose}`).digest();
}

/** 커서: `v1.<iv>.<ciphertext>.<tag>`(AES-256-GCM). 위변조하면 복호화가 실패한다. */
export function encodeCursor(key: string, state: ExportState): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derivedKey(key, "cursor"), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(state), "utf8"), cipher.final()]);
  return ["v1", iv, body, cipher.getAuthTag()]
    .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
    .join(".");
}

/** 형식이 틀리거나 위변조됐거나 만료된 커서는 null. 이유는 구분하지 않는다. */
export function decodeCursor(key: string, cursor: string, now: number): ExportState | null {
  const parts = cursor.split(".");
  if (parts.length !== 4 || parts[0] !== "v1" || cursor.length > 2048) return null;
  let state: unknown;
  try {
    const [iv, body, tag] = parts.slice(1).map((part) => Buffer.from(part, "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", derivedKey(key, "cursor"), iv);
    decipher.setAuthTag(tag);
    state = JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8"));
  } catch {
    return null;
  }
  if (!isExportState(state)) return null;
  const age = now - Date.parse(state.generatedAt);
  return age >= 0 && age <= CURSOR_TTL_MS ? state : null;
}

function isExportState(value: unknown): value is ExportState {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  const after = state.after as Record<string, unknown> | null | undefined;
  return (
    typeof state.exportId === "string" &&
    typeof state.generatedAt === "string" &&
    Number.isFinite(Date.parse(state.generatedAt)) &&
    typeof state.days === "number" &&
    Number.isInteger(state.days) &&
    state.days >= 1 &&
    state.days <= MAX_EXPORT_DAYS &&
    (after === null ||
      (!!after &&
        typeof after.createdAt === "string" &&
        typeof after.jobId === "string" &&
        Number.isInteger(after.personIndex)))
  );
}

/** export 하나의 가명 salt. 같은 export의 페이지끼리만 같다. */
export function exportSalt(key: string, exportId: string): Buffer {
  return createHmac("sha256", derivedKey(key, "salt")).update(exportId).digest();
}

export function pseudonym(salt: Buffer, kind: "o" | "i", value: string): string {
  const digest = createHmac("sha256", salt).update(`${kind}:${value}`).digest("base64url");
  return `${kind}_${digest.slice(0, 22)}`;
}

// ── 행 → 항목 ─────────────────────────────────────────────────────────

function parseJson(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/** 17×2 픽셀 좌표를 0.1px로. 모양이 다르거나 유한하지 않은 값이 있으면 null. */
function points17(value: unknown): number[][] | null {
  if (!Array.isArray(value) || value.length !== 17) return null;
  const out: number[][] = [];
  for (const point of value) {
    if (!Array.isArray(point) || point.length !== 2) return null;
    const [x, y] = point.map(finite);
    if (x === null || y === null) return null;
    out.push([round(x, 1), round(y, 1)]);
  }
  return out;
}

function scores17(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length !== 17) return null;
  const out = value.map(finite);
  return out.every((score): score is number => score !== null)
    ? out.map((score) => round(score, 4))
    : null;
}

function mask17(value: unknown): boolean[] | null {
  return Array.isArray(value) && value.length === 17 && value.every((v) => typeof v === "boolean")
    ? (value as boolean[])
    : null;
}

function pickText(source: Record<string, unknown> | null, keys: string[]): Record<string, string | null> {
  return Object.fromEntries(keys.map((key) => [key, text(source?.[key])]));
}

function observedDay(createdAt: string): string | null {
  const time = Date.parse(createdAt);
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : null;
}

/**
 * 뷰의 한 행을 export 항목으로 바꾼다. 관절이 없는 인물은 공백 분석 대상이 아니므로 null.
 */
export function toObservation(row: GapObservationRow, salt: Buffer): Record<string, unknown> | null {
  const context = asObject(parseJson(row.refine_context_json));
  const skeleton = asObject(parseJson(row.skeleton_json));
  const keypoints = points17(context?.keypoints) ?? points17(skeleton?.keypoints);
  const observedOn = observedDay(row.created_at);
  if (!keypoints || !observedOn) return null;
  const trace = asObject(context?.qualityTrace);
  const meta = asObject(parseJson(row.inference_metadata_json));
  const summary = asObject(parseJson(row.cut_summary_json));
  const cutTags = asObject(summary?.vlmTags) ?? asObject(parseJson(row.tags_json));
  const candidates = (Array.isArray(row.candidates) ? row.candidates : [])
    .map(asObject)
    .filter((candidate): candidate is Record<string, unknown> => candidate !== null);
  const personTags = asObject(parseJson(row.person_tags_json));
  const outputScope = asObject(parseJson(row.output_scope_json));
  return {
    obs: pseudonym(salt, "o", `${row.job_id}:${row.person_index}`),
    inst: pseudonym(salt, "i", row.installation_id),
    observed_on: observedOn,
    expires_on: new Date(Date.parse(`${observedOn}T00:00:00Z`) + MAX_EXPORT_DAYS * DAY_MS)
      .toISOString()
      .slice(0, 10),
    versions: {
      pose_library:
        text(candidates[0]?.pose_library_version) ?? text(meta?.poseLibraryVersion),
      feature: finite(meta?.featureVersion),
      pose_model: text(meta?.poseModelVersion),
      vlm_model: text(meta?.vlmModel),
      vlm_prompt: text(meta?.vlmPromptVersion),
      deployment: text(meta?.deploymentVersion),
    },
    cut: {
      route: text(summary?.route),
      count_confidence: text(summary?.countConfidence),
      person_count: finite(summary?.vlmCount),
      detector_count: finite(summary?.detectorCount),
      tags: pickText(cutTags, ["shot", "action", "view", "relationship"]),
    },
    person: {
      keypoints,
      raw_scores: scores17(parseJson(row.raw_scores_json)),
      effective_scores: scores17(context?.scores) ?? scores17(skeleton?.scores),
      evidence_mask: mask17(trace?.evidence_valid_joint_mask),
      search_mask: mask17(trace?.search_valid_joint_mask),
      coverage_class: row.coverage_class,
      skeleton_state: row.skeleton_state,
      skeleton_source: row.skeleton_source,
      slot_origin: row.slot_origin,
      lower_body_observed: row.lower_body_observed === true,
      confidence: row.confidence,
      fallback_mode: row.fallback_mode,
      search_scope: text(trace?.search_scope),
      distance_metric: row.distance_metric,
      search_stability: row.search_stability,
      rank_distance: finite(row.rank_distance),
      confidence_threshold: finite(row.confidence_threshold),
      quality_reasons: Array.isArray(context?.qualityReasons)
        ? context.qualityReasons.filter((reason): reason is string => typeof reason === "string")
        : [],
      tags: personTags ? pickText(personTags, ["action", "view", "source"]) : {},
      scope: outputScope ? pickText(outputScope, ["detected", "source"]) : {},
    },
    candidates: candidates.map((candidate) => ({
      pose_id: text(candidate.pose_id),
      view: text(candidate.view),
      rank: finite(candidate.rank),
      distance: finite(candidate.distance),
      match_level: text(candidate.match_level),
    })),
    behavior: {
      selected_rank: finite(row.selected_rank),
      exported: row.exported === true,
      selected_refined: typeof row.selected_refined === "boolean" ? row.selected_refined : null,
      job_feedback: text(row.job_feedback),
    },
  };
}

// ── 금지 값 검사 ───────────────────────────────────────────────────────
// 받는 쪽(pose_gaps/observations.py)과 같은 규칙에, 입력 해시 모양(64자리 hex)을 더한다.
// 응답 직전에 한 번 더 돌린다. 하나라도 걸리면 그 페이지를 내보내지 않는다.

const FORBIDDEN_KEYS = new Set([
  "job_id", "jobId", "installation_id", "installationId", "input_sha256", "inputSha256",
  "input_s3_key", "inputS3Key", "s3_key", "bbox", "bbox_xyxy", "image_width", "image_height",
]);
const RAW_ID_PATTERNS = [
  /inst_[0-9a-f]{8}-[0-9a-f]{4}-/i,
  /job_[0-9a-f]{8}-[0-9a-f]{4}-/i,
  /user_[0-9a-f]{12}/,
  /installations\//,
  /(?:^|[^0-9a-f])[0-9a-f]{64}(?:[^0-9a-f]|$)/i,
];

/** 금지 키와 원본 ID 모양 문자열이 있는 위치. 값 자체는 돌려주지 않는다. */
export function privacyProblems(value: unknown, path = ""): string[] {
  const problems: string[] = [];
  const check = (where: string, item: unknown) => {
    if (typeof item === "string" && RAW_ID_PATTERNS.some((pattern) => pattern.test(item))) {
      problems.push(`raw identifier at ${where}`);
    }
  };
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      check(`${path}[${index}]`, item);
      problems.push(...privacyProblems(item, `${path}[${index}]`));
    });
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      const where = `${path}.${key}`;
      if (FORBIDDEN_KEYS.has(key)) problems.push(`forbidden key ${where}`);
      check(where, key);
      check(where, item);
      problems.push(...privacyProblems(item, where));
    }
  }
  return problems;
}
