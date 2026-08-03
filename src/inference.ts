// 도원 추론 서버 호출을 한 곳에 격리한다(계약이 바뀌어도 여기만 수정).
// 계약 원본: Standin-server/docs/API_CONTRACT.md
import { config } from "./config.js";

// 추론 /analyze 응답(CutResult) — 필요한 필드만.
export interface CutResult {
  route: string;
  count_confidence: string;
  detector_count: number;
  vlm_count: number;
  people: Array<{
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
  }>;
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
