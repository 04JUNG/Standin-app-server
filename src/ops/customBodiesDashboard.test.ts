import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { CUSTOM_BODIES_SCRIPT } from "./customBodiesDashboard.js";
import { DASHBOARD_HTML } from "./dashboard.js";

const owner = "inst_11111111-1111-1111-1111-111111111111";
function harness(
  fetcher: (url: string, init: Record<string, unknown>) => Promise<unknown>,
) {
  const elements = new Map<
    string,
    {
      innerHTML: string;
      textContent: string;
      value: string;
      hidden: boolean;
      open: boolean;
      src: string;
      showModal: () => void;
      close: () => void;
      removeAttribute: (key: string) => void;
      addEventListener: () => void;
    }
  >();
  for (const id of [
    "customBodyOwner",
    "customBodyGo",
    "customBodyMsg",
    "customBodyMore",
    "customBodyList",
    "customBodyDialog",
    "customBodyTitle",
    "customBodyDetail",
    "customBodyPreview",
    "customBodyPreviewMsg",
    "customBodyClose",
  ]) {
    const el = {
      innerHTML: "",
      textContent: "",
      value: "",
      hidden: false,
      open: false,
      src: "",
      showModal() {
        el.open = true;
      },
      close() {
        el.open = false;
      },
      removeAttribute(key: string) {
        if (key === "src") el.src = "";
      },
      addEventListener() {},
    };
    elements.set(id, el);
  }
  const revoked: string[] = [],
    calls: Array<{ url: string; init: Record<string, unknown> }> = [];
  const context = vm.createContext({
    $: (id: string) => elements.get(id),
    token: "test-admin-token",
    URLSearchParams,
    AbortController,
    URL: {
      createObjectURL: () => "blob:body-preview",
      revokeObjectURL: (url: string) => revoked.push(url),
    },
    document: { addEventListener() {} },
    fetch: async (url: string, init: Record<string, unknown>) => {
      calls.push({ url, init });
      return fetcher(url, init);
    },
    esc: (v: unknown) =>
      String(v).replace(
        /[&<>"]/g,
        (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
      ),
    when: (s: unknown) => String(s || "—"),
    Error,
  });
  vm.runInContext(CUSTOM_BODIES_SCRIPT, context);
  return { context, elements, revoked, calls };
}
const response = (body: unknown) => ({ ok: true, json: async () => body });
const page = (name = "주인공 A") => ({
  installations: [
    {
      installationId: owner,
      appVersion: "0.2.3",
      osName: "macos",
      cards: [
        {
          cardId: "body",
          name,
          modelName: "기본 모델",
          previewStatus: "available",
          createdAt: "2026-10-27",
          updatedAt: "2026-10-27",
        },
      ],
    },
  ],
  nextCursor: null,
});
test("saved-body list escapes user card content and uses header-only auth/no-store", async () => {
  const h = harness(async () => response(page("<img src=x onerror=bad()>")));
  await vm.runInContext("customBodiesGo(null)", h.context);
  assert.match(h.elements.get("customBodyList")!.innerHTML, /&lt;img/);
  assert.doesNotMatch(h.elements.get("customBodyList")!.innerHTML, /<img /);
  assert.equal(h.calls[0].url, "/v1/admin/review/custom-bodies?limit=20");
  assert.equal(
    (h.calls[0].init.headers as Record<string, string>)["X-Beta-Admin-Token"],
    "test-admin-token",
  );
  assert.equal(h.calls[0].init.cache, "no-store");
  assert.doesNotMatch(h.calls[0].url, /token/);
});
test("earlier list results cannot replace a newer installation filter and failed refresh clears stale cards", async () => {
  const pending: Array<(r: unknown) => void> = [];
  const h = harness(() => new Promise((resolve) => pending.push(resolve)));
  const first = vm.runInContext("customBodiesGo(null)", h.context);
  h.elements.get("customBodyOwner")!.value = owner;
  const second = vm.runInContext("customBodiesGo(null)", h.context);
  pending[1](response(page("newest")));
  await second;
  pending[0](response(page("stale")));
  await first;
  assert.match(h.elements.get("customBodyList")!.innerHTML, /newest/);
  assert.doesNotMatch(h.elements.get("customBodyList")!.innerHTML, /stale/);
  const third = vm.runInContext("customBodiesGo(null)", h.context);
  pending[2]({ ok: false, status: 404, json: async () => ({}) });
  await third;
  assert.equal(h.elements.get("customBodyList")!.innerHTML, "");
  assert.match(
    h.elements.get("customBodyMsg")!.textContent,
    /열람할 수 없습니다/,
  );
});
test("preview loads by authenticated blob and closing removes the image and revokes object URLs", async () => {
  const body = {
    name: "주인공 A",
    modelName: "모델",
    controls: [{ label: "키", value: 180 }],
    previewUrl: "/v1/admin/review/custom-bodies/x/y/preview?revision=abc",
  };
  const h = harness(async (url) =>
    url.includes("/preview?")
      ? {
          ok: true,
          headers: { get: () => "image/svg+xml" },
          blob: async () => new Blob(["<svg/>"]),
        }
      : response(body),
  );
  await vm.runInContext(`openCustomBody('${owner}','body')`, h.context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.elements.get("customBodyPreview")!.src, "blob:body-preview");
  assert.match(h.elements.get("customBodyPreviewMsg")!.textContent, /정면/);
  assert.ok(h.calls.every((c) => !c.url.includes("test-admin-token")));
  vm.runInContext("closeCustomBody()", h.context);
  assert.deepEqual(h.revoked, ["blob:body-preview"]);
  assert.equal(h.elements.get("customBodyPreview")!.src, "");
  assert.equal(h.elements.get("customBodyDetail")!.innerHTML, "");
  assert.equal(h.elements.get("customBodyDialog")!.open, false);
});
test("catalog-unavailable cards remain inspectable without pretending the default image is customized", async () => {
  const h = harness(async () =>
    response({
      name: "예전 체형",
      modelName: "구버전",
      previewUrl: null,
      previewReason: "MODEL_UNAVAILABLE",
      controls: [{ label: "키", value: 181 }],
    }),
  );
  await vm.runInContext(`openCustomBody('${owner}','old')`, h.context);
  assert.match(h.elements.get("customBodyDetail")!.innerHTML, /181/);
  assert.match(
    h.elements.get("customBodyDetail")!.innerHTML,
    /기본 모델을 사용할 수 없습니다/,
  );
  assert.doesNotMatch(h.elements.get("customBodyDetail")!.innerHTML, /<img/);
  assert.equal(h.calls.length, 1);
});
test("dashboard retains existing tabs and parses the integrated body browser without third-party resources", () => {
  assert.match(DASHBOARD_HTML, /data-tab="bodies"/);
  assert.match(DASHBOARD_HTML, /id="tab-metrics"/);
  assert.match(DASHBOARD_HTML, /id="customBodyDialog"/);
  assert.doesNotThrow(
    () =>
      new vm.Script(
        DASHBOARD_HTML.slice(
          DASHBOARD_HTML.indexOf("<script>") + 8,
          DASHBOARD_HTML.lastIndexOf("</script>"),
        ),
      ),
  );
  assert.doesNotMatch(
    CUSTOM_BODIES_SCRIPT,
    /https?:\/\/|<iframe|localStorage\.setItem/,
  );
});
