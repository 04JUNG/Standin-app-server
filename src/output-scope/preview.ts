import type { AnalysisPerson } from "../types.js";
import { resolvePersonOutputScope } from "./model.js";
/** One final mesh scope shared by cards, body/hands, review and export. */
export function previewScope(person: AnalysisPerson) {
  return resolvePersonOutputScope(person).resolved;
}
