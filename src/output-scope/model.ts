/** Output framing preferences. These do not authorize search/refine or crop files. */
export type BodyScope = "full" | "half" | "bust" | "shoulder_head" | "head";
export type ScopeSelection = "auto" | BodyScope;
export type DetectionSource = "vlm_person" | "legacy_shot" | "unknown";
export interface OutputScope {
  selection: ScopeSelection;
  detected: BodyScope | null;
  detectionSource: DetectionSource;
  resolved: BodyScope;
  resolutionSource: "auto" | "user" | "fallback";
}

export function isBodyScope(value: unknown): value is BodyScope {
  return (
    value === "full" ||
    value === "half" ||
    value === "bust" ||
    value === "shoulder_head" ||
    value === "head"
  );
}

export function isScopeSelection(value: unknown): value is ScopeSelection {
  return value === "auto" || isBodyScope(value);
}

/** Recompute derived fields; never trust a caller-supplied resolved value. */
export function resolveOutputScope(
  raw?: Partial<OutputScope> | null,
): OutputScope {
  const selection = isScopeSelection(raw?.selection) ? raw.selection : "auto";
  const detected = isBodyScope(raw?.detected) ? raw.detected : null;
  const detectionSource =
    detected &&
    (raw?.detectionSource === "vlm_person" ||
      raw?.detectionSource === "legacy_shot")
      ? raw.detectionSource
      : "unknown";
  return {
    selection,
    detected,
    detectionSource,
    resolved: selection === "auto" ? (detected ?? "full") : selection,
    resolutionSource:
      selection !== "auto" ? "user" : detected ? "auto" : "fallback",
  };
}

/** Persisted user choice, then per-person detection, then presentation, then full.
 * bust and shoulder_head are different anatomical cuts in the Converter.
 */
export function resolvePersonOutputScope(person?: {
  outputScope?: Partial<OutputScope> | null;
  posePresentation?: { output_scope: string | null } | null;
}): OutputScope {
  const raw = person?.outputScope;
  const detected = isBodyScope(raw?.detected)
    ? raw.detected
    : isBodyScope(person?.posePresentation?.output_scope)
      ? person.posePresentation.output_scope
      : null;
  return resolveOutputScope({ ...raw, detected });
}
