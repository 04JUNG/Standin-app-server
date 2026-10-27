import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { JOURNEY_PANEL_SCRIPT } from "./journeyDashboard.js";
import { DASHBOARD_HTML } from "./dashboard.js";

function fixture() {
  return {
    window: {
      from: "2026-10-21T00:00:00Z",
      to: "2026-10-27T00:00:00Z",
      days: 7,
      audience: "all",
      idleMinutes: 30,
    },
    totals: {
      jobs: 15,
      installations: 5,
      observableJobs: 3,
      unobservableJobs: 12,
    },
    stages: [
      { key: "results", label: "결과 화면 표시", jobs: 3, installations: 2 },
      { key: "saved", label: "실제 파일 저장", jobs: 0, installations: 0 },
    ],
    transitions: [
      {
        from: "results",
        to: "saved",
        reached: 3,
        advanced: 0,
        waiting: 1,
        noNextEvent: 1,
        unobservable: 1,
        failed: 0,
        cancelled: 0,
      },
    ],
    outcomes: {
      saved: 0,
      failed: 0,
      cancelled: 0,
      waiting: 1,
      noNextEvent: 2,
      unobservable: 12,
    },
    durations: [
      {
        key: "save",
        label: "파일 저장",
        samples: 0,
        medianMs: null,
        p90Ms: null,
      },
    ],
    coverage: { version2Jobs: 3, legacyEventJobs: 2, noClientEventJobs: 10 },
    audiences: [{ key: "unclassified", jobs: 15, installations: 5 }],
    notes: ["과거 기록은 소급 복원하지 않습니다."],
  };
}

function browser(
  fetcher: (url: string, init: RequestInit) => Promise<unknown> = async () => ({
    ok: true,
    json: async () => fixture(),
  }),
) {
  const elements = new Map<
    string,
    {
      innerHTML: string;
      textContent: string;
      value: string;
      attributes: Record<string, string>;
      setAttribute: (key: string, value: string) => void;
      addEventListener: () => void;
    }
  >();
  for (const id of [
    "period",
    "journeyAudience",
    "journeyIdle",
    "journeyGo",
    "journeyOut",
    "journeyMsg",
    "journeyDetailSurface",
    "journeyDetailFeature",
    "journeyDetailCategory",
  ]) {
    const attributes: Record<string, string> = {};
    elements.set(id, {
      innerHTML: "",
      textContent: "",
      value: id === "period" ? "7" : id === "journeyIdle" ? "30" : "all",
      attributes,
      setAttribute: (k, v) => {
        attributes[k] = v;
      },
      addEventListener: () => {},
    });
  }
  const context = vm.createContext({
    $: (id: string) => elements.get(id),
    token: "test-admin-token",
    URLSearchParams,
    fetch: fetcher,
    Error,
    esc: (value: unknown) =>
      String(value).replace(
        /[&<>"]/g,
        (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
      ),
    ms: (n: number | null) => (n === null ? "—" : n + "ms"),
    when: (s: string) => s,
  });
  vm.runInContext(JOURNEY_PANEL_SCRIPT, context);
  return { context, elements };
}

test("panel keeps missing telemetry distinct from zero saves and never asserts external users", () => {
  const { context } = browser();
  context.fixture = fixture();
  const html = vm.runInContext("journeyRender(fixture)", context) as string;
  assert.match(html, /관찰할 수 없는 작업/);
  assert.match(html, /이탈로 계산하지 않음/);
  assert.match(html, /미분류/);
  assert.match(html, /이탈 확정이나 원인 판정이 아니며/);
  assert.match(html, /<td class="num">0<\/td>/);
  assert.doesNotMatch(html, /외부 사용자/);
  assert.match(html, /표본/);
});

test("server-provided stage labels and notes are escaped", () => {
  const { context } = browser();
  const data = fixture();
  data.notes = ['<img src=x onerror="alert(1)">'];
  data.stages[0].label = "<script>bad()</script>";
  context.fixture = data;
  const html = vm.runInContext("journeyRender(fixture)", context) as string;
  assert.doesNotMatch(html, /<script>|<img /);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script&gt;/);
});

test("queries selected filters with header auth only and no cache", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const { context, elements } = browser(async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => fixture() };
  });
  elements.get("journeyAudience")!.value = "internal";
  elements.get("journeyIdle")!.value = "60";
  await vm.runInContext("journeyGo()", context);
  assert.equal(
    calls[0].url,
    "/v1/admin/journey?days=7&audience=internal&idleMinutes=60",
  );
  assert.equal(
    (calls[0].init.headers as Record<string, string>)["X-Beta-Admin-Token"],
    "test-admin-token",
  );
  assert.equal(
    (calls[0].init as RequestInit & { cache: string }).cache,
    "no-store",
  );
  assert.equal(elements.get("journeyOut")!.attributes["aria-busy"], "false");
});

