import { SceneBudget } from "./sceneBudget.js";
import { validateSceneCamera, type SceneCameraBinding } from "./sceneCamera.js";
import { SceneError } from "./sceneContract.js";
/** Scene orchestration only. Direction/IK/layout inference belongs to inference. */
import type { Job } from "../jobs/store.js";
import type { SceneSource } from "../converter/scene.js";
import { config } from "../config.js";
import { sceneRefinementRequest, getPoseBvh } from "../inference.js";
import { loadInput } from "../inputStorage.js";
import { resolveExportArtifact } from "../refine/service.js";
import { convertFramed } from "../converter/framing.js";
import { sha256Hex, ConverterError } from "../converter/client.js";
import { bodyStore } from "../body-selection/store.js";
import { shapeRenderable } from "../body-selection/shape.js";
import { handBakeFor } from "../hands/service.js";
import { isBodyScope, resolvePersonOutputScope, type BodyScope } from "../output-scope/model.js";
import { manualPresentationCamera } from "../pose-presentation.js";

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
function publicDirection(raw: unknown): SceneDirection | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw))
    throw new SceneError("SCENE_INTEGRITY", "invalid direction summary");
  const value = raw as Record<string, unknown>;
  const angle = (key: string) => {
    const v = value[key];
    if (v === undefined || v === null) return null;
    if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > 360)
      throw new SceneError("SCENE_INTEGRITY", "invalid direction angle");
    return v;
  };
  const label = (key: string) => {
    const v = value[key];
    if (v === undefined || v === null) return null;
    if (typeof v !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(v))
      throw new SceneError("SCENE_INTEGRITY", "invalid direction label");
    return v;
  };
  return {
    torso_camera_yaw: angle("torso_camera_yaw"), torso_label: label("torso_label"),
    head_label: label("head_label"), head_camera_yaw: angle("head_camera_yaw"),
    head_relative_yaw: angle("head_relative_yaw"), head_pitch_degrees: angle("head_pitch_degrees"),
  };
}
export interface RefinedScene {
  camera?: SceneCameraBinding;
  artifactContract?: "verified-scene-fbx-v1";
  bytes: Uint8Array;
  sha256: string;
  preview: string;
  previewSha256: string;
  summary: ScenePersonSummary[];
}
const defaults = {
  loadInput,
  resolveExportArtifact,
  getPoseBvh,
  convertFramed,
  selection: bodyStore.selection,
  handBakeFor,
  request: sceneRefinementRequest,
};
export async function prepareRefinedScene(
  owner: string,
  job: Job,
  refs: SceneRef[],
  sources: SceneSource[],
  overrides: Partial<typeof defaults> = {},
  artifactOnly = false,
  budget = new SceneBudget(config.sceneRefinementTimeoutMs),
): Promise<RefinedScene> {
  const base = { ...defaults, ...overrides };
  const deps = { ...base,
    loadInput: (...args: Parameters<typeof base.loadInput>) => budget.run(() => base.loadInput(...args)),
    getPoseBvh: (...args: Parameters<typeof base.getPoseBvh>) => budget.run(() => base.getPoseBvh(...args)),
    resolveExportArtifact: (...args: Parameters<typeof base.resolveExportArtifact>) => budget.run(() => base.resolveExportArtifact(...args)),
    selection: (...args: Parameters<typeof base.selection>) => budget.run(() => base.selection(...args)),
    handBakeFor: (...args: Parameters<typeof base.handBakeFor>) => budget.run(() => base.handBakeFor(...args)),
    convertFramed: (input: Parameters<typeof base.convertFramed>[0]) => budget.run(() => base.convertFramed({ ...input, signal: budget.signal })),
    request: (stage: "plan" | "build", input: unknown) => budget.run(() => base.request(stage, input, { signal: budget.signal })),
  };
  if (!job.inputS3Key || !job.result)
    throw new SceneError("SCENE_UNAVAILABLE", "original image unavailable");
  let image: Uint8Array;
  try {
    image = new Uint8Array(await (await deps.loadInput(job.inputS3Key)).arrayBuffer());
  } catch (error) {
    if (error instanceof SceneError) throw error;
    throw new SceneError("SCENE_UNAVAILABLE", "original input could not be read");
  }
  if (job.inputSha256 && sha256Hex(image) !== job.inputSha256)
    throw new SceneError("SCENE_SOURCE_CHANGED", "original input hash changed");
  const persons = refs.map((ref) => {
    const p = job.result!.candidatesByPerson.find(
      (p) => p.personIndex === ref.personIndex,
    )!;
    const c = p.candidates.find((c) => c.id === ref.candidateId)!;
    const s = sources.find((s) => s.person_index === ref.personIndex)!;
    return {
      person_index: ref.personIndex,
      pose_id: c.poseId,
      output_scope: resolvePersonOutputScope(p).resolved,
      observation: s.observation,
      fbx_sha256: ref.sha256,
      fbx_base64: Buffer.from(s.bytes).toString("base64"),
    };
  });
  const plan = await deps.request("plan", {
    image_base64: Buffer.from(image).toString("base64"),
    image_sha256: sha256Hex(image),
    persons,
  });
  if (
    plan.version !== "scene-refinement-v4" ||
    plan.image_sha256 !== sha256Hex(image) ||
    typeof plan.plan_id !== "string" || !plan.plan_id || plan.plan_id.length > 128 ||
    !Array.isArray(plan.people) ||
    plan.people.length !== refs.length ||
    typeof plan.character_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(plan.character_sha256)
  )
    throw new SceneError("SCENE_INTEGRITY", "invalid scene plan lineage");
  const prepared = [];
  const seen = new Set<number>();
  for (const raw of plan.people) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new SceneError("SCENE_INTEGRITY", "invalid scene plan person");
    const row = raw as { person_index: number; pose_id: string };
    const ref = refs.find((r) => r.personIndex === row.person_index);
    if (
      !ref ||
      seen.has(row.person_index) ||
      typeof row.pose_id !== "string" ||
      (row.pose_id === "." || row.pose_id === ".." || !row.pose_id || /[/\\\u0000-\u001f]/.test(row.pose_id))
    )
      throw new SceneError("SCENE_INTEGRITY", "invalid scene plan identity");
    seen.add(row.person_index);
    const person = job.result.candidatesByPerson.find(
      (p) => p.personIndex === row.person_index,
    )!;
    const candidate = person.candidates.find((c) => c.id === ref.candidateId)!;
    const url = new URL(ref.exportPath, "https://scene.internal");
    const bodyMode = url.searchParams.has("bodySelectionRevision");
    const body = bodyMode
      ? await deps.selection(owner, job.id, row.person_index)
      : null;
    if (bodyMode && body && !shapeRenderable(body))
      throw new SceneError("SCENE_UNSUPPORTED_BODY", "scene shape unsupported");
    if (
      bodyMode &&
      (body?.resolutionStatus !== "ready" ||
        !body.resolvedBody ||
        !shapeRenderable(body) ||
        String(body.selectionRevision) !==
          url.searchParams.get("bodySelectionRevision"))
    )
      throw new SceneError("SCENE_SOURCE_CHANGED", "scene body changed");
    // Fetch through the registered/quarantined library route for BOTH current and new poses.
    const base = await deps.getPoseBvh(row.pose_id);
    if (!base.ok) throw new SceneError(base.status >= 500 ? "SCENE_UNAVAILABLE" : "SCENE_SOURCE_CHANGED", "scene pose unavailable");
    let bytes: Uint8Array = new Uint8Array(await base.arrayBuffer());
    const retained = row.pose_id === candidate.poseId;
    if (retained) {
      const expected =
        candidate.sourceBvhSha256 ?? candidate.camera?.source_bvh_sha256;
      if (expected && sha256Hex(bytes) !== expected)
        throw new SceneError("SCENE_SOURCE_CHANGED", "scene pose source changed");
      const artifact = await deps.resolveExportArtifact(
        job.id,
        row.person_index,
        ref.candidateId,
      );
      if (artifact.variant === "refined") bytes = artifact.bytes;
    }
    let full;
    try {
      full = await deps.convertFramed({
        purpose: artifactOnly ? "export" : "preview",
        ...(artifactOnly ? { previewFormat: "none" as const } : {}),
        bvhBytes: bytes,
        scope: "full",
        characterId:
          body?.resolvedBody?.characterId ??
          url.searchParams.get("characterId") ??
          config.converterCharacterId,
        shape: body?.shape,
        shapeSource: body?.shapeSource,
        hands: (await deps.handBakeFor(person)) ?? undefined,
        expectedCharacterSha256: plan.character_sha256,
        cameraRotation: retained
          ? (manualPresentationCamera(person, candidate)?.camera.rotation ??
            candidate.camera?.rotation)
          : undefined,
      });
    } catch (error) {
      // The selected asset can be valid for normal export yet differ from the
      // scene worker's calibrated rig. Only this explicit private code proves it.
      if (error instanceof ConverterError && error.upstreamStatus === 409 &&
          error.upstreamCode === "CHARACTER_SHA256_MISMATCH")
        throw new SceneError("SCENE_UNSUPPORTED_BODY", "scene calibration differs from selected body");
      throw error;
    }
    if (full.characterSha256 !== plan.character_sha256)
      throw new SceneError("SCENE_UNSUPPORTED_BODY", "unsupported scene rig calibration");
    prepared.push({
      person_index: row.person_index,
      pose_id: row.pose_id,
      character_sha256: full.characterSha256,
      fbx_sha256: full.artifactSha256,
      fbx_base64: Buffer.from(full.fbx).toString("base64"),
    });
  }
  const result = await deps.request("build", {
    plan_id: plan.plan_id,
    ...(artifactOnly ? { artifact_only: true } : {}),
    persons: prepared,
  });
  if (
    (artifactOnly && result.artifact_contract !== "verified-scene-fbx-v1") ||
    result.version !== plan.version ||
    result.plan_id !== plan.plan_id ||
    result.image_sha256 !== sha256Hex(image) ||
    result.person_count !== refs.length ||
    !Array.isArray(result.people) || result.people.length !== refs.length ||
    typeof result.fbx_base64 !== "string" || typeof result.preview_base64 !== "string"
  )
    throw new SceneError("SCENE_INTEGRITY", "scene result lineage changed");
  const bytes = Buffer.from(result.fbx_base64 as string, "base64"),
    preview = Buffer.from(result.preview_base64 as string, "base64");
  if (
    bytes.toString("base64") !== result.fbx_base64 ||
    preview.toString("base64") !== result.preview_base64 ||
    sha256Hex(preview) !== result.preview_sha256 ||
    bytes.length > 128 * 1024 * 1024 ||
    !bytes
      .subarray(0, 23)
      .equals(Buffer.from("Kaydara FBX Binary  \0\x1a\0")) ||
    sha256Hex(bytes) !== result.artifact_sha256 ||
    (artifactOnly ? preview.length !== 0 : preview.length > 8 * 1024 * 1024 ||
      !preview.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || sha256Hex(preview) !== result.preview_sha256)
  )
    throw new ConverterError("CONVERTER_INTEGRITY", "scene artifact mismatch");
  // Public review includes no operator paths, prompts or model instructions.
  const reported = new Map<number, Record<string, unknown>>();
  for (const raw of result.people as unknown[]) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new SceneError("SCENE_INTEGRITY", "invalid scene person summary");
    const p = raw as Record<string, unknown>;
    const ref = refs.find(r => r.personIndex === p.person_index);
    const planned = prepared.find(r => r.person_index === p.person_index);
    if (!ref || reported.has(ref.personIndex) || p.pose_id !== planned?.pose_id ||
        !isBodyScope(p.output_scope) ||
        (p.arm_goals !== undefined && !Array.isArray(p.arm_goals)) ||
        (p.interaction !== undefined && p.interaction !== null &&
          (typeof p.interaction !== "string" || !["preserve", "restraining", "reaching"].includes(p.interaction))))
      throw new SceneError("SCENE_INTEGRITY", "scene summary lineage mismatch");
    reported.set(ref.personIndex, p);
  }
  const summary: ScenePersonSummary[] = refs.map(ref => {
    const p = reported.get(ref.personIndex)!;
    const person = job.result!.candidatesByPerson.find(p => p.personIndex === ref.personIndex)!;
    const candidate = person.candidates.find(c => c.id === ref.candidateId)!;
    if (p.baseline_pose_id !== undefined && p.baseline_pose_id !== candidate.poseId)
      throw new SceneError("SCENE_INTEGRITY", "scene baseline changed");
    const previousOutputScope = resolvePersonOutputScope(person).resolved;
    return {
      personIndex: ref.personIndex, previousPoseId: candidate.poseId!, poseId: p.pose_id as string,
      previousOutputScope, outputScope: p.output_scope as BodyScope,
      poseChanged: p.pose_id !== candidate.poseId,
      outputScopeChanged: p.output_scope !== previousOutputScope,
      previousDirection: null, directionChanged: null,
      direction: publicDirection(p.direction),
      interaction: (p.interaction ?? null) as ScenePersonSummary["interaction"],
      armGoalCount: Array.isArray(p.arm_goals) ? p.arm_goals.length : null,
    };
  });
  budget.check();
  const camera = result.camera === undefined ? undefined : validateSceneCamera(result.camera, sha256Hex(bytes), job.result.image ?? undefined);
  return {
    ...(camera ? { camera } : {}),
    ...(artifactOnly ? { artifactContract: "verified-scene-fbx-v1" as const } : {}),
    bytes,
    sha256: sha256Hex(bytes),
    preview: preview.toString("base64"),
    previewSha256: sha256Hex(preview),
    summary,
  };
}
