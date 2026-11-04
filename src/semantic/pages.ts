import type { PoolClient } from "pg";
import { transaction, execute } from "../db.js";
import { getPoseBvh, inferenceStatus } from "../inference.js";
import { sha256Hex } from "../converter/client.js";
import { poseThumbnailUrl } from "../pose-thumbnail.js";
import type { PoseCandidate, AnalysisResult } from "../types.js";
import { SemanticError, type SearchGroup } from "./contract.js";
import { attachSemanticPresentation } from "./presentation.js";

export const SEMANTIC_PAGE_SIZE = 20;
export type SemanticPaging = {
  snapshotId: string;
  nextCursor: string | null;
  loaded: number;
  total: number;
  matches: number;
  near: number;
  pageSize: number;
};
export class SemanticPageError extends Error {
  constructor(
    public code: string,
    public status: 400 | 404 | 409 | 503,
  ) {
    super(code);
  }
}
export function paging(
  snapshotId: string,
  groups: SearchGroup[],
  loaded: number,
): SemanticPaging {
  return {
    snapshotId,
    nextCursor: loaded < groups.length ? `${snapshotId}.${loaded}` : null,
    loaded,
    total: groups.length,
    matches: groups.filter((g) => !g.near).length,
    near: groups.filter((g) => g.near).length,
    pageSize: SEMANTIC_PAGE_SIZE,
  };
}
export async function assertLibrary(
  index: Record<string, string>,
  read = inferenceStatus,
) {
  const current = await read();
  if (!current.healthy)
    throw new SemanticPageError("SEMANTIC_UNAVAILABLE", 503);
  if (
    !index.content_sha256 ||
    !index.version ||
    current.library?.version !== index.version ||
    current.library.contentSha256 !== index.content_sha256
  )
    throw new SemanticPageError("SEMANTIC_SNAPSHOT_CHANGED", 409);
}
async function previewBytes(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader || Number(response.headers.get("Content-Length")) > 2_000_000)
    throw new SemanticError("SEMANTIC_CONTRACT", 502);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 2_000_000) throw new SemanticError("SEMANTIC_CONTRACT", 502);
      chunks.push(part.value);
    }
    const bytes = Buffer.concat(chunks);
    if (
      !new TextDecoder("utf-8", { fatal: true })
        .decode(bytes)
        .startsWith("HIERARCHY")
    )
      throw new SemanticError("SEMANTIC_CONTRACT", 502);
    return bytes;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function materialize(
  groups: SearchGroup[],
  deadline: AbortSignal,
  getPoseBvh: typeof import("../inference.js").getPoseBvh,
): Promise<PoseCandidate[]> {
  const controller = new AbortController();
  deadline = AbortSignal.any([deadline, controller.signal]);
  const entries = groups.flatMap((group) =>
    group.variants.map((variant) => ({ group, variant })),
  );
  const candidates: PoseCandidate[] = new Array(entries.length);
  let cursor = 0;
  try {
    await Promise.all(
      Array.from({ length: Math.min(4, entries.length) }, async () => {
        for (let i = cursor++; i < entries.length; i = cursor++) {
          deadline.throwIfAborted();
          const { group, variant } = entries[i]!;
          const bvh = await getPoseBvh(variant.poseId, deadline);
          if (!bvh.ok) throw new SemanticError("SEMANTIC_UNAVAILABLE", 503);
          const bytes = await previewBytes(bvh);
          candidates[i] = {
            id: `${variant.poseId}::front`,
            poseId: variant.poseId,
            rank: group.rank,
            view: "front",
            tags: group.labels,
            matchLevel: "medium",
            bvhAvailable: true,
            source: "semantic",
            lookupAllowed: true,
            refineAllowed: false,
            releaseAllowed: false,
            manualExportAllowed: true,
            presentationKind: group.near ? "near_match" : "library_match",
            actualMeshValidated: false,
            reviewRequired: true,
            rankScore: group.score,
            semantic: {
              familyId: group.variants[0]!.poseId,
              alternate: variant.alternate,
              description: group.description,
              near: group.near === true,
            },
            sourceBvhSha256: sha256Hex(bytes),
            ...(variant.thumbnail
              ? {
                  thumbnailUrl: poseThumbnailUrl(variant.poseId, "front"),
                }
              : {}),
          };
        }
      }),
    );
  } catch (error) {
    controller.abort(error);
    throw error;
  }
  deadline.throwIfAborted();
  return candidates;
}
export async function saveSnapshot(
  jobId: string,
  snapshotId: string,
  groups: SearchGroup[],
) {
  await execute(
    "INSERT INTO semantic_snapshots(job_id,snapshot_id,groups_json) VALUES ($1,$2,$3)",
    [jobId, snapshotId, JSON.stringify(groups)],
  );
}
export function pageSlice(
  result: AnalysisResult,
  start: number,
  end: number,
): AnalysisResult {
  const delta = structuredClone(result);
  if (delta.semantic?.paging)
    delta.semantic.paging = {
      ...delta.semantic.paging,
      loaded: end,
      nextCursor:
        end < delta.semantic.paging.total
          ? `${delta.semantic.paging.snapshotId}.${end}`
          : null,
    };
  const person = delta.candidatesByPerson[0]!;
  person.candidates = person.candidates.slice(start, end);
  const ids = new Set(person.candidates.map((c) => c.id));
  const p = person.posePresentation!;
  p.library_candidates = p.library_candidates.filter((c) =>
    ids.has(c.candidate_id),
  );
  p.review_candidates = p.review_candidates.filter((c) =>
    ids.has(c.candidate_id),
  );
  return delta;
}

