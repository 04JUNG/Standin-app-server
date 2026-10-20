import { config } from "../config.js";
import { resolvePersonOutputScope, scopeIncludesHands, type OutputScope } from "../output-scope/model.js";
import { getHandCatalog, getHandThumbnail } from "../inference.js";
import {
  converterEnabled,
  EXPECTED_SOLVER_VERSION,
} from "../converter/client.js";
import { FRAMING_VERSION } from "../converter/framing.js";
import {
  HandError,
  parseCatalog,
  record,
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
const readinessDeps = {
  enabled: () => config.handSelectionEnabled && converterEnabled(),
  catalog: handCatalog,
  health: () =>
    fetch(`${config.converterBaseUrl.replace(/\/+$/, "")}/healthz`, {
      signal: AbortSignal.timeout(5000),
    }),
};
let readyCache: { until: number; catalog: HandCatalog } | undefined;
let pending: Promise<HandCatalog> | undefined;
export async function readyHandCatalog(
  fresh = false,
  overrides: Partial<typeof readinessDeps> = {},
): Promise<HandCatalog> {
  const custom = Object.keys(overrides).length > 0;
  const deps = { ...readinessDeps, ...overrides };
  if (!deps.enabled())
    throw new HandError(
      "HAND_SELECTION_DISABLED",
      503,
      "손 선택을 사용할 수 없습니다.",
    );
  if (!fresh && !custom && readyCache && readyCache.until > Date.now())
    return readyCache.catalog;
  if (!fresh && !custom && pending) return pending;
  const check = verifyHandCatalog(deps);
  if (!fresh && !custom) {
    pending = check;
    try {
      const catalog = await check;
      readyCache = { until: Date.now() + 5000, catalog };
      return catalog;
    } finally {
      pending = undefined;
    }
  }
  return check;
}
async function verifyHandCatalog(
  deps: typeof readinessDeps,
): Promise<HandCatalog> {
  try {
    const catalog = await deps.catalog();
    const response = await deps.health();
    const value = record(await response.json());
    const library = record(value.hand_library);
    if (
      !response.ok ||
      value.ok !== true ||
      value.solver_version !== EXPECTED_SOLVER_VERSION ||
      value.framing_version !== FRAMING_VERSION ||
      !Array.isArray(value.output_scopes) ||
      !["full", "half", "bust", "head"].every((s) =>
        (value.output_scopes as unknown[]).includes(s),
      ) ||
      library.version !== catalog.library_version ||
      library.sha256 !== catalog.library_sha256
    )
      throw new Error("hand library mismatch");
    return catalog;
  } catch (error) {
    if (error instanceof HandError) throw error;
    throw new HandError(
      "HANDS_UNAVAILABLE",
      503,
      "손 적용 서비스를 확인하지 못했습니다.",
    );
  }
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
  const catalog = await readyHandCatalog(true);
  if (selection.library_sha256 !== catalog.library_sha256)
    throw new HandError(
      "HAND_LIBRARY_CHANGED",
      409,
      "손 목록이 변경되었습니다. 다시 선택해 주세요.",
    );
  return {
    left: selection.left,
    right: selection.right,
    library_version: selection.library_version,
    library_sha256: selection.library_sha256,
    revision: selection.revision,
  };
}
export { getHandThumbnail };
