import { config } from "../config.js";
import { resolvePersonOutputScope, scopeIncludesHands, type OutputScope } from "../output-scope/model.js";
import { getHandCatalog, getHandThumbnail } from "../inference.js";
import { converterEnabled } from "../converter/client.js";
import { HandAgreement, type HandAgreementDeps } from "./agreement.js";
import {
  HandError,
  SOURCE_POSE,
  parseCatalog,
  type HandCatalog,
  type HandBake,
  type HandSelection,
} from "./model.js";

let cached: { until: number; catalog: HandCatalog } | undefined;
export async function handCatalog(): Promise<HandCatalog> {
  if (cached && cached.until > Date.now()) return cached.catalog;
  try {
    const response = await getHandCatalog();
    if (!response.ok) throw new Error("catalog unavailable");
    const catalog = parseCatalog(await response.json());
    cached = { until: Date.now() + 30_000, catalog };
    return catalog;
  } catch {
    throw new HandError(
      "HANDS_UNAVAILABLE",
      503,
      "손 목록을 불러올 수 없습니다.",
    );
  }
}
/** No feature is advertised until inference and converter agree on the library. */
const readinessDeps: HandAgreementDeps = {
  enabled: () => config.handSelectionEnabled && converterEnabled(),
  catalog: handCatalog,
  health: (init) =>
    fetch(`${config.converterBaseUrl.replace(/\/+$/, "")}/healthz`, init),
};
const agreement = new HandAgreement(readinessDeps);
/**
 * `fresh` (prepare, poll, export) accepts agreement evidence up to 2 s old; listing reads
 * accept 5 s. Concurrent reads share one Converter probe. See `HandAgreement`.
 */
export async function readyHandCatalog(
  fresh = false,
  overrides: Partial<HandAgreementDeps> = {},
): Promise<HandCatalog> {
  // Test/diagnostic overrides get a private agreement with no shared evidence.
  if (Object.keys(overrides).length > 0)
    return new HandAgreement({ ...readinessDeps, ...overrides }, { freshMs: 0, cacheMs: 0 }).read(fresh);
  return agreement.read(fresh);
}
export async function handSelectionAvailable() {
  if (!config.handSelectionEnabled || !converterEnabled()) return false;
  try {
    await readyHandCatalog();
    return true;
  } catch {
    return false;
  }
}
export async function handBakeFor(
  person: {
    handSelection?: HandSelection;
    outputScope?: Partial<OutputScope> | null;
    posePresentation?: { output_scope: string | null } | null;
  } | undefined,
): Promise<HandBake | null> {
  if (!scopeIncludesHands(resolvePersonOutputScope(person).resolved)) return null;
  const selection = person?.handSelection;
  if (!selection) return null;
  // Keeping both source hands needs no preset assets or Converter library agreement.
  // Any selected preset still requires the fresh agreement below.
  if (selection.left === SOURCE_POSE && selection.right === SOURCE_POSE) return null;
  const catalog = await readyHandCatalog(true);
  if (selection.library_sha256 !== catalog.library_sha256)
    throw new HandError(
      "HAND_LIBRARY_CHANGED",
      409,
      "손 목록이 변경되었습니다. 다시 선택해 주세요.",
    );
  return {
    left: selection.left === SOURCE_POSE ? null : selection.left,
    right: selection.right === SOURCE_POSE ? null : selection.right,
    library_version: selection.library_version,
    library_sha256: selection.library_sha256,
    revision: selection.revision,
  };
}
export { getHandThumbnail };
