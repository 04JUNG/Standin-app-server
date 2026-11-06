/** Re-resolve all server authority at prepare, poll, publication and byte delivery. */
import { getOwnedJob } from "../jobs/store.js";
import {
  validateExportCandidate,
  validateConfirmedSelection,
} from "../analytics/store.js";
import { candidateSourceBytes } from "../candidate-source.js";
import { getPoseBvh } from "../inference.js";
import { loadAssets, manualPresentationCamera } from "../pose-presentation.js";
import {
  exportCandidateAllowed,
  manualExportCandidate,
} from "../routed-search.js";
import { refinableLibraryCandidate } from "../refine/eligibility.js";
import { resolveExportArtifact } from "../refine/service.js";
import { findRefinedArtifact } from "../refine/store.js";
import { handBakeFor } from "../hands/service.js";
import { bodyStore } from "../body-selection/store.js";
import { shapeRenderable } from "../body-selection/shape.js";
import { getPreviewRuntime } from "../converter/previewRuntime.js";
import { modelPreviewIdentity } from "../converter/framing.js";
import { checkCharacter } from "../characters/service.js";
import { sha256Hex } from "../converter/client.js";
import { resolvePersonOutputScope } from "../output-scope/model.js";
import { InteractiveError, hash, type Location } from "./model.js";
const defaults = {
  getOwnedJob,
  validateExportCandidate,
  validateConfirmedSelection,
  getPoseBvh,
  loadAssets,
  resolveExportArtifact,
  findRefinedArtifact,
  handBakeFor,
  selection: bodyStore.selection,
  runtime: getPreviewRuntime,
  modelPreviewIdentity,
  checkCharacter,
};
export function createSelectionResolver(
  overrides: Partial<typeof defaults> = {},
  purpose: "export" | "preview" = "export",
) {
  const deps = { ...defaults, ...overrides };
  return async (location: Location, candidateId: string) => {
    const { installationId, jobId, personIndex } = location;
    const job = await deps.getOwnedJob(jobId, installationId);
    if (!job) throw new InteractiveError("NOT_FOUND", 404);
    const person = job.result?.candidatesByPerson.find(
      (p) => p.personIndex === personIndex,
    );
    const candidate = person?.candidates.find((c) => c.id === candidateId);
    if (
      job.status !== "completed" ||
      !person ||
      !candidate ||
      !(await deps.validateExportCandidate(
        installationId,
        jobId,
        personIndex,
        candidateId,
      ))
    )
      throw new InteractiveError("INVALID_SELECTION");
    // A 3D view never upgrades a quarantined/review/semantic candidate's release policy.
    if (
      !exportCandidateAllowed(candidate) ||
      (job.result?.source === "semantic" && !manualExportCandidate(candidate))
    )
      throw new InteractiveError("CANDIDATE_RELEASE_FORBIDDEN");
    if (
      purpose === "export" &&
      !(await deps.validateConfirmedSelection(
        installationId,
        jobId,
        personIndex,
        candidateId,
      ))
    )
      throw new InteractiveError("SELECTION_REQUIRED");
    const manual = manualPresentationCamera(person, candidate);
    if (manualExportCandidate(candidate) && !manual)
      throw new InteractiveError("MANUAL_REVIEW_UNAVAILABLE");
    const body = await deps.selection(installationId, jobId, personIndex);
    if (
      body.resolutionStatus !== "ready" ||
      !body.resolvedBody ||
      (purpose === "export" && body.previewOnly) ||
      !shapeRenderable(body)
    )
      throw new InteractiveError("BODY_PREVIEW_STALE");
    const characterId = body.resolvedBody.characterId;
    if ((await deps.checkCharacter(characterId)) !== "ok")
      throw new InteractiveError("CHARACTER_UNAVAILABLE");
    const hands = await deps.handBakeFor(person);
    const base = await candidateSourceBytes(
      jobId,
      person,
      candidate,
      deps.getPoseBvh,
      deps.loadAssets,
    );
    const originalSha = sha256Hex(base);
    if (candidate.camera && candidate.camera.source_bvh_sha256 !== originalSha)
      throw new InteractiveError("POSE_UNAVAILABLE");
    const artifact = await deps.resolveExportArtifact(
      jobId,
      personIndex,
      candidateId,
    );
    if (
      artifact.variant === "refined" &&
      candidate.sourceBvhSha256 &&
      !refinableLibraryCandidate(candidate)
    )
      throw new InteractiveError("POSE_UNAVAILABLE");
    const bvhBytes = artifact.variant === "refined" ? artifact.bytes : base;
    const refine = await deps.findRefinedArtifact(
      jobId,
      personIndex,
      candidateId,
    );
    if (
      artifact.variant === "refined" &&
      (!refine?.lineage || refine.lineage.baseSha256 !== originalSha)
    )
      throw new InteractiveError("INTERACTIVE_REFINE_LINEAGE_UNAVAILABLE");
    const runtime = await deps.runtime(),
      model = await deps.modelPreviewIdentity(characterId);
    if (!model || model.characterSha256 !== body.resolvedBody.assetSha256)
      throw new InteractiveError("PREVIEW_CHANGED");
    const camera = manual?.camera ?? candidate.camera;
    // Camera mapping belongs to Converter. Legacy yaw-only cameras lack projection; refuse capability.
    if (!camera || !("projection" in camera))
      throw new InteractiveError("INTERACTIVE_CAMERA_UNSUPPORTED");
    const identity = {
      schema: "interactive-selection-v1",
      ownerBinding: hash({ installationId, jobId, personIndex }),
      candidateId,
      source: {
        originalBvhSha256: originalSha,
        outputBvhSha256: sha256Hex(bvhBytes),
        variant: artifact.variant,
        refine: refine
          ? {
              refined: refine.refined,
              reason: refine.reason,
              limbs: refine.limbs,
              lineage: refine.lineage ?? null,
            }
          : null,
      },
      body: body.resolvedBody,
      bodyRevision: body.selectionRevision,
      shape: body.shape ?? null,
      shapeSource: body.shapeSource ?? null,
      hands,
      scope: resolvePersonOutputScope(person).resolved,
      camera,
      mirror: false,
      runtime,
      model,
    };
    return {
      identity,
      selectionHash: hash(identity),
      bvhBytes,
      characterId,
      body,
      hands,
      scope: identity.scope,
      camera,
      originalSha,
      sourceSha: sha256Hex(bvhBytes),
      runtime,
      model,
    };
  };
}
export type ResolvedSelection = Awaited<
  ReturnType<ReturnType<typeof createSelectionResolver>>
>;
