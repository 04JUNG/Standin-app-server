import { transaction } from "../db.js";
import type { AnalysisResult } from "../types.js";
import { readyHandCatalog } from "./service.js";
import {
  HandError,
  readHands,
  record,
  SIDES,
  type HandCatalog,
  type HandSelection,
} from "./model.js";

export interface HandChange {
  left?: string;
  right?: string;
  library_sha256: string;
  expectedRevision: number;
}
const defaults = { transaction, catalog: readyHandCatalog };
export function createHandStore(deps = defaults) {
  async function selection(
    owner: string,
    job: string,
    personIndex: number,
    change?: HandChange,
  ): Promise<HandSelection> {
    const catalog: HandCatalog = await deps.catalog();
    const ids = new Set(
      catalog.categories.flatMap((c) => c.presets.map((p) => p.id)),
    );
    if (change && change.library_sha256 !== catalog.library_sha256)
      throw new HandError(
        "HAND_LIBRARY_CHANGED",
        409,
        "손 목록이 변경되었습니다. 다시 확인해 주세요.",
      );
    if (
      change &&
      SIDES.some((s) => change[s] !== undefined && !ids.has(change[s]!))
    )
      throw new HandError(
        "INVALID_HAND_PRESET",
        400,
        "손 모양을 다시 선택해 주세요.",
      );
    return deps.transaction(async (client) => {
      const { rows } = await client.query<{
        status: string;
        result_json: string | null;
      }>(
        "SELECT status, result_json FROM jobs WHERE id=$1 AND installation_id=$2 FOR UPDATE",
        [job, owner],
      );
      const row = rows[0];
      if (!row)
        throw new HandError("NOT_FOUND", 404, "작업을 찾을 수 없습니다.");
      if (row.status !== "completed" || !row.result_json)
        throw new HandError(
          "NOT_READY",
          409,
          "분석 완료 후 손을 선택해 주세요.",
        );
      const result = JSON.parse(row.result_json) as AnalysisResult;
      const person = result.candidatesByPerson.find(
        (p) => p.personIndex === personIndex,
      );
      if (
        !person ||
        (!person.candidates.length &&
          !person.posePresentation?.library_candidates.length &&
          !person.posePresentation?.review_candidates.length &&
          !person.posePresentation?.generated_candidates.length)
      )
        throw new HandError("NOT_FOUND", 404, "인물을 찾을 수 없습니다.");
      const observation = readHands(person.hands);
      const valid = (id: string) => (ids.has(id) ? id : catalog.default_preset);
      let current: HandSelection = person.handSelection ?? {
        personIndex,
        left: valid(observation.left.preset),
        right: valid(observation.right.preset),
        recommended: {
          left: valid(observation.left.preset),
          right: valid(observation.right.preset),
        },
        observation,
        library_version: catalog.library_version,
        library_sha256: catalog.library_sha256,
        revision: 0,
        changed: [],
      };
      if (current.library_sha256 !== catalog.library_sha256) {
        if (change)
          throw new HandError(
            "HAND_LIBRARY_CHANGED",
            409,
            "손 목록이 변경되었습니다. 다시 확인해 주세요.",
          );
        current = {
          ...current,
          left: valid(current.left),
          right: valid(current.right),
          recommended: {
            left: valid(current.recommended.left),
            right: valid(current.recommended.right),
          },
          library_version: catalog.library_version,
          library_sha256: catalog.library_sha256,
          revision: current.revision + 1,
        };
      }
      if (change) {
        if (change.expectedRevision !== current.revision)
          throw new HandError(
            "HANDS_CHANGED",
            409,
            "손 선택이 변경되었습니다. 다시 확인해 주세요.",
          );
        const left = change.left ?? current.left,
          right = change.right ?? current.right;
        current = {
          ...current,
          left,
          right,
          revision:
            current.revision +
            (left !== current.left || right !== current.right ? 1 : 0),
        };
      }
      current.changed = SIDES.filter(
        (side) => current[side] !== current.recommended[side],
      );
      person.handSelection = current;
      await client.query(
        "UPDATE jobs SET result_json=$2, updated_at=$3 WHERE id=$1",
        [job, JSON.stringify(result), new Date().toISOString()],
      );
      return current;
    });
  }
  return { selection };
}
export const handStore = createHandStore();
export function parseHandChange(raw: unknown): HandChange {
  const v = record(raw);
  if (
    Object.keys(v).some(
      (k) =>
        !["left", "right", "library_sha256", "expectedRevision"].includes(k),
    ) ||
    !SIDES.some((s) => v[s] !== undefined) ||
    SIDES.some((s) => v[s] !== undefined && typeof v[s] !== "string") ||
    typeof v.library_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(v.library_sha256) ||
    !Number.isSafeInteger(v.expectedRevision) ||
    (v.expectedRevision as number) < 0
  )
    throw new HandError("INVALID_INPUT", 400, "손 선택값을 확인해 주세요.");
  return v as unknown as HandChange;
}