/** Job lock also serializes deletion/body/scope writes. Only append rows; never reset selections. */
export async function readPage(
  owner: string,
  jobId: string,
  cursor: string,
  signal: AbortSignal,
  deps = { getPoseBvh, library: inferenceStatus },
  run = transaction,
): Promise<AnalysisResult> {
  if (!/^[0-9a-f-]{36}\.\d{1,7}$/.test(cursor))
    throw new SemanticPageError("INVALID_INPUT", 400);
  return run(async (client: PoolClient) => {
    const jobs = await client.query(
      "SELECT result_json FROM jobs WHERE id=$1 AND installation_id=$2 AND status='completed' FOR UPDATE",
      [jobId, owner],
    );
    if (!jobs.rowCount) throw new SemanticPageError("NOT_FOUND", 404);
    const snapshots = await client.query(
      "SELECT * FROM semantic_snapshots WHERE job_id=$1",
      [jobId],
    );
    const row = snapshots.rows[0];
    if (!row) throw new SemanticPageError("NOT_FOUND", 404);
    const [snapshotId, rawOffset] = cursor.split(".");
    const offset = Number(rawOffset);
    const result = JSON.parse(jobs.rows[0].result_json) as AnalysisResult;
    const info = result.semantic?.paging;
    const groups = JSON.parse(row.groups_json) as SearchGroup[];
    if (
      !info ||
      snapshotId !== row.snapshot_id ||
      offset < SEMANTIC_PAGE_SIZE ||
      offset % SEMANTIC_PAGE_SIZE ||
      offset > info.loaded ||
      offset >= groups.length
    )
      throw new SemanticPageError("SEMANTIC_CURSOR", 409);
    const end = Math.min(offset + SEMANTIC_PAGE_SIZE, groups.length);
    if (offset < info.loaded) return pageSlice(result, offset, end);
    signal.throwIfAborted();
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    await assertLibrary(result.semantic!.index, deps.library);
    const candidates = await materialize(
      groups.slice(offset, end),
      deadline,
      deps.getPoseBvh,
    );
    await assertLibrary(result.semantic!.index, deps.library);
    const person = result.candidatesByPerson[0]!;
    person.candidates.push(...candidates);
    person.candidateCount = person.candidates.length;
    result.semantic!.paging = paging(snapshotId!, groups, end);
    const scope = person.posePresentation?.output_scope;
    const context = attachSemanticPresentation(result);
    if (scope) person.posePresentation!.output_scope = scope;
    // Scope/body/hand state belongs to existing rows and is deliberately preserved.
    for (const c of candidates)
      await client.query(
        `INSERT INTO analysis_candidates(job_id,person_index,candidate_id,pose_id,rank,view,distance,rerank_score,match_level,tags_json,pose_library_version) VALUES($1,0,$2,$3,$4,$5,NULL,NULL,$6,$7,$8)`,
        [
          jobId,
          c.id,
          c.poseId,
          c.rank,
          c.view,
          c.matchLevel,
          JSON.stringify(c.tags),
          result.inferenceMetadata.poseLibraryVersion,
        ],
      );
    await client.query(
      `UPDATE analysis_people SET candidate_count=$2, refine_context_json=(refine_context_json::jsonb || jsonb_build_object('posePresentationAssets',$3::jsonb))::text WHERE job_id=$1 AND person_index=0`,
      [
        jobId,
        person.candidates.length,
        JSON.stringify(context.posePresentationAssets),
      ],
    );
    deadline.throwIfAborted();
    await client.query(
      "UPDATE jobs SET result_json=$2, updated_at=$3 WHERE id=$1",
      [jobId, JSON.stringify(result), new Date().toISOString()],
    );
    return pageSlice(result, offset, end);
  });
}
