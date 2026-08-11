// 도원 추론 서버 호출을 한 곳에 격리한다(계약이 바뀌어도 여기만 수정).
// 계약 원본: Standin-server/docs/API_CONTRACT.md
import { config } from "./config.js";

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

export class InferenceError extends Error {
  constructor(
    public status: number,
    public detail: string,
  ) {
    super(`inference ${status}: ${detail}`);
    this.name = "InferenceError";
  }
}

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = {};
  if (config.inferenceServiceToken) {
    h["Authorization"] = `Bearer ${config.inferenceServiceToken}`;
  }
  return h;
}

// POST /analyze (멀티파트 PNG) → CutResult
export async function analyze(file: Blob, hint = ""): Promise<CutResult> {
  const form = new FormData();
  form.append("file", file, "cut.png");
  if (hint) form.append("hint", hint);

  const res = await fetch(`${config.inferenceBaseUrl}/analyze`, {
    method: "POST",
    body: form,
    headers: authHeaders(),
  });
  if (!res.ok) {
    throw new InferenceError(res.status, await safeText(res));
  }
  return (await res.json()) as CutResult;
}

// ── 포즈 미세조정(refine) ─────────────────────────────────────────────
// 계약 원본: Standin-server/docs/REFINE_DESIGN.md, api/models.py의 RefineRequest/Response.

export interface RefineUpstreamRequest {
  pose_id: string;
  view: string;
  keypoints: number[][];
  scores: number[] | null;
  search_distance: number | null;
  refine_allowed: boolean;
  refinable_limbs: string[];
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
  bvh?: string;
  backend: string;
  limbs: string[];
  limb_decisions: Record<string, unknown>;
  loss_base: number | null;
  loss_final: number | null;
  gain: number | null;
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
): Promise<Response> {
  const params = new URLSearchParams({ view });
  return fetch(
    `${config.inferenceBaseUrl}/pose/${encodeURIComponent(poseId)}/thumbnail?${params}`,
    { headers: authHeaders() },
  );
}

// GET /healthz → 추론 서버 가용 여부
export async function health(): Promise<boolean> {
  try {
    const res = await fetch(`${config.inferenceBaseUrl}/healthz`, {
      headers: authHeaders(),
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
