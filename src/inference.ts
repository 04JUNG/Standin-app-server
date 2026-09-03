// 도원 추론 서버 호출을 한 곳에 격리한다(계약이 바뀌어도 여기만 수정).
// 계약 원본: Standin-server/docs/API_CONTRACT.md
import { config } from "./config.js";
import { currentContext } from "./requestContext.js";

/**
 * 추론 /analyze 응답의 인물 1명.
 *
 * PR #10(스켈레톤 추출 보완)이 더한 품질 필드는 **전부 optional**이다. BFF와 추론 서버는
 * 순차 배포되므로 신 BFF가 구 추론 응답을 받는 창이 반드시 생긴다. 그때 필드가 없다고
 * 실패시키는 대신 `mapping.ts`가 low/refine-off 쪽으로 안전하게 해석한다.
 */
export interface UpstreamPerson {
  index: number;
  box: number[] | null;
  tags: Record<string, string>;
  skeleton: {
    schema_version: string;
    keypoints: number[][];
    scores: number[];
  } | null;
  confidence: string | null;
  candidates: Array<{
    pose_id: string;
    view: string;
    distance: number;
    tags: Record<string, string>;
    rerank_score: number | null;
    bvh_url: string;
    thumbnail_url: string | null;
  }>;
  // ── PR #10 스켈레톤 품질 신호 ────────────────────────────────
  skeleton_state?: string;
  skeleton_source?: string;
  coverage_class?: string;
  slot_origin?: string;
  search_stability?: string | null;
  distance_metric?: string | null;
  rank_distance?: number | null;
  confidence_threshold?: number | null;
  valid_limbs?: string[];
  refinable_limbs?: string[];
  refine_allowed?: boolean;
  /**
   * VLM이 양쪽 골반·무릎·발목을 실제로 관측했는가. false면 추론이 모든 하체 조정을 막는다.
   *
   * 구 추론 응답에는 없다 → `false`로 좁힌다. 하체 refine만 닫히고 팔은 그대로 동작하므로
   * 순차 배포 창에서 안전한 쪽으로 수렴한다.
   */
  lower_body_observed?: boolean;
  /** refine 입력. 17×2 픽셀 좌표. 클라가 아니라 BFF가 보관한다(BFF-04). */
  keypoints?: number[][] | null;
  /** 구조 마스킹·안전정책이 반영된 관절 점수(17). refine 입력. */
  scores?: number[] | null;
  /** 평가·디버깅 전용 RTMPose 원본 점수. 공개 응답에 넣지 않는다. */
  raw_scores?: number[] | null;
  quality_reasons?: string[];
  quality_trace?: Record<string, unknown>;
}

// 추론 /analyze 응답(CutResult) — 필요한 필드만.
export interface CutResult {
  route: string;
  count_confidence: string;
  detector_count: number;
  vlm_count: number;
  people: UpstreamPerson[];
  notes: string[];
  image: { width: number; height: number };
  inference_metadata: {
    deployment_version: string;
    vlm_provider: string;
    vlm_model: string;
    pose_backend: string;
    pose_model_version: string;
    pose_library_version: string;
    feature_version: number;
  };
}

/** 추론 호출이 상한 시간을 넘겼다. 5xx와 구분해 Job 실패 사유로 남긴다. */
export class InferenceTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`inference timed out after ${timeoutMs}ms`);
    this.name = "InferenceTimeoutError";
  }
}

/** AbortSignal.timeout이 던지는 것은 TimeoutError DOMException이다. */
export function isAbortTimeout(error: unknown): boolean {
  return error instanceof DOMException && error.name === "TimeoutError";
}

export class InferenceError extends Error {
  constructor(
    public status: number,
    public detail: string,
  ) {
    super(`inference ${status}: ${detail}`);
    this.name = "InferenceError";
  }
}

/** Job이 실패로 끝난 사유. 클라이언트가 `error` 필드로 그대로 받는다(docs/API.md). */
export type AnalysisFailureCode =
  | "ANALYSIS_TIMEOUT"
  | "ANALYSIS_UNAVAILABLE"
  | "INFERENCE_FAILED";

/**
 * 추론 호출 실패를 Job 실패 사유로 분류한다.
 *
 * 셋을 나누는 이유는 **사용자가 할 수 있는 일이 다르기 때문**이다.
 * - `ANALYSIS_UNAVAILABLE` — 상류(VLM)가 혼잡해 지금은 못 한다. 잠시 후 같은 이미지로
 *   다시 하면 된다. 추론이 `503`으로 알려 준다(Standin-server docs/API_CONTRACT.md §7-1).
 * - `ANALYSIS_TIMEOUT` — 추론이 상한 시간 안에 응답하지 않았다.
 * - `INFERENCE_FAILED` — 그 외. 이미지를 바꾸거나 우리가 고쳐야 한다.
 *
 * ⚠ 이 구분이 없을 때 Gemini 과부하(503)가 `INFERENCE_FAILED`로 접혀서, 사용자는
 *   "다른 이미지로 다시 시도해 주세요"라는 안내를 받았다. 상류가 붐비는 동안에는 어떤
 *   이미지도 실패한다(2026-08-21, master-docs #6).
 */
