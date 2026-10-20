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
import { resolvePersonOutputScope } from "../output-scope/model.js";
import { manualPresentationCamera } from "../pose-presentation.js";

export interface SceneRef {
  personIndex: number;
  candidateId: string;
  exportPath: string;
  sha256: string;
}
export interface RefinedScene {
  artifactContract?: "verified-scene-fbx-v1";
  bytes: Uint8Array;
  sha256: string;
  preview: string;
  previewSha256: string;
  summary: unknown[];
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
): Promise<RefinedScene> {
  const deps = { ...defaults, ...overrides };
  if (!job.inputS3Key || !job.result)
    throw new Error("original image unavailable");
  const image = new Uint8Array(
    await (await deps.loadInput(job.inputS3Key)).arrayBuffer(),
  );
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
    typeof plan.plan_id !== "string" ||
    !Array.isArray(plan.people) ||
    plan.people.length !== refs.length ||
    typeof plan.character_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(plan.character_sha256)
  )
    throw new Error("invalid scene plan lineage");
  const prepared = [];
  const seen = new Set<number>();
  for (const raw of plan.people) {
    const row = raw as { person_index: number; pose_id: string };
    const ref = refs.find((r) => r.personIndex === row.person_index);
    if (
      !ref ||
      seen.has(row.person_index) ||
      typeof row.pose_id !== "string" ||
      !/^[A-Za-z0-9_-]+$/.test(row.pose_id)
    )
      throw new Error("invalid scene plan identity");
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
    if (
      bodyMode &&
      (body?.resolutionStatus !== "ready" ||
        !body.resolvedBody ||
        !shapeRenderable(body) ||
        String(body.selectionRevision) !==
          url.searchParams.get("bodySelectionRevision"))
    )
      throw new Error("scene body changed");
    // Fetch through the registered/quarantined library route for BOTH current and new poses.
    const base = await deps.getPoseBvh(row.pose_id);
    if (!base.ok) throw new Error("scene pose unavailable");
    let bytes: Uint8Array = new Uint8Array(await base.arrayBuffer());
    const retained = row.pose_id === candidate.poseId;
    if (retained) {
      const expected =
        candidate.sourceBvhSha256 ?? candidate.camera?.source_bvh_sha256;
      if (expected && sha256Hex(bytes) !== expected)
        throw new Error("scene pose source changed");
      const artifact = await deps.resolveExportArtifact(
        job.id,
        row.person_index,
        ref.candidateId,
      );
      if (artifact.variant === "refined") bytes = artifact.bytes;
    }
    const full = await deps.convertFramed({
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
    if (full.characterSha256 !== plan.character_sha256)
      throw new Error("unsupported scene rig calibration");
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
    result.person_count !== refs.length
  )
    throw new Error("scene result lineage changed");
  const bytes = Buffer.from(String(result.fbx_base64), "base64"),
    preview = Buffer.from(String(result.preview_base64), "base64");
  if (
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
  const summary = (result.people as Record<string, unknown>[]).map((p) => ({
    personIndex: p.person_index,
    poseId: p.pose_id,
    previousPoseId: p.baseline_pose_id,
    outputScope: p.output_scope,
    direction: p.direction,
    interaction: p.interaction,
    armGoalCount: Array.isArray(p.arm_goals) ? p.arm_goals.length : 0,
  }));
  return {
    ...(artifactOnly ? { artifactContract: "verified-scene-fbx-v1" as const } : {}),
    bytes,
    sha256: sha256Hex(bytes),
    preview: preview.toString("base64"),
    previewSha256: sha256Hex(preview),
    summary,
  };
}
