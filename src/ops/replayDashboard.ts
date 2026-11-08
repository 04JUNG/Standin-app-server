export const REPLAY_PANEL_HTML = String.raw`
<style>
  #replayPanel {
    padding: 24px;
    min-width: 0;
  }
  .replay-heading {
    display: flex;
    justify-content: space-between;
    align-items: start;
    gap: 16px;
    margin-bottom: 20px;
  }
  .replay-heading h2 {
    font-size: 22px;
    margin: 0 0 4px;
  }
  .replay-heading p {
    margin: 0;
  }
  .replay-search {
    display: flex;
    gap: 8px;
    align-items: center;
    margin: 16px 0;
  }
  .replay-search input {
    min-width: 0;
    flex: 1;
    padding: 11px 14px;
  }
  .replay-search button {
    white-space: nowrap;
  }
  .replay-filter-row {
    display: flex;
    gap: 7px;
    align-items: center;
    flex-wrap: wrap;
    margin: 10px 0;
  }
  .replay-filter-row > strong {
    min-width: 68px;
    font-size: 12px;
    color: var(--muted);
  }
  button.replay-chip {
    background: transparent;
    color: var(--muted);
    border: 1px solid var(--line);
    border-radius: 99px;
    padding: 4px 11px;
    font-size: 12px;
    font-weight: 500;
  }
  button.replay-chip[aria-pressed="true"] {
    color: var(--text);
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 8%, var(--panel));
    font-weight: 650;
  }
  button.replay-chip:hover {
    border-color: var(--muted);
    color: var(--text);
  }
  .replay-filters {
    margin: 12px 0;
    border-bottom: 1px solid var(--line);
    padding-bottom: 12px;
  }
  .replay-filters summary {
    cursor: pointer;
    color: var(--muted);
    font-size: 13px;
  }
  .replay-filter-options {
    max-height: 280px;
    overflow: auto;
  }
  .replay-applied {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
    min-height: 28px;
    margin: 10px 0;
  }
  .replay-applied:empty {
    display: none;
  }
  .replay-applied button {
    font-size: 12px;
  }
  .replay-list-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin: 20px 0 10px;
  }
  .replay-list-head h3 {
    font-size: 14px;
    margin: 0;
  }
  .replay-list-head p {
    margin: 0;
  }
  .replay-scroll {
    height: min(68vh, 790px);
    min-height: 360px;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
    padding: 2px 6px 10px 2px;
    border-radius: 10px;
    touch-action: pan-y;
  }
  .replay-scroll.dragging {
    cursor: grabbing;
    user-select: none;
  }
  .replay-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 14px;
  }
  .replay-card {
    min-width: 0;
    border: 1px solid var(--line);
    border-radius: 12px;
    overflow: hidden;
    background: var(--panel);
  }
  .replay-card:hover {
    border-color: var(--muted);
  }
  button.replay-open {
    display: block;
    width: 100%;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--text);
    text-align: left;
    font-weight: 400;
  }
  .replay-preview {
    aspect-ratio: 16/9;
    background: var(--bg);
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }
  .replay-preview img {
    width: 100%;
    height: 100%;
    object-fit: contain;
    position: absolute;
    inset: 0;
  }
  .replay-placeholder {
    text-align: center;
    color: var(--muted);
    font-size: 12px;
    display: grid;
    gap: 6px;
  }
  .replay-placeholder b {
    font-size: 26px;
    font-weight: 400;
    opacity: 0.55;
  }
  .replay-play-mark {
    position: absolute;
    bottom: 10px;
    right: 10px;
    background: rgba(0, 0, 0, 0.65);
    color: white;
    font-size: 11px;
    border-radius: 6px;
    padding: 2px 8px;
    font-variant-numeric: tabular-nums;
  }
  .replay-card-body {
    padding: 13px 14px;
    display: grid;
    gap: 8px;
  }
  .replay-card-title {
    font-size: 14px;
    font-weight: 650;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .replay-card-date {
    font-size: 12px;
    color: var(--muted);
  }
  .replay-card-tags {
    display: flex;
    gap: 5px;
    flex-wrap: wrap;
  }
  .replay-card-tags span {
    font-size: 11px;
    border-radius: 5px;
    background: var(--bg);
    color: var(--muted);
    padding: 1px 6px;
  }
  .replay-card-tags .error {
    color: var(--bad);
  }
  .replay-card-tags .saved {
    color: var(--ok);
  }
  .replay-card-ids {
    font-size: 11px;
    color: var(--muted);
    overflow-wrap: anywhere;
  }
  .replay-job-links {
    display: flex;
    gap: 5px;
    flex-wrap: wrap;
    padding: 0 14px 12px;
  }
  .replay-job-links button {
    font-family: ui-monospace, monospace;
    font-size: 10px;
  }
  .replay-empty {
    grid-column: 1/-1;
    padding: 68px 20px;
    text-align: center;
    color: var(--muted);
    border: 1px dashed var(--line);
    border-radius: 12px;
  }
  .replay-empty h3 {
    color: var(--text);
    margin: 0 0 6px;
    font-size: 16px;
  }
  .replay-empty p {
    margin: 0;
    font-size: 13px;
  }
  .replay-skeleton {
    height: 275px;
    background: var(--bg);
    border-radius: 12px;
    border: 1px solid var(--line);
  }
  .replay-more {
    display: flex;
    justify-content: center;
    gap: 12px;
    align-items: center;
    padding-top: 14px;
    font-size: 12px;
    color: var(--muted);
  }
  #replaySentinel {
    height: 1px;
  }
  .replay-scope {
    color: var(--muted);
    font-size: 12px;
  }
  #replayStatus {
    margin: 8px 0;
    min-height: 20px;
    font-size: 12px;
    color: var(--muted);
  }
  #replayStatus.err {
    color: var(--bad);
  }
  #replayDialog {
    width: min(1280px, 96vw);
    max-height: 94vh;
    overflow: auto;
    padding: 22px;
    border: 1px solid var(--line);
    border-radius: 14px;
    background: var(--panel);
    color: var(--text);
  }
  #replayDialog::backdrop {
    background: rgba(0, 0, 0, 0.6);
  }
  .replay-modal-head {
    display: flex;
    justify-content: space-between;
    align-items: start;
    gap: 16px;
  }
  #replayTitle {
    font-size: 18px;
    margin: 0 0 4px;
  }
  #replayMeta {
    font-size: 12px;
    color: var(--muted);
    margin: 0;
  }
  #replayGaps {
    font-size: 12px;
    color: var(--muted);
    margin: 12px 0;
  }
  .replay-transport {
    padding: 13px 16px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--bg);
    margin: 14px 0;
  }
  .replay-transport-row {
    display: flex;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
  }
  .replay-transport input[type="range"] {
    width: 100%;
    min-width: 0;
    accent-color: var(--ok);
    margin: 12px 0 2px;
    padding: 0;
  }
  .replay-transport label {
    font-size: 12px;
    color: var(--muted);
    display: flex;
    gap: 5px;
    align-items: center;
  }
  .replay-transport input[type="checkbox"] {
    min-width: 0;
  }
  .replay-transport output {
    margin-left: auto;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  #replayFrame {
    width: 100%;
    height: 600px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--bg);
  }
  #replayTimeline {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin: 12px 0;
    max-height: 100px;
    overflow: auto;
  }
  #replayCompare {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
    margin-top: 10px;
  }
  #replayCompare figure {
    margin: 0;
    border: 1px solid var(--line);
    padding: 10px;
    border-radius: 8px;
    min-width: 0;
  }
  #replayCompare img {
    width: 100%;
    height: 160px;
    object-fit: contain;
  }
  #replayCompare figcaption {
    font-size: 11px;
    color: var(--muted);
    overflow-wrap: anywhere;
  }
  #replayCompareDetails summary {
    cursor: pointer;
    font-size: 13px;
  }
  button:focus-visible,
  .replay-scroll:focus-visible,
  summary:focus-visible {
    outline: 2px solid var(--ok);
    outline-offset: 3px;
  }
  @media (max-width: 960px) {
    .replay-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  @media (max-width: 620px) {
    #replayPanel {
      padding: 16px;
    }
    .replay-grid {
      grid-template-columns: 1fr;
    }
    .replay-heading {
      gap: 8px;
    }
    .replay-search {
      flex-wrap: wrap;
    }
    .replay-search input {
      flex-basis: 100%;
    }
    .replay-scroll {
      height: 65vh;
    }
    #replayCompare {
      grid-template-columns: 1fr;
    }
    #replayFrame {
      height: 490px;
    }
  }
</style>
<div class="card" id="replayPanel">
  <div class="replay-heading">
    <div>
      <h2>리플레이</h2>
      <p class="sub">최근 기록을 둘러보고 필요한 순간을 다시 확인하세요.</p>
    </div>
    <button class="ghost" id="replayRefresh">새로고침</button>
  </div>
  <form class="replay-search" id="replaySearchForm" role="search">
    <input
      id="replaySearch"
      aria-label="리플레이 ID 검색"
      placeholder="작업 · 설치 · 앱 세션 ID로 검색"
      autocomplete="off"
      spellcheck="false"
      maxlength="128"
    /><button type="button" class="ghost" id="replaySearchClear" hidden>지우기</button
    ><button type="submit">검색</button>
  </form>
  <div class="replay-filter-row" id="replaySurfaceFilters" aria-label="화면 필터"></div>
  <details class="replay-filters" id="replayFilterDetails">
    <summary>버전 · OS · 상태 필터</summary>
    <div class="replay-filter-options" id="replayFacetFilters"></div>
    <details>
      <summary>고급 필터</summary>
      <div id="replayAdvancedFilters"></div>
    </details>
    <p class="sub" id="replayFacetNote"></p>
  </details>
  <div class="replay-applied" id="replayApplied" aria-label="적용한 필터"></div>
  <div class="replay-list-head">
    <h3>최근 기록 <span class="sub" id="replayCount"></span></h3>
    <p class="replay-scope" id="replayScope"></p>
  </div>
  <p id="replayStatus" role="status" aria-live="polite"></p>
  <div
    class="replay-scroll"
    id="replayScroll"
    tabindex="0"
    role="region"
    aria-label="최근 리플레이 목록 · 스크롤하거나 드래그해서 탐색"
  >
    <div class="replay-grid" id="replayList" role="list"></div>
    <div id="replaySentinel" aria-hidden="true"></div>
  </div>
  <div class="replay-more">
    <span>스크롤하거나 빈 공간을 드래그해 둘러보세요.</span
    ><button class="ghost" id="replayMore" hidden>더 불러오기</button>
  </div>
</div>
<dialog id="replayDialog" aria-labelledby="replayTitle">
  <div class="replay-modal-head">
    <div>
      <h3 id="replayTitle">리플레이</h3>
      <p id="replayMeta"></p>
    </div>
    <button class="ghost" id="replayClose">닫기</button>
  </div>
  <p id="replayGaps"></p>
  <div class="replay-transport">
    <div class="replay-transport-row">
      <button id="replayPlay" disabled>재생</button
      ><label
        >화면
        <select id="replayWindow" aria-label="재생할 창"></select></label
      ><label><input type="checkbox" id="replayFollow" checked />자동 창 전환</label
      ><label
        >속도
        <select id="replaySpeed" aria-label="재생 속도">
          <option value="0.5">0.5×</option>
          <option value="1" selected>1×</option>
          <option value="2">2×</option>
          <option value="4">4×</option>
          <option value="8">8×</option>
        </select></label
      ><output id="replayTime">0:00 / 0:00</output>
    </div>
    <input
      type="range"
      id="replayScrub"
      aria-label="앱 세션 타임라인"
      min="0"
      max="0"
      value="0"
      step="1"
      disabled
    />
    <div class="sub" id="replayPlaybackStatus">기록을 불러오는 중…</div>
  </div>
  <iframe
    id="replayFrame"
    title="격리된 작업 리플레이"
    sandbox="allow-same-origin"
    referrerpolicy="no-referrer"
  ></iframe>
  <div id="replayTimeline" aria-label="기록된 주요 이벤트"></div>
  <details id="replayCompareDetails">
    <summary id="replayCompareSummary">기록 이미지 비교</summary>
    <div id="replayCompare"></div>
    <button class="ghost" id="replayCompareMore" hidden>이미지 더 보기</button>
  </details>
</dialog>
`;

