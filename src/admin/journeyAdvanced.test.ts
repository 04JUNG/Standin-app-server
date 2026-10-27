import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAdvanced,
  type UsageEvent,
  type UsageJob,
} from "./journeyAdvanced.js";
import type { JourneyRow } from "./journey.js";
const w = {
  from: "2026-10-21T00:00:00.000Z",
  to: "2026-10-29T03:00:00.000Z",
  days: 8,
  idleMinutes: 30,
  audience: "all",
};
let seq = 0;
function e(
  name: string,
  at: string,
  p: Record<string, unknown> = {},
  extra: Partial<UsageEvent> = {},
): UsageEvent {
  return {
    event_id: `e${++seq}`,
    installation_id: "i1",
    installation_created_at: "2026-10-21T00:00:00.000Z",
    job_id: "j1",
    event_name: name,
    occurred_at: at,
    sequence_number: seq,
    source: "capture",
    properties: {
      telemetryVersion: 2,
      sessionId: "s1",
      surface: "app",
      osName: "macos",
      appVersion: "0.2.5",
      ...p,
    },
    ...extra,
  };
}
function row(extra: Partial<JourneyRow> = {}): JourneyRow {
  return {
    id: "j1",
    installation_id: "i1",
    audience: "unclassified",
    created_at: "2026-10-21T00:00:00.000Z",
    completed_at: "2026-10-21T00:00:20.000Z",
    status: "completed",
    confirmed_at: null,
    events: [],
    last_outcome: null,
    last_outcome_at: null,
    ...extra,
  };
}
function job(extra: Partial<UsageJob> = {}): UsageJob {
  return {
    id: "j1",
    installation_id: "i1",
    created_at: w.from,
    completed_at: "2026-10-21T00:00:20.000Z",
    status: "completed",
    source: "capture",
    ...extra,
  };
}
const run = (
  events: UsageEvent[],
  jobs: UsageJob[] = [job()],
  rows: JourneyRow[] = [row()],
) => buildAdvanced(events, jobs, rows, w, w.from);
test("feature totals deduplicate across surfaces and only intersect actual exposure", () => {
  const events = [
    e("feature_action", "2026-10-21T00:01:00Z", {
      feature: "hand_library",
      action: "exposure",
    }),
    e("feature_action", "2026-10-21T00:01:01Z", {
      feature: "hand_library",
      action: "exposure",
      surface: "bar",
    }),
    e("feature_action", "2026-10-21T00:01:02Z", {
      feature: "hand_library",
      action: "applied",
    }),
    e(
      "feature_action",
      "2026-10-21T00:01:03Z",
      { feature: "hand_library", action: "open" },
      { installation_id: "i2" },
    ),
    e("export_completed", "2026-10-21T00:02:00Z", { nativeDiskWrite: true }),
  ];
  const r = run(events),
    hand = r.featureSummary.find((f) => f.feature === "hand_library")!;
  assert.equal(hand.exposedInstallations, 1);
  assert.equal(hand.usedInstallations, 2);
  assert.equal(hand.usedAmongExposedInstallations, 1);
  assert.equal(hand.savedAfterApplyInstallations, 1);
  assert.equal(
    hand.surfaces.find((s) => s.surface === "bar")?.exposedInstallations,
    1,
  );
  assert.equal(
    r.featureSummary.find((f) => f.feature === "body_custom")
      ?.usedInstallations,
    0,
  );
});
test("failure origin is explicit and server-only failure is not lost without client events", () => {
  const r = run(
    [
      e("analysis_failed", "2026-10-21T00:01:00Z", {
        code: "TIMEOUT",
        errorCategory: "server",
        httpStatus: 504,
        source: "unknown",
      }),
    ],
    [job({ status: "failed", error_code: "ABANDONED" })],
    [row({ status: "failed" })],
  );
  assert.equal(r.failures.length, 2);
  assert.equal(
    r.failures.find((f) => f.origin === "server_job")?.code,
    "ABANDONED",
  );
  assert.equal(
    r.failures.find((f) => f.origin === "client_report")?.source,
    "capture",
  );
  assert.equal(
    r.failures.find((f) => f.origin === "server_job")?.category,
    "unknown",
  );
});
test("same attempt recovery differs from later retry success; semantic pre-job endpoints correlate", () => {
  const r = run([
    e("export_failed", "2026-10-21T00:01:00Z", {
      attemptId: "a",
      code: "IO_ERROR",
    }),
    e("export_requested", "2026-10-21T00:02:00Z", { attemptId: "b" }),
    e("export_completed", "2026-10-21T00:02:05Z", {
      attemptId: "b",
      nativeDiskWrite: true,
    }),
    e(
      "feature_action",
      "2026-10-21T00:03:00Z",
      { feature: "semantic_search", action: "search_started", attemptId: "q" },
      { job_id: null },
    ),
    e(
      "feature_action",
      "2026-10-21T00:03:08Z",
      {
        feature: "semantic_search",
        action: "search_completed",
        attemptId: "q",
      },
      { job_id: "semantic-job" },
    ),
  ]);
  const recovery = r.recovery.find((s) => s.phase === "export")!;
  assert.equal(recovery.failedAttempts, 1);
  assert.equal(recovery.recoveredAttempts, 0);
  assert.equal(recovery.retriedJobs, 1);
  assert.equal(recovery.laterSuccessJobs, 1);
  assert.equal(
    r.attemptDurations.find((d) => d.key === "semanticSearch")?.medianMs,
    8000,
  );
});
test("activation separates first save, next distinct job, distinct-job save and same-job re-save", () => {
  const r = run(
    [
      e("app_started", "2026-10-21T00:00:01Z", {}, { job_id: null }),
      e("export_completed", "2026-10-21T00:01:00Z", {
        attemptId: "a",
        nativeDiskWrite: true,
      }),
      e("export_completed", "2026-10-21T00:02:00Z", {
        attemptId: "b",
        nativeDiskWrite: true,
      }),
      e(
        "export_completed",
        "2026-10-22T00:04:00Z",
        { attemptId: "c", nativeDiskWrite: true },
        { job_id: "j2" },
      ),
      e(
        "app_started",
        "2026-10-21T00:00:02Z",
        {},
        {
          installation_id: "old",
          installation_created_at: "2026-09-01T00:00:00Z",
          job_id: null,
        },
      ),
    ],
    [job(), job({ id: "j2", created_at: "2026-10-22T00:03:00Z" })],
  );
  assert.equal(r.activation.eligibleInstallations, 1);
  assert.equal(r.activation.firstSaveInstallations, 1);
  assert.equal(r.activation.nextJobInstallations, 1);
  assert.equal(r.activation.repeatSaveInstallations, 1);
  assert.equal(r.activation.sameJobResaveInstallations, 1);
});
test("D1/D7 denominator requires whole KST target day; app return needs no analysis job", () => {
  const r = run([
    e("app_started", "2026-10-21T00:00:01Z", {}, { job_id: null }),
    e("app_started", "2026-10-22T00:00:01Z", {}, { job_id: null }),
    e("app_started", "2026-10-28T00:00:01Z", {}, { job_id: null }),
    e(
      "app_started",
      "2026-10-28T01:00:01Z",
      {},
      {
        installation_id: "fresh",
        installation_created_at: "2026-10-28T00:00:00Z",
        job_id: null,
      },
    ),
  ]);
  assert.equal(r.retention[0].eligibleInstallations, 1);
  assert.equal(r.retention[0].returnedInstallations, 1);
  assert.equal(r.retention[0].analyzedInstallations, 0);
  assert.equal(r.retention[1].eligibleInstallations, 1);
  assert.equal(r.retention[1].returnedInstallations, 1);
  assert.equal(r.retention[1].immatureInstallations, 1);
});
test("every adjacent stage has times or explicit missing samples, reversed readiness stays missing", () => {
  const r = run([
    e("results_viewed", "2026-10-21T00:00:22Z"),
    e("candidate_selected", "2026-10-21T00:00:27Z"),
    e("selection_confirmed", "2026-10-21T00:00:30Z"),
    e("preparation_ready", "2026-10-21T00:00:31Z"),
    e("review_viewed", "2026-10-21T00:00:33Z"),
  ]);
  assert.equal(r.stageDurations.length, 8);
  assert.equal(
    r.stageDurations.find(
      (d) => d.key === "results_viewed_to_candidate_selected",
    )?.medianMs,
    5000,
  );
  const reverse = r.stageDurations.find(
    (d) => d.key === "review_viewed_to_preparation_ready",
  )!;
  assert.equal(reverse.samples, 0);
  assert.equal(reverse.missingSamples, 1);
  assert.equal(reverse.medianMs, null);
  assert.equal(
    r.durationSegments.find((d) => d.key === reverse.key && d.surface === "app")
      ?.missingSamples,
    1,
  );
});
test("explicit back remains action count and does not assert a final abandonment", () => {
  const r = run([
    e("journey_exit", "2026-10-21T00:00:50Z", {
      phase: "review",
      reason: "back",
    }),
    e("export_completed", "2026-10-21T00:01:00Z", { nativeDiskWrite: true }),
  ]);
  assert.equal(r.exits[0].events, 1);
  assert.equal(r.activation.firstSaveInstallations, 1);
});

