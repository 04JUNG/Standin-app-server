// 클라(Tauri)와의 /v1 계약 타입.
// ⚠ 클라 `endpoints.ts`의 타입과 단일 소스로 공유하는 것이 목표(드리프트 방지).
//   나중에 공용 패키지(packages/contract)로 승격 검토.

export type MatchLevel = "high" | "medium" | "low";

export type AnalysisJobStatus = "queued" | "running" | "completed" | "failed";

export interface PoseCandidate {
  id: string; // = 추론 pose_id
  rank: number;
  view: string;
  tags: string[];
  matchLevel: MatchLevel;
  bvhAvailable: boolean;
  thumbnailUrl?: string;
  // 개발자 모드 전용 원시 점수(UI 기본 노출 X)
  distance?: number;
  rerankScore?: number | null;
}

export interface AnalysisResult {
  jobId: string;
  candidatesByPerson: Array<{
    personIndex: number;
    box: number[] | null;
    tags: Record<string, string>;
    candidates: PoseCandidate[];
  }>;
  notes: string[];
}

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId: string;
  };
}
