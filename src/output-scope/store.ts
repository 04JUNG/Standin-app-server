import type { PoolClient } from "pg";
import { transaction } from "../db.js";
import type { AnalysisResult } from "../types.js";
import { resolveOutputScope, type OutputScope, type ScopeSelection } from "./model.js";

export type SaveScopeResult =
  | { ok: true; outputScope: OutputScope }
  | { ok: false; reason: "not_found" | "not_ready" | "person_not_found" };

/** Called within a transaction. Lock the job before read/modify/write so two
 * people edited concurrently cannot overwrite each other's preferences. */
export async function writeOutputScope(
  client: Pick<PoolClient, "query">,
  jobId: string,
  installationId: string,
  personIndex: number,
  selection: ScopeSelection,
): Promise<SaveScopeResult> {
  const { rows } = await client.query<{ status: string; result_json: string | null }>(
    "SELECT status, result_json FROM jobs WHERE id = $1 AND installation_id = $2 FOR UPDATE",
    [jobId, installationId],
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: "not_found" };
  if (row.status !== "completed" || !row.result_json) {
    return { ok: false, reason: "not_ready" };
  }
  const result = JSON.parse(row.result_json) as AnalysisResult;
  const person = result.candidatesByPerson.find((p) => p.personIndex === personIndex);
  if (!person) return { ok: false, reason: "person_not_found" };
  const outputScope = resolveOutputScope({ ...person.outputScope, selection });
  person.outputScope = outputScope;
  await client.query(
    "UPDATE jobs SET result_json = $3, updated_at = $4 WHERE id = $1 AND installation_id = $2",
    [jobId, installationId, JSON.stringify(result), new Date().toISOString()],
  );
  return { ok: true, outputScope };
}

export function saveOutputScope(
  jobId: string, installationId: string, personIndex: number, selection: ScopeSelection,
): Promise<SaveScopeResult> {
  return transaction((client) => writeOutputScope(client, jobId, installationId, personIndex, selection));
}
