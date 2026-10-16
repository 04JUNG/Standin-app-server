// 운영 대시보드 한 장(계획 3단계).
//
// 의존성이 없는 정적 HTML이다. 번들러도 CDN도 쓰지 않는 이유는 이 화면이 **장애 때**
// 열리는 화면이기 때문이다 — 외부 CDN이 막히거나 느릴 때 대시보드까지 안 뜨면 곤란하다.
// 차트도 라이브러리 없이 인라인 SVG로 그린다.
//
// 토큰은 페이지에 심지 않는다. 주소창의 ?token= 은 로드 직후 history.replaceState로
// 지우고 sessionStorage에만 남긴다 — 브라우저 히스토리·리퍼러에 토큰이 남지 않게 한다.

import {
  COCO17_EDGES,
  COCO17_KEYPOINT_NAMES,
  JOINT_SCORE_FAINT,
  PERSON_COLORS,
} from "./skeleton.js";

// 뼈대 상수는 TypeScript 모듈 하나에만 둔다. 화면용 사본을 따로 적으면 관절 순서가
// 조용히 어긋나므로, 여기서 JSON으로 심어 브라우저와 테스트가 같은 값을 쓰게 한다.
const SKELETON_CONSTANTS = String.raw`
const EDGES = ${JSON.stringify(COCO17_EDGES)};
const JOINT_NAMES = ${JSON.stringify(COCO17_KEYPOINT_NAMES)};
const JOINT_FAINT = ${JSON.stringify(JOINT_SCORE_FAINT)};
const PERSON_COLORS = ${JSON.stringify(PERSON_COLORS)};
`;

export const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Standin 운영 대시보드</title>
<style>
  :root {
    color-scheme: light dark;
    --bg:#f6f5f2; --panel:#ffffff; --line:#e4e2dc; --grid:#eeece7; --text:#1d2025; --muted:#686d74;
    --ok:#2f7d5b; --warn:#b5651d; --bad:#b23a3a; --accent:#1d2025;
    --c-users:#c0701f; --c-jobs:#2f7d5b; --c-down:#7a5ca3; --c-fail:#b23a3a;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#131519; --panel:#1b1e23; --line:#2c3038; --grid:#23262c; --text:#eceef1; --muted:#a0a6af;
            --ok:#5fb88f; --warn:#e39b55; --bad:#e07070; --accent:#eceef1;
            --c-users:#e39b55; --c-jobs:#5fb88f; --c-down:#b195dc; --c-fail:#e07070; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:15px/1.6 "Pretendard","Apple SD Gothic Neo","Malgun Gothic",ui-sans-serif,system-ui,sans-serif; -webkit-font-smoothing:antialiased; }
  header { padding:16px 20px; border-bottom:1px solid var(--line); display:flex; gap:16px; align-items:center; flex-wrap:wrap; }
  h1 { font-size:16px; margin:0; font-weight:600; }
  main { padding:20px; display:grid; gap:16px; max-width:1200px; margin:0 auto; }
  .row { display:grid; gap:16px; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:18px 20px; }
  .card h2 { font-size:15px; margin:0 0 12px; color:var(--text); font-weight:700; letter-spacing:0; }
  .big { font-size:28px; font-weight:650; font-variant-numeric:tabular-nums; }
  .sub { color:var(--muted); font-size:12px; }
  .pill { display:inline-flex; align-items:center; gap:6px; padding:3px 9px; border-radius:999px; font-size:12px; font-weight:600; }
  .pill.ok { background:color-mix(in srgb,var(--ok) 18%,transparent); color:var(--ok); }
  .pill.warn { background:color-mix(in srgb,var(--warn) 18%,transparent); color:var(--warn); }
  .pill.bad { background:color-mix(in srgb,var(--bad) 18%,transparent); color:var(--bad); }
  table { width:100%; border-collapse:collapse; font-variant-numeric:tabular-nums; }
  th,td { text-align:left; padding:9px 10px; border-bottom:1px solid var(--line); }
  th { color:var(--muted); font-size:12.5px; font-weight:600; }
  td.num, th.num { text-align:right; }
  .scroll { overflow-x:auto; }
  svg { display:block; width:100%; height:120px; }
  .empty { color:var(--muted); padding:12px 0; }
  button { font:inherit; background:var(--accent); color:var(--panel); border:0; border-radius:8px; padding:7px 14px; font-weight:600; cursor:pointer; }
  input { font:inherit; background:var(--bg); color:var(--text); border:1px solid var(--line); border-radius:8px; padding:7px 10px; min-width:280px; }
  #gate { display:none; padding:40px 20px; max-width:460px; margin:0 auto; }
  #gate.show { display:block; }
  #app.hide { display:none; }
  .lookup { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .lookup input { min-width:340px; flex:1; }
  select { font:inherit; background:var(--bg); color:var(--text); border:1px solid var(--line); border-radius:8px; padding:7px 10px; }
  button.ghost { background:transparent; color:var(--muted); border:1px solid var(--line); padding:3px 9px; font-size:12px; font-weight:500; }
  button.ghost:hover { color:var(--text); border-color:var(--accent); }
  .err { color:var(--bad); }
  .mono { font-family:ui-monospace,"Cascadia Mono",Consolas,monospace; font-size:12px; }
  .detail { border:1px solid var(--line); border-radius:10px; padding:14px 16px; margin-top:14px; background:var(--bg); }
  .detail h3 { font-size:13px; margin:16px 0 8px; font-weight:600; }
  .shot { max-width:320px; width:100%; border:1px solid var(--line); border-radius:8px; display:block; }
  .cands { display:grid; gap:10px; grid-template-columns:repeat(auto-fill,minmax(118px,1fr)); }
  .cand { border:1px solid var(--line); border-radius:8px; padding:8px; }
  .cand.sel { border-color:var(--accent); box-shadow:0 0 0 1px var(--accent) inset; }
  .cand img { width:100%; aspect-ratio:3/4; object-fit:contain; background:var(--panel); border-radius:6px; }
  .cand .sub { font-size:11px; }
  .side { display:grid; gap:16px; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); align-items:start; }
  .bar { height:6px; background:var(--accent); border-radius:3px; min-width:2px; }
  .cohort { background:var(--bg); border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
  .cohort.hot { border-color:var(--warn); }
  .cohort .big { font-size:22px; }
  .gap { color:var(--bad); font-weight:600; }
  .shotWrap { position:relative; max-width:320px; }
  .shotWrap .shot { max-width:none; width:100%; }
  .shotWrap .ovl { position:absolute; inset:0; width:100%; height:100%; pointer-events:none; }
  .shotWrap.solo .ovl { position:static; background:var(--panel); border:1px solid var(--line); border-radius:8px; }
  .ovl .bone { stroke-linecap:round; fill:none; }
  .ovl .joint { stroke:#0b0e14; stroke-width:.6; }
  .ovl .faint { opacity:.35; }
  .ovl .box { fill:none; stroke-dasharray:6 4; opacity:.7; }
  .ovl.noBones .bone, .ovl.noJoints .joint, .ovl.noBoxes .box { display:none; }
  .ovl g.person.off { display:none; }
  .legend { display:flex; gap:6px; flex-wrap:wrap; align-items:center; margin:8px 0 0; }
  .legend .chip { border:1px solid var(--line); border-radius:999px; padding:2px 10px; font-size:12px; cursor:pointer; background:transparent; color:var(--text); font-weight:500; }
  .legend .chip.off { opacity:.4; text-decoration:line-through; }
  .legend .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:5px; }
  .toggles { display:flex; gap:12px; flex-wrap:wrap; margin-top:6px; }
  .toggles label { font-size:12px; color:var(--muted); display:inline-flex; gap:4px; align-items:center; cursor:pointer; }
  .toggles input { min-width:0; }
  .tagline { display:flex; gap:6px; flex-wrap:wrap; margin:4px 0 8px; }
  .tag { border:1px solid var(--line); border-radius:6px; padding:2px 8px; font-size:12px; color:var(--muted); }
  .tag b { color:var(--text); font-weight:600; }
  /* ── v2: 머리글·탭·KPI·서랍 ─────────────────────────────── */
  header { position:sticky; top:0; z-index:20; background:var(--bg); }
  header .spacer { margin-left:auto; }
  header select { padding:4px 8px; }
  nav.tabs { display:flex; gap:4px; padding:0 20px; border-bottom:1px solid var(--line); position:sticky; top:57px; z-index:19; background:var(--bg); overflow-x:auto; }
  nav.tabs button { background:transparent; color:var(--muted); border:0; border-bottom:2px solid transparent; border-radius:0; padding:10px 14px; font-weight:600; }
  nav.tabs button.on { color:var(--text); border-bottom-color:var(--accent); }
  nav.tabs button:hover { color:var(--text); }
  section.tab { display:none; gap:16px; }
  section.tab.on { display:grid; }
  .kpis { display:grid; gap:12px; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); }
  .kpi { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:14px 16px; }
  .kpi .label { font-size:12px; color:var(--muted); font-weight:600; }
  .kpi .value { font-size:26px; font-weight:700; font-variant-numeric:tabular-nums; margin-top:4px; }
  .kpi .hint { font-size:11px; color:var(--muted); margin-top:2px; }
  .kpi.warn .value { color:var(--warn); }
  .kpi.bad .value { color:var(--bad); }
  .grid2 { display:grid; gap:16px; grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); }
  .card h2 .ghost { float:right; }
  tbody tr:hover { background:color-mix(in srgb,var(--accent) 6%,transparent); }
  #backdrop { position:fixed; inset:0; background:rgba(0,0,0,.35); z-index:40; display:none; }
  #backdrop.on { display:block; }
  #drawer { position:fixed; top:0; right:0; bottom:0; width:min(920px,100vw); background:var(--bg); border-left:1px solid var(--line); z-index:41; transform:translateX(100%); transition:transform .18s ease; display:flex; flex-direction:column; }
  #drawer.on { transform:translateX(0); }
  .drawer-head { display:flex; gap:8px; align-items:center; padding:12px 16px; border-bottom:1px solid var(--line); }
  .drawer-head #drawerTitle { font-weight:600; font-size:14px; }
  .drawer-body { overflow-y:auto; padding:0 16px 24px; flex:1; }
  .drawer-body .detail { border:0; padding:0; background:transparent; }
  /* ── 선 차트 ─────────────────────────────────────────────── */
  .lc { width:100%; height:auto; display:block; overflow:visible; }
  .lc text { font-size:12px; fill:var(--muted); font-family:inherit; }
  .lc .day { fill:var(--text); font-weight:600; }
  .lc .val { font-size:12.5px; font-weight:700; }
  .lc .grid { stroke:var(--grid); stroke-width:1; }
  .lc .axis { stroke:var(--line); stroke-width:1; }
  .lc .cursor { stroke:var(--muted); stroke-width:1; stroke-dasharray:2 3; }
  .chart-title { display:flex; align-items:baseline; gap:8px; margin:14px 0 2px; font-size:13.5px; font-weight:700; }
  .chart-title .swatch { display:inline-block; width:18px; height:0; border-top:2px dotted; transform:translateY(-3px); }
  .chart-summary { font-size:13.5px; color:var(--text); margin:10px 0 0; min-height:22px; }
  .chart-summary .sub { font-size:12.5px; }
  .seg { display:inline-flex; border:1px solid var(--line); border-radius:8px; overflow:hidden; }
  .seg button { background:var(--panel); color:var(--text); border:0; border-right:1px solid var(--line); border-radius:0; padding:6px 14px; font-weight:500; }
  .seg button:last-child { border-right:0; }
  .seg button.on { background:color-mix(in srgb,var(--c-users) 14%,var(--panel)); font-weight:700; }
  .controls { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
  /* ── 모아 보기 ─────────────────────────────────────────────── */
  .gal { display:grid; grid-template-columns:220px 1fr; gap:16px; margin-top:14px; align-items:start; }
  @media (max-width:760px) { .gal { grid-template-columns:1fr; } }
  .folders { border:1px solid var(--line); border-radius:10px; max-height:640px; overflow-y:auto; }
  .folders button { display:flex; justify-content:space-between; gap:8px; width:100%; text-align:left; background:transparent; color:var(--text); border:0; border-bottom:1px solid var(--line); border-radius:0; padding:9px 12px; font-weight:500; }
  .folders button:last-child { border-bottom:0; }
  .folders button.on { background:color-mix(in srgb,var(--c-users) 12%,var(--panel)); font-weight:700; }
  .folders .count { color:var(--muted); font-variant-numeric:tabular-nums; }
  .tiles { display:grid; gap:12px; grid-template-columns:repeat(auto-fill,minmax(160px,1fr)); }
  .tile { border:1px solid var(--line); border-radius:10px; overflow:hidden; background:var(--panel); cursor:pointer; text-align:left; padding:0; color:var(--text); font-weight:400; }
  .tile:hover { border-color:var(--text); }
  .tile .img { aspect-ratio:3/4; background:var(--bg); display:flex; align-items:center; justify-content:center; }
  .tile img { width:100%; height:100%; object-fit:contain; }
  .tile .cap { padding:8px 10px; font-size:12.5px; display:grid; gap:4px; }
  .tile .bar { height:4px; }
  .o-selected { background:var(--ok); } .o-no_selection { background:var(--warn); } .o-zero_people { background:var(--muted); }
  .o-failed { background:var(--bad); } .o-in_progress { background:var(--line); }
  /* ── 사용자 활동 ──────────────────────────────────────────── */
  .days { display:grid; grid-template-columns:repeat(14,1fr); gap:4px; margin:10px 0 4px; }
  .day { text-align:center; font-size:11.5px; color:var(--muted); padding:6px 0; border-radius:8px; }
  .day.today { background:color-mix(in srgb,var(--c-users) 10%,var(--panel)); color:var(--text); font-weight:700; }
  .dot { width:14px; height:14px; border-radius:50%; margin:5px auto 3px; border:2px solid var(--line); }
  .t-selected { background:var(--ok); border-color:var(--ok); } .t-no_selection { background:var(--warn); border-color:var(--warn); }
  .t-failed { background:var(--bad); border-color:var(--bad); } .t-visit_only { border-color:var(--muted); }
  .strip { display:inline-flex; gap:3px; }
  .strip i { width:9px; height:9px; border-radius:50%; border:1.5px solid var(--line); display:inline-block; }
  .strip i.v { border-color:var(--muted); } .strip i.j { background:var(--c-jobs); border-color:var(--c-jobs); }
  .dayhead { margin:16px 0 6px; font-weight:700; font-size:14px; }
  /* 배지·버튼이 좁은 칸에서 "후보 선 / 택"처럼 쪼개지지 않게 한다. 칸이 모자라면 표가 가로로 흐른다. */
  .pill, button { white-space:nowrap; }
  #activityOut td { white-space:nowrap; }
</style>
</head>
<body>
<div id="gate">
  <h1>운영 대시보드</h1>
  <p class="sub">관리자 토큰을 입력하세요. 이 브라우저 탭에만 보관되며 주소창에는 남지 않습니다.</p>
  <p><input id="token" type="password" placeholder="X-Beta-Admin-Token" autocomplete="off"></p>
  <p><button id="enter">열기</button> <span id="gateError" class="sub"></span></p>
</div>

<div id="app" class="hide">
  <header>
    <h1>Standin 운영</h1>
    <span id="inference"></span>
    <span id="analysis"></span>
    <span id="tasks" class="sub"></span>
    <span class="spacer"></span>
    <label class="sub" style="display:inline-flex;gap:6px;align-items:center">기간
      <select id="period">
        <option value="1">오늘</option>
        <option value="7" selected>7일</option>
        <option value="14">14일</option>
        <option value="30">30일</option>
        <option value="90">90일</option>
      </select>
    </label>
    <span class="sub" title="열람 기록이 이 이름으로 남는다">
      <span id="reviewer">—</span> · 갱신 <span id="updated">—</span>
    </span>
  </header>
  <nav class="tabs" id="tabs">
    <button data-tab="overview" class="on">개요</button>
    <button data-tab="jobs">작업</button>
    <button data-tab="installs">설치</button>
    <button data-tab="gallery">모아 보기</button>
    <button data-tab="metrics">지표</button>
    <button data-tab="ops">운영</button>
  </nav>
  <main>
    <section class="tab on" id="tab-overview">
      <div id="kpis" class="kpis"><p class="empty">불러오는 중…</p></div>
      <p class="sub" id="kpiNote"></p>
      <div class="card">
        <h2>시간대별 활동</h2>
        <div class="controls">
          <div class="seg" id="actRange">
            <button data-range="24h" class="on">24시간</button>
            <button data-range="7d">7일</button>
            <button data-range="30d">30일</button>
          </div>
          <div class="seg" id="actBucket"></div>
          <span class="sub" id="actMsg"></span>
        </div>
        <div id="actOut"></div>
      </div>
      <div class="grid2">
        <div class="card"><h2>선택률 · 일별 (어제까지)</h2><div id="ovSelection"></div></div>
        <div class="card"><h2>분석 수 · 일별 (어제까지)</h2><div id="ovUsage"></div></div>
      </div>
      <div class="card">
        <h2>최근 Job <button class="ghost" data-goto="jobs">전체 보기 →</button></h2>
        <div id="ovRecent"></div>
      </div>
    </section>
    <section class="tab" id="tab-jobs">
    <div class="card">
      <h2>최근 Job — 설치 상관없이 들어온 순서대로</h2>
      <div class="lookup">
        <select id="recentStatus">
          <option value="">전체</option>
          <option value="completed">completed</option>
          <option value="failed">failed</option>
          <option value="running">running</option>
          <option value="queued">queued</option>
        </select>
        <button id="recentGo">불러오기</button>
        <span id="recentMsg" class="sub"></span>
      </div>
      <div id="recentOut"></div>
    </div>
    </section>
    <section class="tab" id="tab-gallery">
      <div class="card">
        <h2>모아 보기</h2>
        <div class="controls">
          <div class="seg" id="galMode">
            <button data-mode="roughs" class="on">러프·결과</button>
            <button data-mode="poses">포즈 라이브러리</button>
          </div>
          <div class="seg" id="galGroup"></div>
          <input id="galSearch" placeholder="pose_id 검색" autocomplete="off" style="display:none;min-width:200px">
          <span class="sub" id="galMsg"></span>
        </div>
        <p class="sub" id="galNote"></p>
        <div class="gal">
          <div class="folders" id="galFolders"></div>
          <div><div class="tiles" id="galTiles"></div><p id="galMoreWrap"></p></div>
        </div>
      </div>
    </section>
    <section class="tab" id="tab-installs">
    <div class="card">
      <h2>설치 조회 — 이 설치가 무엇을 돌렸나</h2>
      <div class="lookup">
        <input id="lookupId" placeholder="inst_00000000-0000-4000-8000-000000000000" autocomplete="off" spellcheck="false">
        <select id="lookupStatus">
          <option value="">전체</option>
          <option value="failed">failed</option>
          <option value="completed">completed</option>
          <option value="running">running</option>
          <option value="queued">queued</option>
        </select>
        <button id="lookupGo">조회</button>
        <button class="ghost" id="rosterGo">설치 목록</button>
        <label class="sub" style="display:inline-flex;gap:6px;align-items:center">
          <input type="checkbox" id="rosterActive" style="width:auto;min-width:0"> 철회·삭제요청 숨기기
        </label>
        <span id="lookupMsg" class="sub"></span>
      </div>
      <div id="rosterOut"></div>
    </div>
    </section>
    <section class="tab" id="tab-metrics">
    <div class="card">
      <h2>제품 지표 — 퍼널 · 코호트 · 이탈 신호</h2>
      <div class="lookup">
        <button class="ghost" id="productGo">불러오기</button>
        <span id="productMsg" class="sub"></span>
      </div>
      <div id="productOut"></div>
    </div>
    </section>
    <section class="tab" id="tab-ops">
    <div class="row" id="cards"></div>
    <div class="card">
      <h2>최근 1시간 · 분 단위 (막대=요청, 빨강=5xx)</h2>
      <div id="chartHour"></div>
    </div>
    <div class="card">
      <h2>최근 24시간 · 시간 단위</h2>
      <div id="chartDay"></div>
    </div>
    <div class="row">
      <div class="card"><h2>오류 코드 (1시간)</h2><div class="scroll" id="errors"></div></div>
      <div class="card"><h2>라우트 (1시간)</h2><div class="scroll" id="routes"></div></div>
    </div>
    <div class="row">
      <div class="card"><h2>분석 Job (1시간)</h2><div class="scroll" id="jobs"></div></div>
      <div class="card"><h2>사용량</h2><div id="quota"></div></div>
    </div>
    <p class="sub">
      지연시간은 히스토그램에서 읽은 값이라 버킷 상한까지만 정확하다("이 값 이하"라는 뜻).
      태스크별 p95를 평균 내면 p95가 아니게 되므로 값 대신 분포를 저장한다.
    </p>
    </section>
  </main>
</div>

<div id="backdrop"></div>
<aside id="drawer" aria-hidden="true">
  <div class="drawer-head">
    <button class="ghost" id="drawerBack" style="display:none">← 설치 기록</button>
    <span id="drawerTitle"></span>
    <button class="ghost" id="drawerClose" style="margin-left:auto">닫기 ✕</button>
  </div>
  <div class="drawer-body">
    <div id="activityOut"></div>
    <div id="lookupOut"></div>
    <div id="detailOut"></div>
  </div>
</aside>

<script>${SKELETON_CONSTANTS}
const KEY = "standin.adminToken";
const $ = (id) => document.getElementById(id);

function readTokenFromUrl() {
  const url = new URL(location.href);
  const token = url.searchParams.get("token");
  if (!token) return null;
  // 토큰이 주소창·히스토리·리퍼러에 남지 않게 즉시 지운다.
  url.searchParams.delete("token");
  history.replaceState(null, "", url.toString());
  return token;
}

let token = readTokenFromUrl() || sessionStorage.getItem(KEY) || "";

async function load() {
  const res = await fetch("/v1/admin/ops", { headers: { "X-Beta-Admin-Token": token } });
  if (!res.ok) throw new Error(res.status === 404 ? "토큰이 올바르지 않습니다." : "조회 실패 " + res.status);
  return res.json();
}

function pill(text, kind) { return '<span class="pill ' + kind + '">' + text + "</span>"; }
function esc(value) { return String(value).replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c])); }
function ms(value) { return value === null || value === undefined ? "—" : value >= 1000 ? (value/1000).toFixed(1) + "s" : value + "ms"; }

