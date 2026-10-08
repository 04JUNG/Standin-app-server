import { neutralMetadata } from "./neutral.js";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { pool, transaction } from "../db.js";
import type { AnalysisResult, AnalysisPerson } from "../types.js";
import { config } from "../config.js";
import { checkCharacter } from "../characters/service.js";
import { loadBodyCatalog } from "./catalog.js";
import {
  bodyRef,
  defaultPreferences,
  eligible,
  resolveBody,
  snapshot,
  type BodyCatalog,
  type BodyIntent,
  type BodyPolicy,
  type BodyPreferences,
  type BodySelection,
} from "./model.js";
export type BodyDb = Pick<PoolClient, "query">;
export class BodyError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 404 | 409 | 503,
    readonly details?: unknown,
  ) {
    super(code);
  }
}
export interface Mutation {
  expectedRevision: number;
  mutationId: string;
}
export interface PreferenceChange extends Mutation {
  mode: BodyPreferences["mode"];
  defaultCharacterId: string | null;
}
export interface SelectionChange extends Mutation {
  intent: BodyIntent;
  characterId?: string;
}
export const bodyDeps = { catalog: loadBodyCatalog, check: checkCharacter };
export type BodyDeps = typeof bodyDeps;
export async function readPreferences(
  db: BodyDb,
  installationId: string,
): Promise<BodyPreferences> {
  const { rows } = await db.query<{ value: BodyPreferences }>(
    "SELECT value FROM body_preferences WHERE installation_id=$1",
    [installationId],
  );
  return rows[0]?.value ?? defaultPreferences();
}
async function replay(
  db: BodyDb,
  owner: string,
  resource: string,
  m: Mutation,
  payload: unknown,
): Promise<{ hash: string; value: unknown }> {
  const hash = createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
  const { rows } = await db.query<{ payload_hash: string; response: unknown }>(
    "SELECT payload_hash,response FROM body_mutations WHERE installation_id=$1 AND resource=$2 AND mutation_id=$3",
    [owner, resource, m.mutationId],
  );
  if (rows[0] && rows[0].payload_hash !== hash)
    throw new BodyError("IDEMPOTENCY_CONFLICT", 409);
  return { hash, value: rows[0]?.response };
}
async function remember(
  db: BodyDb,
  owner: string,
  resource: string,
  job: string | null,
  m: Mutation,
  hash: string,
  value: unknown,
) {
  await db.query(
    `INSERT INTO body_mutations (installation_id,resource,mutation_id,job_id,payload_hash,response,created_at)
    VALUES ($1,$2,$3,$4,$5,$6,now())`,
    [owner, resource, m.mutationId, job, hash, JSON.stringify(value)],
  );
  // Bounded idempotency history per resource. Versions still reject stale requests after eviction.
  await db.query(
    `DELETE FROM body_mutations WHERE installation_id=$1 AND resource=$2 AND mutation_id IN
    (SELECT mutation_id FROM body_mutations WHERE installation_id=$1 AND resource=$2 ORDER BY created_at DESC,mutation_id DESC OFFSET 128)`,
    [owner, resource],
  );
}
function expect(actual: number, wanted: number, code: string) {
  if (actual !== wanted)
    throw new BodyError(code, 409, { currentRevision: actual });
}
export async function writePreferences(
  db: BodyDb,
  owner: string,
  change: PreferenceChange,
  deps: BodyDeps = bodyDeps,
): Promise<BodyPreferences> {
  const lock = await db.query(
    "SELECT id FROM installations WHERE id=$1 FOR UPDATE",
    [owner],
  );
  if (!lock.rows.length) throw new BodyError("NOT_FOUND", 404);
  const previous = await replay(db, owner, "preferences", change, [
    change.mode,
    change.defaultCharacterId,
    change.expectedRevision,
  ]);
  if (previous.value) return previous.value as BodyPreferences;
  const current = await readPreferences(db, owner);
  expect(current.revision, change.expectedRevision, "BODY_PREFERENCE_CONFLICT");
  if (change.mode === "fixed_default" && !change.defaultCharacterId)
    throw new BodyError("INVALID_INPUT", 400);
  if (change.defaultCharacterId) {
    if (
      !deps
        .catalog()
        .assets.some((a) => a.characterId === change.defaultCharacterId)
    )
      throw new BodyError("INVALID_CHARACTER", 400);
    if ((await deps.check(change.defaultCharacterId)) !== "ok")
      throw new BodyError("BODY_UNAVAILABLE", 409);
  }
  const value: BodyPreferences = {
    ...current,
    mode: change.mode,
    defaultCharacterId: change.defaultCharacterId,
    revision: current.revision + 1,
  };
  await db.query(
    `INSERT INTO body_preferences (installation_id,value) VALUES ($1,$2)
    ON CONFLICT (installation_id) DO UPDATE SET value=EXCLUDED.value`,
    [owner, JSON.stringify(value)],
  );
  await remember(db, owner, "preferences", null, change, previous.hash, value);
  return value;
}
/** Capture once, before queue dispatch. Does not contact the converter or run inference. */
export async function captureBodyPolicy(
  db: BodyDb,
  jobId: string,
  owner: string,
  catalog = loadBodyCatalog(),
): Promise<void> {
  const policy = snapshot(await readPreferences(db, owner), catalog);
  await db.query(
    "UPDATE jobs SET body_policy_json=$2 WHERE id=$1 AND body_policy_json IS NULL",
    [jobId, JSON.stringify(policy)],
  );
}
/** Called under the existing persistAnalysisRecords job lock; retries never overwrite manual choices. */
export async function initializeBodySelections(
  db: BodyDb,
  jobId: string,
  result: AnalysisResult,
  catalog = loadBodyCatalog(),
): Promise<void> {
  const { rows } = await db.query<{ body_policy_json: BodyPolicy | null }>(
    "SELECT body_policy_json FROM jobs WHERE id=$1",
    [jobId],
  );
  const policy = rows[0]?.body_policy_json;
  if (!policy) return;
  for (const p of result.candidatesByPerson) {
    const rec = p.bodyRecommendation ?? {
      status: "disabled" as const,
      body: null,
      reasonCodes: ["body_disabled"],
    };
    const value = resolveBody(
      p.personIndex,
      policy,
      rec,
      catalog,
      p.candidates.map((c) => c.poseId),
    );
    await db.query(
      `INSERT INTO body_selections (job_id,person_index,value) VALUES ($1,$2,$3)
      ON CONFLICT (job_id,person_index) DO NOTHING`,
      [jobId, p.personIndex, JSON.stringify(value)],
    );
  }
}
async function ownedPerson(
  db: BodyDb,
  owner: string,
  jobId: string,
  index: number,
  lock = false,
) {
  const { rows } = await db.query<{
    status: string;
    result_json: string | null;
    body_policy_json: BodyPolicy | null;
  }>(
    `SELECT status,result_json,body_policy_json FROM jobs WHERE id=$1 AND installation_id=$2${lock ? " FOR UPDATE" : ""}`,
    [jobId, owner],
  );
  const job = rows[0];
  if (!job) throw new BodyError("NOT_FOUND", 404);
  if (job.status !== "completed" || !job.result_json)
    throw new BodyError("NOT_READY", 409);
  const person = (
    JSON.parse(job.result_json) as AnalysisResult
  ).candidatesByPerson.find((p) => p.personIndex === index);
  if (!person) throw new BodyError("NOT_FOUND", 404);
  if (!job.body_policy_json)
    throw new BodyError("BODY_SELECTION_UNSUPPORTED", 409);
  return { person, policy: job.body_policy_json };
}
function revalidate(
  value: BodySelection,
  person: AnalysisPerson,
  catalog: BodyCatalog,
): BodySelection {
  const poses = person.candidates.map((c) => c.poseId);
  const recommendation =
    value.recommendation.status === "available" &&
    !eligible(value.recommendation.body, catalog, poses)
      ? {
          ...value.recommendation,
          status: "unavailable" as const,
          reasonCodes: ["body_asset_unavailable"],
        }
      : value.recommendation;
  return {
    ...value,
    recommendation,
    resolutionStatus:
      value.resolvedBody && !eligible(value.resolvedBody, catalog, poses)
        ? "unavailable"
        : value.resolutionStatus,
  };
}
export async function readSelection(
  db: BodyDb,
  owner: string,
  jobId: string,
  index: number,
  catalog = loadBodyCatalog(),
): Promise<BodySelection> {
  const { person } = await ownedPerson(db, owner, jobId, index);
  const { rows } = await db.query<{ value: BodySelection }>(
    "SELECT value FROM body_selections WHERE job_id=$1 AND person_index=$2",
    [jobId, index],
  );
  if (!rows[0]) throw new BodyError("BODY_SELECTION_UNSUPPORTED", 409);
  return revalidate(rows[0].value, person, catalog);
}
export async function writeSelection(
  db: BodyDb,
  owner: string,
  jobId: string,
  index: number,
  change: SelectionChange,
  deps: BodyDeps = bodyDeps,
): Promise<BodySelection> {
  const { person, policy } = await ownedPerson(db, owner, jobId, index, true);
  const resource = `${jobId}:${index}`;
  const previous = await replay(db, owner, resource, change, [
    change.intent,
    change.characterId ?? null,
    change.expectedRevision,
  ]);
  if (previous.value) return previous.value as BodySelection;
  const catalog = deps.catalog();
  const stored = await db.query<{ value: BodySelection }>(
    "SELECT value FROM body_selections WHERE job_id=$1 AND person_index=$2",
    [jobId, index],
  );
  const current = stored.rows[0]?.value;
  if (!current) throw new BodyError("BODY_SELECTION_UNSUPPORTED", 409);
  expect(
    current.selectionRevision,
    change.expectedRevision,
    "BODY_SELECTION_CONFLICT",
  );
  const poses = person.candidates.map((c) => c.poseId);
  if (!poses.length) throw new BodyError("BODY_NOT_APPLICABLE", 409);
  const manual = catalog.assets.find(
    (a) => a.characterId === change.characterId,
  );
  if (change.intent === "manual" && !manual)
    throw new BodyError("INVALID_CHARACTER", 400);
  if (manual && !eligible(manual, catalog, poses))
    throw new BodyError("BODY_POSE_UNSUPPORTED", 409);
  const value = resolveBody(
    index,
    policy,
    current.recommendation,
    catalog,
    poses,
    change.intent,
    manual ? bodyRef(manual) : null,
    current.selectionRevision + 1,
  );
  if (value.resolutionStatus !== "ready" || !value.resolvedBody)
    throw new BodyError(
      change.intent === "auto"
        ? "BODY_RECOMMENDATION_UNAVAILABLE"
        : "BODY_UNAVAILABLE",
      409,
    );
  if ((await deps.check(value.resolvedBody.characterId)) !== "ok")
    throw new BodyError("BODY_UNAVAILABLE", 409);
  await db.query(
    "UPDATE body_selections SET value=$3 WHERE job_id=$1 AND person_index=$2",
    [jobId, index, JSON.stringify(value)],
  );
  await remember(db, owner, resource, jobId, change, previous.hash, value);
  return value;
}
export async function bodyOptions(
  db: BodyDb,
  owner: string,
  jobId: string,
  index: number,
  deps: BodyDeps = bodyDeps,
) {
  const { person } = await ownedPerson(db, owner, jobId, index);
  const catalog = deps.catalog(),
    poses = person.candidates.map((c) => c.poseId);
  const characters = await Promise.all(
    catalog.assets.map(async (a) => {
      const reasons = !poses.length
        ? ["BODY_NOT_APPLICABLE"]
        : !eligible(a, catalog, poses)
          ? ["BODY_POSE_UNSUPPORTED"]
          : (await deps.check(a.characterId)) !== "ok"
            ? ["BODY_UNAVAILABLE"]
            : [];
      return {
        characterId: a.characterId,
        bodyRef: bodyRef(a),
        ...(a.displayName ? { displayName: a.displayName } : {}),
        ...(a.neutralPreview ? { neutralPreview: neutralMetadata(a) } : {}),
        selectable: reasons.length === 0,
        reasonCodes: reasons,
      };
    }),
  );
  return { catalogRevision: catalog.version, characters };
}
/** One owner-scoped read; compose the live state without modifying result_json. */
export async function attachBodySelections(
  owner: string,
  result: AnalysisResult,
  db: BodyDb = pool,
): Promise<AnalysisResult> {
  if (!config.bodySelectionEnabled) return result;
  const { rows } = await db.query<{
    person_index: number;
    value: BodySelection;
  }>(
    `SELECT b.person_index,b.value FROM body_selections b
    JOIN jobs j ON j.id=b.job_id WHERE j.id=$1 AND j.installation_id=$2`,
    [result.jobId, owner],
  );
  const catalog = loadBodyCatalog();
  return {
    ...result,
    candidatesByPerson: result.candidatesByPerson.map((p) => {
      const row = rows.find((r) => r.person_index === p.personIndex);
      return row
        ? { ...p, bodySelection: revalidate(row.value, p, catalog) }
        : p;
    }),
  };
}
export const bodyStore = {
  preferences: (owner: string) => readPreferences(pool, owner),
  savePreferences: (owner: string, change: PreferenceChange) =>
    transaction((db) => writePreferences(db, owner, change)),
  selection: (owner: string, job: string, index: number) =>
    readSelection(pool, owner, job, index),
  saveSelection: (
    owner: string,
    job: string,
    index: number,
    change: SelectionChange,
  ) => transaction((db) => writeSelection(db, owner, job, index, change)),
  options: (owner: string, job: string, index: number) =>
    bodyOptions(pool, owner, job, index),
};
