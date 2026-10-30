import type { BodyScope } from "../output-scope/model.js";
import type { SceneCameraBinding } from "./sceneCamera.js";
export interface SceneRef {
  personIndex: number;
  candidateId: string;
  exportPath: string;
  sha256: string;
}
export interface SceneDirection {
  torso_camera_yaw: number | null;
  torso_label: string | null;
  head_label: string | null;
  head_camera_yaw: number | null;
  head_relative_yaw: number | null;
  head_pitch_degrees: number | null;
}
export interface ScenePersonSummary {
  personIndex: number;
  previousPoseId: string;
  poseId: string;
  previousOutputScope: BodyScope;
  outputScope: BodyScope;
  poseChanged: boolean;
  outputScopeChanged: boolean;
  previousDirection: null;
  directionChanged: null;
  direction: SceneDirection | null;
  interaction: "preserve" | "restraining" | "reaching" | null;
  armGoalCount: number | null;
}
export interface RefinedScene {
  camera?: SceneCameraBinding;
  artifactContract?: "verified-scene-fbx-v1";
  bytes: Uint8Array;
  sha256: string;
  preview: string;
  previewSha256: string;
  summary: ScenePersonSummary[];
  parts?: import("./sceneParts.js").PartsReceipt[];
}