function chart(points, labelOf) {
  if (!points.length) return '<p class="empty">데이터가 아직 없습니다.</p>';
  let lastDay = "";
  const axis = points.map((point) => {
    const at = kst(point.at);
    const top = at.md !== lastDay ? at.md : "";
    lastDay = at.md;
    return { top, bottom: at.hm };
  });
  return chartGroup(axis, [
    { label: "요청", values: points.map((point) => point.requests), unit: "건", color: "--c-jobs", dash: "2 4" },
    { label: "5xx", values: points.map((point) => point.errors5xx), unit: "건", color: "--c-fail", dash: "6 4" },
  ], (i) => esc(labelOf(points[i])) + " · 요청 " + points[i].requests + "건 · 5xx " + points[i].errors5xx +
    "건 · p95 " + ms(points[i].p95Ms), '<span class="sub">점에 마우스를 올리면 그 시각의 숫자가 보입니다.</span>');
}

function table(rows, head) {
  if (!rows.length) return '<p class="empty">없음</p>';
  return "<table><thead><tr><th>" + head + '</th><th class="num">건수</th></tr></thead><tbody>' +
    rows.map((row) => "<tr><td>" + esc(row.key) + '</td><td class="num">' + row.count + "</td></tr>").join("") +
    "</tbody></table>";
}

function render(data) {
  const bff = data.bff.hour, inference = data.inference.hour;
  const errorRate = bff.requests ? (bff.errors5xx / bff.requests) * 100 : 0;
  $("inference").innerHTML = (data.inferenceHealthy ? pill("추론 정상", "ok") : pill("추론 응답 없음", "bad"))
    + (data.inferenceLibrary ? " " + pill("라이브러리 " + esc(data.inferenceLibrary.version), "ok") : "");
  $("analysis").innerHTML = data.analysisEnabled ? pill("분석 켜짐", "ok") : pill("분석 중단됨", "warn");
  $("tasks").textContent = "태스크 BFF " + (data.tasks.bff || 0) + " · 추론 " + (data.tasks.inference || 0);
  $("updated").textContent = new Date(data.now).toLocaleTimeString("ko-KR");
  $("reviewer").textContent = data.reviewer || "—";

  $("cards").innerHTML = [
    ['요청 (1시간)', bff.requests, ""],
    ['5xx 비율', errorRate.toFixed(2) + "%", bff.errors5xx + "건 / 4xx " + bff.errors4xx + "건"],
    ['BFF p95', ms(bff.p95Ms), "p50 " + ms(bff.p50Ms)],
    ['추론 p95', ms(inference.p95Ms), inference.requests + "건 · p50 " + ms(inference.p50Ms)],
  ].map(([title, value, sub]) =>
    '<div class="card"><h2>' + title + '</h2><div class="big">' + esc(value) + '</div><div class="sub">' + esc(sub) + "</div></div>"
  ).join("");

  $("chartHour").innerHTML = chart(data.bff.minutes, (p) => new Date(p.at).toLocaleTimeString("ko-KR"));
  $("chartDay").innerHTML = chart(data.bff.hours, (p) => new Date(p.at).toLocaleString("ko-KR"));
  $("errors").innerHTML = table(data.topErrors, "코드");
  $("routes").innerHTML = table(data.topRoutes, "라우트");
  $("jobs").innerHTML = table(data.jobs, "상태");
  $("quota").innerHTML = '<div class="big">' + data.quota.used + "</div><div class=\"sub\">전역 일일 사용량 · 상한 " +
    (data.quota.limit > 0 ? data.quota.limit : "없음") + " · " + esc(data.quota.day) + "</div>";
}

async function tick() {
  try {
    render(await load());
    $("gate").classList.remove("show");
    $("app").classList.remove("hide");
  } catch (error) {
    $("app").classList.add("hide");
    $("gate").classList.add("show");
    $("gateError").textContent = error.message;
  }
}

// ── 설치 조회 ────────────────────────────────────────────────
//
// 위 집계는 "서비스가 지금 어떤가"를 답하고, 여기는 "이 사용자에게 무슨 일이
// 있었나"를 답한다. 30초 자동 갱신은 이 영역을 건드리지 않는다 — render()가
// 자기 id들만 다시 그리므로, 조회 결과가 눈앞에서 사라지지 않는다.
const LOOKUP_LIMIT = 20;
let lookup = { id: "", status: "", items: [], nextCursor: null, installation: null };

function when(iso) {
  if (!iso) return "—";
  const at = new Date(iso);
  return isNaN(at.getTime()) ? esc(iso) : at.toLocaleString("ko-KR", { hour12: false });
}

function took(item) {
  if (!item.createdAt || !item.completedAt) return "—";
  const elapsed = new Date(item.completedAt) - new Date(item.createdAt);
  return isFinite(elapsed) && elapsed >= 0 ? ms(elapsed) : "—";
}

/** completed인데 인물이 0명이면 실패는 아니지만 봐야 할 건이라 따로 표시한다. */
function jobStatus(item) {
  if (item.status === "failed") return pill("failed", "bad");
  if (item.status === "completed") {
    return item.personCount === 0 ? pill("완료 · 인물 0", "warn") : pill("completed", "ok");
  }
  return pill(esc(item.status), "warn");
}