test("failed queries clear old numbers instead of displaying stale or zero data", async () => {
  const { context, elements } = browser(async () => ({
    ok: false,
    status: 503,
  }));
  elements.get("journeyOut")!.innerHTML = "old numbers";
  await vm.runInContext("journeyGo()", context);
  assert.equal(elements.get("journeyOut")!.innerHTML, "");
  assert.equal(elements.get("journeyMsg")!.textContent, "조회 실패 (503)");
});

test("slow responses for earlier filters cannot overwrite latest selection", async () => {
  const responses: Array<(value: unknown) => void> = [];
  const { context, elements } = browser(
    () => new Promise((resolve) => responses.push(resolve)),
  );
  const first = vm.runInContext("journeyGo()", context) as Promise<void>;
  elements.get("journeyAudience")!.value = "internal";
  const second = vm.runInContext("journeyGo()", context) as Promise<void>;
  const latest = fixture();
  latest.totals.jobs = 42;
  responses[1]({ ok: true, json: async () => latest });
  await second;
  const latestHtml = elements.get("journeyOut")!.innerHTML;
  responses[0]({ ok: true, json: async () => fixture() });
  await first;
  assert.equal(elements.get("journeyOut")!.innerHTML, latestHtml);
  assert.match(latestHtml, /42/);
});

test("complete emitted dashboard JS parses and panel is inside product metrics", () => {
  const start = DASHBOARD_HTML.indexOf("<script>") + 8;
  const end = DASHBOARD_HTML.lastIndexOf("</script>");
  assert.doesNotThrow(() => new vm.Script(DASHBOARD_HTML.slice(start, end)));
  const panel = DASHBOARD_HTML.indexOf('id="journeyPanel"');
  assert.ok(panel > DASHBOARD_HTML.indexOf('id="tab-metrics"'));
  assert.ok(panel < DASHBOARD_HTML.indexOf('id="tab-ops"'));
});

function advancedFixture() {
  return {
    ...fixture(),
    advanced: {
      scope: { historyFrom: "2026-10-01T00:00:00Z" },
      featureSummary: [
        {
          feature: "hand_library",
          exposedInstallations: 4,
          usedInstallations: 3,
          usedAmongExposedInstallations: 2,
          appliedInstallations: 2,
          savedAfterApplyInstallations: 1,
          events: 12,
          surfaces: [
            { surface: "app", usedInstallations: 2 },
            { surface: "bar", usedInstallations: 2 },
          ],
        },
      ],
      featureSegments: [
        {
          feature: "hand_library",
          action: "selected",
          surface: "app",
          osName: "macos",
          source: "capture",
          appVersion: "0.2.3",
          events: 3,
          installations: 2,
          jobs: 2,
        },
        {
          feature: "semantic_search",
          action: "search_started",
          surface: "bar",
          osName: "windows",
          source: "semantic",
          appVersion: "0.2.3",
          events: 5,
          installations: 2,
          jobs: 2,
        },
      ],
      failures: [
        {
          category: "server",
          code: "CONVERTER_FAILED",
          feature: "export",
          phase: "preparing",
          surface: "bar",
          osName: "windows",
          source: "capture",
          appVersion: "0.2.3",
          httpStatus: 503,
          events: 2,
          jobs: 1,
          installations: 1,
        },
        {
          category: "permission",
          code: "CAPTURE_PERMISSION",
          feature: "capture",
          phase: "input",
          surface: "app",
          osName: "macos",
          source: "capture",
          appVersion: "0.2.3",
          events: 1,
          jobs: 0,
          installations: 1,
        },
      ],
      stageOutcomes: [
        {
          stage: "results_viewed",
          label: "結果<unsafe>",
          feature: "pose_selection",
          surface: "bar",
          source: "capture",
          outcome: "noNextEvent",
          jobs: 1,
        },
      ],
      durationSegments: [
        {
          key: "results_to_selection",
          label: "結果<unsafe>",
          surface: "bar",
          feature: "pose_selection",
          samples: 1,
          missingSamples: 1,
          medianMs: 1540,
          p90Ms: 2200,
        },
      ],
      recovery: [
        {
          phase: "preparing",
          feature: "export",
          surface: "bar",
          failedAttempts: 2,
          recoveredAttempts: 1,
          unmatchedFailures: 1,
        },
      ],
      exits: [
        {
          phase: "results",
          feature: "pose_selection",
          surface: "bar",
          reason: "back",
          events: 1,
          installations: 1,
        },
      ],
      activation: {
        eligibleInstallations: 4,
        firstSaveInstallations: 2,
        nextJobInstallations: 1,
        repeatSaveInstallations: 0,
        historyFrom: "2026-10-01",
      },
      retention: [
        {
          day: 1,
          eligibleInstallations: 4,
          returnedInstallations: 2,
          analyzedInstallations: 1,
          savedInstallations: 0,
        },
        {
          day: 7,
          eligibleInstallations: 0,
          returnedInstallations: 0,
          analyzedInstallations: 0,
          savedInstallations: 0,
        },
      ],
      notes: ["<img src=x>"],
    },
  };
}

