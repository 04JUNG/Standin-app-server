import { shapeRuntimeMetadata } from "./shapeRuntime.js";
import { neutralMetadata } from "./neutral.js";
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool, transaction } from "../db.js";
import type { AnalysisResult, AnalysisPerson } from "../types.js";
import { config } from "../config.js";
import { checkCharacter } from "../characters/service.js";
import { loadBodyCatalog } from "./catalog.js";
import {
  bodyShape,
  shapeDefault,
  shapeEditable,
  shapeSpec,
  ShapeInputError,
  type BodyShape,
} from "./shape.js";
import {
  bodyRef,
  defaultPreferences,
  eligible,
  resolveBody,
  snapshot,
  type BodyCard,
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
  /** Absent keeps the saved value; null clears it. */
  shapeDefault?: unknown;
}
/** Card edits. Each bumps the preferences revision like any other preference write. */
export type CardChange = Mutation &
  (
    | {
        op: "create";
        name: string;
        characterId: string;
        controls: unknown;
      }
    | {
        op: "update";
        cardId: string;
        name?: string;
        characterId?: string;
        controls?: unknown;
      }
    | { op: "delete"; cardId: string }
  );
export const CARD_LIMIT = 48;
export const CARD_NAME_MAX = 24;
/** Id of the card made from an older "내 기본값" (shapeDefault) when cards are first read. */
export const MIGRATED_CARD_ID = "my-default";
export interface SelectionChange extends Mutation {
  intent: BodyIntent;
  characterId?: string;
  /** Manual only: `{ controls }` for a shape-capable asset. */
  shape?: { controls: unknown };
}
function shapeError(e: unknown): never {
  if (e instanceof ShapeInputError)
    throw new BodyError(e.code, e.code === "INVALID_SHAPE" ? 400 : 409);
  throw e;
}
/**
 * Characters the settings page may edit, with what it needs to show them outside a job:
 * the name, the neutral preview and the live-preview runtime (same metadata as body-options).
 */
export function presentShapeEditable(catalog: BodyCatalog) {
  const byId = new Map(catalog.assets.map((a) => [a.characterId, a]));
  return shapeEditable(catalog).map((entry) => {
    const a = byId.get(entry.characterId)!;
    return {
      ...entry,
      ...(a.displayName ? { displayName: a.displayName } : {}),
      ...(a.neutralPreview ? { neutralPreview: neutralMetadata(a) } : {}),
      ...(a.shapeRuntime ? { shapeRuntime: shapeRuntimeMetadata(a) } : {}),
    };
  });
}
/** Preferences as the client sees them: stored value plus what the catalog allows. */
export type PresentedPreferences = BodyPreferences & {
  shapeEditable?: ReturnType<typeof presentShapeEditable>;
};
export function presentPreferences(
  value: BodyPreferences,
  catalog: BodyCatalog = loadBodyCatalog(),
): PresentedPreferences {
  return {
    ...value,
    shapeDefault: value.shapeDefault ?? null,
    cards: cardsOf(value),
    lastUsed: value.lastUsed ?? null,
    shapeEditable: presentShapeEditable(catalog),
  };
}
/**
 * Saved cards. Rows written before cards existed show their "내 기본값" as one card so the
 * user keeps it; the first card write stores that list for real.
 */