async function lookupFetch(cursor) {
  const query = "limit=" + LOOKUP_LIMIT +
    (lookup.status ? "&status=" + encodeURIComponent(lookup.status) : "") +
    (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
  const res = await fetch(
    "/v1/admin/review/installations/" + encodeURIComponent(lookup.id) + "/jobs?" + query,
    { headers: { "X-Beta-Admin-Token": token } },
  );
  if (!res.ok) {
    // 404가 둘을 겸한다 — 토큰 거절(미들웨어)과 없는 설치(라우트). 메시지로 가른다.
    const body = await res.json().catch(() => null);
    const message = body && body.error ? body.error.message : "";
    if (res.status === 404) throw new Error(message === "not found" ? "토큰이 거절됐습니다." : "그런 설치가 없습니다.");
    if (res.status === 400) throw new Error(message || "입력이 올바르지 않습니다.");
    throw new Error("조회 실패 " + res.status);
  }
  return res.json();
}

// ── Job 상세 ─────────────────────────────────────────────────
//
// 원본 러프 · 후보 결과 · 확정 선택 · refine 산출물을 한 화면에 놓는다. 넷을 따로
// 보면 "이 결과가 말이 되는가"를 판단할 수 없다 — 원본과 후보를 나란히 놓아야
// 매칭이 맞는지 알고, 선택과 refine을 겹쳐 봐야 사용자가 무엇을 들고 갔는지 안다.

/** 후보 썸네일은 blob으로 싣는다. img 태그는 관리자 토큰 헤더를 실을 수 없다. */
// ── 서랍 ─────────────────────────────────────────────────────
//
// 상세와 설치 기록은 어디서 눌러도 오른쪽 서랍에 연다. 예전에는 페이지 맨 아래 칸에
// 그려져, 위쪽 목록에서 누르면 결과가 화면 밖에 생겼다.
function showDrawer(mode) {
  const detail = mode === "detail";
  $("detailOut").style.display = detail ? "" : "none";
  $("lookupOut").style.display = detail ? "none" : "";
  $("activityOut").style.display = detail ? "none" : "";
  // 설치 기록에서 들어온 상세면 돌아갈 길을 남긴다.
  $("drawerBack").style.display = detail && $("lookupOut").innerHTML ? "" : "none";
  $("drawerTitle").textContent = detail ? "Job 상세" : "설치 기록";
  $("drawer").classList.add("on");
  $("drawer").setAttribute("aria-hidden", "false");
  $("backdrop").classList.add("on");
  $("drawer").querySelector(".drawer-body").scrollTop = 0;
}

function closeDrawer() {
  releaseDetailBlobs();
  $("drawer").classList.remove("on");
  $("drawer").setAttribute("aria-hidden", "true");
  $("backdrop").classList.remove("on");
  $("detailOut").innerHTML = "";
  $("lookupOut").innerHTML = "";
  $("activityOut").innerHTML = "";
}

let detailBlobUrls = [];

function releaseDetailBlobs() {
  detailBlobUrls.forEach((url) => URL.revokeObjectURL(url));
  detailBlobUrls = [];
}

async function fillCandidateThumb(img) {
  const poseId = img.dataset.pose, view = img.dataset.view;
  try {
    const res = await fetch(
      "/v1/admin/review/pose-candidates/" + encodeURIComponent(poseId) + "/thumbnail?view=" + encodeURIComponent(view),
      { headers: { "X-Beta-Admin-Token": token } },
    );
    if (!res.ok) throw new Error(String(res.status));
    const url = URL.createObjectURL(await res.blob());
    detailBlobUrls.push(url);
    img.src = url;
  } catch {
    img.insertAdjacentHTML("afterend", '<div class="sub">썸네일 없음</div>');
    img.remove();
  }
}

function groupBy(rows, key) {
  const out = new Map();
  (rows || []).forEach((row) => {
    const bucket = out.get(row[key]) || [];
    bucket.push(row);
    out.set(row[key], bucket);
  });
  return out;
}

function candidateCard(row, selectedId) {
  const chosen = row.candidate_id === selectedId;
  const score = [
    row.distance === null || row.distance === undefined ? null : "d " + Number(row.distance).toFixed(3),
    row.rerank_score === null || row.rerank_score === undefined ? null : "r " + Number(row.rerank_score).toFixed(3),
  ].filter(Boolean).join(" · ");
  return '<div class="cand' + (chosen ? " sel" : "") + '">' +
    '<img data-pose="' + esc(row.pose_id) + '" data-view="' + esc(row.view) + '" alt="">' +
    '<div class="sub" style="margin-top:6px">#' + row.rank + " · " + esc(row.match_level || "?") + "</div>" +
    '<div class="sub mono" title="' + esc(row.pose_id) + '">' + esc(String(row.pose_id).slice(0, 16)) + "</div>" +
    (score ? '<div class="sub">' + esc(score) + "</div>" : "") +
    (chosen ? '<div style="margin-top:4px">' + pill("선택됨", "ok") + "</div>" : "") +
    "</div>";
}

// 지금 열린 상세의 Job. refine 카드의 미리보기·FBX 경로를 만들 때 쓴다.
let currentDetailJobId = "";

function refinedQuery(row) {
  return "/v1/admin/review/jobs/" + encodeURIComponent(currentDetailJobId) + "/refined/" +
    encodeURIComponent(row.personIndex) + "/{kind}?candidateId=" + encodeURIComponent(row.candidateId);
}

function refineCard(row) {
  // 저장된 미리보기가 있으면 바로, 조정본인데 없으면 관리자 경로가 그 자리에서 그린다.
  // refine은 이제 미리보기 없이 끝나므로(5초 상한) 처음 한 번은 여기서 그려진다.
  const preview = row.thumbnailUrl
    ? '<img src="' + esc(row.thumbnailUrl) + '" alt="">'
    : row.refined
      ? '<img data-refined="' + esc(refinedQuery(row).replace("{kind}", "thumbnail")) + '" alt="">' +
        '<div class="sub refined-wait">미리보기 만드는 중…</div>'
      : '<div class="sub">조정 안 함 — 후보 그림을 보세요</div>';
  return '<div class="cand">' + preview +
    '<div style="margin:6px 0 4px">' + (row.refined ? pill("조정됨", "ok") : pill("조정 안 함", "warn")) + "</div>" +
    '<div class="sub mono" title="' + esc(row.poseId) + '">' + esc(String(row.poseId).slice(0, 16)) + "</div>" +
    '<div class="sub">' + esc(row.reason || "—") + "</div>" +
    (row.limbs && row.limbs.length ? '<div class="sub">' + esc(row.limbs.join(", ")) + "</div>" : "") +
    '<div class="sub" style="margin-top:4px;display:flex;gap:8px;align-items:center">' +
      (row.bvhUrl ? '<a href="' + esc(row.bvhUrl) + '" target="_blank" rel="noopener">BVH</a>' : "") +
      '<button class="ghost" data-fbx="' + esc(refinedQuery(row).replace("{kind}", "fbx")) + '">FBX</button>' +
    "</div></div>";
}

/** 관리자 토큰이 헤더로 가야 해서 img src로 못 부른다. blob으로 받아 붙인다. */
async function fillRefinedThumb(img) {
  const wait = img.nextElementSibling;
  try {
    const res = await fetch(img.dataset.refined, { headers: { "X-Beta-Admin-Token": token } });
    if (!res.ok) throw new Error(res.status === 404 ? "그릴 조정본이 없습니다" : "미리보기 실패 " + res.status);
    const url = URL.createObjectURL(await res.blob());
    detailBlobUrls.push(url);
    img.src = url;
    if (wait) wait.remove();
  } catch (error) {
    img.remove();
    if (wait) { wait.textContent = error.message; wait.classList.add("err"); }
  }
}

async function downloadFbx(button) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "변환 중…";
  try {
    const res = await fetch(button.dataset.fbx, { headers: { "X-Beta-Admin-Token": token } });
    if (!res.ok) throw new Error(res.status === 404 ? "원본이 없습니다" : "변환 실패 " + res.status);
    const disposition = res.headers.get("Content-Disposition") || "";
    const match = /filename="([^"]+)"/.exec(disposition);
    const url = URL.createObjectURL(await res.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = match ? match[1] : "refined.fbx";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    button.textContent = res.headers.get("X-Standin-Variant") === "base" ? "FBX(원본)" : label;
  } catch (error) {
    button.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function scoreOf(person, index) {
  const values = (person.jointScores && person.jointScores.values) || [];
  return index < values.length ? values[index] : null;
}

/**
 * 관절 좌표는 원본 러프의 픽셀이다. 원본 크기를 모르는 옛 Job(입력 크기 컬럼이 비어
 * 있다)은 좌표가 닿는 범위로 캔버스를 잡는다 — 비율이 조금 어긋나도 "뼈대를 못 본다"
 * 보다는 낫다.
 */
function overlayBox(detail) {
  if (detail.image && detail.image.width > 0 && detail.image.height > 0) {
    return { width: detail.image.width, height: detail.image.height, exact: true };
  }
  let maxX = 0, maxY = 0;
  (detail.people || []).forEach((person) => {
    ((person.skeleton && person.skeleton.keypoints) || []).forEach((point) => {
      maxX = Math.max(maxX, point[0]); maxY = Math.max(maxY, point[1]);
    });
    if (person.box) { maxX = Math.max(maxX, person.box[2]); maxY = Math.max(maxY, person.box[3]); }
  });
  if (maxX <= 0 || maxY <= 0) return null;
  return { width: Math.ceil(maxX * 1.04), height: Math.ceil(maxY * 1.04), exact: false };
}

function personColor(index) { return PERSON_COLORS[index % PERSON_COLORS.length]; }

function overlaySvg(detail) {
  const box = overlayBox(detail);
  if (!box) return { svg: "", box: null };
  const unit = Math.max(box.width, box.height);
  const bone = Math.max(unit / 260, 1);
  const dot = Math.max(unit / 190, 1.4);
  const groups = (detail.people || []).map((person, order) => {
    const color = personColor(order);
    const keypoints = (person.skeleton && person.skeleton.keypoints) || [];
    const parts = [];
    if (person.box) {
      parts.push('<rect class="box" x="' + person.box[0] + '" y="' + person.box[1] +
        '" width="' + (person.box[2] - person.box[0]) + '" height="' + (person.box[3] - person.box[1]) +
        '" stroke="' + color + '" stroke-width="' + bone + '"></rect>');
    }
    EDGES.forEach((edge) => {
      const a = keypoints[edge.a], b = keypoints[edge.b];
      if (!a || !b) return;
      const scoreA = scoreOf(person, edge.a), scoreB = scoreOf(person, edge.b);
      const weak = Math.min(scoreA === null ? 1 : scoreA, scoreB === null ? 1 : scoreB) < JOINT_FAINT;
      parts.push('<line class="bone' + (weak ? " faint" : "") + '" x1="' + a[0] + '" y1="' + a[1] +
        '" x2="' + b[0] + '" y2="' + b[1] + '" stroke="' + color + '" stroke-width="' + bone + '"></line>');
    });
    keypoints.forEach((point, index) => {
      const score = scoreOf(person, index);
      const name = JOINT_NAMES[index] || ("관절 " + index);
      parts.push('<circle class="joint' + (score !== null && score < JOINT_FAINT ? " faint" : "") +
        '" cx="' + point[0] + '" cy="' + point[1] + '" r="' + dot + '" fill="' + color + '">' +
        "<title>인물 " + person.personIndex + " · " + esc(name) +
        (score === null ? "" : " · " + score.toFixed(2)) + "</title></circle>");
    });
    return parts.length
      ? '<g class="person" data-person="' + person.personIndex + '">' + parts.join("") + "</g>"
      : "";
  }).join("");
  if (!groups) return { svg: "", box: null };
  return {
    svg: '<svg class="ovl" id="detailOvl" viewBox="0 0 ' + box.width + " " + box.height +
      '" preserveAspectRatio="none">' + groups + "</svg>",
    box: box,
  };
}

function overlayLegend(detail) {
  const chips = (detail.people || []).filter((person) => person.skeleton || person.box)
    .map((person, order) =>
      '<button class="chip" data-person="' + person.personIndex + '">' +
      '<span class="dot" style="background:' + personColor(order) + '"></span>인물 ' + person.personIndex +
      "</button>").join("");
  if (!chips) return "";
  return '<div class="legend">' + chips + "</div>" +
    '<div class="toggles">' +
    '<label><input type="checkbox" id="ovlBones" checked>뼈</label>' +
    '<label><input type="checkbox" id="ovlJoints" checked>관절</label>' +
    '<label><input type="checkbox" id="ovlBoxes" checked>박스</label>' +
    "</div>";
}

function bindOverlay() {
  const svg = $("detailOvl");
  if (!svg) return;
  const toggle = (id, cls) => {
    const input = $(id);
    if (input) input.addEventListener("change", () => svg.classList.toggle(cls, !input.checked));
  };
  toggle("ovlBones", "noBones");
  toggle("ovlJoints", "noJoints");
  toggle("ovlBoxes", "noBoxes");
  document.querySelectorAll(".legend .chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const group = svg.querySelector('g.person[data-person="' + chip.dataset.person + '"]');
      if (!group) return;
      const off = !group.classList.contains("off");
      group.classList.toggle("off", off);
      chip.classList.toggle("off", off);
    });
  });
}

function scoreNote(person) {
  const source = person.jointScores && person.jointScores.source;
  if (source === "raw") return "점수는 마스킹 전 원본이다(refine이 막힌 인물은 저장된 점수가 0이다)";
  if (source === "none") return "점수가 없어 모든 관절을 같은 농도로 그린다";
  return "";
}

function personBadges(person) {
  const state = person.skeletonState;
  const stateKind = state === "valid" ? "ok" : state === "missing" || state === "invalid" ? "bad" : "warn";
  const coverage = person.coverageClass;
  const coverageKind = coverage === "full" ? "ok" : coverage === "insufficient" ? "bad" : "warn";
  const scope = person.outputScope;
  return [
    person.confidence ? pill("신뢰도 " + esc(person.confidence), person.confidence === "high" ? "ok" : "warn") : "",
    state ? pill("추출 " + esc(state), stateKind) : "",
    coverage ? pill("범위 " + esc(coverage), coverageKind) : "",
    person.skeletonSource
      ? pill(
          "출처 " + esc(person.skeletonSource),
          person.skeletonSource === "full_image" ? "ok" : person.skeletonSource === "none" ? "bad" : "warn",
        )
      : "",
    person.fallbackMode && person.fallbackMode !== "none"
      ? pill("폴백 " + esc(person.fallbackMode), "warn")
      : "",
    person.slotOrigin ? pill("슬롯 " + esc(person.slotOrigin), person.slotOrigin === "vlm" ? "ok" : "warn") : "",
    pill(person.refineAllowed ? "refine 허용" : "refine 불가", person.refineAllowed ? "ok" : "warn"),
    pill(person.lowerBodyObserved ? "하체 관측" : "하체 미관측", person.lowerBodyObserved ? "ok" : "warn"),
    scope ? pill("출력범위 " + esc(scope.resolved) + " · " + esc(scope.detectionSource), scope.detected ? "ok" : "warn") : "",
  ].filter(Boolean).join(" ");
}

function tagLine(tags, prefix) {
  const keys = Object.keys(tags || {});
  if (!keys.length) return "";
  return '<div class="tagline">' + (prefix ? '<span class="sub">' + esc(prefix) + "</span>" : "") +
    keys.map((key) => '<span class="tag">' + esc(key) + " <b>" + esc(tags[key]) + "</b></span>").join("") +
    "</div>";
}

/**
 * 인물별 VLM 태그. 없으면 그 사실을 적는다 — 빈칸으로 두면 "태그가 없는 인물"과
 * "인물별로 물어본 적 없는 Job"이 같아 보인다.
 */
function personTagLine(person) {
  const tags = person.personTags;
  if (!tags) {
    return '<div class="tagline"><span class="sub">인물별 태그 없음 — 이 Job은 컷 단위로만 물었다</span></div>';
  }
  const shown = {};
  if (tags.action) shown.action = tags.action;
  if (tags.view) shown.view = tags.view;
  const source = tags.source || "unknown";
  const known = Object.keys(shown).length > 0;
  return '<div class="tagline"><span class="sub">인물별</span>' +
    (known
      ? Object.keys(shown).map((key) =>
          '<span class="tag">' + esc(key) + " <b>" + esc(shown[key]) + "</b></span>").join("")
      : '<span class="tag sub">VLM이 모른다고 답했다</span>') +
    pill(esc(source), source === "vlm_person" ? "ok" : "warn") +
    "</div>";
}

function searchSignalLine(signals) {
  if (!signals) return "";
  const items = [
    ["Top-1 거리", signals.rankDistance === null || signals.rankDistance === undefined
      ? null : Number(signals.rankDistance).toFixed(3)],
    ["기준", signals.confidenceThreshold === null || signals.confidenceThreshold === undefined
      ? null : Number(signals.confidenceThreshold).toFixed(3)],
    ["지표", signals.distanceMetric],
    ["안정성", signals.searchStability],
  ].filter((item) => item[1] !== null && item[1] !== undefined && item[1] !== "");
  if (!items.length) return "";
  return '<div class="tagline"><span class="sub">검색</span>' +
    items.map((item) => '<span class="tag">' + esc(item[0]) + " <b>" + esc(item[1]) + "</b></span>").join("") +
    "</div>";
}

