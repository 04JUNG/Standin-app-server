/** Public v1 allowlist. Producer sends cumulative snapshots; private fields never survive. */
import { poseThumbnailUrl } from "../pose-thumbnail.js";

export const STAGES = ["analyzing", "extracting", "understanding", "searching", "refining", "ranking"] as const;
export type Stage = typeof STAGES[number];
type Overlay = { format: "coco17"; coordinateSpace: "image-normalized"; points: ([number, number] | null)[] };
type Preview = { id: string; rank: number; thumbnailUrl: string };
export interface ProgressPerson {
  personIndex: number;
  skeleton?: Overlay;
  observations?: { id: string; label: string }[];
  searchMode?: "pose" | "description" | "combined" | "upper_body";
  candidates?: Preview[];
  refinement?: { candidateId: string; status: "running" | "improved" | "unchanged" | "reverted" | "skipped";
    before?: Overlay; after?: Overlay; beforeThumbnailUrl?: string; afterThumbnailUrl?: string };
}
export interface AnalysisProgress {
  version: "pose-analysis-progress.v1";
  sequence: number;
  stage: Stage;
  updatedAt: string;
  completedStages: Stage[];
  skippedStages: Stage[];
  activePersonIndex?: number;
  people: ProgressPerson[];
}
const dict = (x: unknown): Record<string, unknown> | undefined =>
  x !== null && typeof x === "object" && !Array.isArray(x) ? x as Record<string, unknown> : undefined;
const index = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
const stage = (x: unknown): x is Stage => STAGES.includes(x as Stage);
const codes = (x: unknown): Stage[] => Array.isArray(x) ? STAGES.filter(s => x.includes(s)) : [];

const LABELS: Record<string, Record<string, string>> = {
  knees: { bent: "굽힌 무릎", straight: "편 무릎", mixed: "서로 다른 무릎 굽힘" },
  legs: { apart: "벌린 다리", together: "모은 다리", staggered: "앞뒤로 놓인 다리" },
  arms: { lowered: "내린 팔", raised: "올린 팔", spread: "벌린 팔", mixed: "서로 다른 팔 높이" },
  torso: { forward: "앞으로 기운 상체", backward: "뒤로 기운 상체", upright: "세운 상체" },
};
export function translateObservations(raw: unknown): { id: string; label: string }[] {
  const observations = dict(raw);
  if (!observations) return [];
  return Object.entries(LABELS).flatMap(([key, values]) => {
    const value = observations[key];
    const label = typeof value === "string" && Object.hasOwn(values, value) ? values[value] : undefined;
    return label ? [{ id: `${key}:${value}`, label }] : [];
  }).slice(0, 8);
}

export function overlay(raw: unknown): Overlay | undefined {
  const o = dict(raw);
  if (o?.format !== "coco17" || o.coordinateSpace !== "image-normalized" || !Array.isArray(o.points) || o.points.length !== 17) return;
  const points: Overlay["points"] = o.points.map((p: unknown) =>
    Array.isArray(p) && p.length === 2 && p.every(v => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1)
      ? [p[0] as number, p[1] as number] : null);
  // Facial details are intentionally omitted in public progress.
  points.fill(null, 0, 5);
  return { format: "coco17", coordinateSpace: "image-normalized", points };
}

/** Only existing static library thumbnails. Never aligned/render-on-demand URLs. */
function preview(raw: unknown): Preview | undefined {
  const p = dict(raw);
  if (!p || typeof p.id !== "string" || p.id.length > 160 || !index(p.rank) || p.rank < 1 || p.rank > 100 || typeof p.thumbnailUrl !== "string") return;
  const match = /^\/pose\/([^/?]+)\/thumbnail\?view=(front|back|side|three_quarter)$/.exec(p.thumbnailUrl);
  if (!match) return;
  let pose: string;
  try { pose = decodeURIComponent(match[1]); } catch { return; }
  const view = match[2];
  if (!pose || pose.length > 240 || /[\/\\\x00-\x1f]/.test(pose)) return;
  if (p.thumbnailUrl !== `/pose/${encodeURIComponent(pose)}/thumbnail?view=${view}`) return;
  if (p.id !== `${pose}::${view}` && p.id !== `semantic::${pose}` && !/^preview_[a-f0-9]{64}$/.test(p.id)) return;
  return { id: p.id, rank: p.rank, thumbnailUrl: poseThumbnailUrl(pose, view) };
}

export function sanitizeProgress(raw: unknown): AnalysisProgress | undefined {
  const p = dict(raw);
  if (!p || p.version !== "pose-analysis-progress.v1" || !index(p.sequence) || p.sequence < 1 || !stage(p.stage) || !Array.isArray(p.people) || p.people.length > 20) return;
  const people: ProgressPerson[] = [];
  const seen = new Set<number>();
  for (const value of p.people) {
    const row = dict(value);
    if (!row || !index(row.personIndex) || row.personIndex > 99 || seen.has(row.personIndex)) return;
    seen.add(row.personIndex);
    const person: ProgressPerson = { personIndex: row.personIndex };
    const skeleton = overlay(row.skeleton);
    if (skeleton) person.skeleton = skeleton;
    const observations = translateObservations(row.observations);
    if (observations.length) person.observations = observations;
    if (["pose", "description", "combined", "upper_body"].includes(row.searchMode as string)) person.searchMode = row.searchMode as ProgressPerson["searchMode"];
    if (Array.isArray(row.candidates)) {
      const ids = new Set<string>();
      const candidates = row.candidates.slice(0, 5).map(preview).filter((c): c is Preview => !!c && !ids.has(c.id) && !!ids.add(c.id));
      if (candidates.length) person.candidates = candidates.sort((a, b) => a.rank - b.rank);
    }
    // No automatic refinement runs in the current analyze producer. Do not accept
    // arbitrary refinement URLs or manufacture running/before/after from eligibility.
    people.push(person);
  }
  const completedStages = codes(p.completedStages), skippedStages = codes(p.skippedStages);
  if (completedStages.some(s => skippedStages.includes(s))) return;
  return { version: "pose-analysis-progress.v1", sequence: p.sequence, stage: p.stage,
    updatedAt: new Date().toISOString(), completedStages, skippedStages,
    ...(index(p.activePersonIndex) && seen.has(p.activePersonIndex) ? { activePersonIndex: p.activePersonIndex } : {}),
    people: people.sort((a, b) => a.personIndex - b.personIndex) };
}