/**
 * 실패한 분석의 하루 쿼터를 돌려줄 것인가.
 *
 * 기준은 **분석이 실제로 수행됐는가**다. 쿼터는 우리가 한 일에 매기는 값이므로, 상류가
 * 요청을 받아주지도 않아 아무 일도 일어나지 않았다면 사용자의 하루 10회에서 깎을 근거가 없다.
 * `INPUT_STORAGE_FAILED`(입력 저장 실패)에 이미 같은 논리가 적용돼 있다(jobs/routes.ts).
 *
 * `ANALYSIS_TIMEOUT`과 `INFERENCE_FAILED`는 뺀다 — 추론이 실제로 돌다가 늦어지거나
 * 거절한 경우라 "아무 일도 없었다"고 볼 수 없다. 이 경계는 정책이므로 바꿀 수 있다
 * (master-docs #6 「남는 질문」).
 */
export function shouldRefundQuota(code: AnalysisFailureCode): boolean {
  return code === "ANALYSIS_UNAVAILABLE";
}

export function analysisFailureCode(error: unknown): AnalysisFailureCode {
  if (error instanceof InferenceTimeoutError) return "ANALYSIS_TIMEOUT";
  // 503은 HTTP 의미 그대로 "지금은 못 하지만 나중엔 된다"다. 추론이 이 상태로만
  // 답하도록 계약을 맞춰 뒀으므로 본문 code를 파싱하지 않고 상태로 판단한다.
  if (error instanceof InferenceError && error.status === 503) return "ANALYSIS_UNAVAILABLE";
  return "INFERENCE_FAILED";
}

/**
 * 추론 호출에 붙는 공통 헤더.
 *
 * `X-Request-Id`를 함께 넘기는 이유: 추론 서버가 같은 값을 자기 로그에 실어 주므로,
 * 분석 한 건의 실패를 두 서버 로그에서 하나로 이어 볼 수 있다. 컨텍스트가 없는
 * 경로(기동·타이머)에서는 헤더를 생략한다 — 없는 값을 지어내지 않는다.
 */
function authHeaders(): Record<string, string> {
  const h: Record<string, string> = {};
  if (config.inferenceServiceToken) {
    h["Authorization"] = `Bearer ${config.inferenceServiceToken}`;
  }
  const requestId = currentContext()?.requestId;
  if (requestId) h["X-Request-Id"] = requestId;
  return h;
}

// POST /analyze (멀티파트 PNG) → CutResult
export async function analyze(file: Blob, hint = ""): Promise<CutResult> {
  const form = new FormData();
  form.append("file", file, "cut.png");
  if (hint) form.append("hint", hint);

  // 상한이 없으면 추론이 멈췄을 때 Job이 running에 영원히 남는다. 동시 분석 한도가
  // 1이라 그 설치는 스위퍼가 돌 때까지(수 분) 아무것도 못 한다.
  let res: Response;
  try {
    res = await fetch(`${config.inferenceBaseUrl}/analyze`, {
      method: "POST",
      body: form,
      headers: authHeaders(),
      signal: AbortSignal.timeout(config.analysisTimeoutMs),
    });
  } catch (error) {
    if (isAbortTimeout(error)) throw new InferenceTimeoutError(config.analysisTimeoutMs);
    throw error;
  }
  if (!res.ok) {
    throw new InferenceError(res.status, await safeText(res));
  }
  return (await res.json()) as CutResult;
}

// ── 포즈 미세조정(refine) ─────────────────────────────────────────────
// 계약 원본: Standin-server/docs/REFINE_DESIGN.md, api/models.py의 RefineRequest/Response.

/**
 * POST /refine 요청.
 *
 * ⚠ `skeleton_state`·`coverage_class`·`slot_origin`·`skeleton_source`는 **선택 필드가
 *   아니다.** 추론의 `structural_refine_allowed`가 네 값을 전부 검사하고(`slot_origin`은
 *   `"vlm"`, `skeleton_source`는 `"full_image"`만 통과), `REFINE_V2_ENABLED`가 켜져 있으면
 *   하나라도 빠질 때 fail-closed로 `reason="skeleton_policy"`를 돌려준다. 그건 오류 응답이
 *   아니라 정상 스킵이라 로그에도 남지 않는다 — 즉 **빠뜨리면 refine이 조용히 꺼진다.**
 *
 *   전부 `/analyze` 때 DB에 넣어 둔 값이며 클라이언트가 되돌려 보내는 값이 아니다(BFF-04).
 */
