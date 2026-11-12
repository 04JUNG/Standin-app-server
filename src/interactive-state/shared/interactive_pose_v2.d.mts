/** BFF type declaration for the byte-for-byte vendored Converter reader (see PROVENANCE.txt). */
export declare const ENCODING: "standin-binary-f64le-v2";
export declare const MEDIA_TYPE: "application/vnd.standin.solved-pose-state-v2";
export interface SolvedBoneV2 {
  readonly name: string;
  readonly parent: number;
  readonly restLocal: Float64Array;
  readonly poseLocal: Float64Array;
  readonly inverseBind: Float64Array;
}
export interface SolvedMeshV2 {
  readonly name: string;
  readonly vertexCount: number;
  readonly normalCount: number;
  readonly triangleCount: number;
  readonly positions: Float64Array;
  readonly normals: Float64Array;
  readonly triangles: Uint32Array;
  readonly normalTriangles: Uint32Array;
  readonly weightOffsets: Uint32Array;
  readonly weightBones: Uint16Array;
  readonly weightValues: Float64Array;
}
export interface SolvedModelV2 {
  readonly schema: "interactive-pose-model-v1";
  readonly coordinates: {
    readonly space: string;
    readonly originBlender: readonly number[];
    readonly matrixLayout: string;
    readonly baked: string;
  };
  readonly capabilities: { readonly localHands: false };
  readonly bones: readonly SolvedBoneV2[];
  readonly meshes: readonly SolvedMeshV2[];
}
export interface SolvedStateV2 {
  readonly schema: "solved-pose-state-v1";
  /** Decoded but not identity-validated; callers must run their own identity schema. */
  readonly identity: unknown;
  readonly safety: unknown;
  readonly dependencies: unknown;
  readonly model: SolvedModelV2;
  readonly stateHash: string;
  readonly modelSha256: string;
  readonly byteLength: number;
}
/** Verifies SHA256(bytes) === expectedSha256, then strictly decodes and validates. */
export function readSolvedStateV2(bytes: Uint8Array, expectedSha256: string): Promise<SolvedStateV2>;
/** JSON.stringify of the [[a,b,c],...] triangle list (existing skin trianglesSha256 pins). */
export function triangleIndexJson(triangles: ArrayLike<number>): string;
export function toV1Model(model: SolvedModelV2): {
  schema: string;
  coordinates: Record<string, unknown>;
  capabilities: Record<string, unknown>;
  bones: { name: string; parent: number; restLocal: number[]; poseLocal: number[]; inverseBind: number[] }[];
  meshes: {
    name: string;
    positions: number[][];
    normals: number[][];
    normalTriangles: number[][];
    triangles: number[][];
    weights: [number, number][][];
  }[];
};
