// 클라(Tauri)와의 /v1 계약 타입.
// ⚠ 클라 `endpoints.ts`의 타입과 단일 소스로 공유하는 것이 목표(드리프트 방지).
//   나중에 공용 패키지(packages/contract)로 승격 검토.

export type MatchLevel = "high" | "medium" | "low";

export type AnalysisJobStatus = "queued" | "running" | "completed" | "failed";

/**
 * 인물 단위 폴백 상태(요구서 §3-2).
 *
 * `soft`(저신뢰지만 후보 있음)와 `hard`(후보 없음)는 **다른 상태**다. 하나로 뭉치면
 * "참고용 후보를 보여준다"와 "이 인물은 자동 후보가 없다"를 화면이 구분할 수 없다.
 */
export type FallbackMode = "none" | "soft" | "hard";

export type PersonConfidence = "high" | "low";
export type SkeletonState = "valid" | "partial" | "suspect" | "missing" | "invalid";
export type SkeletonSource = "full_image" | "crop_retry" | "none";
export type CoverageClass = "full" | "reduced" | "sparse" | "insufficient";

export interface PoseCandidate {
  id: string; // unique exposed candidate id (pose + view)
  poseId: string;
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
  image: { width: number; height: number };
  inferenceMetadata: {
    deploymentVersion: string;
    vlmProvider: string;
    vlmModel: string;
    poseBackend: string;
    poseModelVersion: string;
    poseLibraryVersion: string;
    featureVersion: number;
  };
  candidatesByPerson: AnalysisPerson[];
  notes: string[];
  /**
   * 이 응답을 만든 BFF가 어떤 기능을 노출하는가(OPS-02).
   *
   * 클라이언트가 자기 판단으로 refine을 호출하지 않게 하려면 서버가 알려 줘야 한다.
   * 추론 endpoint가 살아 있어도 BFF flag가 꺼져 있으면 여기서 false가 나간다.
   */
  capabilities: {
    refine: boolean;
    /**
     * FBX 저장을 노출해도 되는가. converter는 추론 서버와 별개로 배포되므로 refine과 함께
     * 켜지지 않는다. 클라이언트가 자기 판단으로 format=fbx를 보내면 converter가 없는
     * 배포에서 전건 실패한다 — 그래서 서버가 알려 준다.
     */
    fbxExport: boolean;
  };
}

/** 사용자가 고르는 저장 포맷. BVH는 클립스튜디오 3.1.0 이상에서만 열린다. */
export type ExportFormat = "bvh" | "fbx";

export interface AnalysisPerson {
  personIndex: number;
  box: number[] | null;
  tags: Record<string, string>;
  skeleton: {
    schemaVersion: string;
    keypoints: number[][];
    scores: number[];
  } | null;
  confidence: PersonConfidence;
  skeletonState: SkeletonState;
  skeletonSource: SkeletonSource;
  coverageClass: CoverageClass;
  fallbackMode: FallbackMode;
  refineAllowed: boolean;
  refinableLimbs: string[];
  candidateCount: number;
  candidateShortfallReason: string | null;
  candidates: PoseCandidate[];
}

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId: string;
  };
}
