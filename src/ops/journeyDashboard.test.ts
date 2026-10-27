import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { JOURNEY_PANEL_SCRIPT } from "./journeyDashboard.js";
import { DASHBOARD_HTML } from "./dashboard.js";

function fixture() {
  return {
    window: { from: "2026-10-21T00:00:00Z", to: "2026-10-27T00:00:00Z", days: 7, audience: "all", idleMinutes: 30 },
    totals: { jobs: 15, installations: 5, observableJobs: 3, unobservableJobs: 12 },
    stages: [{ key: "results", label: "결과 화면 표시", jobs: 3, installations: 2 }, { key: "saved", label: "실제 파일 저장", jobs: 0, installations: 0 }],
    transitions: [{ from: "results", to: "saved", reached: 3, advanced: 0, waiting: 1, noNextEvent: 1, unobservable: 1, failed: 0, cancelled: 0 }],
    outcomes: { saved: 0, failed: 0, cancelled: 0, waiting: 1, noNextEvent: 2, unobservable: 12 },
    durations: [{ key: "save", label: "파일 저장", samples: 0, medianMs: null, p90Ms: null }],
    coverage: { version2Jobs: 3, legacyEventJobs: 2, noClientEventJobs: 10 },
    audiences: [{ key: "unclassified", jobs: 15, installations: 5 }],
    notes: ["과거 기록은 소급 복원하지 않습니다."],
  };
}

function browser(fetcher: (url: string, init: RequestInit) => Promise<unknown> = async () => ({ ok: true, json: async () => fixture() })) {
  const elements = new Map<string, { innerHTML: string; textContent: string; value: string; attributes: Record<string, string>; setAttribute: (key: string, value: string) => void; addEventListener: () => void }>();
  for (const id of ["period", "journeyAudience", "journeyIdle", "journeyGo", "journeyOut", "journeyMsg"]) {
    const attributes: Record<string, string> = {};
    elements.set(id, { innerHTML: "", textContent: "", value: id === "period" ? "7" : id === "journeyIdle" ? "30" : "all", attributes,
      setAttribute: (k, v) => { attributes[k] = v; }, addEventListener: () => {}, });
  }
  const context = vm.createContext({
    $: (id: string) => elements.get(id), token: "test-admin-token", URLSearchParams,
    fetch: fetcher, Error,
    esc: (value: unknown) => String(value).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!)),
    ms: (n: number | null) => n === null ? "—" : n + "ms", when: (s: string) => s,
  });
  vm.runInContext(JOURNEY_PANEL_SCRIPT, context);
  return { context, elements };
}

test("panel keeps missing telemetry distinct from zero saves and never asserts external users", () => {
  const { context } = browser(); context.fixture = fixture();
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
  const { context } = browser(); const data = fixture();
  data.notes = ['<img src=x onerror="alert(1)">']; data.stages[0].label = "<script>bad()</script>";
  context.fixture = data;
  const html = vm.runInContext("journeyRender(fixture)", context) as string;
  assert.doesNotMatch(html, /<script>|<img /);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script&gt;/);
});

test("queries selected filters with header auth only and no cache", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const { context, elements } = browser(async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => fixture() }; });
  elements.get("journeyAudience")!.value = "internal";
  elements.get("journeyIdle")!.value = "60";
  await vm.runInContext("journeyGo()", context);
  assert.equal(calls[0].url, "/v1/admin/journey?days=7&audience=internal&idleMinutes=60");
  assert.equal((calls[0].init.headers as Record<string, string>)["X-Beta-Admin-Token"], "test-admin-token");
  assert.equal((calls[0].init as RequestInit & { cache: string }).cache, "no-store");
  assert.equal(elements.get("journeyOut")!.attributes["aria-busy"], "false");
});

test("failed queries clear old numbers instead of displaying stale or zero data", async () => {
  const { context, elements } = browser(async () => ({ ok: false, status: 503 }));
  elements.get("journeyOut")!.innerHTML = "old numbers";
  await vm.runInContext("journeyGo()", context);
  assert.equal(elements.get("journeyOut")!.innerHTML, "");
  assert.equal(elements.get("journeyMsg")!.textContent, "조회 실패 (503)");
});

test("slow responses for earlier filters cannot overwrite latest selection", async () => {
  const responses: Array<(value: unknown) => void> = [];
  const { context, elements } = browser(() => new Promise((resolve) => responses.push(resolve)));
  const first = vm.runInContext("journeyGo()", context) as Promise<void>;
  elements.get("journeyAudience")!.value = "internal";
  const second = vm.runInContext("journeyGo()", context) as Promise<void>;
  const latest = fixture(); latest.totals.jobs = 42;
  responses[1]({ ok: true, json: async () => latest }); await second;
  const latestHtml = elements.get("journeyOut")!.innerHTML;
  responses[0]({ ok: true, json: async () => fixture() }); await first;
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
