import { FEATURE_ACTIONS, FEATURE_NAMES } from "../analytics/store.js";
import {
  buildJourney,
  JOURNEY_STAGES,
  type JourneyRow,
  type JourneyWindow,
} from "./journey.js";
export interface UsageEvent {
  event_id: string;
  installation_id: string;
  installation_created_at: string;
  job_id: string | null;
  event_name: string;
  occurred_at: string;
  sequence_number: number;
  source: string | null;
  properties: Record<string, unknown>;
}
export interface UsageJob {
  id: string;
  installation_id: string;
  created_at: string;
  completed_at: string | null;
  status: string;
  source: string | null;
  error_code?: string | null;
}
export const USAGE_ACTIONS = [
  "open",
  "search_started",
  "selected",
  "applied",
  "adjusted",
  "reset",
  "creation_started",
  "saved",
  "reused",
  "upload_started",
];
const validFeature = (v: unknown) =>
  FEATURE_NAMES.includes(v as (typeof FEATURE_NAMES)[number])
    ? String(v)
    : "unknown";
const safeCode = (v: unknown) =>
  typeof v === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(v) ? v : "unknown";
const safeVersion = (v: unknown) =>
  typeof v === "string" && /^[a-zA-Z0-9._+-]{1,64}$/.test(v) ? v : "unknown";
const member = (v: unknown, choices: string[]) =>
  choices.includes(String(v)) ? String(v) : "unknown";
const stamp = (e: UsageEvent) => Date.parse(e.occurred_at);
const isSave = (e: UsageEvent) =>
  e.job_id !== null &&
  e.event_name === "export_completed" &&
  e.properties.nativeDiskWrite === true;
const failure = (e: UsageEvent) =>
  e.event_name.endsWith("_failed") ||
  (e.event_name === "feature_action" &&
    ["failed", "search_failed", "upload_failed", "preview_failed"].includes(
      String(e.properties.action),
    ));
const isId = (v: unknown): v is string =>
  typeof v === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(v);
const dimensions = (e: UsageEvent) => ({
  surface: member(e.properties.surface, ["app", "bar"]),
  osName: member(e.properties.osName, ["macos", "windows", "linux"]),
  source: member(e.source ?? e.properties.source, [
    "capture",
    "file",
    "semantic",
    "clipboard",
    "history",
  ]),
  appVersion: safeVersion(e.properties.appVersion),
});
export function stats(values: number[]) {
  const sorted = values
    .filter((v) => Number.isFinite(v) && v >= 0)
    .sort((a, b) => a - b);
  const p = (q: number) => {
    if (!sorted.length) return null;
    const x = (sorted.length - 1) * q,
      l = Math.floor(x),
      u = Math.ceil(x);
    return sorted[l] + (sorted[u] - sorted[l]) * (x - l);
  };
  return { samples: sorted.length, medianMs: p(0.5), p90Ms: p(0.9) };
}
const uniqueInst = (events: UsageEvent[]) =>
  new Set(events.map((e) => e.installation_id)).size;
