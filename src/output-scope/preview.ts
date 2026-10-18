import type { AnalysisPerson } from "../types.js";
import { isBodyScope, resolveOutputScope } from "./model.js";

/** Stored user preferences win over inference presentation; recompute derived values. */
export function previewScope(person: AnalysisPerson) {
  if (person.outputScope)
    return resolveOutputScope(person.outputScope).resolved;
  const scope = person.posePresentation?.output_scope;
  return isBodyScope(scope) ? scope : "full";
}