test("advanced panel separates unique adoption, proven errors, explicit exits and mature retention", () => {
  const { context } = browser();
  context.fixture = advancedFixture();
  const html = vm.runInContext("journeyRender(fixture)", context) as string;
  assert.match(html, /고유 이용 설치/);
  assert.match(html, /2 \/ 4 \(50%\)/);
  assert.match(html, /1 \/ 2 \(50%\)/);
  assert.match(html, /서버 오류/);
  assert.match(html, /CONVERTER_FAILED/);
  assert.match(html, /CAPTURE_PERMISSION/);
  assert.match(html, /1.54초/);
  assert.match(html, /D7/);
  assert.doesNotMatch(html, /<img |<unsafe>/);
  assert.match(html, /&lt;unsafe&gt;/);
  assert.match(html, /&lt;img/);
  assert.match(html, /해당 날짜가 완전히 지난 설치만 분모/);
  assert.match(html, /최종 이탈 건수로 합산하지 않습니다/);
});

test("feature and cause filters affect only details, retaining whole-cohort denominator", () => {
  const { context, elements } = browser();
  context.fixture = advancedFixture();
  elements.get("journeyDetailSurface")!.value = "bar";
  elements.get("journeyDetailCategory")!.value = "server";
  const html = vm.runInContext("journeyRender(fixture)", context) as string;
  assert.match(html, /CONVERTER_FAILED/);
  assert.doesNotMatch(html, /CAPTURE_PERMISSION/);
  assert.match(html, /검색 실행/);
  assert.doesNotMatch(html, /직접 선택<\/td>/);
  assert.match(html, /고유 이용 설치/);
  assert.match(html, /관찰할 수 없는 작업/);
  assert.match(html, /12/);
});

test("zero duration stays zero while missing duration and zero-denominator rates stay unknown", () => {
  const { context } = browser();
  assert.equal(vm.runInContext("journeySeconds(0)", context), "0초");
  assert.equal(vm.runInContext("journeySeconds(null)", context), "—");
  assert.equal(vm.runInContext("journeySeconds(-1)", context), "—");
  assert.equal(vm.runInContext("journeyRatio(0,0)", context), "—");
  assert.equal(vm.runInContext("journeyRatio(0,4)", context), "0 / 4 (0%)");
});

function emittedFunction(name: string, next: string) {
  const start = DASHBOARD_HTML.indexOf(`function ${name}(`);
  const end = DASHBOARD_HTML.indexOf(`function ${next}(`, start);
  assert.ok(start > 0 && end > start);
  return DASHBOARD_HTML.slice(start, end);
}

test("legacy funnel renders both installation and job rates and labels server records accurately", () => {
  const { context } = browser();
  vm.runInContext('function pct(n) {return n == null ? "—" : n+"%";}', context);
  vm.runInContext(emittedFunction("funnelTable", "cohortCards"), context);
  context.stages = [
    {
      key: "completed",
      label: "분석 완료",
      installations: 5,
      jobs: 15,
      fromPrevious: 100,
      fromStarted: 100,
      jobFromPrevious: 100,
      jobFromStarted: 100,
    },
    {
      key: "selected",
      label: "후보 선택",
      installations: 2,
      jobs: 5,
      fromPrevious: 40,
      fromStarted: 40,
      jobFromPrevious: 33.3,
      jobFromStarted: 33.3,
    },
    {
      key: "exported",
      label: "저장 완료",
      installations: 0,
      jobs: 0,
      fromPrevious: 0,
      fromStarted: 0,
      jobFromPrevious: 0,
      jobFromStarted: 0,
    },
  ];
  const html = vm.runInContext("funnelTable(stages)", context) as string;
  assert.match(html, /설치 · 직전 대비/);
  assert.match(html, /작업 · 직전 대비/);
  assert.match(html, /40%/);
  assert.match(html, /33.3%/);
  assert.match(html, /서버 내보내기 기록/);
  assert.doesNotMatch(html, /저장 완료/);
});

test("legacy health distinguishes unused fields from collection errors without asserting dropout causes", () => {
  const { context } = browser();
  vm.runInContext('function pct(n) {return n == null ? "—" : n+"%";}', context);
  vm.runInContext(
    emittedFunction("instrumentationBlock", "distanceTable"),
    context,
  );
  context.health = {
    columns: [
      {
        label: "analysis_candidates.rerank_score",
        rows: 10,
        nulls: 10,
        nullRate: 100,
        empty: true,
        applicability: "unused",
        note: "현재 검색에서 사용하지 않음",
      },
    ],
    stageGaps: [
      {
        stage: "사용 확정",
        server: 5,
        client: 0,
        gap: -5,
        note: "원인 미확정",
        serverUnit: "jobs",
        clientUnit: "events",
      },
    ],
  };
  const html = vm.runInContext(
    "instrumentationBlock(health)",
    context,
  ) as string;
  assert.doesNotMatch(
    html,
    /비어 있는 컬럼 1개|음수는 이벤트 유실|원인.*확정했다/,
  );
  assert.match(html, /현재 검색에서 사용하지 않음/);
  assert.match(html, /차이만으로 유실이나 접수 실패를 확정할 수 없습니다/);
  assert.match(html, /서버: jobs \/ 클라: events/);
});