const count = (events: UsageEvent[]) => ({
  events: events.length,
  installations: uniqueInst(events),
  jobs: new Set(events.flatMap((e) => (e.job_id ? [e.job_id] : []))).size,
});
function grouped<T extends object>(
  events: UsageEvent[],
  key: (e: UsageEvent) => T,
) {
  const groups = new Map<string, { key: T; events: UsageEvent[] }>();
  for (const e of events) {
    const k = key(e),
      hash = JSON.stringify(k);
    const g = groups.get(hash) ?? { key: k, events: [] };
    g.events.push(e);
    groups.set(hash, g);
  }
  return [...groups.values()].map((g) => ({ ...g.key, ...count(g.events) }));
}
const day = (s: string) => Math.floor((Date.parse(s) + 9 * 3600000) / 86400000);
function valid(events: UsageEvent[], to: number) {
  return events.filter(
    (e) =>
      e.properties.telemetryVersion === 2 &&
      isId(e.properties.sessionId) &&
      Number.isFinite(stamp(e)) &&
      stamp(e) <= to,
  );
}
export function buildAdvanced(
  allEvents: UsageEvent[],
  historyJobs: UsageJob[],
  rows: JourneyRow[],
  w: JourneyWindow,
  historyFrom: string,
) {
  const from = Date.parse(w.from),
    to = Date.parse(w.to);
  const history = valid(allEvents, to).sort(
    (a, b) =>
      stamp(a) - stamp(b) ||
      a.sequence_number - b.sequence_number ||
      a.event_id.localeCompare(b.event_id),
  );
  const events = history.filter((e) => stamp(e) >= from),
    features = events.filter(
      (e) =>
        e.event_name === "feature_action" &&
        validFeature(e.properties.feature) !== "unknown" &&
        FEATURE_ACTIONS.includes(
          e.properties.action as (typeof FEATURE_ACTIONS)[number],
        ),
    );
  const saves = history.filter(isSave),
    jobIds = new Set(rows.map((r) => r.id));
  const cohortEvents = events.filter((e) => e.job_id && jobIds.has(e.job_id));
  const index = <T>(values: T[], key: (v: T) => string) => {
    const map = new Map<string, T[]>();
    for (const v of values) {
      const k = key(v),
        group = map.get(k) ?? [];
      group.push(v);
      map.set(k, group);
    }
    return map;
  };
  const byJob = index(cohortEvents, (e) => e.job_id!);
  const byInst = index(history, (e) => e.installation_id);
  const jobsByInst = index(historyJobs, (j) => j.installation_id);
  const savesByInst = index(saves, (e) => e.installation_id);
  const savesByJob = index(saves, (e) =>
    JSON.stringify([e.installation_id, e.job_id]),
  );
  const featureUsage = grouped(features, (e) => ({
    feature: validFeature(e.properties.feature),
    action: String(e.properties.action),
  }));
  const featureSegments = grouped(features, (e) => ({
    feature: validFeature(e.properties.feature),
    action: String(e.properties.action),
    ...dimensions(e),
  }));
  const summary = (es: UsageEvent[]) => {
    const exposed = new Set(
      es
        .filter((e) => e.properties.action === "exposure")
        .map((e) => e.installation_id),
    );
    const used = new Set(
      es
        .filter((e) => USAGE_ACTIONS.includes(String(e.properties.action)))
        .map((e) => e.installation_id),
    );
    const applied = es.filter((e) =>
      ["applied", "saved", "reused"].includes(String(e.properties.action)),
    );
    const savedAfter = applied.filter(
      (e) =>
        e.job_id &&
        (
          savesByJob.get(JSON.stringify([e.installation_id, e.job_id])) ?? []
        ).some((s) => stamp(s) >= stamp(e)),
    );
    return {
      events: es.length,
      exposedInstallations: exposed.size,
      usedInstallations: used.size,
      usedAmongExposedInstallations: [...used].filter((id) => exposed.has(id))
        .length,
      appliedInstallations: uniqueInst(applied),
      savedAfterApplyInstallations: uniqueInst(savedAfter),
    };
  };
  const featureSummary = FEATURE_NAMES.map((feature) => {
    const es = features.filter((e) => e.properties.feature === feature);
    const flag = (
      {
        hand_library: "usedHandLibrary",
        body_selection: "usedBodySelection",
        body_custom: "usedBodyCustom",
        history: "fromHistory",
        semantic_search: "fromSemanticSearch",
      } as Record<string, string>
    )[feature];
    const attributed = events.filter(
      (e) => isSave(e) && flag && e.properties[flag] === true,
    );
    return {
      feature,
      ...summary(es),
      savedWithFeatureInstallations: uniqueInst(attributed),
      savedWithFeatureJobs: new Set(attributed.map((e) => e.job_id)).size,
      surfaces: ["app", "bar", "unknown"].map((surface) => ({
        surface,
        ...summary(es.filter((e) => dimensions(e).surface === surface)),
      })),
    };
  });
  const failures = grouped(events.filter(failure), (e) => ({
    origin: "client_report",
    scope: "event_time",
    httpStatus:
      typeof e.properties.httpStatus === "number" &&
      e.properties.httpStatus >= 400 &&
      e.properties.httpStatus <= 599
        ? e.properties.httpStatus
        : null,
    category: member(e.properties.errorCategory, [
      "server",
      "network",
      "permission",
      "validation",
      "client",
    ]),
    code: safeCode(e.properties.code ?? e.properties.reason),
    feature: validFeature(e.properties.feature),
    phase: safeCode(e.properties.phase ?? e.event_name),
    ...dimensions(e),
  }));
  const serverFailures = historyJobs
    .filter((j) => jobIds.has(j.id) && j.status === "failed")
    .map(
      (j) =>
        ({
          event_id: `server:${j.id}`,
          installation_id: j.installation_id,
          installation_created_at: j.created_at,
          job_id: j.id,
          event_name: "analysis_failed",
          occurred_at: j.completed_at ?? j.created_at,
          sequence_number: 0,
          source: j.source,
          properties: { code: j.error_code },
        }) satisfies UsageEvent,
    );
  failures.push(
    ...grouped(serverFailures, (e) => ({
      origin: "server_job",
      scope: "job_cohort",
      httpStatus: null,
      category: "unknown",
      code: safeCode(e.properties.code),
      feature: "analysis",
      phase: "analysis",
      ...dimensions(e),
    })),
  );
  const exits = grouped(
    events.filter((e) => e.event_name === "journey_exit"),
    (e) => ({
      phase: safeCode(e.properties.phase),
      reason: member(e.properties.reason, ["back", "home", "close", "cancel"]),
      feature: validFeature(e.properties.feature),
      ...dimensions(e),
    }),
  );
  // Explicit same-attempt success is recovery; a later unrelated success is not.
  const recoveryByJob = index(
    events.filter((e) => e.job_id !== null),
    (e) => e.job_id!,
  );
  const recovery = [
    "analysis",
    "preparation",
    "export",
    "selection",
    "feature",
  ].flatMap((phase) => {
    const phaseFailed = events.filter(
      (e) =>
        failure(e) &&
        (phase === "feature"
          ? e.event_name === "feature_action"
          : e.event_name.startsWith(phase + "_")),
    );
    const groups = new Map<
      string,
      { feature: string; surface: string; failed: UsageEvent[] }
    >();
    for (const e of phaseFailed) {
      const known = validFeature(e.properties.feature),
        feature =
          known !== "unknown"
            ? known
            : phase === "analysis"
              ? "analysis"
              : phase === "selection"
                ? "pose_selection"
                : phase === "feature"
                  ? "unknown"
                  : "export",
        surface = dimensions(e).surface,
        key = JSON.stringify([feature, surface]);
      const group = groups.get(key) ?? { feature, surface, failed: [] };
      group.failed.push(e);
      groups.set(key, group);
    }
    return [...groups.values()].map(({ feature, surface, failed }) => {
      const byAttempt = new Map<string, UsageEvent>();
      let unmatchedFailures = 0;
      for (const e of failed) {
        if (
          !isId(e.properties.attemptId) ||
          (phase !== "feature" && !e.job_id)
        ) {
          unmatchedFailures++;
          continue;
        }
        const k = JSON.stringify([
          e.installation_id,
          phase === "feature" ? null : e.job_id,
          e.properties.sessionId,
          e.properties.attemptId,
          phase === "feature" ? e.properties.feature : null,
        ]);
        if (!byAttempt.has(k)) byAttempt.set(k, e);
      }
      const success = (e: UsageEvent) =>
        phase === "export"
          ? isSave(e)
          : phase === "preparation"
            ? e.event_name === "preparation_ready"
            : phase === "selection"
              ? e.event_name === "selection_confirmed"
              : phase === "analysis"
                ? e.event_name === "results_viewed"
                : e.event_name === "feature_action" &&
                  [
                    "search_completed",
                    "upload_completed",
                    "preview_completed",
                    "applied",
                    "saved",
                    "reused",
                  ].includes(String(e.properties.action));
      let recoveredAttempts = 0;
      for (const e of byAttempt.values())
        if (
          (phase === "feature"
            ? (byInst.get(e.installation_id) ?? [])
            : (recoveryByJob.get(e.job_id!) ?? [])
          ).some(
            (s) =>
              s.installation_id === e.installation_id &&
              (phase === "feature" || s.job_id === e.job_id) &&
              s.properties.sessionId === e.properties.sessionId &&
              s.properties.attemptId === e.properties.attemptId &&
              (phase !== "feature" ||
                s.properties.feature === e.properties.feature) &&
              stamp(s) >= stamp(e) &&
              success(s),
          )
        )
          recoveredAttempts++;
      const failedJobs = new Set(
          failed.flatMap((e) => (e.job_id ? [e.job_id] : [])),
        ),
        retriedJobs = new Set<string>(),
        laterSuccessJobs = new Set<string>();
      for (const e of failed) {
        if (!e.job_id) continue;
        const later = (recoveryByJob.get(e.job_id) ?? []).filter(
          (s) =>
            s.installation_id === e.installation_id &&
            stamp(s) > stamp(e) &&
            (phase !== "feature" ||
              s.properties.feature === e.properties.feature),
        );
        if (
          later.some(
            (s) =>
              isId(s.properties.attemptId) &&
              s.properties.attemptId !== e.properties.attemptId &&
              (phase === "feature"
                ? [
                    "search_started",
                    "upload_started",
                    "creation_started",
                  ].includes(String(s.properties.action))
                : s.event_name ===
                  (
                    {
                      analysis: "input_confirmed",
                      preparation: "preparation_started",
                      export: "export_requested",
                      selection: "candidate_selected",
                    } as Record<string, string>
                  )[phase]),
          )
        )
          retriedJobs.add(e.job_id);
        if (later.some(success)) laterSuccessJobs.add(e.job_id);
      }
      return {
        phase,
        feature,
        surface,
        failedAttempts: byAttempt.size,
        recoveredAttempts,
        unmatchedFailures,
        failedJobs: failedJobs.size,
        retriedJobs: retriedJobs.size,
        laterSuccessJobs: laterSuccessJobs.size,
      };
    });
  });
  const newInst = new Map<string, UsageEvent>();
  for (const e of history)
    if (
      Date.parse(e.installation_created_at) >= from &&
      Date.parse(e.installation_created_at) <= to &&
      !newInst.has(e.installation_id)
    )
      newInst.set(e.installation_id, e);
  const firstSaves = new Map<string, UsageEvent>();
  for (const e of saves)
    if (newInst.has(e.installation_id) && !firstSaves.has(e.installation_id))
      firstSaves.set(e.installation_id, e);
  const activation = {
    eligibleInstallations: newInst.size,
    firstSaveInstallations: firstSaves.size,
    nextJobInstallations: [...firstSaves.values()].filter((e) =>
      (jobsByInst.get(e.installation_id) ?? []).some(
        (j) =>
          j.installation_id === e.installation_id &&
          j.id !== e.job_id &&
          Date.parse(j.created_at) > stamp(e) &&
          Date.parse(j.created_at) <= to,
      ),
    ).length,
    repeatSaveInstallations: [...firstSaves.values()].filter((e) =>
      (savesByInst.get(e.installation_id) ?? []).some(
        (s) =>
          s.installation_id === e.installation_id &&
          s.job_id !== e.job_id &&
          stamp(s) > stamp(e),
      ),
    ).length,
    sameJobResaveInstallations: [...firstSaves.values()].filter((e) =>
      (savesByInst.get(e.installation_id) ?? []).some(
        (s) =>
          s.installation_id === e.installation_id &&
          s.job_id === e.job_id &&
          stamp(s) > stamp(e) &&
          isId(s.properties.attemptId) &&
          s.properties.attemptId !== e.properties.attemptId,
      ),
    ).length,
    historyFrom,
    cohortBasis: "new_installations_with_consented_v2_activity",
  };
  const retention = [1, 7].map((offset) => {
    const eligible = [...newInst.values()].filter(
      (e) => day(e.occurred_at) + offset < day(w.to),
    );
    const target = (e: UsageEvent, time: string) =>
      day(time) === day(e.occurred_at) + offset;
    return {
      day: offset,
      eligibleInstallations: eligible.length,
      returnedInstallations: eligible.filter((e) =>
        (byInst.get(e.installation_id) ?? []).some(
          (a) =>
            a.installation_id === e.installation_id && target(e, a.occurred_at),
        ),
      ).length,
      analyzedInstallations: eligible.filter((e) =>
        (jobsByInst.get(e.installation_id) ?? []).some(
          (j) =>
            j.installation_id === e.installation_id && target(e, j.created_at),
        ),
      ).length,
      savedInstallations: eligible.filter((e) =>
        (savesByInst.get(e.installation_id) ?? []).some(
          (s) =>
            s.installation_id === e.installation_id && target(e, s.occurred_at),
        ),
      ).length,
      immatureInstallations: newInst.size - eligible.length,
      cohortBasis: "first_consented_v2_activity_kst",
    };
  });
  const consentedJobIds = new Set(historyJobs.map((j) => j.id));
  const durationSegments: Array<{
    key: string;
    label: string;
    surface: string;
    feature: string;
    samples: number;
    missingSamples: number;
    medianMs: number | null;
    p90Ms: number | null;
  }> = [];
  const stageDurations = JOURNEY_STAGES.slice(0, -1).map(
    ([start, label], i) => {
      const [end, endLabel] = JOURNEY_STAGES[i + 1];
      const samples: Array<{ value: number; event: UsageEvent | undefined }> =
        [];
      const expected = new Map<string, number>();
      let reached = 0;
      for (const row of rows.filter((r) => consentedJobIds.has(r.id))) {
        const es = byJob.get(row.id) ?? [];
        const get = (key: string) =>
          key === "requested"
            ? [Date.parse(row.created_at)]
            : key === "completed"
              ? row.status === "completed" && row.completed_at
                ? [Date.parse(row.completed_at)]
                : []
              : key === "selection_confirmed"
                ? [
                    ...(row.confirmed_at ? [Date.parse(row.confirmed_at)] : []),
                    ...es.filter((e) => e.event_name === key).map(stamp),
                  ]
                : es
                    .filter(
                      (e) =>
                        e.event_name === key &&
                        (key !== "export_completed" || isSave(e)),
                    )
                    .map(stamp);
        const starts = get(start)
            .filter(Number.isFinite)
            .sort((a, b) => a - b),
          ends = get(end)
            .filter(Number.isFinite)
            .sort((a, b) => a - b);
        if (!starts.length) continue;
        reached++;
        const context =
          es.find((e) => e.event_name === start && stamp(e) === starts[0]) ??
          (["requested", "completed"].includes(start)
            ? (es.find((e) => e.event_name === "input_confirmed") ??
              es.find(
                (e) =>
                  e.event_name === "feature_action" &&
                  e.properties.feature === "analysis" &&
                  e.properties.action === "upload_completed",
              ))
            : undefined);
        const surface = context ? dimensions(context).surface : "unknown";
        expected.set(surface, (expected.get(surface) ?? 0) + 1);
        const ending = ends.find((t) => t >= starts[0]);
        if (ending === undefined) continue;
        samples.push({ value: ending - starts[0], event: context });
      }
      for (const surface of ["app", "bar", "unknown"]) {
        const ss = samples.filter((s) =>
          s.event
            ? dimensions(s.event).surface === surface
            : surface === "unknown",
        );
        durationSegments.push({
          key: `${start}_to_${end}`,
          label: `${label} → ${endLabel}`,
          surface,
          feature: "unknown",
          ...stats(ss.map((s) => s.value)),
          missingSamples: (expected.get(surface) ?? 0) - ss.length,
        });
      }
      return {
        scope: "consented_job_cohort",
        key: `${start}_to_${end}`,
        label: `${label} → ${endLabel}`,
        from: start,
        to: end,
        ...stats(samples.map((s) => s.value)),
        missingSamples: reached - samples.length,
        surfaces: ["app", "bar", "unknown"].map((surface) => {
          const v = samples.filter((s) =>
            s.event
              ? dimensions(s.event).surface === surface
              : surface === "unknown",
          );
          return { surface, ...stats(v.map((s) => s.value)) };
        }),
      };
    },
  );
  const attemptDurations: Array<{
    key: string;
    label: string;
    samples: number;
    missingSamples: number;
    medianMs: number | null;
    p90Ms: number | null;
  }> = [];
  const attemptDefs: Array<{
    key: string;
    label: string;
    feature: string;
    start: string;
    end: string;
    action: boolean;
    phase?: string;
  }> = [
    {
      key: "candidatePreview",
      label: "후보 이미지 로드 시작 → 표시",
      feature: "pose_selection",
      phase: "candidate_image",
      start: "preview_started",
      end: "preview_completed",
      action: true,
    },
    {
      key: "reviewImagePreview",
      label: "최종 이미지 로드 시작 → 표시",
      feature: "export",
      phase: "review_image",
      start: "preview_started",
      end: "preview_completed",
      action: true,
    },
    {
      key: "reviewModelPreview",
      label: "최종 3D 로드 시작 → 표시",
      feature: "export",
      phase: "review_model",
      start: "preview_started",
      end: "preview_completed",
      action: true,
    },
    {
      key: "inputUpload",
      label: "업로드 요청 → 작업 접수",
      feature: "analysis",
      start: "upload_started",
      end: "upload_completed",
      action: true,
    },
    {
      key: "semanticSearch",
      label: "문장 검색 시작 → 완료",
      feature: "semantic_search",
      start: "search_started",
      end: "search_completed",
      action: true,
    },
    {
      key: "preparation",
      label: "파일 준비 시작 → 완료",
      feature: "export",
      start: "preparation_started",
      end: "preparation_ready",
      action: false,
    },
    {
      key: "nativeSave",
      label: "저장 요청 → 실제 저장",
      feature: "export",
      start: "export_requested",
      end: "export_completed",
      action: false,
    },
  ];
  for (const def of attemptDefs) {
    const starts = new Map<string, UsageEvent>(),
      ends = new Map<string, UsageEvent[]>();
    const key = (e: UsageEvent) =>
      JSON.stringify([
        e.installation_id,
        e.properties.sessionId,
        e.properties.attemptId,
        ["inputUpload", "semanticSearch"].includes(def.key) ? null : e.job_id,
      ]);
    for (const e of events) {
      if (!isId(e.properties.attemptId)) continue;
      if (
        def.action &&
        (e.event_name !== "feature_action" ||
          e.properties.feature !== def.feature)
      )
        continue;
      if (def.phase && e.properties.phase !== def.phase) continue;
      const action = def.action ? e.properties.action : e.event_name;
      if (action === def.start && !starts.has(key(e))) starts.set(key(e), e);
      if (action === def.end && (def.end !== "export_completed" || isSave(e))) {
        const arr = ends.get(key(e)) ?? [];
        arr.push(e);
        ends.set(key(e), arr);
      }
    }
    const paired = [...starts.entries()].map(([key, start]) => ({
      start,
      end: ends.get(key)?.find((e) => stamp(e) >= stamp(start)),
    }));
    const sample = paired.filter(
      (p): p is { start: UsageEvent; end: UsageEvent } => !!p.end,
    );
    attemptDurations.push({
      key: def.key,
      label: def.label,
      ...stats(sample.map((p) => stamp(p.end) - stamp(p.start))),
      missingSamples: paired.length - sample.length,
    });
    for (const surface of ["app", "bar", "unknown"]) {
      const scoped = paired.filter(
          (p) => dimensions(p.start).surface === surface,
        ),
        complete = scoped.filter((p) => p.end);
      durationSegments.push({
        key: def.key,
        label: def.label,
        surface,
        feature: def.feature,
        ...stats(complete.map((p) => stamp(p.end!) - stamp(p.start))),
        missingSamples: scoped.length - complete.length,
      });
    }
  }
  const searchEvents = features.filter(
    (e) => e.properties.feature === "semantic_search",
  );
  const searchStats = (es: UsageEvent[]) => {
    const actions = (a: string) => es.filter((e) => e.properties.action === a);
    const attempts = (values: UsageEvent[]) =>
      new Set(
        values.map((e) =>
          JSON.stringify([
            e.installation_id,
            e.properties.sessionId,
            isId(e.properties.attemptId) ? e.properties.attemptId : e.event_id,
          ]),
        ),
      ).size;
    return {
      started: attempts(actions("search_started")),
      completed: attempts(actions("search_completed")),
      zeroResult: attempts(
        actions("search_completed").filter(
          (e) => e.properties.resultCount === 0,
        ),
      ),
      failed: attempts(actions("search_failed")),
      cancelled: attempts(actions("cancelled")),
      repeated: attempts(
        actions("search_started").filter(
          (e) =>
            typeof e.properties.searchOrdinal === "number" &&
            e.properties.searchOrdinal > 1,
        ),
      ),
      installations: uniqueInst(es),
      resultCountMissing: attempts(
        actions("search_completed").filter(
          (e) => typeof e.properties.resultCount !== "number",
        ),
      ),
    };
  };
  const searchOutcomes = {
    ...searchStats(searchEvents),
    surfaces: ["app", "bar", "unknown"].map((surface) => ({
      surface,
      ...searchStats(
        searchEvents.filter((e) => dimensions(e).surface === surface),
      ),
    })),
  };
  const distinctJobs = (es: UsageEvent[]) =>
    new Set(es.flatMap((e) => (e.job_id ? [e.job_id] : []))).size;
  const latestResults = new Map<string, UsageEvent>();
  for (const e of cohortEvents.filter((e) => e.event_name === "results_viewed"))
    latestResults.set(e.job_id!, e);
  const resultEvents = [...latestResults.values()];
  const partialKnown = (e: UsageEvent) =>
    typeof e.properties.zeroCandidatePeople === "number" &&
    Number.isSafeInteger(e.properties.zeroCandidatePeople) &&
    e.properties.zeroCandidatePeople >= 0 &&
    typeof e.properties.peopleCount === "number" &&
    Number.isSafeInteger(e.properties.peopleCount) &&
    e.properties.peopleCount >= e.properties.zeroCandidatePeople;
  const results = {
    partialZeroCandidateJobs: distinctJobs(
      resultEvents.filter(
        (e) =>
          partialKnown(e) &&
          (e.properties.zeroCandidatePeople as number) > 0 &&
          (e.properties.zeroCandidatePeople as number) <
            (e.properties.peopleCount as number),
      ),
    ),
    personCandidateCountMissingJobs: distinctJobs(
      resultEvents.filter((e) => !partialKnown(e)),
    ),
    zeroCandidatePeople: resultEvents.reduce(
      (n, e) =>
        n +
        (partialKnown(e) ? (e.properties.zeroCandidatePeople as number) : 0),
      0,
    ),
    observedPeople: resultEvents.reduce(
      (n, e) =>
        n + (partialKnown(e) ? (e.properties.peopleCount as number) : 0),
      0,
    ),
    viewedJobs: distinctJobs(resultEvents),
    zeroCandidateJobs: distinctJobs(
      resultEvents.filter((e) => e.properties.candidateCount === 0),
    ),
    candidateCountMissingJobs: distinctJobs(
      resultEvents.filter(
        (e) => typeof e.properties.candidateCount !== "number",
      ),
    ),
    thumbnailFailedJobs: distinctJobs(
      cohortEvents.filter((e) => e.event_name === "thumbnail_failed"),
    ),
    candidateChangeEvents: cohortEvents.filter(
      (e) =>
        e.event_name === "candidate_selected" &&
        e.properties.candidateChanged === true,
    ).length,
  };
  const nativeAttempts = new Map<string, UsageEvent[]>();
  let unmatchedWritingEvents = 0;
  for (const e of events.filter(isSave)) {
    if (!isId(e.properties.attemptId)) {
      unmatchedWritingEvents++;
      continue;
    }
    const key = JSON.stringify([
        e.installation_id,
        e.job_id,
        e.properties.sessionId,
        e.properties.attemptId,
      ]),
      group = nativeAttempts.get(key) ?? [];
    group.push(e);
    nativeAttempts.set(key, group);
  }
  const writingAttempts = [...nativeAttempts.values()].map((group) => ({
    event: group[0],
    written: group.find(
      (e) =>
        typeof e.properties.writingElapsedMs === "number" &&
        Number.isFinite(e.properties.writingElapsedMs) &&
        e.properties.writingElapsedMs >= 0 &&
        e.properties.writingElapsedMs <= 86400000,
    ),
  }));
  const writingEvents = writingAttempts.flatMap((a) =>
    a.written ? [a.written] : [],
  );
  attemptDurations.push({
    key: "nativeWriting",
    label: "로컬 파일 저장 처리 시간",
    ...stats(writingEvents.map((e) => e.properties.writingElapsedMs as number)),
    missingSamples:
      writingAttempts.length - writingEvents.length + unmatchedWritingEvents,
  });
  for (const surface of ["app", "bar", "unknown"]) {
    const attempts = writingAttempts.filter(
        (a) => dimensions(a.event).surface === surface,
      ),
      writing = attempts.flatMap((a) => (a.written ? [a.written] : []));
    durationSegments.push({
      key: "nativeWriting",
      label: "로컬 파일 저장 처리 시간",
      surface,
      feature: "export",
      ...stats(writing.map((e) => e.properties.writingElapsedMs as number)),
      missingSamples:
        attempts.length -
        writing.length +
        events.filter(
          (e) =>
            isSave(e) &&
            !isId(e.properties.attemptId) &&
            dimensions(e).surface === surface,
        ).length,
    });
  }
  const stageGroups = new Map<
    string,
    {
      stage: string;
      label: string;
      feature: string;
      surface: string;
      source: string;
      osName: string;
      appVersion: string;
      outcome: string;
      jobs: number;
    }
  >();
  for (const row of rows) {
    const one = buildJourney([row], w),
      stage = [...one.stages].reverse().find((s) => s.jobs > 0)!;
    const es = byJob.get(row.id) ?? [],
      last = es.filter((e) => e.event_name === stage.key).at(-1) ?? es.at(-1);
    const outcome = Object.entries(one.outcomes).find(([, n]) => n > 0)![0];
    const group = {
      stage: stage.key,
      label: stage.label,
      feature:
        last && validFeature(last.properties.feature) !== "unknown"
          ? validFeature(last.properties.feature)
          : ["requested", "completed"].includes(stage.key)
            ? "analysis"
            : [
                  "results_viewed",
                  "candidate_selected",
                  "selection_confirmed",
                ].includes(stage.key)
              ? "pose_selection"
              : "export",
      ...(last
        ? dimensions(last)
        : {
            surface: "unknown",
            source: "unknown",
            osName: "unknown",
            appVersion: "unknown",
          }),
      outcome,
    };
    const key = JSON.stringify(group),
      existing = stageGroups.get(key);
    if (existing) existing.jobs++;
    else stageGroups.set(key, { ...group, jobs: 1 });
  }
  return {
    searchOutcomes,
    results,
    attemptDurations: attemptDurations.map((d) => ({
      ...d,
      scope: "consented_event_time",
    })),
    stageOutcomes: [...stageGroups.values()],
    durationSegments,
    scope: "consented_event_time_and_new_installation_cohort",
    featureUsage,
    featureSummary,
    featureSegments,
    failures,
    exits,
    recovery,
    activation,
    retention,
    stageDurations,
    coverage: {
      events: events.length,
      installations: uniqueInst(events),
      jobCohortEvents: cohortEvents.length,
      newInstallationsWithV2: newInst.size,
    },
    notes: [
      "기능 사용은 노출과 별도 관측이며 사용률 분모는 실제 노출 설치의 교집합입니다. 선택 기능 미사용은 이탈이 아닙니다.",
      "기능·클라이언트 실패·명시적 이동은 이벤트 시각 기준입니다. 서버 실패는 작업 생성 코호트이며 origin을 분리합니다. 두 출처를 더하면 같은 실패를 중복 셀 수 있습니다.",
      "고유 설치는 사람 수가 아니며 화면별 설치·작업 수는 중복됩니다. 적용 후 저장은 같은 작업에서 시간 순서가 확인된 경우만 집계합니다.",
      "동일시도 복구는 작업·세션·시도를 연결합니다. 실패 후 같은 작업 성공은 별도 관측이며 설정이 같거나 문제가 해결됐다고 단정하지 않습니다.",
      "활성화·재방문은 현재 동의가 유효하고 조회 기간에 새로 등록되어 v2 활동이 관측된 설치만 분모입니다. 동의 없는 전체 설치 대비 비율이 아닙니다.",
      "D1/D7은 첫 관측일(KST) 이후 해당 날짜가 완전히 지난 설치만 집계합니다. 재방문은 앱 이벤트, 분석은 서버 작업, 저장은 네이티브 쓰기 완료입니다.",
      "복구의 기능·화면은 실패가 발생한 맥락입니다. 다른 화면에서 재시도해 성공해도 최초 실패 맥락에 집계합니다. 작업·시도 연결이 없는 분석 실패는 연결 불가로 남기고 다른 작업의 재분석을 복구로 추정하지 않습니다.",
      "과거 계측 누락은 복원하지 않습니다. 오래된 설치의 생애 첫 사용·첫 저장을 이 조회 기간만으로 추정하지 않습니다.",
      "구간 시간은 같은 작업의 실제 관측된 순서만 연결합니다. 재방문·설정 변경 시간을 포함할 수 있으며 서버 구간 화면은 연결된 input_confirmed 또는 upload_completed가 있을 때만 구분합니다. 병렬 준비·누락·역순은 표본 누락으로 남깁니다.",
    ],
  };
}