test("semantic zero-result and repeated search are observed independently from failures", () => {
  const r = run([
    e(
      "feature_action",
      "2026-10-21T00:01:00Z",
      {
        feature: "semantic_search",
        action: "search_started",
        attemptId: "q1",
        searchOrdinal: 2,
      },
      { job_id: null },
    ),
    e(
      "feature_action",
      "2026-10-21T00:01:05Z",
      {
        feature: "semantic_search",
        action: "search_completed",
        attemptId: "q1",
        resultCount: 0,
      },
      { job_id: "search-result" },
    ),
    e("results_viewed", "2026-10-21T00:02:00Z", { candidateCount: 0 }),
    e("candidate_selected", "2026-10-21T00:02:03Z", { candidateChanged: true }),
  ]);
  assert.equal(r.searchOutcomes.started, 1);
  assert.equal(r.searchOutcomes.zeroResult, 1);
  assert.equal(r.searchOutcomes.repeated, 1);
  assert.equal(r.searchOutcomes.failed, 0);
  assert.equal(r.results.zeroCandidateJobs, 1);
  assert.equal(r.results.candidateChangeEvents, 1);
});

test("recovery segments by failure screen and includes unlinked pre-job analysis failure", () => {
  const r = run([
    e("export_failed", "2026-10-21T00:01:00Z", {
      attemptId: "a",
      surface: "bar",
    }),
    e("export_requested", "2026-10-21T00:02:00Z", {
      attemptId: "b",
      surface: "app",
    }),
    e("export_completed", "2026-10-21T00:02:05Z", {
      attemptId: "b",
      surface: "app",
      nativeDiskWrite: true,
    }),
    e(
      "analysis_failed",
      "2026-10-21T00:00:01Z",
      { surface: "app" },
      { job_id: null },
    ),
  ]);
  const recovery = r.recovery.find(
    (s) => s.phase === "export" && s.surface === "bar",
  )!;
  assert.equal(recovery.feature, "export");
  assert.equal(recovery.laterSuccessJobs, 1);
  assert.equal(
    r.recovery.find((s) => s.phase === "analysis")?.unmatchedFailures,
    1,
  );
});
test("native write duration deduplicates identical attempts and excludes unlinked observations", () => {
  const r = run([
    e("export_completed", "2026-10-21T00:01:00Z", {
      attemptId: "a",
      nativeDiskWrite: true,
      writingElapsedMs: 200,
    }),
    e("export_completed", "2026-10-21T00:01:01Z", {
      attemptId: "a",
      nativeDiskWrite: true,
      writingElapsedMs: 300,
    }),
    e("export_completed", "2026-10-21T00:01:02Z", {
      nativeDiskWrite: true,
      writingElapsedMs: 500,
    }),
  ]);
  const d = r.attemptDurations.find((d) => d.key === "nativeWriting")!;
  assert.equal(d.samples, 1);
  assert.equal(d.medianMs, 200);
  assert.equal(d.missingSamples, 1);
});
test("some zero-candidate people are distinct from a zero-result job; old events remain unknown", () => {
  const r = run([
    e("results_viewed", "2026-10-21T00:01:00Z", {
      candidateCount: 10,
      peopleCount: 3,
      zeroCandidatePeople: 1,
      peopleWithCandidates: 2,
    }),
  ]);
  assert.equal(r.results.zeroCandidateJobs, 0);
  assert.equal(r.results.partialZeroCandidateJobs, 1);
  assert.equal(r.results.zeroCandidatePeople, 1);
  assert.equal(r.results.observedPeople, 3);
  const old = run([
    e("results_viewed", "2026-10-21T00:01:00Z", {
      candidateCount: 10,
      peopleCount: 3,
    }),
  ]);
  assert.equal(old.results.personCandidateCountMissingJobs, 1);
  assert.equal(old.results.partialZeroCandidateJobs, 0);
});
