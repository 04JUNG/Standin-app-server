/** Synthetic protocol examples. No Blender execution or deployment evidence. */
import { PARTS_HTTP_CONTRACT, REQUIRED_PARTS_ENGINE, type PartsCapability, type PartsSelection } from "./sceneParts.js";
export const partsCapabilityFixture: PartsCapability = {
  contract_version: PARTS_HTTP_CONTRACT, engine_version: REQUIRED_PARTS_ENGINE, available: true,
  catalog_sha256: null, operations: ["advance_foot"], recipes: [], automatic_image_extraction: false,
  requires_explicit_intent: true, requires_artifact_review: true,
};
export const partsSelectionFixture: PartsSelection = {
  contractVersion: PARTS_HTTP_CONTRACT, engineVersion: REQUIRED_PARTS_ENGINE, catalogSha256: null,
  edits: [{ personIndex: 0, intent: { source: "user_confirmed", reference: "user_edit_1", description: "왼발을 인물 앞쪽으로 5cm 더 내민다" },
    operation: { type: "advance_foot", side: "left", distance_m: .05 } }],
};