export interface RefineUpstreamRequest {
  pose_id: string;
  view: string;
  keypoints: number[][];
  scores: number[] | null;
  search_distance: number | null;
  refine_allowed: boolean;
  refinable_limbs: string[];
  // ── v2.5 policy lineage ─────────────────────────────────────────────
  skeleton_state: string | null;
  coverage_class: string | null;
  slot_origin: string | null;
  skeleton_source: string | null;
  lower_body_observed: boolean;
}

export interface RefineUpstreamResponse {
  pose_id: string;
  view: string;
  /** false는 오류가 아니다 — 안전 게이트가 조정을 버리고 베이스를 준 정상 결과. */
  refined: boolean;
  reason: string;
  /** 항상 베이스(`/pose/{id}/bvh`). 조정본에는 URL이 없다. 상대 경로다. */
  bvh_url: string;
  /**
   * 조정본 BVH 본문(LF 개행). `refined=true`일 때만 채워진다.
   *
   * 조정본을 얻는 **유일한** 경로다 — `/refined/{handle}/bvh`는 제거됐다
   * (REFINE_HANDOFF §3 4단계). `refined=false`면 없다.
   */
  bvh?: string | null;
  backend: string;
  limbs: string[];
  limb_decisions: Record<string, unknown>;
  loss_base: number | null;
  loss_final: number | null;
  gain: number | null;
  // ── v2.5 신규. 구 추론 응답에는 없으므로 optional로 받는다 ──────────────
  /** 실행한 refine policy/code 버전. 예: "v2.5.3" */
  refine_version?: string;
  /**
   * `improved | unchanged | reverted | not_attempted`.
   *
   * `reason` 하나로는 "안전 게이트가 되돌렸다"와 "애초에 시도하지 않았다"가 구분되지 않는다.
   * 지표에서 품질 절벽을 보려면 이 값이 필요하다.
   */
  refine_outcome?: string;
  diagnostics?: Record<string, unknown>;
}

/**
 * POST /refine → RefineResponse.
 *
 * 명시적 timeout을 둔다(BFF-07). refine은 사용자가 저장을 기다리는 동기 경로이므로
 * 추론이 느려질 때 무한정 붙잡고 있으면 저장 흐름 전체가 멈춘다.
 */
export async function refine(req: RefineUpstreamRequest): Promise<RefineUpstreamResponse> {
  const res = await fetch(`${config.inferenceBaseUrl}/refine`, {
    method: "POST",
    body: JSON.stringify(req),
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    signal: AbortSignal.timeout(config.refineTimeoutMs),
  });
  if (!res.ok) {
    throw new InferenceError(res.status, await safeText(res));
  }
  return (await res.json()) as RefineUpstreamResponse;
}

// fetchUpstreamPath()는 제거됐다(REFINE_HANDOFF §3 4단계). 추론 컨테이너의 로컬
// 디스크에서 조정본을 받아오던 경로인데, 이제 조정본은 /refine 응답 본문으로만 온다.

// GET /pose/{id}/bvh → 원본 응답(상태·바디를 호출측이 그대로 프록시)
export async function getPoseBvh(poseId: string): Promise<Response> {
  return fetch(
    `${config.inferenceBaseUrl}/pose/${encodeURIComponent(poseId)}/bvh`,
    {
      headers: authHeaders(),
    },
  );
}

// GET /pose/{id}/thumbnail?view=... → PNG 원본 응답
export async function getPoseThumbnail(
  poseId: string,
  view: string,
  /**
   * 클라이언트가 보낸 `If-None-Match`. 그대로 상류에 넘겨야 304 왕복이 성립한다.
   * 넘기지 않으면 추론이 매번 200으로 본문을 다시 보내고, 캐시 검증이 무의미해진다.
   */
  ifNoneMatch?: string,
): Promise<Response> {
  const params = new URLSearchParams({ view });
  const headers: Record<string, string> = { ...authHeaders() };
  if (ifNoneMatch) headers["If-None-Match"] = ifNoneMatch;
  return fetch(
    `${config.inferenceBaseUrl}/pose/${encodeURIComponent(poseId)}/thumbnail?${params}`,
    { headers },
  );
}

// GET /healthz → 추론 서버 가용 여부
export async function health(): Promise<boolean> {
  try {
    // ⚠ 상한이 없으면 추론이 멈출 때 /healthz도 같이 멈춘다. ALB는 그걸 BFF 장애로
    //   읽고 멀쩡한 태스크를 교체한다 — 추론 장애가 BFF 장애로 번지는 경로다.
    const res = await fetch(`${config.inferenceBaseUrl}/healthz`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(config.healthTimeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