/** 컷 요약. 왜 이 컷이 그 route로 갔고 VLM이 몇 명을 봤는지. */
function cutSummaryBlock(summary) {
  if (!summary) return "";
  const counts = [summary.detectorCount, summary.vlmCount]
    .every((value) => value === null || value === undefined)
    ? null
    : (summary.detectorCount ?? "?") + " / " + (summary.vlmCount ?? "?");
  const items = [
    ["route", summary.route],
    ["개수 신뢰도", summary.countConfidence],
    ["검출기/VLM 인원", counts],
  ].filter((item) => item[1] !== null && item[1] !== undefined && item[1] !== "");
  return "<h3>컷 요약</h3>" +
    (items.length
      ? '<div class="tagline">' +
        items.map((item) => '<span class="tag">' + esc(item[0]) + " <b>" + esc(item[1]) + "</b></span>").join("") +
        "</div>"
      : "") +
    (summary.vlmTags
      ? tagLine(summary.vlmTags, "VLM이 말한 컷 태그")
      : '<p class="sub">VLM이 말한 컷 태그가 기록되지 않았다(구 추론 응답).</p>');
}

function metadataPills(meta) {
  if (!meta) return "";
  const items = [
    ["VLM", [meta.vlmProvider, meta.vlmModel].filter(Boolean).join(" ")],
    ["추출", [meta.poseBackend, meta.poseModelVersion].filter(Boolean).join(" ")],
    ["라이브러리", meta.poseLibraryVersion],
    ["배포", meta.deploymentVersion],
    ["피처", meta.featureVersion],
  ].filter((item) => item[1] !== null && item[1] !== undefined && item[1] !== "");
  return '<div class="tagline">' +
    items.map((item) => '<span class="tag">' + esc(item[0]) + " <b>" + esc(item[1]) + "</b></span>").join("") +
    "</div>";
}

function detailRender(detail) {
  releaseDetailBlobs();
  currentDetailJobId = detail.jobId;
  const byPerson = groupBy(detail.candidates, "person_index");
  const refinedByPerson = groupBy(detail.refined, "personIndex");
  const chosen = new Map((detail.selections || []).map((s) => [s.person_index, s.candidate_id]));
  const overlay = overlaySvg(detail);

  const people = (detail.people || []).map((person) => {
    const index = person.personIndex;
    const candidates = byPerson.get(index) || [];
    const refined = refinedByPerson.get(index) || [];
    const selectedId = chosen.get(index);
    const note = scoreNote(person);
    return "<h3>인물 " + index + " · 후보 " + candidates.length + "개" +
      (selectedId ? " · " + pill("선택 있음", "ok") : " · " + pill("선택 없음", "warn")) +
      (person.candidateShortfallReason ? ' <span class="sub">' + esc(person.candidateShortfallReason) + "</span>" : "") +
      "</h3>" +
      '<div class="tagline">' + personBadges(person) + "</div>" +
      personTagLine(person) +
      tagLine(person.tags, "컷 단위") +
      searchSignalLine(person.searchSignals) +
      (person.skeleton
        ? '<p class="sub">뼈대 ' + esc(person.skeleton.schemaVersion) + " · 관절 " +
          person.skeleton.keypoints.length + "개" + (note ? " · " + esc(note) : "") + "</p>"
        : '<p class="sub">뼈대 없음</p>') +
      (candidates.length
        ? '<div class="cands">' + candidates.map((row) => candidateCard(row, selectedId)).join("") + "</div>"
        : '<p class="empty">후보가 없습니다.</p>') +
      (refined.length
        ? "<h3>refine 결과</h3><div class=\"cands\">" + refined.map(refineCard).join("") + "</div>"
        : "");
  }).join("");

  const shot = detail.inputUrl
    ? '<div class="shotWrap"><img class="shot" src="' + esc(detail.inputUrl) + '" alt="">' + overlay.svg + "</div>" +
      '<p class="sub">서명 URL은 ' + (detail.inputUrlExpiresInSeconds || 300) + "초 뒤 만료된다.</p>"
    : overlay.svg
      ? '<div class="shotWrap solo">' + overlay.svg + "</div>" +
        '<p class="sub">원본은 지워졌고(90일 lifecycle) 뼈대만 남아 있다' +
        (overlay.box && !overlay.box.exact ? " · 캔버스는 좌표 범위로 추정했다" : "") + ".</p>"
      : '<p class="empty">원본도 뼈대도 남아 있지 않습니다.</p>';

  $("detailOut").innerHTML =
    '<div class="detail">' +
    '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
    '<span class="mono">' + esc(detail.jobId) + "</span>" + jobStatus({ status: detail.status, personCount: (detail.people || []).length }) +
    '<span class="sub">' + when(detail.createdAt) + "</span>" +
    '<button class="ghost" id="detailClose" style="margin-left:auto">닫기</button></div>' +
    '<div class="side" style="margin-top:12px"><div><h3>원본 러프와 뼈대</h3>' + shot + overlayLegend(detail) +
    "</div><div>" +
    (detail.feedback ? "<h3>사용자 피드백</h3><p>" + esc(detail.feedback) + "</p>" : "") +
    "<h3>추론 메타</h3>" + metadataPills(detail.inferenceMetadata) +
    (detail.inferenceMetadata
      ? '<details><summary class="sub">원본 JSON</summary><pre class="mono" style="white-space:pre-wrap">' +
        esc(JSON.stringify(detail.inferenceMetadata, null, 2)) + "</pre></details>"
      : '<p class="empty">메타가 없습니다.</p>') +
    cutSummaryBlock(detail.cutSummary) +
    ((detail.people || []).some((person) => person.personTags)
      ? '<p class="sub">인물별 <b>action·view</b>는 사람마다 따로 판단한 값이다. 아래 "컷 단위" 줄은 컷 하나에서 뽑아 전원에게 복사한 값이라 둘이 다를 수 있다.</p>'
      : '<p class="sub">이 Job은 VLM에 <b>컷 단위</b>로만 물었다. 같은 컷의 모든 인물이 같은 action·view를 받는다. 인물별 태그는 프롬프트를 p2-person-tags로 바꾼 뒤부터 쌓인다.</p>') +
    "</div></div>" + people + "</div>";

  $("detailOut").querySelectorAll(".cand img[data-pose]").forEach(fillCandidateThumb);
  $("detailOut").querySelectorAll(".cand img[data-refined]").forEach(fillRefinedThumb);
  $("detailOut").querySelectorAll("button[data-fbx]").forEach((button) => {
    button.addEventListener("click", () => downloadFbx(button));
  });
  bindOverlay();
  $("detailClose").addEventListener("click", closeDrawer);
  showDrawer("detail");
}

async function openDetail(jobId, button) {
  const label = button.textContent;
  button.textContent = "여는 중";
  try {
    const res = await fetch("/v1/admin/review/jobs/" + encodeURIComponent(jobId), {
      headers: { "X-Beta-Admin-Token": token },
    });
    if (!res.ok) throw new Error(res.status === 404 ? "그 Job을 찾을 수 없습니다." : "상세 조회 실패 " + res.status);
    detailRender(await res.json());
  } catch (error) {
    $("lookupMsg").innerHTML = '<span class="err">' + esc(error.message) + "</span>";
  } finally {
    button.textContent = label;
  }
}

let recent = { items: [], nextCursor: null, status: "" };

async function recentFetch(cursor) {
  const query = new URLSearchParams({ limit: "20" });
  if (recent.status) query.set("status", recent.status);
  if (cursor) query.set("cursor", cursor);
  const res = await fetch("/v1/admin/review/jobs?" + query.toString(), {
    headers: { "X-Beta-Admin-Token": token },
  });
  if (!res.ok) throw new Error("조회 실패 " + res.status);
  return res.json();
}

function recentRender() {
  if (!recent.items.length) {
    $("recentOut").innerHTML = '<p class="empty">아직 없습니다.</p>';
    return;
  }
  const rows = recent.items.map((item) =>
    "<tr><td>" + jobStatus(item) + "</td>" +
    '<td class="mono">' + esc(item.jobId) + "</td>" +
    '<td class="sub">' + when(item.createdAt) + "</td>" +
    '<td class="num">' + took(item) + "</td>" +
    "<td>" + (item.installationId
      ? '<button class="ghost mono" data-inst="' + esc(item.installationId) + '" title="' +
        esc(item.installationId) + '">' + esc(String(item.installationId).slice(0, 13)) + "…</button>"
      : '<span class="sub">—</span>') + "</td>" +
    '<td class="num">' + (item.personCount === null || item.personCount === undefined ? "—" : item.personCount) + "</td>" +
    '<td class="num">' + (item.selectionCount === null || item.selectionCount === undefined ? "—" : item.selectionCount) + "</td>" +
    "<td>" + (item.errorCode ? pill(esc(item.errorCode), "bad") : "") + "</td>" +
    '<td><button class="ghost" data-job="' + esc(item.jobId) + '">상세</button></td></tr>').join("");
  $("recentOut").innerHTML =
    '<div class="scroll"><table><thead><tr><th>상태</th><th>Job</th><th>들어온 때</th>' +
    '<th class="num">걸린 시간</th><th>설치</th><th class="num">인물</th><th class="num">선택</th>' +
    "<th>오류</th><th></th></tr></thead><tbody>" + rows + "</tbody></table></div>" +
    (recent.nextCursor ? '<p><button class="ghost" id="recentMore">더 보기</button></p>' : "");
  $("recentOut").querySelectorAll("button[data-job]").forEach((button) => {
    button.addEventListener("click", () => openDetail(button.dataset.job, button));
  });
  // 설치 버튼은 그 설치의 전체 기록으로 넘어가는 지름길이다.
  $("recentOut").querySelectorAll("button[data-inst]").forEach((button) => {
    button.addEventListener("click", () => {
      $("lookupId").value = button.dataset.inst;
      lookupGo(null);
    });
  });
  const more = $("recentMore");
  if (more) {
    more.addEventListener("click", async () => {
      more.disabled = true;
      try {
        const page = await recentFetch(recent.nextCursor);
        recent.items = recent.items.concat(page.items);
        recent.nextCursor = page.nextCursor;
        recentRender();
      } catch (error) {
        $("recentMsg").innerHTML = '<span class="err">' + esc(error.message) + "</span>";
        more.disabled = false;
      }
    });
  }
}

async function recentGo() {
  $("recentMsg").textContent = "불러오는 중";
  try {
    recent.status = $("recentStatus").value;
    const page = await recentFetch(null);
    recent.items = page.items;
    recent.nextCursor = page.nextCursor;
    $("recentMsg").textContent = "";
    recentRender();
  } catch (error) {
    $("recentMsg").innerHTML = '<span class="err">' + esc(error.message) + "</span>";
  }
}

function lookupRender() {
  const install = lookup.installation;
  const head = install
    ? '<div class="sub" style="margin:12px 0 8px">' +
      '<span class="mono">' + esc(install.installationId) + "</span> · " +
      esc(install.appVersion || "?") + " · " + esc(install.osName || "?") + " " + esc(install.osVersion || "") +
      " · 마지막 접속 " + when(install.lastSeenAt) +
      (install.revokedAt ? " · " + pill("철회됨", "bad") : "") +
      (install.deletionRequestedAt ? " · " + pill("삭제 요청", "warn") : "") +
      "</div>"
    : "";

  if (!lookup.items.length) {
    $("lookupOut").innerHTML = head + '<p class="empty">해당 조건의 기록이 없습니다.</p>';
    return;
  }

  const rows = lookup.items.map((item) =>
    "<tr><td>" + jobStatus(item) + "</td>" +
    '<td class="mono" title="' + esc(item.jobId) + '">' + esc(String(item.jobId).slice(0, 12)) + "…</td>" +
    "<td>" + when(item.createdAt) + "</td>" +
    '<td class="num">' + took(item) + "</td>" +
    '<td class="' + (item.errorCode ? "err mono" : "sub") + '">' + esc(item.errorCode || "—") + "</td>" +
    '<td class="num">' + (item.personCount || 0) + "</td>" +
    '<td class="num">' + (item.selectionCount || 0) + "</td>" +
    "<td>" + (item.inputAvailable
      ? '<span class="sub">' + (item.inputWidth || "?") + "×" + (item.inputHeight || "?") + "</span>"
      : '<span class="sub" title="버킷 lifecycle 90일">만료</span>') + "</td>" +
    '<td><button class="ghost" data-detail="' + esc(item.jobId) + '">상세</button></td></tr>'
  ).join("");

  $("lookupOut").innerHTML = head +
    '<div class="scroll"><table><thead><tr><th>상태</th><th>Job</th><th>만든 시각</th>' +
    '<th class="num">소요</th><th>에러코드</th><th class="num">인물</th><th class="num">선택</th><th>원본</th><th></th>' +
    "</tr></thead><tbody>" + rows + "</tbody></table></div>" +
    (lookup.nextCursor ? '<p style="margin:12px 0 0"><button class="ghost" id="lookupMore">더 보기</button></p>' : "");

  $("lookupOut").querySelectorAll("button[data-detail]").forEach((button) => {
    button.addEventListener("click", () => openDetail(button.dataset.detail, button));
  });
  if ($("lookupMore")) $("lookupMore").addEventListener("click", () => lookupGo(lookup.nextCursor));
}

async function lookupGo(cursor) {
  // s3 ls에서 복사하면 prefix 끝에 슬래시가 붙어 온다. 그대로 두면 경로가
  // installations/inst_…//jobs 가 되어 라우트에 걸리지 않는다.
  const id = $("lookupId").value.trim().replace(/\/+$/, "");
  if (!id) { $("lookupMsg").innerHTML = '<span class="err">installationId를 입력하세요.</span>'; return; }
  $("lookupId").value = id;
  lookup.id = id;
  lookup.status = $("lookupStatus").value;
  $("lookupMsg").textContent = "조회 중…";
  try {
    const data = await lookupFetch(cursor);
    lookup.installation = data.installation;
    lookup.nextCursor = data.nextCursor;
    lookup.items = cursor ? lookup.items.concat(data.items) : data.items;
    $("lookupMsg").textContent = lookup.items.length + "건" + (data.nextCursor ? " (더 있음)" : "");
    $("detailOut").innerHTML = "";
    lookupRender();
    showDrawer("install");
    if (!cursor) installActivityGo(id);
  } catch (error) {
    $("lookupMsg").innerHTML = '<span class="err">' + esc(error.message) + "</span>";
    $("lookupOut").innerHTML = '<p class="err">' + esc(error.message) + "</p>";
    showDrawer("install");
  }
}

// ── 제품 지표 ────────────────────────────────────────────────
//
// 퍼널에서 어디가 새는지 보고, 코호트에서 누가 거기 멈췄는지 세고, 신호에서 그들이
// 무엇이 달랐는지로 내려간다. 세 블록의 순서가 곧 읽는 순서다.

function pct(value) { return value === null || value === undefined ? "—" : value + "%"; }

