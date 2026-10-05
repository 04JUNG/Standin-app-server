import assert from "node:assert/strict";
import test from "node:test";
import { GAP_THRESHOLDS, toLibraryWeeks, toVlmPrompts } from "./library.js";

test("gap thresholds match Standin-server config/pose_gaps.json", () => {
  // tau_soft · tau_strong · extraction_cap. 한쪽만 바꾸면 BFF 지표와 공백 분석이 어긋난다.
  assert.deepEqual(GAP_THRESHOLDS, { weak: 0.25, strong: 0.35, extractionCap: 0.6 });
});

test("weekly rows become rates over eligible people, not over everyone", () => {
  const [week] = toLibraryWeeks([
    {
      week: "2026-09-28",
      pose_library_version: "lib-20261002-91b57d0f",
      coverage_class: "full",
      people: 40,
      eligible: 20,
      weak_gap: 3,
      strong_gap: 2,
      extraction_suspect: 4,
      selected: 10,
      irrelevant: 1,
      top1_median: 0.21349,
    },
  ]);
  assert.deepEqual(week, {
    week: "2026-09-28",
    libraryVersion: "lib-20261002-91b57d0f",
    coverageClass: "full",
    people: 40,
    eligible: 20,
    weakGap: 3,
    strongGap: 2,
    extractionSuspect: 4,
    gapRate: 25,
    strongGapRate: 10,
    top1Median: 0.213,
    selectionRate: 50,
    irrelevantRate: 5,
  });
});

test("a week with nobody eligible reports unknown rates, not zero", () => {
  const [week] = toLibraryWeeks([
    {
      week: "2026-09-28", pose_library_version: "v1", coverage_class: "sparse",
      people: 3, eligible: 0, weak_gap: 0, strong_gap: 0, extraction_suspect: 0,
      selected: 0, irrelevant: 0, top1_median: null,
    },
  ]);
  assert.equal(week.gapRate, null);
  assert.equal(week.top1Median, null);
});

test("prompt rows keep route counts and rate the person tags", () => {
  const [prompt] = toVlmPrompts([
    {
      prompt_version: "p2-person-tags", jobs: 10, core: 8, bust: 1, skip: 1, unrecorded_route: 0,
      count_high: 9, count_known: 10, people: 16, tagged: 12, vlm_person: 12, legacy_cut: 0,
    },
  ]);
  assert.deepEqual(prompt, {
    promptVersion: "p2-person-tags",
    jobs: 10,
    routes: { core: 8, bust: 1, skip: 1, unrecorded: 0 },
    countConfidenceHighRate: 90,
    people: 16,
    personTagFillRate: 75,
    personTagSources: { vlmPerson: 12, legacyCut: 0 },
  });
});
