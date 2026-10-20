import { generatedChecksFailed } from "./generated-policy.js";
import { refinableLibraryCandidate } from "./refine/eligibility.js";
import { createHash } from "node:crypto";
import { poseThumbnailUrl } from "./pose-thumbnail.js";
/** Server-owned migration from inspect-only results to explicit author review.
 * No VLM, converter, ranking or validation status changes occur here. Source availability
 * and quarantine are checked again against inference before review/export bytes are used.
 */
import type { PoolClient } from "pg";
import type { AnalysisResult, PoseCandidate } from "./types.js";
import { validateRenderCamera, type PrivatePreviewAsset } from "./pose-presentation.js";

const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const poseId = (v: unknown): v is string => typeof v === "string" && !!v && v.length <= 512 && !/[\/\\\x00-\x1f\x7f]/.test(v) && ![".", ".."].includes(v);
export function upgradeManualResult(
  original: AnalysisResult,
  assets: Map<number, Record<string, PrivatePreviewAsset>>,
): AnalysisResult {
  const result = structuredClone(original);
  for (const person of result.candidatesByPerson) {
    const p = person.posePresentation;
    if (!p || !["dynamic-pose-presentation-v1", "semantic-pose-presentation-v1"].includes(p.version)) continue;
    const candidates: PoseCandidate[] = [];
    for (const row of [...p.library_candidates, ...p.review_candidates]) {
      const asset = assets.get(person.personIndex)?.[row.candidate_id];
      if (!/^preview_[a-f0-9]{64}$/.test(row.candidate_id) || !poseId(row.pose_id) ||
        !["library_match", "near_match", "geometry_review", "framing_reference", "mirror_reference"].includes(row.kind) ||
        row.source !== "library" || row.lookup_allowed !== true || row.review_required !== true ||
        row.auto_apply_allowed !== false || row.refine_allowed !== false || row.release_allowed !== false ||
        row.export_allowed !== false || row.actual_mesh_validated !== false ||
        row.asset.transport !== "library_bvh" || !hash(row.asset.bvh_sha256) ||
        !asset || asset.transport !== "library_bvh" || asset.pose_id !== row.pose_id ||
        asset.bvh_sha256 !== row.asset.bvh_sha256) continue;
      try { validateRenderCamera(row.render_camera); } catch { continue; }
      const prior = person.candidates.find((c) => c.poseId === row.pose_id && c.sourceBvhSha256 === row.asset.bvh_sha256);
      const refine = result.source !== "semantic" && person.refineAllowed === true &&
        row.kind === "library_match" && refinableLibraryCandidate(prior);
      if (result.source === "semantic" && (!prior?.semantic || prior.source !== "semantic")) continue;
      candidates.push({
        ...(result.source === "semantic" ? prior! : {}),
        id: row.candidate_id, poseId: row.pose_id, rank: result.source === "semantic" ? prior!.rank : candidates.length + 1,
        view: "front", tags: prior?.tags ?? [row.kind === "library_match" ? "검색 후보" : "참고 후보"],
        matchLevel: "low", source: result.source === "semantic" ? "semantic" : "library",
        lookupAllowed: true, bvhAvailable: true, refineAllowed: refine, releaseAllowed: false,
        ...(refine ? { camera: prior!.camera, distance: prior!.distance } : {}),
        actualMeshValidated: false, reviewRequired: true, manualExportAllowed: true,
        presentationKind: row.kind, notExactMatch: row.kind !== "library_match",
        sourceBvhSha256: row.asset.bvh_sha256,
        thumbnailUrl: poseThumbnailUrl(row.pose_id, "front"),
        posterUrl: `/v1/pose-candidates/${encodeURIComponent(row.pose_id)}/poster?${new URLSearchParams({ jobId: result.jobId, personIndex: String(person.personIndex), candidateId: row.candidate_id })}`,
      });
    }
    for (const row of p.generated_candidates) {
      const asset = assets.get(person.personIndex)?.[row.candidate_id];
      row.manual_use_block_reason = p.generation_status !== "preview_ready" ? "generation_unavailable" :
        !asset?.bvh ? "source_missing" :
        asset.bvh_sha256 !== row.asset.bvh_sha256 || createHash("sha256").update(asset.bvh).digest("hex") !== row.asset.bvh_sha256 ? "source_changed" : "policy_unavailable";
      // preview_ready is emitted only after the existing generation/observation/hand gates.
      // The automatic-release flags deliberately stay false.
      if (!(["ok", "no_result"].includes(p.search_status)) || ["error", "blocked", "undetermined"].includes(p.status) ||
          p.generation_status !== "preview_ready" || p.preview_status !== "ready" ||
          !/^preview_[a-f0-9]{64}$/.test(row.candidate_id) || row.pose_id !== null ||
          row.source !== "generation" || row.kind !== "generated_review" ||
          row.lookup_allowed !== true || row.review_required !== true ||
          row.auto_apply_allowed !== false || row.refine_allowed !== false ||
          row.release_allowed !== false || row.export_allowed !== false ||
          row.actual_mesh_validated !== false || row.asset.transport !== "inline_bvh" ||
          !hash(row.asset.bvh_sha256) || !asset || asset.transport !== "inline_bvh" ||
          asset.pose_id !== null || asset.bvh_sha256 !== row.asset.bvh_sha256 ||
          generatedChecksFailed(asset.validation) || !asset.bvh || Buffer.byteLength(asset.bvh) > 2_000_000 ||
          createHash("sha256").update(asset.bvh).digest("hex") !== row.asset.bvh_sha256) continue;
      try { validateRenderCamera(row.render_camera); } catch { continue; }
      delete row.manual_use_block_reason;
      candidates.push({ id: row.candidate_id, poseId: null, rank: candidates.length + 1,
        view: "front", tags: ["새로 만든 포즈"], matchLevel: "low", source: "generation",
        lookupAllowed: true, bvhAvailable: true, refineAllowed: false, releaseAllowed: false,
        actualMeshValidated: false, reviewRequired: true, manualExportAllowed: true,
        presentationKind: "generated_review", notExactMatch: true,
        sourceBvhSha256: row.asset.bvh_sha256,
        posterUrl: row.asset.preview_bvh_url + "/poster",
      });
    }
    person.candidates = candidates;
  }
  result.manualExportVersion = 2;
  return result;
}