function funnelTable(stages) {
  const first = stages[0] ? stages[0].installations : 0;
  return '<div class="scroll"><table><thead><tr><th>단계</th><th class="num">설치</th>' +
    '<th class="num">건수</th><th class="num">직전 대비</th><th class="num">투입 대비</th><th></th>' +
    "</tr></thead><tbody>" +
    stages.map((stage, index) => {
      // 직전 대비가 크게 꺾이는 칸이 곧 새는 자리다. 60% 미만이면 눈에 띄게 둔다.
      const leaky = stage.fromPrevious !== null && stage.fromPrevious < 60;
      const width = first ? Math.max(1, Math.round((stage.installations / first) * 100)) : 0;
      return "<tr><td>" + esc(stage.label) + "</td>" +
        '<td class="num">' + stage.installations + "</td>" +
        '<td class="num">' + (stage.jobs === null ? "—" : stage.jobs) + "</td>" +
        '<td class="num' + (leaky ? " gap" : "") + '">' + pct(stage.fromPrevious) + "</td>" +
        '<td class="num">' + pct(stage.fromStarted) + "</td>" +
        '<td style="width:38%"><div class="bar" style="width:' + width + '%"></div></td></tr>';
    }).join("") +
    "</tbody></table></div>";
}

function cohortCards(cohorts) {
  return '<div class="row">' + cohorts.map((item) =>
    '<div class="cohort' + (item.highlight ? " hot" : "") + '">' +
    '<h2>' + esc(item.label) + "</h2>" +
    '<div class="big">' + item.count + '</div>' +
    '<div class="sub">' + pct(item.share) + " · " + esc(item.hint) + "</div></div>"
  ).join("") + "</div>";
}

function signalRows(dropoff) {
  const lines = [
    ["완료된 Job", dropoff.selected.jobs, dropoff.notSelected.jobs],
    ["인물 0명 비율", pct(dropoff.selected.zeroPeopleRate), pct(dropoff.notSelected.zeroPeopleRate)],
    ["후보 부족 비율", pct(dropoff.selected.shortfallRate), pct(dropoff.notSelected.shortfallRate)],
    ["최고 후보 거리(평균, 낮을수록 좋음)", dropoff.selected.avgBestDistance === null ? "—" : dropoff.selected.avgBestDistance,
      dropoff.notSelected.avgBestDistance === null ? "—" : dropoff.notSelected.avgBestDistance],
    ["인물 수(평균)", dropoff.selected.avgPeople === null ? "—" : dropoff.selected.avgPeople,
      dropoff.notSelected.avgPeople === null ? "—" : dropoff.notSelected.avgPeople],
  ];
  return "<table><thead><tr><th>지표</th><th class=\"num\">선택함</th><th class=\"num\">선택 안 함</th></tr></thead><tbody>" +
    lines.map((line) =>
      "<tr><td>" + esc(line[0]) + '</td><td class="num">' + esc(line[1]) + '</td><td class="num">' + esc(line[2]) + "</td></tr>"
    ).join("") + "</tbody></table>";
}

function levelList(title, levels) {
  if (!levels.length) return "<h3>" + title + '</h3><p class="empty">없음</p>';
  return "<h3>" + title + "</h3><table><tbody>" + levels.map((level) =>
    "<tr><td>" + esc(level.level) + '</td><td class="num">' + level.count + '</td><td class="num sub">' + pct(level.share) + "</td></tr>"
  ).join("") + "</tbody></table>";
}

/**
 * ⓪ 계측 건강도를 맨 위에 둔다.
 *
 * 비어 있는 컬럼을 모르고 지표를 읽으면 "점수 평균 null"만 보고 한참 헤맨다.
 * 지표를 믿어도 되는지가 지표보다 먼저다.
 */
function instrumentationBlock(inst) {
  if (!inst) return "";
  const empty = inst.columns.filter((column) => column.empty);
  const gaps = inst.stageGaps.filter((gap) => gap.gap !== 0);

  const warn = empty.length
    ? '<p class="sub"><span class="gap">비어 있는 컬럼 ' + empty.length + "개</span> — " +
      empty.map((column) => esc(column.label)).join(", ") + ". 이 컬럼에 기대는 지표는 지금 의미가 없다.</p>"
    : '<p class="sub">비어 있는 컬럼 없음.</p>';

  const columnTable = '<div class="scroll"><table><thead><tr><th>컬럼</th><th class="num">행</th>' +
    '<th class="num">빈 값</th><th class="num">비율</th></tr></thead><tbody>' +
    inst.columns.map((column) =>
      "<tr><td" + (column.empty ? ' class="gap"' : "") + ">" + esc(column.label) + "</td>" +
      '<td class="num">' + column.rows + '</td><td class="num">' + column.nulls + "</td>" +
      '<td class="num' + (column.empty ? " gap" : "") + '">' + pct(column.nullRate) + "</td></tr>"
    ).join("") + "</tbody></table></div>";

  const gapTable = '<div class="scroll"><table><thead><tr><th>단계</th><th class="num">서버</th>' +
    '<th class="num">클라</th><th class="num">차이</th><th>해석</th></tr></thead><tbody>' +
    inst.stageGaps.map((gap) =>
      "<tr><td>" + esc(gap.stage) + '</td><td class="num">' + gap.server + '</td><td class="num">' + gap.client + "</td>" +
      '<td class="num' + (gap.gap !== 0 ? " gap" : "") + '">' + (gap.gap > 0 ? "+" : "") + gap.gap + "</td>" +
      '<td class="sub">' + esc(gap.note) + "</td></tr>"
    ).join("") + "</tbody></table></div>";

  return "<h3>⓪ 계측 건강도 — 지표를 믿어도 되는가</h3>" + warn +
    '<div class="side">' + columnTable + gapTable + "</div>" +
    (gaps.length ? '<p class="sub">서버와 클라이언트가 어긋난 단계가 ' + gaps.length + "개다. 음수는 이벤트 유실, 양수는 서버에 닿지 못한 시도를 뜻한다.</p>" : "");
}

/** 거리 구간별 선택률 — matchLevel 임계값(0.25/0.45)을 보정할 근거다. */
function distanceTable(buckets) {
  if (!buckets || !buckets.length) return "";
  const peak = Math.max(1, ...buckets.map((bucket) => bucket.jobs));
  return "<h3>거리 구간별 선택률 — 어디서 고르기를 멈추나</h3>" +
    '<div class="scroll"><table><thead><tr><th>최단 거리</th><th class="num">Job</th>' +
    '<th class="num">선택</th><th class="num">선택률</th><th></th></tr></thead><tbody>' +
    buckets.map((bucket) =>
      "<tr><td>" + esc(bucket.bucket) + '</td><td class="num">' + bucket.jobs + "</td>" +
      '<td class="num">' + bucket.selected + '</td><td class="num">' + pct(bucket.selectionRate) + "</td>" +
      '<td style="width:30%"><div class="bar" style="width:' + Math.round((bucket.jobs / peak) * 100) + '%"></div></td></tr>'
    ).join("") + "</tbody></table></div>" +
    '<p class="sub">현재 matchLevel 임계값은 0.25(high) · 0.45(medium)이고 코드에 "실데이터로 보정할 것"이라 적혀 있다. 선택률이 꺾이는 구간이 곧 보정할 자리다.</p>';
}

/** ① 설치하고 첫 러프까지. 퍼널의 가장 큰 구멍이 여기라 따로 해부한다. */
function firstRunBlock(first) {
  if (!first) return "";
  const time = '<div class="scroll"><table><thead><tr><th>첫 러프까지</th><th class="num">설치</th>' +
    '<th class="num">비중</th></tr></thead><tbody>' +
    first.timeToFirst.map((item) =>
      "<tr><td>" + esc(item.bucket) + '</td><td class="num">' + item.count + "</td>" +
      '<td class="num">' + pct(item.share) + "</td></tr>"
    ).join("") + "</tbody></table></div>";

  const idle = '<div class="scroll"><table><thead><tr><th>아직 안 돌린 설치</th><th class="num">수</th>' +
    "<th>해석</th></tr></thead><tbody>" +
    first.idle.map((item) =>
      "<tr><td>" + esc(item.bucket) + '</td><td class="num' + (item.bucket.indexOf("7일 넘게") === 0 ? " gap" : "") + '">' +
      item.count + '</td><td class="sub">' + esc(item.hint) + "</td></tr>"
    ).join("") + "</tbody></table></div>";

  const captures = first.captureFailures.length
    ? '<div class="scroll" style="margin-top:10px"><table><thead><tr><th>캡처 실패 코드</th>' +
      '<th class="num">건수</th><th class="num">설치</th></tr></thead><tbody>' +
      first.captureFailures.map((row) =>
        "<tr><td>" + esc(row.code) + '</td><td class="num">' + row.events + "</td>" +
        '<td class="num">' + row.installations + "</td></tr>"
      ).join("") + "</tbody></table></div>"
    : "";

  // 한 설치에 몰려 있으면 "전체 실패"가 아니라 "한 사람이 갇혀 있다"는 뜻이다.
  const top = first.topFailingInstalls.length
    ? '<p class="sub">캡처 실패가 몰린 설치: ' +
      first.topFailingInstalls.map((row) =>
        '<button class="ghost" data-pick="' + esc(row.installationId) + '">' +
        esc(row.installationId.slice(5, 17)) + "… " + row.events + "건</button>"
      ).join(" ") + "</p>"
    : "";

  return "<h3>② 첫 실행 — 설치하고 러프를 넣기까지</h3>" +
    '<p class="sub">기간 내 새로 만들어진 설치 ' + first.installs + "곳 중 " + first.reached +
    "곳이 러프를 넣었다 (" + pct(first.reachRate) + ").</p>" +
    '<div class="side">' + time + idle + "</div>" + captures + top;
}

/** ② 몇 번째에 건지나. 1회차가 낮고 뒤가 높으면 "여러 번 돌려야 건진다"는 뜻이다. */
function retryBlock(retry) {
  if (!retry || !retry.curve.length) return "";
  const peak = Math.max(1, ...retry.curve.map((row) => row.jobs));
  const curve = '<div class="scroll"><table><thead><tr><th>시도</th><th class="num">Job</th>' +
    '<th class="num">선택</th><th class="num">선택률</th><th></th></tr></thead><tbody>' +
    retry.curve.map((row) =>
      "<tr><td>" + esc(row.attempt) + '</td><td class="num">' + row.jobs + "</td>" +
      '<td class="num">' + row.selected + '</td><td class="num">' + pct(row.selectionRate) + "</td>" +
      '<td style="width:30%"><div class="bar" style="width:' + Math.round((row.jobs / peak) * 100) + '%"></div></td></tr>'
    ).join("") + "</tbody></table></div>";

  const first = retry.firstSelection.length
    ? '<div class="scroll"><table><thead><tr><th>처음 고르기까지</th><th class="num">설치</th>' +
      '<th class="num">비중</th></tr></thead><tbody>' +
      retry.firstSelection.map((row) =>
        "<tr><td>" + esc(row.attempt) + '</td><td class="num">' + row.installations + "</td>" +
        '<td class="num">' + pct(row.share) + "</td></tr>"
      ).join("") + "</tbody></table></div>"
    : '<p class="empty">아직 아무도 고르지 않았다.</p>';

  return "<h3>④ 재시도 — 몇 번째에 건지나</h3>" +
    '<div class="side">' + curve + first + "</div>" +
    '<p class="sub">명시적 재실행(rerun_of) ' + retry.rerunJobs + "건 / 전체 " + retry.totalJobs +
    "건 (" + pct(retry.rerunRate) + ").</p>";
}

/** ⑥ 라이브러리 버전별 공백. 버전이 바뀐 주에 공백률이 내려가야 포즈를 더한 효과가 있다. */
function libraryBlock(library) {
  if (!library) return "";
  const head = "<h3>⑥ 라이브러리 공백 — 버전별, 주 단위</h3>";
  if (!library.weeks.length) return head + '<p class="empty">아직 집계할 분석이 없다.</p>';
  const t = library.thresholds;
  return head +
    '<div class="scroll"><table><thead><tr><th>주</th><th>라이브러리</th><th>coverage</th>' +
    '<th class="num">적격</th><th class="num">공백률</th><th class="num">강한 공백</th>' +
    '<th class="num">추출 의심</th><th class="num">Top-1 중앙값</th><th class="num">선택률</th>' +
    '<th class="num">엉뚱함</th></tr></thead><tbody>' +
    library.weeks.map((row) =>
      "<tr><td>" + esc(row.week) + "</td><td>" + esc(row.libraryVersion) + "</td><td>" +
      esc(row.coverageClass) + '</td><td class="num">' + row.eligible + "/" + row.people + "</td>" +
      '<td class="num">' + pct(row.gapRate) + '</td><td class="num">' + pct(row.strongGapRate) + "</td>" +
      '<td class="num">' + row.extractionSuspect + '</td><td class="num">' +
      (row.top1Median === null ? "—" : row.top1Median.toFixed(3)) + "</td>" +
      '<td class="num">' + pct(row.selectionRate) + '</td><td class="num">' + pct(row.irrelevantRate) + "</td></tr>"
    ).join("") + "</tbody></table></div>" +
    '<p class="sub">공백률 = Top-1 거리 ' + t.weak + " 초과 " + t.extractionCap + " 이하인 적격 인물(강한 공백은 " +
    t.strong + " 초과). " + t.extractionCap + " 초과는 라이브러리보다 관절 추출을 먼저 의심해 따로 센다. " +
    "적격 = VLM 인물 슬롯 · 전체 이미지 추출 · valid/partial · full/reduced · 전신 검색 · 얽힘 아님 · 관절 오류 피드백 없음.</p>";
}

/** ⑦ VLM 프롬프트 버전별. 프롬프트를 바꾼 뒤 route·인원수가 흔들리지 않는지 본다. */
function vlmBlock(vlm) {
  if (!vlm || !vlm.prompts.length) return "";
  return "<h3>⑦ VLM 프롬프트 — 버전별</h3>" +
    '<div class="scroll"><table><thead><tr><th>프롬프트</th><th class="num">Job</th>' +
    '<th class="num">core / bust / skip</th><th class="num">인원수 일치</th><th class="num">인물</th>' +
    '<th class="num">인물 태그</th><th class="num">인물별 / 1인 컷</th></tr></thead><tbody>' +
    vlm.prompts.map((row) =>
      "<tr><td>" + esc(row.promptVersion) + '</td><td class="num">' + row.jobs + "</td>" +
      '<td class="num">' + row.routes.core + " / " + row.routes.bust + " / " + row.routes.skip + "</td>" +
      '<td class="num">' + pct(row.countConfidenceHighRate) + '</td><td class="num">' + row.people + "</td>" +
      '<td class="num">' + pct(row.personTagFillRate) + '</td><td class="num">' +
      row.personTagSources.vlmPerson + " / " + row.personTagSources.legacyCut + "</td></tr>"
    ).join("") + "</tbody></table></div>" +
    '<p class="sub">unrecorded는 프롬프트 버전을 저장하기 전의 분석이다. 1인 컷은 인물별로 묻지 않은 프롬프트에서 컷 값을 그 인물의 값으로 쓴 경우다.</p>';
}