export function cardsOf(value: BodyPreferences): BodyCard[] {
  if (value.cards) return value.cards;
  const mine = value.shapeDefault;
  if (!mine) return [];
  const epoch = new Date(0).toISOString();
  return [
    {
      cardId: MIGRATED_CARD_ID,
      name: "내 기본 체형",
      characterId: mine.characterId,
      controls: mine.controls,
      createdAt: epoch,
      updatedAt: epoch,
    },
  ];
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
  const keepShape = !("shapeDefault" in change);
  const previous = await replay(db, owner, "preferences", change, [
    change.mode,
    change.defaultCharacterId,
    change.expectedRevision,
    // Old clients never send the key; their replay hash must stay unchanged.
    ...(keepShape ? [] : [change.shapeDefault ?? null]),
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
  let nextShape = current.shapeDefault ?? null;
  if (!keepShape) {
    try {
      nextShape = shapeDefault(deps.catalog(), change.shapeDefault ?? null);
    } catch (e) {
      shapeError(e);
    }
    if (nextShape && (await deps.check(nextShape.characterId)) !== "ok")
      throw new BodyError("BODY_UNAVAILABLE", 409);
  }
  const value: BodyPreferences = {
    ...current,
    mode: change.mode,
    defaultCharacterId: change.defaultCharacterId,
    shapeDefault: nextShape,
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
async function storePreferences(
  db: BodyDb,
  owner: string,
  value: BodyPreferences,
) {
  await db.query(
    `INSERT INTO body_preferences (installation_id,value) VALUES ($1,$2)
    ON CONFLICT (installation_id) DO UPDATE SET value=EXCLUDED.value`,
    [owner, JSON.stringify(value)],
  );
}
function cardName(raw: unknown) {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name || [...name].length > CARD_NAME_MAX)
    throw new BodyError("INVALID_CARD_NAME", 400);
  return name;
}
/** A card always carries controls for a shape-capable body (same rule as "내 기본값"). */
async function cardBody(
  characterId: string,
  controls: unknown,
  deps: BodyDeps,
) {
  let body;
  try {
    body = shapeDefault(deps.catalog(), { characterId, controls });
  } catch (e) {
    shapeError(e);
  }
  if (!body) throw new BodyError("INVALID_SHAPE", 400);
  if ((await deps.check(body.characterId)) !== "ok")
    throw new BodyError("BODY_UNAVAILABLE", 409);
  return body;
}
export async function writeCards(
  db: BodyDb,
  owner: string,
  change: CardChange,
  deps: BodyDeps = bodyDeps,
  now: () => Date = () => new Date(),
): Promise<BodyPreferences> {
  const lock = await db.query(
    "SELECT id FROM installations WHERE id=$1 FOR UPDATE",
    [owner],
  );
  if (!lock.rows.length) throw new BodyError("NOT_FOUND", 404);
  const { expectedRevision, mutationId, ...payload } = change;
  void mutationId;
  const previous = await replay(db, owner, "preferences", change, [
    "cards",
    expectedRevision,
    payload,
  ]);
  if (previous.value) return previous.value as BodyPreferences;
  const current = await readPreferences(db, owner);
  expect(current.revision, expectedRevision, "BODY_PREFERENCE_CONFLICT");
  const cards = cardsOf(current);
  const at = now().toISOString();
  const find = (id: string) => {
    const i = cards.findIndex((c) => c.cardId === id);
    if (i < 0) throw new BodyError("CARD_NOT_FOUND", 404);
    return i;
  };
  let next: BodyCard[];
  if (change.op === "create") {
    if (cards.length >= CARD_LIMIT) throw new BodyError("CARD_LIMIT", 409);
    const body = await cardBody(change.characterId, change.controls, deps);
    next = [
      ...cards,
      {
        cardId: "card_" + randomUUID(),
        name: cardName(change.name),
        ...body,
        createdAt: at,
        updatedAt: at,
      },
    ];
  } else if (change.op === "update") {
    const i = find(change.cardId);
    const card = cards[i]!;
    const reshape = "characterId" in change || "controls" in change;
    const body = reshape
      ? await cardBody(
          change.characterId ?? card.characterId,
          change.controls ?? card.controls,
          deps,
        )
      : null;
    next = cards.map((c, j) =>
      j === i
        ? {
            ...c,
            ...(change.name !== undefined
              ? { name: cardName(change.name) }
              : {}),
            ...(body ?? {}),
            updatedAt: at,
          }
        : c,
    );
  } else {
    const i = find(change.cardId);
    next = cards.filter((_, j) => j !== i);
  }
  const value: BodyPreferences = {
    ...current,
    cards: next,
    // The migrated card *is* the old "내 기본값"; deleting it must not bring it back.
    ...(change.op === "delete" && change.cardId === MIGRATED_CARD_ID
      ? { shapeDefault: null }
      : {}),
    revision: current.revision + 1,
  };
  await storePreferences(db, owner, value);
  await remember(db, owner, "preferences", null, change, previous.hash, value);
  return value;
}
/**
 * Remembers a hand-picked body for the next job (`last_used`). Same transaction as the
 * selection write; it does not bump the preferences revision so an open settings screen
 * does not get a conflict for something it never edits.
 */
async function recordLastUsed(
  db: BodyDb,
  owner: string,
  value: BodySelection,
  now: () => Date,
) {
  if (value.resolvedSource !== "manual" || !value.resolvedBody) return;
  await db.query("SELECT id FROM installations WHERE id=$1 FOR UPDATE", [
    owner,
  ]);
  const current = await readPreferences(db, owner);
  await storePreferences(db, owner, {
    ...current,
    lastUsed: {
      characterId: value.resolvedBody.characterId,
      controls: value.shape?.controls ?? null,
      usedAt: now().toISOString(),
    },
  });
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
/** Separate preview context: catalog pose coverage still gates every legacy export path. */
export function personBodyContext(person: AnalysisPerson) {
  const p = person.posePresentation;
  const previewOnly =
    !!p && ["dynamic-pose-presentation-v1", "semantic-pose-presentation-v1"].includes(p.version) &&
    ["full", "half", "shoulder_head", "head"].includes(p.output_scope ?? "") &&
    [p.library_candidates, p.review_candidates, p.generated_candidates].some(
      (g) => g.length > 0,
    );
  return {
    previewOnly,
    poses: previewOnly
      ? [
          ...p!.library_candidates,
          ...p!.review_candidates,
          ...p!.generated_candidates,
        ].map((c) => c.candidate_id)
      : person.candidates.map((c) => c.poseId),
  };
}
function initialBody(
  person: AnalysisPerson,
  policy: BodyPolicy,
  catalog: BodyCatalog,
) {
  const context = personBodyContext(person);
  return resolveBody(
    person.personIndex,
    policy,
    person.bodyRecommendation ?? {
      status: "disabled",
      body: null,
      reasonCodes: ["body_disabled"],
    },
    catalog,
    context.poses,
    "inherit",
    null,
    0,
    null,
    context.previewOnly,
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
    const value = initialBody(p, policy, catalog);
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
  const { poses, previewOnly } = personBodyContext(person);
  const recommendation =
    value.recommendation.status === "available" &&
    !eligible(value.recommendation.body, catalog, poses, previewOnly)
      ? {
          ...value.recommendation,
          status: "unavailable" as const,
          reasonCodes: ["body_asset_unavailable"],
        }
      : value.recommendation;
  // A shaped choice is only valid while its asset still accepts the same controls.
  const asset = catalog.assets.find(
    (a) => a.characterId === value.resolvedBody?.characterId,
  );
  const shapeLost = !!value.shape && !shapeSpec(asset);
  return {
    ...value,
    shape: value.shape ?? null,
    // Derived, never stored: the source a shaped body must be baked with right now.
    ...(value.shape ? { shapeSource: asset?.shapeSource ?? null } : {}),
    recommendation,
    resolutionStatus:
      (value.resolvedBody &&
        !eligible(value.resolvedBody, catalog, poses, previewOnly)) ||
      shapeLost
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
  const { person, policy } = await ownedPerson(db, owner, jobId, index);
  const { rows } = await db.query<{ value: BodySelection }>(
    "SELECT value FROM body_selections WHERE job_id=$1 AND person_index=$2",
    [jobId, index],
  );
  if (!rows[0]) throw new BodyError("BODY_SELECTION_UNSUPPORTED", 409);
  const stored = rows[0].value;
  // Old presentation jobs stored not_applicable because legacy candidates are empty.
  // Resolve their original snapshot, not today's preferences; GET remains read-only.
  const value =
    personBodyContext(person).previewOnly &&
    stored.resolutionStatus === "not_applicable"
      ? {
          ...initialBody(person, policy, catalog),
          selectionRevision: stored.selectionRevision,
        }
      : stored;
  return revalidate(value, person, catalog);
}
export async function writeSelection(
  db: BodyDb,
  owner: string,
  jobId: string,
  index: number,
  change: SelectionChange,
  deps: BodyDeps = bodyDeps,
  now: () => Date = () => new Date(),
): Promise<BodySelection> {
  const { person, policy } = await ownedPerson(db, owner, jobId, index, true);
  const resource = `${jobId}:${index}`;
  const previous = await replay(db, owner, resource, change, [
    change.intent,
    change.characterId ?? null,
    change.expectedRevision,
    ...(change.shape ? [change.shape] : []),
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
  const { poses, previewOnly } = personBodyContext(person);
  if (!poses.length) throw new BodyError("BODY_NOT_APPLICABLE", 409);
  const manual = catalog.assets.find(
    (a) => a.characterId === change.characterId,
  );
  if (change.intent === "manual" && !manual)
    throw new BodyError("INVALID_CHARACTER", 400);
  if (manual && !eligible(manual, catalog, poses, previewOnly))
    throw new BodyError("BODY_POSE_UNSUPPORTED", 409);
  let shape: BodyShape | null = null;
  if (change.shape) {
    if (change.intent !== "manual" || !manual)
      throw new BodyError("INVALID_INPUT", 400);
    try {
      shape = bodyShape(manual, change.shape.controls);
    } catch (e) {
      shapeError(e);
    }
  }
  const value = resolveBody(
    index,
    policy,
    current.recommendation,
    catalog,
    poses,
    change.intent,
    manual ? bodyRef(manual) : null,
    current.selectionRevision + 1,
    shape,
    previewOnly,
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
  await recordLastUsed(db, owner, value, now);
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
    { poses, previewOnly } = personBodyContext(person);
  const characters = await Promise.all(
    catalog.assets.map(async (a) => {
      const reasons = !poses.length
        ? ["BODY_NOT_APPLICABLE"]
        : !eligible(a, catalog, poses, previewOnly)
          ? ["BODY_POSE_UNSUPPORTED"]
          : (await deps.check(a.characterId)) !== "ok"
            ? ["BODY_UNAVAILABLE"]
            : [];
      return {
        characterId: a.characterId,
        bodyRef: bodyRef(a),
        ...(a.displayName ? { displayName: a.displayName } : {}),
        ...(a.neutralPreview ? { neutralPreview: neutralMetadata(a) } : {}),
        ...(shapeSpec(a) ? { shape: shapeSpec(a) } : {}),
        ...(shapeSpec(a) && a.shapeRuntime
          ? { shapeRuntime: shapeRuntimeMetadata(a) }
          : {}),
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
  preferences: async (owner: string) =>
    presentPreferences(await readPreferences(pool, owner)),
  savePreferences: async (owner: string, change: PreferenceChange) =>
    presentPreferences(
      await transaction((db) => writePreferences(db, owner, change)),
    ),
  saveCards: async (owner: string, change: CardChange) =>
    presentPreferences(
      await transaction((db) => writeCards(db, owner, change)),
    ),
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
