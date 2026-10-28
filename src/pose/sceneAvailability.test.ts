import assert from "node:assert/strict";
import test from "node:test";
import type { Job } from "../jobs/store.js";
import { sceneAvailability } from "./sceneAvailability.js";
import { analysisFailureDetails } from "../jobs/failure.js";
import { toHistoryItem, type JobHistoryRow } from "../jobs/history.js";
const job = { status: "completed", inputS3Key: "private-key", result: { image: { width: 100, height: 200 },
  candidatesByPerson: [{ personIndex: 0, box: [0,0,50,100], candidates: [{ id: "library" }, { id: "new", source: "generation" }] }] } } as Job;
const enabled = { scene: () => true, fbx: () => true, converter: () => true, storage: () => true, refinement: () => false, worker: () => false };
test("basic readiness ignores unselected generation and is independent of v4 worker/flag", () => {
  const capability = sceneAvailability(job, enabled);
  assert.deepEqual(capability.originalSelection, { available: true, reasons: [] });
  assert.deepEqual(capability.autoCorrectV4.reasons, ["refinement_disabled", "refinement_unavailable"]);
  assert.equal(capability.candidateEligibility[0]!.candidates[0]!.available, true);
  assert.deepEqual(capability.candidateEligibility[0]!.candidates[1]!.reasons, ["generated_individual_only"]);
});
test("capability unavailable reasons distinguish configuration, observation, input and storage", () => {
  const result = sceneAvailability({ ...job, inputS3Key: null, result: { ...job.result!, source: "semantic", image: null } },
    { ...enabled, scene: () => false, converter: () => false, storage: () => false });
  assert.deepEqual(result.originalSelection.reasons, ["feature_disabled", "converter_unavailable", "observation_missing", "semantic_input"]);
  assert.ok(result.autoCorrectV4.reasons.includes("source_image_unavailable"));
  assert.ok(sceneAvailability(job, { ...enabled, fbx: () => false }).originalSelection.reasons.includes("fbx_export_disabled"));
  assert.ok(result.manifest.reasons.includes("receipt_storage_unavailable"));
});
test("history and polling use the same analysis timeout failure and explicit recovery", () => {
  for (const code of ["ANALYSIS_TIMEOUT", "ANALYSIS_UPSTREAM_TIMEOUT"]) {
    const row = { error_code: code } as JobHistoryRow;
    assert.deepEqual(toHistoryItem(row).failure, analysisFailureDetails(code));
    assert.equal(toHistoryItem(row).failure?.phase, "analysis");
    assert.equal(toHistoryItem(row).failure?.recovery, "explicit_retry");
  }
  assert.equal(analysisFailureDetails(null), null);
});
