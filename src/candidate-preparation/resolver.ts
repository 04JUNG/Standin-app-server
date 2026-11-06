/** All source geometry, camera and policy inputs originate on the server. No selection is fabricated. */
import { getOwnedJob } from "../jobs/store.js";
import { loadRefineContext, type StoredRefineContext } from "../refine/store.js";
import { candidateRefineAllowed } from "../refine/eligibility.js";
import { hash, PreparationError, type Owner, type EngineInput, ENGINE_CONTRACT } from "./model.js";
// Only source authority participates. Body, shape, hands, scope and appearance belong after selection.
function sourceCandidates(candidates: import("../types.js").PoseCandidate[]) {
  return candidates.map(c => ({ id: c.id, poseId: c.poseId, rank: c.rank, view: c.view,
    source: c.source ?? null, presentationKind: c.presentationKind ?? null,
    sourceSha256: c.sourceBvhSha256 ?? null, camera: c.camera ?? null,
    distance: c.distance ?? null, releaseAllowed: c.releaseAllowed ?? null,
    refineAllowed: c.refineAllowed ?? null, lookupAllowed: c.lookupAllowed ?? null,
    manualExportAllowed: c.manualExportAllowed ?? null, reviewRequired: c.reviewRequired ?? null,
    notExactMatch: c.notExactMatch ?? null }));
}
/** The final engine contract requires original, finite observations and complete policy lineage. */
function sourceObservation(stored: StoredRefineContext | null) {
  if (!stored || !Array.isArray(stored.keypoints) || stored.keypoints.length !== 17 ||
    stored.keypoints.some(p => !Array.isArray(p) || p.length !== 2 || p.some(v => !Number.isFinite(v))) ||
    !Array.isArray(stored.scores) || stored.scores.length !== 17 ||
    stored.scores.some(v => !Number.isFinite(v) || v < 0) ||
    [stored.skeletonState, stored.coverageClass, stored.slotOrigin, stored.skeletonSource]
      .some(v => typeof v !== "string" || v.length === 0)) return null;
  const { refineV3: _shadow, ...source } = stored;
  return source;
}
const defaults = { getOwnedJob, loadRefineContext };
export function createPreparationResolver(overrides: Partial<typeof defaults> = {}) {
  const deps = { ...defaults, ...overrides };
  return async (l: Owner, engineIdentity: unknown) => {
    const job = await deps.getOwnedJob(l.jobId, l.installationId);
    if (!job) throw new PreparationError("NOT_FOUND", 404);
    if (job.status !== "completed" || !job.result) throw new PreparationError("NOT_READY");
    if (job.result.source === "semantic") throw new PreparationError("PREPARATION_UNSUPPORTED");
    const people = job.result.candidatesByPerson;
    const total = people.reduce((n, p) => n + p.candidates.length, 0);
    if (!total || total > 64 || people.some(p => p.candidates.length > 5))
      throw new PreparationError("PREPARATION_SIZE_UNSUPPORTED", 400);
    const candidates: EngineInput["candidates"] = [];
    const bindings: unknown[] = [];
    const unsupported: Array<{ personIndex: number; candidateId: string; sourceSha256: string; reason: string }> = [];
    // Deliberately bounded: no 5N network/body-model fanout.
    for (const person of people) {
      const stored = await deps.loadRefineContext(l.jobId, person.personIndex);
      const observation = sourceObservation(stored);
      bindings.push({ personIndex: person.personIndex, observation, candidates: sourceCandidates(person.candidates) });
      for (const c of person.candidates) {
        const source = c.sourceBvhSha256 ?? c.camera?.source_bvh_sha256;
        if (!candidateRefineAllowed(c) || !observation || !source || !/^[a-f0-9]{64}$/.test(source) || !c.camera || c.camera.source_bvh_sha256 !== source || !c.poseId ||
          !/^[A-Za-z0-9_.:-]{1,128}$/.test(c.id)) {
          unsupported.push({ personIndex: person.personIndex, candidateId: c.id, sourceSha256: source ?? "",
            reason: !candidateRefineAllowed(c) ? "candidate_policy" : "authoritative_input_unavailable" });
          continue;
        }
        candidates.push({ person_id: String(person.personIndex), candidate_id: c.id, source_sha256: source,
          request: { pose_id: c.poseId, view: c.view, camera: c.camera, keypoints: observation.keypoints,
            scores: observation.scores, search_distance: c.distance ?? null, refine_allowed: observation.refineAllowed,
            refinable_limbs: observation.refinableLimbs, skeleton_state: observation.skeletonState,
            coverage_class: observation.coverageClass, slot_origin: observation.slotOrigin,
            skeleton_source: observation.skeletonSource, lower_body_observed: observation.lowerBodyObserved,
            render_thumbnail: false } });
      }
    }
    const candidateSetRevision = hash(people.map(p => ({ person: p.personIndex, candidates: sourceCandidates(p.candidates) })));
    const contextHash = hash({ schema: ENGINE_CONTRACT, owner: { installationId: l.installationId, jobId: l.jobId }, candidateSetRevision, bindings, engineIdentity });
    return { contextHash, candidateSetRevision, candidates, unsupported,
      order: people.flatMap(p => p.candidates.map(c => ({ personIndex: p.personIndex, candidateId: c.id }))) };
  };
}
export const resolvePreparation = createPreparationResolver();
