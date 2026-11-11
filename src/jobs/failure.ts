/** Shared between polling and history; manual retry never implies upstream cancellation. */
export function analysisFailureDetails(code: string | null) {
  if (!code) return null;
  return { code, phase: "analysis" as const, recovery: "explicit_retry" as const,
    serverOperationMayContinue: code === "ANALYSIS_TIMEOUT" || code === "ABANDONED" };
}