function metricCards(items) {
  return '<div class="row">' + items.map((item) =>
    '<div class="cohort"><h2>' + esc(item.label) + "</h2>" +
    '<div class="big">' + esc(String(item.value)) + "</div>" +
    '<div class="sub">' + esc(item.hint) + "</div></div>").join("") + "</div>";
}

/** 날짜별 막대 하나짜리 간단한 추이. ops 차트는 요청·5xx 전용이라 따로 둔다. */
// ── 선 차트 ─────────────────────────────────────────────────
//
// 점선과 점으로 그리고, 같은 그룹의 차트는 시간축을 공유한다. 한 차트에 마우스를 올리면
// 그룹 전체에 세로선이 서고 아래 요약줄에 그 구간의 숫자가 뜬다. 막대는 구간 사이 변화가
// 잘 안 보이고, 시간축이 없어 "몇 시에"를 읽을 수 없었다.
const CHART_W = 960;
let chartSeq = 0;
const chartGroups = {};
const KST_PARTS = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

function kst(iso) {
  const parts = {};
  const date = new Date(iso);
  // 축 이름표 하나 때문에 화면 전체가 죽으면 안 된다(formatToParts는 잘못된 날짜에 던진다).
  if (Number.isNaN(date.getTime())) return { md: "", hm: "", hour: -1 };
  KST_PARTS.formatToParts(date).forEach((part) => { parts[part.type] = part.value; });
  return { md: parts.month + "." + parts.day, hm: parts.hour + ":" + parts.minute, hour: Number(parts.hour) };
}

function niceMax(value) {
  if (value <= 1) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  const n = value / magnitude;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * magnitude;
}

function fmtNum(value) {
  return Number.isInteger(value) ? String(value) : (Math.round(value * 10) / 10).toFixed(1);
}

/**
 * spec: { group, index, points:[{value, top, bottom}], color, dash, unit, partialLast }
 * top/bottom은 x축 두 줄(날짜·시각). 비우면 그 칸은 이름표를 생략한다.
 */
function lineChart(spec) {
  const W = spec.width || CHART_W, H = 168, L = 8, R = 52, T = 26, B = 44;
  const n = spec.points.length;
  const plotW = W - L - R, plotH = H - T - B;
  const max = niceMax(Math.max(0, ...spec.points.map((point) => point.value || 0)));
  const x = (i) => (n <= 1 ? L + plotW / 2 : L + (i * plotW) / (n - 1));
  const y = (v) => T + plotH * (1 - (v || 0) / max);
  const color = "var(" + spec.color + ")";
  const parts = [];
  [0, max / 2, max].forEach((tick) => {
    parts.push('<line class="grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(tick) + '" y2="' + y(tick) + '"/>');
    parts.push('<text x="' + (W - R + 8) + '" y="' + (y(tick) + 4) + '">' + fmtNum(tick) + "</text>");
  });
  parts.push('<line class="axis" x1="' + L + '" x2="' + (W - R) + '" y1="' + (T + plotH) + '" y2="' + (T + plotH) + '"/>');
  const step = Math.max(1, Math.ceil(n / (W >= 700 ? 10 : 5)));
  const labeled = [];
  spec.points.forEach((point, i) => { if (point.top) labeled.push(i); });
  for (let i = 0; i < n; i += step) {
    if (!labeled.some((j) => Math.abs(i - j) < step * 0.6)) labeled.push(i);
  }
  labeled.forEach((i) => {
    const point = spec.points[i];
    if (point.top) parts.push('<text class="day" text-anchor="middle" x="' + x(i) + '" y="' + (T + plotH + 18) + '">' + esc(point.top) + "</text>");
    if (point.bottom) parts.push('<text text-anchor="middle" x="' + x(i) + '" y="' + (T + plotH + 34) + '">' + esc(point.bottom) + "</text>");
  });
  const path = spec.points.map((point, i) => x(i).toFixed(1) + "," + y(point.value).toFixed(1)).join(" ");
  parts.push('<polyline points="' + path + '" style="fill:none;stroke:' + color + ';stroke-width:2;stroke-linecap:round;stroke-dasharray:' + (spec.dash || "2 5") + '"/>');
  spec.points.forEach((point, i) => {
    const partial = spec.partialLast && i === n - 1;
    parts.push('<circle cx="' + x(i).toFixed(1) + '" cy="' + y(point.value).toFixed(1) + '" r="3" style="' +
      (partial ? "fill:var(--panel);stroke:" + color + ";stroke-width:1.5" : "fill:" + color) + '"/>');
  });
  parts.push('<line class="cursor" x1="0" x2="0" y1="' + T + '" y2="' + (T + plotH) + '" visibility="hidden"/>');
  parts.push('<text class="val" text-anchor="middle" y="' + (T - 9) + '" visibility="hidden" style="fill:' + color + '"></text>');
  const half = n <= 1 ? plotW / 2 : plotW / (n - 1) / 2;
  spec.points.forEach((point, i) => {
    parts.push('<rect data-g="' + spec.group + '" data-i="' + i + '" data-x="' + x(i).toFixed(1) + '" x="' + (x(i) - half).toFixed(1) +
      '" y="' + T + '" width="' + (half * 2).toFixed(1) + '" height="' + plotH + '" fill="transparent"/>');
  });
  return '<svg class="lc" data-g="' + spec.group + '" data-c="' + spec.index + '" viewBox="0 0 ' + W + " " + H + '">' + parts.join("") + "</svg>";
}

/**
 * 시간축을 공유하는 차트 묶음을 만든다. charts: [{label, values, unit, color, dash}],
 * summarize(i)는 그 구간의 요약 HTML, idle은 아무 구간도 가리키지 않을 때의 요약.
 */
function chartGroup(points, charts, summarize, idle, options) {
  const group = "g" + (++chartSeq);
  chartGroups[group] = { charts, summarize, idle, summaryId: group + "-sum" };
  const partialLast = Boolean(options && options.partialLast);
  return charts.map((chart, index) =>
    '<div class="chart-title"><span class="swatch" style="border-color:var(' + chart.color + ')"></span>' + esc(chart.label) + "</div>" +
    lineChart({ group, index, color: chart.color, dash: chart.dash, unit: chart.unit, partialLast,
      width: options && options.width,
      points: points.map((point, i) => ({ value: chart.values[i], top: point.top, bottom: point.bottom })) })
  ).join("") + '<div class="chart-summary" id="' + group + '-sum">' + idle + "</div>";
}

function chartHover(group, i) {
  const info = chartGroups[group];
  if (!info) return;
  document.querySelectorAll('svg.lc[data-g="' + group + '"]').forEach((svg) => {
    const chart = info.charts[Number(svg.dataset.c)];
    const rect = svg.querySelector('rect[data-i="' + i + '"]');
    const cursor = svg.querySelector(".cursor");
    const label = svg.querySelector(".val");
    if (i === null || !rect) {
      cursor.setAttribute("visibility", "hidden");
      label.setAttribute("visibility", "hidden");
      return;
    }
    const xPos = rect.dataset.x;
    cursor.setAttribute("x1", xPos); cursor.setAttribute("x2", xPos);
    cursor.setAttribute("visibility", "visible");
    label.setAttribute("x", xPos);
    label.textContent = fmtNum(chart.values[i] || 0) + (chart.unit || "");
    label.setAttribute("visibility", "visible");
  });
  const summary = document.getElementById(info.summaryId);
  if (summary) summary.innerHTML = i === null ? info.idle : info.summarize(i);
}

document.addEventListener("mouseover", (event) => {
  const rect = event.target.closest && event.target.closest("rect[data-g]");
  if (rect) chartHover(rect.dataset.g, Number(rect.dataset.i));
});
document.addEventListener("mouseout", (event) => {
  const from = event.target.closest && event.target.closest("svg.lc");
  const to = event.relatedTarget && event.relatedTarget.closest && event.relatedTarget.closest("svg.lc");
  if (from && from !== to && (!to || to.dataset.g !== from.dataset.g)) chartHover(from.dataset.g, null);
});

/**
 * 일별 추이 한 줄짜리. points: [{value, title}] (title은 "YYYY-MM-DD · …").
 * 예전 막대 차트를 같은 선 차트로 바꿨다 — 호출하는 곳은 그대로 둔다.
 */
function trendBars(points, options) {
  if (!points.length) return '<p class="empty">데이터가 아직 없습니다.</p>';
  const opts = options || {};
  const axis = points.map((point, i) => {
    const day = String(point.title || "").slice(5, 10).replace("-", ".");
    // 일 단위는 아래 줄이 이미 날짜다. 위 줄(날짜 경계)은 시간 단위 차트에서만 쓴다.
    return { top: "", bottom: day };
  });
  return chartGroup(axis, [{ label: opts.label || "", values: points.map((point) => point.value || 0),
    unit: opts.unit || "", color: opts.color || "--c-jobs", dash: opts.dash }],
    (i) => esc(points[i].title), '<span class="sub">점에 마우스를 올리면 그날의 숫자가 보입니다.</span>',
    { width: opts.width });
}

function accuracyBlock(accuracy) {
  if (!accuracy || !accuracy.days) {
    return "<h3>정확도</h3><p class=\"empty\">아직 마감된 날이 없습니다. 집계는 하루가 끝난 뒤에 들어옵니다.</p>";
  }
  const feedback = accuracy.feedback.length
    ? '<div class="scroll"><table><thead><tr><th>피드백 사유</th><th class="num">건수</th>' +
      '<th class="num">비중</th></tr></thead><tbody>' +
      accuracy.feedback.map((row) =>
        "<tr><td>" + esc(row.reason) + '</td><td class="num">' + row.count +
        '</td><td class="num' + (row.reason === "candidates_irrelevant" ? " gap" : "") + '">' +
        pct(row.share) + "</td></tr>").join("") + "</tbody></table></div>"
    : '<p class="empty">피드백이 없습니다.</p>';
  return "<h3>정확도 — 어제까지 " + accuracy.days + "일</h3>" +
    metricCards([
      { label: "선택률", value: pct(accuracy.selectionRate),
        hint: "완료 " + accuracy.jobsCompleted + "건 중 고른 Job" },
      { label: "Top-1 비율", value: pct(accuracy.top1Rate),
        hint: "고른 것 중 첫 번째였던 비율" },
      { label: "평균 역순위", value: accuracy.meanReciprocalRank === null ? "—" : accuracy.meanReciprocalRank,
        hint: "1에 가까울수록 위에서 고른다" },
      { label: "내보내기 전환", value: pct(accuracy.exportRate),
        hint: "고른 뒤 실제로 받아 간 비율" },
    ]) +
    '<p class="sub">피드백을 남긴 Job은 ' + pct(accuracy.feedbackRate) +
    "다. 아래 비중은 그 안에서의 비율이라 표본이 작으면 크게 흔들린다.</p>" + feedback +
    "<h3>선택률 추이</h3>" +
    trendBars(accuracy.trend.map((point) => ({
      value: point.selectionRate === null ? 0 : point.selectionRate,
      title: point.day + " · " + pct(point.selectionRate) + " · 완료 " + point.jobsCompleted + "건",
    })), { label: "선택률", unit: "%", color: "--c-jobs" });
}

function usageBlock(usage) {
  if (!usage || !usage.days) return "";
  return "<h3>사용률</h3>" +
    metricCards([
      { label: "하루 평균 분석", value: usage.jobsPerDay === null ? "—" : usage.jobsPerDay,
        hint: "총 " + usage.jobsStarted + "건 / " + usage.days + "일" },
      { label: "설치당 분석", value: usage.jobsPerActiveInstallation === null ? "—" : usage.jobsPerActiveInstallation,
        hint: "활성 설치 " + usage.activeInstallations + "곳 기준" },
      { label: "실패율", value: pct(usage.failureRate),
        hint: "시작 " + usage.jobsStarted + "건 중 실패 " + usage.jobsFailed + "건" },
    ]) +
    trendBars(usage.trend.map((point) => ({
      value: point.jobsStarted,
      title: point.day + " · 시작 " + point.jobsStarted + "건 · 실패 " + point.jobsFailed + "건",
    })), { label: "분석 Job", unit: "건", color: "--c-users", dash: "6 4" });
}

function productRender(data) {
  const drop = data.dropoff;
  $("productOut").innerHTML = accuracyBlock(data.accuracy) + usageBlock(data.usage) +
    instrumentationBlock(data.instrumentation) +
    '<h3>① 퍼널 — 어디서 새는가</h3>' + funnelTable(data.funnel) +
    '<p class="sub">실패한 Job ' + data.jobsFailed + "건. 설치 수는 사람, 건수는 부하다 — 한 사람이 열 번 돌린 것과 열 사람이 한 번씩 돌린 것을 같게 보지 않으려고 함께 센다.</p>" +
    firstRunBlock(data.firstRun) +
    '<h3>③ 코호트 — 누가 어디서 멈췄나</h3>' + cohortCards(data.cohorts) +
    retryBlock(data.retry) +
    '<h3>⑤ 이탈 신호 — 선택한 쪽과 무엇이 달랐나</h3>' +
    '<div class="side"><div class="scroll">' + signalRows(drop) + "</div>" +
    '<div class="scroll">' + levelList("1순위 후보 match_level · 선택함", drop.selected.matchLevels) +
    levelList("1순위 후보 match_level · 선택 안 함", drop.notSelected.matchLevels) + "</div></div>" +
    distanceTable(data.instrumentation ? data.instrumentation.distanceBuckets : null) +
    '<p class="sub" style="margin-top:10px">다시 돌린 Job ' + drop.rerunJobs + "건." +
    (drop.feedback.length
      ? " 선택하지 않은 Job의 피드백: " + drop.feedback.map((f) => esc(f.reason) + "(" + f.count + ")").join(", ")
      : " 선택하지 않은 Job에 달린 피드백은 없다.") + "</p>" +
    libraryBlock(data.library) +
    vlmBlock(data.vlm) +
    '<details style="margin-top:10px"><summary class="sub">클라이언트 이벤트 대조 — 서버 기록과 어긋나면 계측 유실이다</summary>' +
    '<div class="scroll" style="margin-top:8px"><table><thead><tr><th>이벤트</th><th class="num">건수</th><th class="num">설치</th></tr></thead><tbody>' +
    data.clientStages.map((stage) =>
      "<tr><td>" + esc(stage.event) + '</td><td class="num">' + stage.events + '</td><td class="num">' + stage.installations + "</td></tr>"
    ).join("") + "</tbody></table></div></details>";

  // 캡처 실패가 몰린 설치를 누르면 아래 설치 조회로 넘어간다. 집계에서 사람으로
  // 바로 내려갈 수 있어야 "한 명이 갇혀 있다"를 확인할 수 있다.
  $("productOut").querySelectorAll("button[data-pick]").forEach((button) => {
    button.addEventListener("click", () => {
      $("lookupId").value = button.dataset.pick;
      lookupGo(null);
    });
  });
}

async function productGo() {
  $("productMsg").textContent = "불러오는 중…";
  try {
    const res = await fetch("/v1/admin/product?days=" + encodeURIComponent($("period").value), {
      headers: { "X-Beta-Admin-Token": token },
    });
    if (!res.ok) throw new Error(res.status === 404 ? "토큰이 거절됐습니다." : "조회 실패 " + res.status);
    const data = await res.json();
    $("productMsg").textContent = "최근 " + data.windowDays + "일 · " + when(data.since) + " 이후";
    productRender(data);
  } catch (error) {
    $("productMsg").innerHTML = '<span class="err">' + esc(error.message) + "</span>";
    $("productOut").innerHTML = "";
  }
}

$("productGo").addEventListener("click", productGo);
$("recentGo").addEventListener("click", recentGo);
$("recentStatus").addEventListener("change", () => { if (recent.items.length) recentGo(); });


// ── 설치 명부 ────────────────────────────────────────────────
//
// id를 외워 두거나 S3 prefix를 훑지 않고도 "누가 있나"에서 시작할 수 있게 한다.
let roster = { items: [], nextCursor: null };

async function rosterFetch(cursor) {
  const query = "limit=20" +
    ($("rosterActive").checked ? "&activeOnly=true" : "") +
    (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
  const res = await fetch("/v1/admin/review/installations?" + query, {
    headers: { "X-Beta-Admin-Token": token },
  });
  if (!res.ok) throw new Error(res.status === 404 ? "토큰이 거절됐습니다." : "명부 조회 실패 " + res.status);
  return res.json();
}

function rosterRender() {
  if (!roster.items.length) {
    $("rosterOut").innerHTML = '<p class="empty">설치가 없습니다.</p>';
    return;
  }
  const rows = roster.items.map((item) =>
    '<tr><td><button class="ghost" data-pick="' + esc(item.installationId) + '">조회</button></td>' +
    '<td class="mono" title="' + esc(item.installationId) + '">' + esc(item.installationId.slice(5, 17)) + "…</td>" +
    "<td>" + when(item.lastSeenAt) + "</td>" +
    '<td class="sub">' + esc(item.appVersion || "?") + " · " + esc(item.osName || "?") + "</td>" +
    '<td><span class="strip" data-strip="' + esc(item.installationId) + '"></span></td>' +
    '<td class="num">' + item.jobCount + "</td>" +
    '<td class="num' + (item.failedCount ? " err" : "") + '">' + item.failedCount + "</td>" +
    "<td>" + (item.lastJobAt ? when(item.lastJobAt) : '<span class="sub">없음</span>') + "</td>" +
    "<td>" + (item.revokedAt ? pill("철회", "bad") : item.deletionRequestedAt ? pill("삭제 요청", "warn") : "") + "</td></tr>"
  ).join("");

  $("rosterOut").innerHTML =
    '<div class="scroll" style="margin-top:12px"><table><thead><tr><th></th><th>설치</th><th>마지막 접속</th>' +
    '<th>앱 · OS</th><th title="오래된 날 → 오늘. 테두리 = 방문, 채움 = 분석">최근 7일</th><th class="num">Job</th><th class="num">실패</th><th>마지막 분석</th><th></th>' +
    "</tr></thead><tbody>" + rows + "</tbody></table></div>" +
    (roster.nextCursor ? '<p style="margin:10px 0 0"><button class="ghost" id="rosterMore">설치 더 보기</button></p>' : "");

  rosterStrips();
  $("rosterOut").querySelectorAll("button[data-pick]").forEach((button) => {
    button.addEventListener("click", () => {
      $("lookupId").value = button.dataset.pick;
      lookupGo(null);
    });
  });
  if ($("rosterMore")) $("rosterMore").addEventListener("click", () => rosterGo(roster.nextCursor));
}

async function rosterGo(cursor) {
  $("lookupMsg").textContent = "명부 조회 중…";
  try {
    const data = await rosterFetch(cursor);
    roster.nextCursor = data.nextCursor;
    roster.items = cursor ? roster.items.concat(data.items) : data.items;
    $("lookupMsg").textContent = "설치 " + roster.items.length + "곳" + (data.nextCursor ? " (더 있음)" : "");
    rosterRender();
  } catch (error) {
    $("lookupMsg").innerHTML = '<span class="err">' + esc(error.message) + "</span>";
    $("rosterOut").innerHTML = "";
  }
}

$("rosterGo").addEventListener("click", () => rosterGo(null));
$("rosterActive").addEventListener("change", () => { if (roster.items.length) rosterGo(null); });

$("lookupGo").addEventListener("click", () => lookupGo(null));
$("lookupId").addEventListener("keydown", (event) => { if (event.key === "Enter") lookupGo(null); });
$("lookupStatus").addEventListener("change", () => { if (lookup.id) lookupGo(null); });

// ── 개요 ─────────────────────────────────────────────────────
function kpiCard(label, value, hint, kind) {
  return '<div class="kpi' + (kind ? " " + kind : "") + '"><div class="label">' + esc(label) + "</div>" +
    '<div class="value">' + esc(String(value)) + "</div>" +
    (hint ? '<div class="hint">' + esc(hint) + "</div>" : "") + "</div>";
}

function overviewRender(data) {
  const k = data.kpis;
  const n = (value) => (value === null || value === undefined ? "—" : value);
  $("kpis").innerHTML =
    kpiCard("활성 설치", n(k.activeInstallations), "기간 중 접속 · 전체 " + k.totalInstallations + "곳") +
    kpiCard("오늘 활성", n(k.activeToday), "최근 24시간 접속") +
    kpiCard("분석", n(k.jobsStarted), "완료 " + k.jobsCompleted + "건") +
    kpiCard("선택률", pct(k.selectionRate), "완료 중 고른 Job " + k.jobsSelected + "건") +
    kpiCard("다운로드", n(k.downloads), "내보낸 Job " + k.jobsExported + "건 · 전환 " + pct(k.exportRate)) +
    kpiCard("실패율", pct(k.failureRate), "실패 " + k.jobsFailed + "건",
      k.failureRate !== null && k.failureRate >= 10 ? "bad" : k.failureRate !== null && k.failureRate >= 5 ? "warn" : "") +
    kpiCard("피드백", n(k.feedbackCount), "관련 없음 " + pct(k.irrelevantRate),
      k.irrelevantRate !== null && k.irrelevantRate >= 30 ? "warn" : "");
  $("kpiNote").textContent = "최근 " + data.windowDays + "일 · " + when(data.since) +
    " 이후. 위 숫자는 오늘까지, 아래 추이는 하루가 끝난 날(어제)까지다.";
  const days = data.trends.days;
  $("ovSelection").innerHTML = days
    ? trendBars(data.trends.selection.map((point) => ({
        value: point.selectionRate === null ? 0 : point.selectionRate,
        title: point.day + " · " + pct(point.selectionRate) + " · 완료 " + point.jobsCompleted + "건",
      })), { unit: "%", color: "--c-jobs", width: 480 })
    : '<p class="empty">아직 마감된 날이 없습니다.</p>';
  $("ovUsage").innerHTML = days
    ? trendBars(data.trends.usage.map((point) => ({
        value: point.jobsStarted,
        title: point.day + " · 시작 " + point.jobsStarted + "건 · 실패 " + point.jobsFailed + "건",
      })), { unit: "건", color: "--c-users", dash: "6 4", width: 480 })
    : '<p class="empty">아직 마감된 날이 없습니다.</p>';
}

async function overviewGo() {
  try {
    const res = await fetch("/v1/admin/overview?days=" + encodeURIComponent($("period").value), {
      headers: { "X-Beta-Admin-Token": token },
    });
    if (!res.ok) throw new Error("개요 조회 실패 " + res.status);
    overviewRender(await res.json());
  } catch (error) {
    $("kpis").innerHTML = '<p class="err">' + esc(error.message) + "</p>";
  }
  // 첫 화면의 최근 Job은 작업 탭 목록과 같은 질의를 앞 8건만 쓴다.
  try {
    const page = await recentFetch(null);
    const rows = page.items.slice(0, 8).map((item) =>
      "<tr><td>" + jobStatus(item) + "</td>" +
      '<td class="sub">' + when(item.createdAt) + "</td>" +
      '<td class="num">' + took(item) + "</td>" +
      '<td class="num">' + (item.personCount === null || item.personCount === undefined ? "—" : item.personCount) + "</td>" +
      '<td class="num">' + (item.selectionCount === null || item.selectionCount === undefined ? "—" : item.selectionCount) + "</td>" +
      "<td>" + (item.errorCode ? pill(esc(item.errorCode), "bad") : "") + "</td>" +
      '<td><button class="ghost" data-job="' + esc(item.jobId) + '">상세</button></td></tr>').join("");
    $("ovRecent").innerHTML = rows
      ? '<div class="scroll"><table><thead><tr><th>상태</th><th>들어온 때</th><th class="num">걸린 시간</th>' +
        '<th class="num">인물</th><th class="num">선택</th><th>오류</th><th></th></tr></thead><tbody>' +
        rows + "</tbody></table></div>"
      : '<p class="empty">아직 없습니다.</p>';
    $("ovRecent").querySelectorAll("button[data-job]").forEach((button) => {
      button.addEventListener("click", () => openDetail(button.dataset.job, button));
    });
  } catch (error) {
    $("ovRecent").innerHTML = '<p class="err">' + esc(error.message) + "</p>";
  }
}

// ── 시간대별 활동 ───────────────────────────────────────────
const ACT_BUCKETS = { "24h": ["1h", "3h"], "7d": ["3h", "6h", "1d"], "30d": ["6h", "1d"] };
const BUCKET_LABEL = { "1h": "1시간", "3h": "3시간", "6h": "6시간", "1d": "1일" };
const activity = { range: "24h", bucket: "1h" };

function activityControls() {
  document.querySelectorAll("#actRange button").forEach((button) => {
    button.classList.toggle("on", button.dataset.range === activity.range);
  });
  $("actBucket").innerHTML = ACT_BUCKETS[activity.range].map((bucket) =>
    '<button data-bucket="' + bucket + '" class="' + (bucket === activity.bucket ? "on" : "") + '">' +
    BUCKET_LABEL[bucket] + "</button>").join("");
  $("actBucket").querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => { activity.bucket = button.dataset.bucket; activityGo(); });
  });
}

