import { config } from "../config.js";
import { log } from "../log.js";
import { createCandidateRefineTransport } from "../inference.js";
import { validateConfirmedSelection } from "../analytics/store.js";
import { resolvePreparation } from "./resolver.js";
import { PreparationService } from "./service.js";
import { PreparationStore } from "./store.js";
export const preparationEnabled = () => config.candidatePreparationEnabled && config.candidateRefineToken.length >= 32;
export const preparationService = new PreparationService({ store: new PreparationStore(), resolve: resolvePreparation,
  transport: createCandidateRefineTransport(), confirmed: validateConfirmedSelection,
  metric: (event, data) => log.info({ type: "candidate_preparation", event, ...data }) });

// One short capability flight for all result readers; polling never multiplies engine probes.
let capabilityFlight: Promise<boolean> | null = null;
let capabilityUntil = 0, capabilityValue = false;
export async function candidatePreparationAvailable() {
  if (!preparationEnabled()) return false;
  if (Date.now() < capabilityUntil) return capabilityValue;
  if (!capabilityFlight) capabilityFlight = preparationService.identity().then(() => true, () => false).then(value => {
    capabilityValue = value; capabilityUntil = Date.now() + 5000; capabilityFlight = null; return value;
  });
  return capabilityFlight;
}
