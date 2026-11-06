import { validateConfirmedSelection } from "../analytics/store.js";
/** Bridge to the existing selected-only body/hand/export flow. No source solver executes here. */
import { getJob } from "../jobs/store.js";
import { preparationEnabled, preparationService } from "./runtime.js";
import { PreparationError } from "./model.js";
const defaults = { enabled: preparationEnabled, service: preparationService, getJob, confirmed: validateConfirmedSelection };
export function createPreparedSelectionSource(deps = defaults) {
 return async (jobId: string, personIndex: number, candidateId: string) => {
  if (!deps.enabled()) return null;
  const job = await deps.getJob(jobId);
  if (!job?.installationId) return null;
  const l = { jobId, installationId: job.installationId };
  const head = await deps.service.deps.store.head(l);
  if (!head) return null; // Legacy jobs remain on the legacy selected-only path.
  if (head.status === "cancelled" || head.status === "invalidated") throw new PreparationError("PREPARATION_SUPERSEDED");
  if (!(await deps.confirmed(l.installationId, jobId, personIndex, candidateId)))
    throw new PreparationError("SELECTION_REQUIRED");
  return deps.service.source(l, head.batchId, personIndex, candidateId);
 };
}
export const preparedSelectionSource = createPreparedSelectionSource();