function activityRender(data) {
  const points = data.points;
  if (!points.length) { $("actOut").innerHTML = '<p class="empty">데이터가 없습니다.</p>'; return; }
  const daily = data.bucket === "1d";
  let lastDay = "";
  const axis = points.map((point) => {
    const at = kst(point.start);
    const top = at.md !== lastDay ? at.md : "";
    lastDay = at.md;
    return daily ? { top: "", bottom: at.md } : { top, bottom: at.hm };
  });
  const sum = (key) => points.reduce((total, point) => total + point[key], 0);
  const idle = '<span class="sub">총 분석 ' + sum("jobsStarted") + "건(완료 " + sum("jobsCompleted") +
    " · 실패 " + sum("jobsFailed") + ") · 다운로드 " + sum("downloads") +
    "건. 들어온 설치는 구간마다 따로 세므로 더하지 않는다. 점에 마우스를 올리면 구간별 숫자가 보인다.</span>";
  const summarize = (i) => {
    const point = points[i];
    const from = kst(point.start), to = kst(point.end);
    const partial = i === points.length - 1;
    return "<b>" + from.md + " " + from.hm + " → " + to.md + " " + to.hm + " KST</b>" +
      " · 들어온 설치 <b>" + point.activeInstallations + "명</b>" +
      " · 분석 Job <b>" + point.jobsStarted + "건</b> (완료 " + point.jobsCompleted + " · 실패 " +
      '<span class="' + (point.jobsFailed ? "err" : "") + '">' + point.jobsFailed + "</span>)" +
      " · 다운로드 <b>" + point.downloads + "건</b>" + (partial ? ' <span class="sub">· 진행 중인 구간</span>' : "");
  };
  $("actOut").innerHTML = chartGroup(axis, [
    { label: "들어온 설치", values: points.map((point) => point.activeInstallations), unit: "명", color: "--c-users", dash: "1 5" },
    { label: "분석 Job", values: points.map((point) => point.jobsStarted), unit: "건", color: "--c-jobs", dash: "6 4" },
    { label: "다운로드", values: points.map((point) => point.downloads), unit: "건", color: "--c-down", dash: "3 3" },
  ], summarize, idle, { partialLast: true });
}

async function activityGo() {
  activityControls();
  $("actMsg").textContent = "불러오는 중…";
  try {
    const query = new URLSearchParams({ range: activity.range, bucket: activity.bucket });
    const res = await fetch("/v1/admin/timeseries?" + query.toString(), { headers: { "X-Beta-Admin-Token": token } });
    if (!res.ok) throw new Error("조회 실패 " + res.status);
    const data = await res.json();
    $("actMsg").textContent = BUCKET_LABEL[data.bucket] + " 단위 · 한국 시간";
    activityRender(data);
  } catch (error) {
    $("actMsg").innerHTML = '<span class="err">' + esc(error.message) + "</span>";
  }
}

document.querySelectorAll("#actRange button").forEach((button) => {
  button.addEventListener("click", () => {
    activity.range = button.dataset.range;
    activity.bucket = ACT_BUCKETS[activity.range][0];
    activityGo();
  });
});

// ── 사용자(설치)별 활동 ─────────────────────────────────────
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
function dayLabel(date) {
  const weekday = WEEKDAYS[new Date(date + "T00:00:00Z").getUTCDay()];
  return date.slice(5).replace("-", ".") + " (" + weekday + ")";
}
const OUTCOME_PILL = { selected: "ok", no_selection: "warn", zero_people: "warn", failed: "bad", in_progress: "warn" };

async function installActivityGo(installationId) {
  $("activityOut").innerHTML = '<p class="sub">활동 불러오는 중…</p>';
  try {
    const res = await fetch("/v1/admin/review/installations/" + encodeURIComponent(installationId) + "/activity",
      { headers: { "X-Beta-Admin-Token": token } });
    if (!res.ok) throw new Error("활동 조회 실패 " + res.status);
    activityRenderInstall(await res.json());
  } catch (error) {
    $("activityOut").innerHTML = '<p class="err">' + esc(error.message) + "</p>";
  }
}