export const REPLAY_PANEL_SCRIPT = String.raw`
let replayManifest,
  replayPlayer,
  replayBundle,
  replaySelected = {},
  replaySeek = 0,
  replayBefore,
  replayDuration = 0;
let replayFilters = {},
  replayRange,
  replayScopeData,
  replayBrowseEpoch = 0,
  replayBrowseAbort,
  replayListBusy = false,
  replaySeen = new Set();
let replayModalEpoch = 0,
  replayWindowEpoch = 0,
  replayModalAbort,
  replayWindowAbort,
  replayPlaying = false,
  replayLoading = false,
  replayClock,
  replayLastTick = 0,
  replayScrubbing = false,
  replayOutside = false,
  replayMissing = 0,
  replayOpener,
  replayBundlePromise;
let replayAssets = new Map(),
  replayAssetPending = new Map(),
  replayCompareItems = [],
  replayCompareCount = 0,
  replayAssessments = new Map();
const replayThumbs = new Map(),
  replayThumbQueue = [];
let replayThumbActive = 0;
const REPLAY_FILTER_KEY = "standin.replayFilters.v1";
const replayFilterKeys = [
  "q",
  "jobId",
  "feature",
  "appVersion",
  "os",
  "surface",
  "failed",
  "saveState",
  "state",
  "audience",
  "environment",
];
try {
  const saved = JSON.parse(sessionStorage.getItem(REPLAY_FILTER_KEY) || "{}");
  for (const k of replayFilterKeys)
    if (typeof saved[k] === "string" && saved[k].length <= 128) replayFilters[k] = saved[k];
} catch {}
const replaySurfaceNames = { app: "전체 화면", bar: "플로팅 바", capture: "캡처" };
const replayStateNames = {
  recording: "종료 신호 없음",
  complete: "업로드 완료",
  incomplete: "기록 일부 누락",
};
const replaySaveNames = {
  saved: "저장됨",
  failed: "저장 실패",
  cancelled: "저장 취소",
  unknown: "저장 미확인",
};
const replayErrorNames = {
  REPLAY_EXPIRED: "보관 기간이 끝난 기록입니다.",
  REPLAY_NOT_FOUND: "삭제되었거나 열 수 없는 기록입니다.",
  REPLAY_AUTHORIZATION_DENIED: "현재 서비스에서 리플레이 열람이 허용되지 않았습니다.",
  REPLAY_INVALID: "검색 ID 또는 조회 조건을 확인해 주세요.",
  REPLAY_DISABLED: "리플레이 기능이 꺼져 있습니다.",
  REPLAY_STORAGE_UNAVAILABLE: "기록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.",
};
const replayEl = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const replayShort = (s, n = 12) =>
  String(s || "").length > n ? String(s).slice(0, n) + "…" : String(s || "");
const replayFormatTime = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
};
const replayDate = (v) =>
  new Date(v).toLocaleString("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
async function replayFetch(path, binary = false, signal) {
  const res = await fetch(path, {
    headers: { "X-Beta-Admin-Token": token },
    cache: "no-store",
    signal,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = Error(replayErrorNames[body.error?.code] || "기록 조회 실패 · HTTP " + res.status);
    err.status = res.status;
    throw err;
  }
  return binary ? res.blob() : res.json();
}
function replayPersist() {
  try {
    sessionStorage.setItem(REPLAY_FILTER_KEY, JSON.stringify(replayFilters));
  } catch {}
}
function replayParams() {
  const q = new URLSearchParams(replayRange);
  for (const k of replayFilterKeys) if (replayFilters[k]) q.set(k, replayFilters[k]);
  return q;
}
function replayApply(key, value) {
  if (replayFilters[key] === value) delete replayFilters[key];
  else replayFilters[key] = value;
  replayPersist();
  void replayListGo();
}
function replayClearAll() {
  replayFilters = {};
  $("replaySearch").value = "";
  $("replaySearchClear").hidden = true;
  replayPersist();
  void replayListGo();
}
function replayApplied() {
  const root = $("replayApplied");
  root.replaceChildren();
  const labels = {
    q: "검색",
    jobId: "연결 작업",
    feature: "기능",
    appVersion: "버전",
    os: "OS",
    surface: "화면",
    failed: "오류",
    saveState: "저장",
    state: "기록",
    audience: "설치 구분",
    environment: "환경",
  };
  for (const k of replayFilterKeys)
    if (replayFilters[k]) {
      const value =
        k === "surface"
          ? replaySurfaceNames[replayFilters[k]]
          : k === "saveState"
            ? replaySaveNames[replayFilters[k]]
            : k === "state"
              ? replayStateNames[replayFilters[k]]
              : k === "failed"
                ? replayFilters[k] === "true"
                  ? "있음"
                  : "보고 없음"
                : k === "audience"
                  ? replayFilters[k] === "internal"
                    ? "내부 테스트"
                    : "미분류"
                  : replayFilters[k];
      const b = replayEl("button", "replay-chip", labels[k] + " · " + value + " ×");
      b.title = labels[k] + " 필터 제거";
      b.onclick = () => {
        delete replayFilters[k];
        if (k === "q") {
          $("replaySearch").value = "";
          $("replaySearchClear").hidden = true;
        }
        replayPersist();
        void replayListGo();
      };
      root.append(b);
    }
  if (root.children.length) {
    const clear = replayEl("button", "ghost", "모두 지우기");
    clear.onclick = replayClearAll;
    root.append(clear);
  }
}
function replayScopeRender(scope) {
  replayScopeData = scope;
  const days = Number($("period").value || 7);
  $("replayScope").textContent =
    (days === 1 ? "최근 24시간" : "최근 " + days + "일") +
    " · " +
    (scope.hideInternal ? "개발자 제외" : "개발자 포함") +
    " · 최근 수집순";
}
function replayFacetGroup(root, title, key, options, names = {}) {
  const row = replayEl("div", "replay-filter-row");
  row.append(replayEl("strong", "", title));
  for (const option of options) {
    const b = replayEl(
      "button",
      "replay-chip",
      (names[option.value] || option.value) + " " + option.count,
    );
    b.type = "button";
    b.dataset.replayFilter = key;
    b.dataset.value = option.value;
    b.setAttribute("aria-pressed", String(replayFilters[key] === option.value));
    b.onclick = () => replayApply(key, option.value);
    row.append(b);
  }
  if (!options.length) row.append(replayEl("span", "sub", "해당 범위의 기록 없음"));
  root.append(row);
}
function replayRenderFacets(data) {
  const active = document.activeElement,
    focus = active?.dataset.replayFilter
      ? [active.dataset.replayFilter, active.dataset.value]
      : null;
  $("replaySurfaceFilters").replaceChildren();
  $("replayFacetFilters").replaceChildren();
  $("replayAdvancedFilters").replaceChildren();
  const f = data.facets;
  replayFacetGroup(
    $("replaySurfaceFilters"),
    "화면",
    "surface",
    f.surfaces || [],
    replaySurfaceNames,
  );
  for (const [title, key, list, names] of [
    ["버전", "appVersion", f.versions],
    ["OS", "os", f.os, { macos: "macOS", windows: "Windows", linux: "Linux" }],
    ["오류", "failed", f.errors, { true: "오류 있음", false: "오류 보고 없음" }],
    ["저장", "saveState", f.saveStates, replaySaveNames],
    ["녹화 상태", "state", f.states, replayStateNames],
  ])
    replayFacetGroup($("replayFacetFilters"), title, key, list || [], names || {});
  replayFacetGroup($("replayAdvancedFilters"), "설치 구분", "audience", f.audiences || [], {
    internal: "내부 테스트",
    unclassified: "미분류",
  });
  $("replayAdvancedFilters").append(
    replayEl(
      "p",
      "sub",
      "환경 · " + data.scope.environment + " · 기간은 상단 설정을 따르고, 개발자 세션은 설치 구분에서 내부를 골랐을 때만 보입니다.",
    ),
  );
  $("replayFacetNote").textContent = data.truncated.length
    ? "선택지가 100개를 넘는 필터가 있습니다. 기간이나 검색 범위를 좁혀 주세요."
    : "태그 선택지는 현재 검색 범위 전체를 기준으로 합니다.";
  if (focus)
    for (const b of document.querySelectorAll("[data-replay-filter]"))
      if (b.dataset.replayFilter === focus[0] && b.dataset.value === focus[1])
        b.focus({ preventScroll: true });
}
function replayReleaseThumb(img) {
  const item = replayThumbs.get(img);
  if (item) {
    item.controller.abort();
    if (item.url) URL.revokeObjectURL(item.url);
    replayThumbs.delete(img);
  }
  img.removeAttribute("src");
  img.hidden = true;
}
const replayThumbObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      const img = entry.target.querySelector("img");
      if (!img) continue;
      img.dataset.near = entry.isIntersecting ? "yes" : "no";
      if (entry.isIntersecting && !img.dataset.failed) {
        replayThumbQueue.push({ img, epoch: replayBrowseEpoch });
        replayPumpThumbs();
      } else replayReleaseThumb(img);
    }
  },
  { root: $("replayScroll"), rootMargin: "160px" },
);
async function replayPumpThumbs() {
  while (replayThumbActive < 2 && replayThumbQueue.length) {
    const { img, epoch } = replayThumbQueue.shift();
    if (
      !img.isConnected ||
      img.dataset.near !== "yes" ||
      replayThumbs.has(img) ||
      epoch !== replayBrowseEpoch
    )
      continue;
    const item = { controller: new AbortController(), url: null };
    replayThumbs.set(img, item);
    replayThumbActive++;
    void replayFetch(img.dataset.url, true, item.controller.signal)
      .then((blob) => {
        if (
          epoch !== replayBrowseEpoch ||
          !img.isConnected ||
          img.dataset.near !== "yes" ||
          item.controller.signal.aborted
        )
          return;
        item.url = URL.createObjectURL(blob);
        img.src = item.url;
        img.hidden = false;
      })
      .catch((e) => {
        if (e.name !== "AbortError") img.dataset.failed = "yes";
      })
      .finally(() => {
        replayThumbActive--;
        replayPumpThumbs();
      });
  }
}
function replayResetThumbs() {
  replayThumbObserver.disconnect();
  for (const img of replayThumbs.keys()) replayReleaseThumb(img);
  replayThumbQueue.length = 0;
}
function replayCard(item) {
  const card = replayEl("article", "replay-card");
  card.setAttribute("role", "listitem");
  card.dataset.replayId = item.replayId;
  const open = replayEl("button", "replay-open");
  open.type = "button";
  open.setAttribute(
    "aria-label",
    replayDate(item.createdAt) + " " + (item.jobCount ? "작업 " + item.jobIds[0] : "앱 세션") + " · 기록 " + item.replayId.slice(0,8) + " 열기",
  );
  open.onclick = () => replayOpen(item.replayId, 0, open);
  const preview = replayEl("div", "replay-preview"),
    placeholder = replayEl("div", "replay-placeholder");
  placeholder.append(
    replayEl("b", "", "▷"),
    replayEl("span", "", item.preview ? "기록 이미지" : "대표 이미지 없음"),
  );
  preview.append(placeholder);
  if (item.preview) {
    const img = replayEl("img");
    img.hidden = true;
    img.alt =
      "기록된 " +
      ({ rough: "러프", final: "최종 프레임", thumbnail: "참고 이미지" }[item.preview.kind] ||
        "이미지");
    img.dataset.url = item.preview.adminUrl;
    img.draggable = false;
    preview.append(img);
    replayThumbObserver.observe(preview);
  }
  preview.append(replayEl("span", "replay-play-mark", "▶ " + replayFormatTime(item.durationMs)));
  const body = replayEl("div", "replay-card-body");
  body.append(
    replayEl(
      "span",
      "replay-card-title",
      item.jobCount
        ? "작업 " +
            replayShort(item.jobIds[0], 18) +
            (item.jobCount > 1 ? " 외 " + (item.jobCount - 1) + "개" : "")
        : "작업 연결 없는 앱 세션",
    ),
    replayEl("span", "replay-card-date", replayDate(item.createdAt)),
  );
  const tags = replayEl("span", "replay-card-tags");
  for (const surface of item.surfaces)
    tags.append(replayEl("span", "", replaySurfaceNames[surface] || surface));
  tags.append(
    replayEl("span", "", item.appVersion),
    replayEl("span", "", item.os),
    replayEl("span", "", replayStateNames[item.state] || item.state),
  );
  if (item.hasError) tags.append(replayEl("span", "error", "오류 있음"));
  if (item.saveStates.includes("saved")) tags.append(replayEl("span", "saved", "저장됨"));
  body.append(tags);
  const ids = replayEl(
    "span",
    "replay-card-ids",
    "설치 " + replayShort(item.installationId, 17) + " · 세션 " + replayShort(item.appSessionId, 8),
  );
  ids.title = "설치 " + item.installationId + " · 앱 세션 " + item.appSessionId;
  body.append(ids);
  open.append(preview, body);
  card.append(open);
  if (item.jobIds.length) {
    const links = replayEl("div", "replay-job-links");
    for (const job of item.jobIds) {
      const b = replayEl("button", "ghost", replayShort(job, 18) + "만 보기");
      b.title = job;
      b.onclick = () => replayForJob(job);
      links.append(b);
    }
    card.append(links);
  }
  return card;
}
function replayEmpty(title, description) {
  const box = replayEl("div", "replay-empty");
  box.append(replayEl("h3", "", title), replayEl("p", "", description));
  $("replayList").replaceChildren(box);
}
async function replayListGo(append = false) {
  if (append && (replayListBusy || !replayBefore)) return;
  if (!append) {
    replayBrowseAbort?.abort();
    replayBrowseAbort = new AbortController();
    replayBrowseEpoch++;
    replayBefore = null;
    replaySeen.clear();
    replayResetThumbs();
    $("replayList").replaceChildren(
      ...Array.from({ length: 3 }, () => replayEl("div", "replay-skeleton")),
    );
    $("replayScroll").scrollTop = 0;
    const to = new Date();
    replayRange = {
      from: new Date(to.getTime() - Number($("period").value || 7) * 86400000).toISOString(),
      to: to.toISOString(),
    };
    $("replaySearch").value = replayFilters.q || "";
    $("replaySearchClear").hidden = !$("replaySearch").value;
    replayApplied();
    $("replayCount").textContent = "";
    for (const b of document.querySelectorAll("[data-replay-filter]")) b.disabled = true;
  }
  const epoch = replayBrowseEpoch,
    signal = replayBrowseAbort.signal,
    q = replayParams();
  q.set("limit", "18");
  if (append) q.set("before", replayBefore);
  replayListBusy = true;
  $("replayScroll").setAttribute("aria-busy", "true");
  $("replayStatus").classList.remove("err");
  $("replayStatus").textContent = append ? "다음 기록을 불러오는 중…" : "최근 기록을 불러오는 중…";
  $("replayMore").disabled = true;
  if (!append) {
    const fq = replayParams();
    void replayFetch("/v1/admin/replays/facets?" + fq, false, signal)
      .then((data) => {
        if (epoch === replayBrowseEpoch) replayRenderFacets(data);
      })
      .catch((e) => {
        if (epoch === replayBrowseEpoch && e.name !== "AbortError") {
          for (const id of ["replaySurfaceFilters", "replayFacetFilters", "replayAdvancedFilters"])
            $(id).replaceChildren();
          $("replayFacetNote").textContent = "태그 선택지를 불러오지 못했습니다.";
        }
      });
  }
  try {
    const data = await replayFetch("/v1/admin/replays?" + q, false, signal);
    if (epoch !== replayBrowseEpoch) return;
    if (!append) $("replayList").replaceChildren();
    for (const item of data.items)
      if (!replaySeen.has(item.replayId)) {
        replaySeen.add(item.replayId);
        $("replayList").append(replayCard(item));
      }
    replayBefore = data.nextBefore;
    replayScopeRender(data.scope);
    $("replayCount").textContent = replaySeen.size + "개 표시";
    $("replayMore").hidden = !replayBefore;
    $("replayStatus").textContent = replaySeen.size
      ? replayBefore
        ? "아래로 내려 더 많은 기록을 확인하세요."
        : "이 범위의 기록을 모두 확인했습니다."
      : "검색과 태그를 지우거나 기간을 넓혀 보세요.";
    if (!replaySeen.size)
      replayEmpty(
        "이 범위에 기록이 없습니다",
        "기간·검색·태그·개발자 제외 기준을 확인해 주세요. 미수집을 작업 실패로 해석하지 않습니다.",
      );
  } catch (e) {
    if (epoch !== replayBrowseEpoch || e.name === "AbortError") return;
    $("replayStatus").classList.add("err");
    $("replayStatus").textContent = e.message;
    if (!append)
      replayEmpty(
        e.status === 403 ? "리플레이를 열 수 없습니다" : "기록을 불러오지 못했습니다",
        e.message,
      );
    $("replayMore").hidden = !append;
  } finally {
    if (epoch === replayBrowseEpoch) {
      replayListBusy = false;
      $("replayScroll").setAttribute("aria-busy", "false");
      $("replayMore").disabled = false;
    }
  }
}
function replayPause() {
  replayPlaying = false;
  replayPlayer?.pause();
  $("replayPlay").textContent = "재생";
}
function replayCleanup() {
  replayModalEpoch++;
  replayWindowEpoch++;
  replayModalAbort?.abort();
  replayWindowAbort?.abort();
  clearInterval(replayClock);
  replayPause();
  replayLoading = false;
  replayScrubbing = false;
  const frame = $("replayFrame");
  frame.onload = null;
  replayPlayer?.destroy();
  replayPlayer = null;
  frame.srcdoc = "";
  for (const url of replayAssets.values()) URL.revokeObjectURL(url);
  replayAssets.clear();
  replayAssetPending.clear();
  replayAssessments.clear();
  replaySelected = {};
  replayManifest = null;
  $("replayCompare").replaceChildren();
  $("replayTimeline").replaceChildren();
}
function replayClose() {
  if ($("replayDialog").open) $("replayDialog").close();
  replayCleanup();
  if (replayOpener?.isConnected && replayOpener.getClientRects().length)
    replayOpener.focus({ preventScroll: true });
  else document.querySelector("#tabs button.on")?.focus();
}
function replayUpdateTime() {
  const range = $("replayScrub");
  range.max = String(replayDuration);
  range.value = String(replaySeek);
  range.disabled = !replayDuration;
  range.setAttribute(
    "aria-valuetext",
    replayFormatTime(replaySeek) + " / " + replayFormatTime(replayDuration),
  );
  $("replayTime").textContent =
    replayFormatTime(replaySeek) + " / " + replayFormatTime(replayDuration);
}
function replayWindowAt(time) {
  const chunks = (replayManifest?.streams || []).flatMap((s) =>
    s.chunks.map((c) => ({
      window: s.windowInstanceId,
      start: c.startedOffsetMs,
      end: c.endedOffsetMs,
    })),
  );
  return (
    chunks
      .filter((c) => c.start <= time)
      .sort((a, b) => b.start - a.start || a.window.localeCompare(b.window))[0]?.window ||
    chunks.sort((a, b) => a.start - b.start)[0]?.window
  );
}
function replaySyncWindowStatus() {
  const st = replayManifest?.streams.find(s => s.windowInstanceId === $("replayWindow").value);
  if (!st || replayLoading) return false;
  const start = Math.min(...st.chunks.map(c => c.startedOffsetMs)), end = Math.max(...st.chunks.map(c => c.endedOffsetMs));
  const outside = replaySeek < start || replaySeek > end;
  if (outside !== replayOutside && replayPlayer && replayPlaying && !replayScrubbing) {
    if (outside) replayPlayer.pause(); else replayPlayer.seek(replaySeek, true);
  }
  replayOutside = outside;
  $("replayPlaybackStatus").textContent = (replaySurfaceNames[st.surface] || st.surface) + (outside ? " · 이 시간대에는 이 창의 기록이 없습니다 (" + replayFormatTime(start) + "–" + replayFormatTime(end) + ")." : replayMissing ? " · 청크 또는 이미지 누락 " + replayMissing + "개" : " · 기록된 구간을 드래그해서 확인하세요.");
  return !outside;
}
function replayDoSeek(time) {
  replaySeek = Math.max(0, Math.min(replayDuration, time));
  replayUpdateTime();
  const target = $("replayFollow").checked ? replayWindowAt(replaySeek) : $("replayWindow").value;
  if (target && target !== $("replayWindow").value) {
    $("replayWindow").value = target;
    void replayLoadWindow();
  } else if (replayPlayer && !replayLoading)
    replayPlayer.seek(replaySeek, replayPlaying && !replayScrubbing && replaySyncWindowStatus());
}
function replayStart() {
  if (!replayManifest || replayLoading || !replayDuration) return;
  if (replaySeek >= replayDuration) replayDoSeek(0);
  replayPlaying = true;
  replayLastTick = performance.now();
  $("replayPlay").textContent = "일시정지";
  if (replaySyncWindowStatus()) replayPlayer?.play(Number($("replaySpeed").value));
}
async function replayAsset(asset, epoch) {
  if (replayAssets.has(asset.contentHash)) return replayAssets.get(asset.contentHash);
  if (replayAssetPending.has(asset.contentHash)) return replayAssetPending.get(asset.contentHash);
  const promise = (async () => {
    const blob = await replayFetch(asset.adminUrl, true, replayModalAbort.signal);
    if (epoch !== replayModalEpoch) return null;
    const url = URL.createObjectURL(blob);
    replayAssets.set(asset.contentHash, url);
    replaySelected[asset.contentHash] = url;
    return url;
  })();
  replayAssetPending.set(asset.contentHash, promise);
  try {
    return await promise;
  } finally {
    if (replayAssetPending.get(asset.contentHash) === promise)
      replayAssetPending.delete(asset.contentHash);
  }
}
async function replayLoadBundle() {
  if (replayBundle) return replayBundle;
  if (!replayBundlePromise)
    replayBundlePromise = (async () => {
      const blob = await replayFetch("/v1/admin/replay-player.js", true);
      const url = URL.createObjectURL(
        new Blob([await blob.text()], { type: "application/javascript" }),
      );
      try {
        return (replayBundle = await import(url));
      } finally {
        URL.revokeObjectURL(url);
      }
    })().finally(() => (replayBundlePromise = null));
  return replayBundlePromise;
}
async function replayOpen(id, seek = 0, opener = document.activeElement) {
  replayCleanup();
  replayOpener = opener;
  const epoch = replayModalEpoch;
  replayModalAbort = new AbortController();
  replaySeek = seek;
  replayDuration = 0;
  replayUpdateTime();
  if (!$("replayDialog").open) $("replayDialog").showModal();
  $("replayClose").focus();
  $("replayTitle").textContent = "리플레이 불러오는 중…";
  $("replayMeta").textContent = "";
  $("replayGaps").textContent = "";
  $("replayPlay").disabled = true;
  $("replayPlaybackStatus").textContent = "기록을 불러오는 중…";
  try {
    const m = await replayFetch(
      "/v1/admin/replays/" + encodeURIComponent(id) + "/manifest",
      false,
      replayModalAbort.signal,
    );
    if (epoch !== replayModalEpoch) return;
    replayManifest = m;
    replayDuration = Math.max(0, ...m.streams.flatMap((s) => s.chunks.map((c) => c.endedOffsetMs)));
    $("replayTitle").textContent = replayDate(m.session.startedAt) + " 리플레이";
    $("replayMeta").textContent =
      m.session.appVersion + " · " + m.session.os + " · 앱 세션 " + m.session.appSessionId;
    $("replayGaps").textContent =
      (m.gaps.length
        ? "종료 미전송 또는 기록 누락 " + m.gaps.length + "곳 · "
        : "청크 순서 누락 없음 · ") +
      (m.assets.some((a) => ["canvas_frame", "final"].includes(a.kind))
        ? "3D 표본 있음"
        : "3D 표본 없음");
    const select = $("replayWindow");
    select.replaceChildren();
    for (const st of m.streams) {
      const o = replayEl(
        "option",
        "",
        replaySurfaceNames[st.surface] + " · " + replayShort(st.windowInstanceId, 10),
      );
      o.value = st.windowInstanceId;
      select.append(o);
    }
    select.value = replayWindowAt(replaySeek) || select.value;
    $("replayFollow").checked = true;
    for (const event of m.timeline) replayAnnotation(event.name, event.offsetMs);
    replayCompareItems = m.assets.filter((a) => ["rough", "final", "csp_result"].includes(a.kind));
    replayCompareCount = 0;
    $("replayCompareDetails").open = false;
    $("replayCompareSummary").textContent =
      "기록 이미지 비교 · " + replayCompareItems.length + "개";
    $("replayCompareMore").hidden = true;
    await replayLoadBundle();
    if (epoch !== replayModalEpoch) return;
    await replayLoadWindow();
    if (epoch !== replayModalEpoch) return;
    replayClock = setInterval(() => {
      const now = performance.now(),
        dt = now - replayLastTick;
      replayLastTick = now;
      if (!replayPlaying || replayLoading || replayScrubbing) return;
      replaySeek = Math.min(replayDuration, replaySeek + dt * Number($("replaySpeed").value));
      replayUpdateTime();
      const target = $("replayFollow").checked ? replayWindowAt(replaySeek) : null;
      if (target && target !== $("replayWindow").value) {
        $("replayWindow").value = target;
        void replayLoadWindow();
      }
      if (!replayLoading) replaySyncWindowStatus();
      if (replaySeek >= replayDuration) replayPause();
    }, 50);
  } catch (e) {
    if (epoch !== replayModalEpoch || e.name === "AbortError") return;
    $("replayTitle").textContent = e.message;
    $("replayPlaybackStatus").textContent = "기록을 열 수 없습니다.";
  }
}
function replayAnnotation(name, offset, assessment) {
  const names = {
    analysis_failed: "분석 오류",
    export_failed: "저장 오류",
    export_completed: "저장 완료",
    search_input: "검색 입력",
    search_submitted: "검색 실행",
    feature_action: "작업 동작",
    input_confirmed: "입력 확정",
    replay_gap: "기록 누락",
    csp_result_captured: "CSP 결과 사진",
    csp_result_assessment: "사용자 평가",
  };
  const b = replayEl(
    "button",
    "ghost",
    replayFormatTime(offset) + " " + (names[name] || name) + (assessment ? " · " + assessment : ""),
  );
  b.onclick = () => replayDoSeek(Math.max(0, offset - (/error|fail/i.test(name) ? 5000 : 0)));
  $("replayTimeline").append(b);
  return b;
}
async function replayLoadWindow() {
  const epoch = replayModalEpoch,
    windowEpoch = ++replayWindowEpoch,
    m = replayManifest,
    st = m?.streams.find((s) => s.windowInstanceId === $("replayWindow").value);
  if (!st) {
    $("replayPlaybackStatus").textContent = "수집된 창이 없습니다.";
    return;
  }
  replayWindowAbort?.abort();
  replayWindowAbort = new AbortController();
  replayLoading = true;
  replayPlayer?.destroy();
  replayPlayer = null;
  $("replayPlay").disabled = true;
  $("replayPlaybackStatus").textContent = "화면을 불러오는 중…";
  $("replayTimeline")
    .querySelectorAll("[data-replay-custom]")
    .forEach((n) => n.remove());
  const current = () => epoch === replayModalEpoch && windowEpoch === replayWindowEpoch;
  try {
    let events = [],
      missing = 0;
    for (const chunk of st.chunks) {
      try {
        events.push(...(await replayFetch(chunk.url, false, replayWindowAbort.signal)).events);
      } catch (e) {
        if (e.name === "AbortError") throw e;
        missing++;
      }
      if (!current()) return;
      if (events.length > 100000) throw Error("한 화면의 재생 범위를 초과했습니다.");
    }
    events.sort((a, b) => a.timestamp - b.timestamp);
    if (!events.length) throw Error("이 창에 재생할 기록이 없습니다.");
    const hashes = new Set();
    for (const match of JSON.stringify(events).matchAll(
      /(?:replay-asset:\/\/|"(?:assetHash|backgroundAssetHash|roughAssetHash)":")([a-f0-9]{64})/g,
    ))
      hashes.add(match[1]);
    const needed = [
      ...new Map(
        m.assets.filter((a) => hashes.has(a.contentHash)).map((a) => [a.contentHash, a]),
      ).values(),
    ];
    for (let i = 0; i < needed.length; i += 3) {
      await Promise.all(
        needed.slice(i, i + 3).map((a) =>
          replayAsset(a, epoch).catch(() => {
            missing++;
          }),
        ),
      );
      if (!current()) return;
    }
    for (const event of events.filter(
      (e) =>
        e.type === 5 &&
        e.data?.tag &&
        !["surface", "visibility", "capture_overlay", "canvas_frame"].includes(e.data.tag),
    )) {
      const b = replayAnnotation(
        event.data.tag,
        event.timestamp - m.session.startedAt,
        { good: "잘 나왔어요", bad: "이상해요", cannot_import: "불러오지 못했어요" }[
          event.data.payload?.assessment
        ],
      );
      b.dataset.replayCustom = "true";
    }
    for (const event of events.filter(
      (e) => e.type === 5 && e.data?.tag === "csp_result_assessment",
    )) {
      const p = event.data.payload || {};
      replayAssessments.set(p.assetHash + ":" + p.artifactHash, p.assessment);
    }
    replayUpdateAssessments();
    const frame = $("replayFrame"),
      csp =
        "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src blob: data:; font-src blob:; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src about:; form-action 'none'; base-uri 'none'";
    frame.onload = () => {
      if (!current() || frame.contentDocument?.body.dataset.window !== String(windowEpoch)) return;
      try {
        replayPlayer = replayBundle.createReplayPlayer(frame, {
          events,
          assets: replaySelected,
          surface: st.surface,
          startedAt: m.session.startedAt,
          seekMs: replaySeek,
          externalControls: true,
        });
        replayLoading = false;
        $("replayPlay").disabled = !replayDuration;
        replayMissing = missing;
        replaySyncWindowStatus();
        replayUpdateTime();
        if (replayPlaying && !replayScrubbing) replayPlayer.play(Number($("replaySpeed").value));
      } catch (e) {
        replayLoading = false;
        $("replayPlaybackStatus").textContent = "재생 초기화 실패: " + e.message;
      }
    };
    frame.srcdoc =
      '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="' +
      csp.replace(/"/g, "&quot;") +
      '"><meta name="referrer" content="no-referrer"></head><body data-window="' +
      windowEpoch +
      '"></body></html>';
  } catch (e) {
    if (!current() || e.name === "AbortError") return;
    replayLoading = false;
    replayPause();
    $("replayPlaybackStatus").textContent = e.message;
  }
}
function replayUpdateAssessments() {
  for (const f of $("replayCompare").querySelectorAll("figure")) {
    const value =
      replayAssessments.get(f.dataset.assetHash + ":" + f.dataset.artifactHash) ||
      f.dataset.assessment;
    const label = { good: "잘 나왔어요", bad: "이상해요", cannot_import: "불러오지 못했어요" }[
      value
    ];
    f.querySelector("figcaption").textContent =
      f.dataset.caption + (label ? " · 사용자 평가: " + label : "");
  }
}
async function replayCompareMore() {
  const epoch = replayModalEpoch,
    items = replayCompareItems.slice(replayCompareCount, replayCompareCount + 12);
  replayCompareCount += items.length;
  $("replayCompareMore").hidden = replayCompareCount >= replayCompareItems.length;
  for (const asset of items) {
    const figure = replayEl("figure"),
      caption = replayEl(
        "figcaption",
        "",
        ({ rough: "러프", final: "최종 프레임", csp_result: "CSP 결과 사진" }[asset.kind] ||
          asset.kind) +
          " · " +
          asset.snapshotVersion +
          (asset.kind === "csp_result" ? " · 앱 보고 선택 / BFF 산출물 대조" : ""),
      );
    figure.dataset.assetHash = asset.contentHash;
    figure.dataset.artifactHash = asset.artifactHash || "";
    figure.dataset.assessment = asset.assessment || "";
    figure.dataset.caption = caption.textContent;
    figure.append(caption);
    $("replayCompare").append(figure);
    replayUpdateAssessments();
    try {
      const url = await replayAsset(asset, epoch);
      if (epoch !== replayModalEpoch) return;
      const img = replayEl("img");
      img.alt = asset.kind;
      img.src = url;
      figure.prepend(img);
    } catch (e) {
      if (epoch !== replayModalEpoch) return;
      figure.prepend(replayEl("p", "sub", "이미지 누락 또는 만료"));
    }
  }
}
function replayForJob(jobId) {
  replayFilters = { jobId };
  replayPersist();
  if ($("drawer").classList.contains("on")) closeDrawer();
  const loaded = loadedTabs.has("replay");
  selectTab("replay");
  if (loaded) void replayListGo();
  $("replayPanel").scrollIntoView({ block: "start" });
}
$("replaySearch").value = replayFilters.q || "";
$("replaySearchClear").hidden = !$("replaySearch").value;
$("replaySearchForm").onsubmit = (e) => {
  e.preventDefault();
  const value = $("replaySearch").value.trim();
  if (value) replayFilters.q = value;
  else delete replayFilters.q;
  replayPersist();
  void replayListGo();
};
$("replaySearch").oninput = () => {
  $("replaySearchClear").hidden = !$("replaySearch").value;
};
$("replaySearchClear").onclick = () => {
  $("replaySearch").value = "";
  delete replayFilters.q;
  replayPersist();
  void replayListGo();
  $("replaySearch").focus();
};
$("replayRefresh").onclick = () => replayListGo();
$("replayMore").onclick = () => replayListGo(true);
new IntersectionObserver(
  (entries) => {
    if (entries.some((e) => e.isIntersecting) && replayBefore) void replayListGo(true);
  },
  { root: $("replayScroll"), rootMargin: "180px" },
).observe($("replaySentinel"));
let replayDrag,
  suppressReplayClick = false;
$("replayScroll").addEventListener("pointerdown", (e) => {
  if (e.pointerType !== "mouse" || e.button !== 0 || e.target.closest("input,select")) return;
  replayDrag = { id: e.pointerId, y: e.clientY, top: $("replayScroll").scrollTop, moved: false };
});
$("replayScroll").addEventListener("pointermove", (e) => {
  if (!replayDrag || e.pointerId !== replayDrag.id) return;
  if (!(e.buttons & 1)) {
    replayEndDrag();
    return;
  }
  if (!replayDrag.moved && Math.abs(e.clientY - replayDrag.y) > 8) {
    replayDrag.moved = true;
    $("replayScroll").setPointerCapture(e.pointerId);
    $("replayScroll").classList.add("dragging");
  }
  if (replayDrag.moved) {
    e.preventDefault();
    $("replayScroll").scrollTop = replayDrag.top - (e.clientY - replayDrag.y);
  }
});
function replayEndDrag() {
  if (replayDrag?.moved) {
    suppressReplayClick = true;
    setTimeout(() => (suppressReplayClick = false), 0);
  }
  $("replayScroll").classList.remove("dragging");
  replayDrag = null;
}
$("replayScroll").addEventListener("pointerup", replayEndDrag);
$("replayScroll").addEventListener("pointercancel", replayEndDrag);
$("replayScroll").addEventListener(
  "click",
  (e) => {
    if (suppressReplayClick) {
      e.preventDefault();
      e.stopPropagation();
    }
  },
  true,
);
$("replayClose").onclick = replayClose;
$("replayDialog").addEventListener("cancel", (e) => {
  e.preventDefault();
  replayClose();
});
$("replayDialog").addEventListener("close", () => {
  if (replayManifest) replayCleanup();
});
$("replayPlay").onclick = () => (replayPlaying ? replayPause() : replayStart());
$("replayWindow").onchange = () => {
  $("replayFollow").checked = false;
  void replayLoadWindow();
};
$("replayFollow").onchange = () => replayDoSeek(replaySeek);
$("replaySpeed").onchange = () => replayPlayer?.setSpeed(Number($("replaySpeed").value));
$("replayScrub").oninput = () => replayDoSeek(Number($("replayScrub").value));
$("replayScrub").addEventListener("pointerdown", () => {
  replayScrubbing = true;
  replayPlayer?.pause();
});
window.addEventListener("pointerup", () => {
  replayEndDrag();
  if (replayScrubbing) {
    replayScrubbing = false;
    replayLastTick = performance.now();
    if (replayPlaying) if (replaySyncWindowStatus()) replayPlayer?.play(Number($("replaySpeed").value));
  }
});
$("replayScrub").addEventListener("keydown", (e) => {
  if (["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(e.key)) {
    e.preventDefault();
    const step = e.shiftKey || e.key.startsWith("Page") ? 10000 : 1000;
    replayDoSeek(
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? replayDuration
          : replaySeek + (["ArrowLeft", "PageDown"].includes(e.key) ? -step : step),
    );
  }
});
$("replayCompareDetails").ontoggle = () => {
  if ($("replayCompareDetails").open && !replayCompareCount) void replayCompareMore();
};
$("replayCompareMore").onclick = replayCompareMore;
document.addEventListener("click", (e) => {
  const job = e.target.closest("[data-replay-job]");
  if (job) {
    replayForJob(job.dataset.replayJob);
    return;
  }
  const metric = e.target.closest("[data-replay-metric]");
  if (metric) {
    replayFilters = {};
    if (metric.dataset.replayMetric === "errors") replayFilters.failed = "true";
    const feature = $("journeyDetailFeature")?.value;
    if (feature && feature !== "all") replayFilters.feature = feature;
    replayPersist();
    const loaded = loadedTabs.has("replay");
    selectTab("replay");
    if (loaded) void replayListGo();
  }
});
`;