/** The same job row lock is used by hands/scope changes, so lazy migration never
 * overwrites an intervening user's settings. Rows and exposed JSON commit together. */
export async function upgradeOwnedManualResult(
  db: Pick<PoolClient, "query">, jobId: string, owner: string,
): Promise<AnalysisResult | null> {
  const { rows } = await db.query<{ status: string; result_json: string | null }>(
    "SELECT status,result_json FROM jobs WHERE id=$1 AND installation_id=$2 AND created_at::timestamptz > now() - interval '90 days' FOR UPDATE", [jobId, owner],
  );
  const row = rows[0];
  if (!row || row.status !== "completed" || !row.result_json) return null;
  const original = JSON.parse(row.result_json) as AnalysisResult;
  if (original.manualExportVersion === 2) return original;
  const contexts = await db.query<{ person_index: number; refine_context_json: string | null }>(
    "SELECT person_index,refine_context_json FROM analysis_people WHERE job_id=$1", [jobId],
  );
  const assets = new Map<number, Record<string, PrivatePreviewAsset>>();
  for (const c of contexts.rows) {
    try { assets.set(c.person_index, JSON.parse(c.refine_context_json ?? "{}").posePresentationAssets ?? {}); } catch { /* No private binding means no manual permission. */ }
  }
  const result = upgradeManualResult(original, assets);
  for (const person of result.candidatesByPerson) for (const candidate of person.candidates) {
    if (candidate.manualExportAllowed !== true) continue;
    await db.query(
      `INSERT INTO analysis_candidates
        (job_id,person_index,candidate_id,pose_id,rank,view,distance,rerank_score,match_level,tags_json,pose_library_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (job_id,person_index,candidate_id) DO UPDATE SET
         pose_id=EXCLUDED.pose_id,rank=EXCLUDED.rank,view=EXCLUDED.view,
         match_level=EXCLUDED.match_level,tags_json=EXCLUDED.tags_json`,
      [jobId, person.personIndex, candidate.id, candidate.poseId, candidate.rank, candidate.view,
        candidate.distance ?? null, candidate.rerankScore ?? null, candidate.matchLevel,
        JSON.stringify(candidate.tags), result.inferenceMetadata.poseLibraryVersion],
    );
  }
  await db.query("UPDATE jobs SET result_json=$2 WHERE id=$1 AND installation_id=$3", [jobId, JSON.stringify(result), owner]);
  return result;
}