function activityRenderInstall(data) {
  const last = data.lastVisit ? (data.lastVisit === data.today ? "오늘" : dayLabel(data.lastVisit)) : "없음";
  const cells = data.days.map((day) =>
    '<div class="day' + (day.date === data.today ? " today" : "") + '" title="' + esc(dayLabel(day.date)) +
    (day.visited ? " · 방문" : " · 안 옴") + (day.jobs ? " · 분석 " + day.jobs + "건 · 선택 " + day.selected + "건" : "") + '">' +
    esc(day.date === data.today ? "오늘" : day.date.slice(8)) +
    '<div class="dot t-' + day.tone + '"></div>' + (day.jobs ? day.jobs + "건" : "&nbsp;") + "</div>").join("");
  const byDay = {};
  data.jobs.forEach((job) => { (byDay[job.day] = byDay[job.day] || []).push(job); });
  const list = Object.keys(byDay).sort().reverse().map((date) =>
    '<div class="dayhead">' + esc(date === data.today ? "오늘 · " + dayLabel(date) : dayLabel(date)) + " · " + byDay[date].length + "건</div>" +
    '<div class="scroll"><table><tbody>' + byDay[date].map((job) =>
      "<tr><td class=\"sub\">" + esc(kst(job.createdAt).hm) + "</td>" +
      "<td>" + pill(esc(job.outcomeLabel), OUTCOME_PILL[job.outcome] || "warn") + "</td>" +
      '<td class="sub">인물 ' + job.personCount + "명</td>" +
      "<td>" + (job.exported ? pill("내보냄", "ok") : '<span class="sub">내보내기 없음</span>') + "</td>" +
      "<td>" + (job.refined ? pill("조정됨", "ok") : "") + "</td>" +
      "<td>" + (job.feedback ? '<span class="sub">피드백: ' + esc(job.feedback) + "</span>" : "") +
        (job.errorCode ? ' <span class="err mono">' + esc(job.errorCode) + "</span>" : "") + "</td>" +
      '<td><button class="ghost" data-detail="' + esc(job.jobId) + '">상세</button></td></tr>').join("") +
    "</tbody></table></div>").join("");
  $("activityOut").innerHTML =
    '<div class="card" style="margin:12px 0"><h2>최근 14일 활동</h2>' +
    '<div class="chart-summary">최근 14일 중 <b>' + data.visitedDays + "일</b> 방문 · 마지막 방문 <b>" + esc(last) +
    "</b> · 분석 <b>" + data.jobsTotal + "건</b> 중 후보 선택 <b>" + data.jobsSelected + "건</b></div>" +
    '<div class="days">' + cells + "</div>" +
    '<p class="sub">점: 초록 = 후보를 고른 날 · 주황 = 돌렸지만 고르지 않음 · 빨강 = 실패만 · 테두리만 = 방문만</p>' +
    (list || '<p class="empty">최근 14일 동안 돌린 분석이 없습니다.</p>') + "</div>";
  $("activityOut").querySelectorAll("button[data-detail]").forEach((button) => {
    button.addEventListener("click", () => openDetail(button.dataset.detail, button));
  });
}

async function rosterStrips() {
  const spans = Array.from($("rosterOut").querySelectorAll("span[data-strip]"));
  const ids = spans.map((span) => span.dataset.strip).slice(0, 50);
  if (!ids.length) return;
  try {
    const res = await fetch("/v1/admin/review/installations-activity?ids=" + encodeURIComponent(ids.join(",")),
      { headers: { "X-Beta-Admin-Token": token } });
    if (!res.ok) return;
    const data = await res.json();
    spans.forEach((span) => {
      const cells = data.strips[span.dataset.strip] || [];
      span.innerHTML = cells.map((cell) =>
        '<i class="' + (cell.jobs ? "j" : cell.visited ? "v" : "") + '" title="' + esc(dayLabel(cell.date)) +
        (cell.jobs ? " · 분석 " + cell.jobs + "건" : cell.visited ? " · 방문" : " · 안 옴") + '"></i>').join("");
    });
  } catch (error) { /* 출석 칸은 없어도 목록은 쓸 수 있다 */ }
}

// ── 모아 보기 ───────────────────────────────────────────────
//
// 사용자 사진을 여러 장 여는 화면이라 서버가 페이지마다 열람 기록을 남긴다(24장씩,
// 서명 URL 5분). 포즈 라이브러리는 공용 자산이라 그런 제한이 없다.
const gallery = { mode: "roughs", group: "date", folder: null, cursor: null, blobs: [] };
const GROUPS = {
  roughs: [["date", "날짜별"], ["installation", "설치별"], ["status", "결과별"]],
  poses: [["sources", "출처별"], ["categories", "분류별"]],
};

function galleryReleaseBlobs() {
  gallery.blobs.forEach((url) => URL.revokeObjectURL(url));
  gallery.blobs = [];
}

function galleryControls() {
  document.querySelectorAll("#galMode button").forEach((button) => {
    button.classList.toggle("on", button.dataset.mode === gallery.mode);
  });
  $("galGroup").innerHTML = GROUPS[gallery.mode].map(([key, label]) =>
    '<button data-group="' + key + '" class="' + (key === gallery.group ? "on" : "") + '">' + label + "</button>").join("");
  $("galGroup").querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => { gallery.group = button.dataset.group; galleryGo(); });
  });
  $("galSearch").style.display = gallery.mode === "poses" ? "" : "none";
  $("galNote").textContent = gallery.mode === "roughs"
    ? "최근 90일 · 동의 철회·삭제 요청 설치 제외 · 24장씩 · 페이지를 열 때마다 열람 기록이 남습니다. 누르면 오른쪽에 상세가 열립니다."
    : "검색에 쓰이는 라이브러리 그대로입니다(격리된 포즈 제외). 누르면 네 방향을 크게 봅니다.";
}

function folderLabel(folder) {
  if (gallery.mode === "roughs" && gallery.group === "date") return dayLabel(folder.key);
  if (gallery.mode === "roughs" && gallery.group === "installation") return folder.key.slice(5, 17) + "…";
  return folder.label || folder.key;
}

async function galleryGo() {
  galleryControls();
  galleryReleaseBlobs();
  $("galFolders").innerHTML = '<p class="sub" style="padding:10px">불러오는 중…</p>';
  $("galTiles").innerHTML = "";
  $("galMoreWrap").innerHTML = "";
  try {
    let folders;
    if (gallery.mode === "roughs") {
      const res = await fetch("/v1/admin/gallery/folders?group=" + gallery.group, { headers: { "X-Beta-Admin-Token": token } });
      if (!res.ok) throw new Error("폴더 조회 실패 " + res.status);
      folders = (await res.json()).folders;
    } else {
      const res = await fetch("/v1/admin/gallery/pose-folders", { headers: { "X-Beta-Admin-Token": token } });
      if (!res.ok) throw new Error("라이브러리 폴더 조회 실패 " + res.status);
      const data = await res.json();
      folders = data[gallery.group];
      $("galMsg").textContent = "포즈 " + data.total + "개";
    }
    if (!folders.length) { $("galFolders").innerHTML = '<p class="empty" style="padding:10px">비어 있습니다.</p>'; return; }
    $("galFolders").innerHTML = folders.map((folder) =>
      '<button data-key="' + esc(folder.key) + '" title="' + esc(folder.key) + '"><span>' + esc(folderLabel(folder)) +
      '</span><span class="count">' + folder.count + "</span></button>").join("");
    $("galFolders").querySelectorAll("button").forEach((button) => {
      button.addEventListener("click", () => galleryOpenFolder(button.dataset.key));
    });
    galleryOpenFolder(folders[0].key);
  } catch (error) {
    $("galFolders").innerHTML = '<p class="err" style="padding:10px">' + esc(error.message) + "</p>";
  }
}

function galleryOpenFolder(key) {
  gallery.folder = key;
  gallery.cursor = null;
  galleryReleaseBlobs();
  $("galTiles").innerHTML = "";
  $("galFolders").querySelectorAll("button").forEach((button) => {
    button.classList.toggle("on", button.dataset.key === key);
  });
  galleryLoad();
}

async function galleryLoad() {
  $("galMoreWrap").innerHTML = '<span class="sub">불러오는 중…</span>';
  try {
    const params = new URLSearchParams();
    let url;
    if (gallery.mode === "roughs") {
      params.set("group", gallery.group);
      params.set("key", gallery.folder);
      url = "/v1/admin/gallery/roughs?";
    } else {
      params.set(gallery.group === "sources" ? "source" : "category", gallery.folder);
      if ($("galSearch").value.trim()) params.set("q", $("galSearch").value.trim());
      url = "/v1/admin/gallery/poses?";
    }
    if (gallery.cursor) params.set("cursor", gallery.cursor);
    const res = await fetch(url + params.toString(), { headers: { "X-Beta-Admin-Token": token } });
    if (!res.ok) throw new Error("조회 실패 " + res.status);
    const data = await res.json();
    const tiles = gallery.mode === "roughs" ? data.items.map(roughTile) : data.items.map(poseTile);
    $("galTiles").insertAdjacentHTML("beforeend", tiles.join(""));
    gallery.cursor = data.nextCursor || data.next_cursor || null;
    $("galMoreWrap").innerHTML = gallery.cursor ? '<button class="ghost" id="galMore">더 보기</button>' : "";
    if ($("galMore")) $("galMore").addEventListener("click", galleryLoad);
    bindTiles();
  } catch (error) {
    $("galMoreWrap").innerHTML = '<span class="err">' + esc(error.message) + "</span>";
  }
}

function roughTile(item) {
  return '<button class="tile" data-job="' + esc(item.jobId) + '">' +
    '<div class="bar o-' + esc(item.outcome) + '"></div>' +
    '<div class="img">' + (item.inputUrl ? '<img loading="lazy" src="' + esc(item.inputUrl) + '" alt="">' : '<span class="sub">원본 만료</span>') + "</div>" +
    '<div class="cap"><div>' + pill(esc(item.outcomeLabel), OUTCOME_PILL[item.outcome] || "warn") + "</div>" +
    '<div class="sub">' + esc(kst(item.createdAt).md + " " + kst(item.createdAt).hm) + " · 인물 " + item.personCount + "명</div>" +
    '<div class="sub">' + (item.exported ? "내보냄" : "내보내기 없음") + (item.refined ? " · 조정됨" : "") + "</div></div></button>";
}

function poseTile(item) {
  const view = item.views.includes("three_quarter") ? "three_quarter" : item.views[0];
  return '<button class="tile" data-pose-open="' + esc(item.pose_id) + '" data-views="' + esc(item.views.join(",")) +
    '" data-meta="' + esc(item.source_label + " · " + item.category + " · " + item.action + (item.review_status ? " · " + item.review_status : "")) + '">' +
    '<div class="img"><img data-gal-pose="' + esc(item.pose_id) + '" data-view="' + esc(view) + '" alt=""></div>' +
    '<div class="cap"><div class="mono" title="' + esc(item.pose_id) + '">' + esc(item.pose_id.slice(0, 22)) + "</div>" +
    '<div class="sub">' + esc(item.category) + " · " + esc(item.action) + "</div></div></button>";
}

async function galleryPoseThumb(img) {
  try {
    const res = await fetch("/v1/admin/review/pose-candidates/" + encodeURIComponent(img.dataset.galPose) +
      "/thumbnail?view=" + encodeURIComponent(img.dataset.view), { headers: { "X-Beta-Admin-Token": token } });
    if (!res.ok) return;
    const url = URL.createObjectURL(await res.blob());
    gallery.blobs.push(url);
    img.src = url;
  } catch (error) { /* 썸네일 하나 없다고 목록을 막지 않는다 */ }
}

function bindTiles() {
  $("galTiles").querySelectorAll("img[data-gal-pose]:not([src])").forEach(galleryPoseThumb);
  $("galTiles").querySelectorAll("button[data-job]:not([data-bound])").forEach((button) => {
    button.dataset.bound = "1";
    button.addEventListener("click", () => openDetail(button.dataset.job, button));
  });
  $("galTiles").querySelectorAll("button[data-pose-open]:not([data-bound])").forEach((button) => {
    button.dataset.bound = "1";
    button.addEventListener("click", () => openPose(button));
  });
}

function openPose(button) {
  releaseDetailBlobs();
  const poseId = button.dataset.poseOpen;
  const views = button.dataset.views.split(",");
  $("lookupOut").innerHTML = "";
  $("activityOut").innerHTML = "";
  $("detailOut").innerHTML = '<div class="detail"><h3 class="mono">' + esc(poseId) + "</h3>" +
    '<p class="sub">' + esc(button.dataset.meta) + "</p>" +
    '<div class="cands">' + views.map((view) =>
      '<div class="cand"><img data-pose="' + esc(poseId) + '" data-view="' + esc(view) + '" alt="">' +
      '<div class="sub" style="margin-top:6px">' + esc(view) + "</div></div>").join("") + "</div></div>";
  $("detailOut").querySelectorAll(".cand img[data-pose]").forEach(fillCandidateThumb);
  showDrawer("detail");
  $("drawerTitle").textContent = "포즈";
}

document.querySelectorAll("#galMode button").forEach((button) => {
  button.addEventListener("click", () => {
    gallery.mode = button.dataset.mode;
    gallery.group = GROUPS[gallery.mode][0][0];
    galleryGo();
  });
});
$("galSearch").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && gallery.folder) galleryOpenFolder(gallery.folder);
});

// ── 탭 ───────────────────────────────────────────────────────
//
// 탭을 처음 열 때만 그 탭의 데이터를 가져온다. 열지 않은 탭 때문에 첫 화면이 느려지지
// 않게 한다. 마지막으로 본 탭은 이 브라우저에만 기억한다(없어도 개요로 연다).
const TAB_KEY = "standin.adminTab";
const loadedTabs = new Set(["overview", "ops"]);

function selectTab(name) {
  document.querySelectorAll("#tabs button").forEach((button) => {
    button.classList.toggle("on", button.dataset.tab === name);
  });
  document.querySelectorAll("section.tab").forEach((section) => {
    section.classList.toggle("on", section.id === "tab-" + name);
  });
  try { localStorage.setItem(TAB_KEY, name); } catch (error) { /* 저장 못 해도 동작은 같다 */ }
  if (loadedTabs.has(name)) return;
  loadedTabs.add(name);
  if (name === "jobs") recentGo();
  if (name === "installs") rosterGo(null);
  if (name === "metrics") productGo();
  if (name === "gallery") galleryGo();
}

document.querySelectorAll("#tabs button").forEach((button) => {
  button.addEventListener("click", () => selectTab(button.dataset.tab));
});
document.querySelectorAll("button[data-goto]").forEach((button) => {
  button.addEventListener("click", () => selectTab(button.dataset.goto));
});

$("period").addEventListener("change", () => {
  overviewGo();
  if (loadedTabs.has("metrics")) productGo();
});

$("drawerClose").addEventListener("click", closeDrawer);
$("backdrop").addEventListener("click", closeDrawer);
$("drawerBack").addEventListener("click", () => {
  releaseDetailBlobs();
  $("detailOut").innerHTML = "";
  showDrawer("install");
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && $("drawer").classList.contains("on")) closeDrawer();
});

let overviewLoaded = false;
async function boot() {
  await tick();
  if (overviewLoaded || $("app").classList.contains("hide")) return;
  overviewLoaded = true;
  overviewGo();
  activityGo();
  let saved = null;
  try { saved = localStorage.getItem(TAB_KEY); } catch (error) { saved = null; }
  if (saved && saved !== "overview" && document.getElementById("tab-" + saved)) selectTab(saved);
}

$("enter").addEventListener("click", () => {
  token = $("token").value.trim();
  sessionStorage.setItem(KEY, token);
  boot();
});

if (token) { sessionStorage.setItem(KEY, token); boot(); }
else { $("gate").classList.add("show"); }
setInterval(() => { if (token) tick(); }, 30000);
</script>
</body>
</html>`;
