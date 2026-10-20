/** Respect explicit failures in the original checks without inventing new thresholds.
 * Older BFF contexts omitted evidence; their trusted preview_ready contract is still required.
 */
export function generatedChecksFailed(evidence: unknown): boolean {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return false;
  const row = evidence as Record<string, unknown>;
  const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
  if (object(row.diagnostics).kinematic_probe_pass === false) return true;
  return [row.validation, row.hand_skin_screen].some(v =>
    ["failed", "rejected", "error", "timeout", "unavailable", "unverified"].includes(String(object(v).status)),
  );
}
