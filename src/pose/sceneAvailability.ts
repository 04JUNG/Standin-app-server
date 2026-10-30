import type { Job } from "../jobs/store.js";
import { config } from "../config.js";
import { sceneReceiptStorageAvailable } from "./sceneStorage.js";
import { scenePartsCapability } from "./sceneParts.js";
const defaults = {
  scene: () => config.sceneExportEnabled, fbx: () => config.fbxExportEnabled,
  converter: () => !!config.converterBaseUrl, storage: sceneReceiptStorageAvailable,
  refinement: () => config.sceneRefinementEnabled,
  worker: () => !!config.sceneRefinementBaseUrl && !!config.sceneRefinementToken,
};
/** Configuration readiness is distinct from a successful live worker health probe. */
export function sceneAvailability(job: Job, overrides: Partial<typeof defaults> = {}) {
  const deps = { ...defaults, ...overrides };
  const reasons: string[] = [];
  if (!deps.scene()) reasons.push("feature_disabled");
  if (!deps.fbx()) reasons.push("fbx_export_disabled");
  if (!deps.converter()) reasons.push("converter_unavailable");
  if (!job.result?.image || job.status !== "completed") reasons.push("observation_missing");
  if (job.result?.source === "semantic") reasons.push("semantic_input");
  const v4 = [...reasons];
  if (!deps.storage()) v4.push("receipt_storage_unavailable");
  if (!deps.refinement()) v4.push("refinement_disabled");
  if (!deps.worker()) v4.push("refinement_unavailable");
  if (!job.inputS3Key) v4.push("source_image_unavailable");
  const configurationReasons = ["feature_disabled", "fbx_export_disabled", "converter_unavailable",
    "receipt_storage_unavailable", "refinement_disabled", "refinement_unavailable"];
  const configured = !v4.some(reason => configurationReasons.includes(reason));
  v4.push("parts_discovery_required", "explicit_intent_required");
  return {
    version: "scene-availability-v1", selectionValidation: "required_on_prepare",
    candidateEligibility: (job.result?.candidatesByPerson ?? []).map(p => ({
      personIndex: p.personIndex,
      reason: !p.candidates.length ? "no_candidates" : !p.box ? "observation_missing" : null,
      candidates: p.candidates.map(c => ({ candidateId: c.id,
        available: c.source !== "generation" && !!p.box,
        reasons: c.source === "generation" ? ["generated_individual_only"] : !p.box ? ["observation_missing"] : [],
      })),
    })),
    originalSelection: { available: reasons.length === 0, reasons },
    autoCorrectV4: { available: false, reasons: v4, readiness: "configuration_only", configured,
      parts: { ...scenePartsCapability(), discoveryPath: `/v1/analysis/jobs/${encodeURIComponent(job.id)}/scene/parts` } },
    manifest: { available: reasons.length === 0 && deps.storage(), reasons: deps.storage() ? reasons : [...reasons, "receipt_storage_unavailable"] },
  };
}
