// 운영 대시보드 한 장(계획 3단계).
//
// 의존성이 없는 정적 HTML이다. 번들러도 CDN도 쓰지 않는 이유는 이 화면이 **장애 때**
// 열리는 화면이기 때문이다 — 외부 CDN이 막히거나 느릴 때 대시보드까지 안 뜨면 곤란하다.
// 차트도 라이브러리 없이 인라인 SVG로 그린다.
//
// 토큰은 페이지에 심지 않는다. 주소창의 ?token= 은 로드 직후 history.replaceState로
// 지우고 sessionStorage에만 남긴다 — 브라우저 히스토리·리퍼러에 토큰이 남지 않게 한다.

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
    --bg: #0f1115; --panel: #171a21; --line: #262b36; --text: #e6e9ef;
    --muted: #98a2b3; --ok: #2f9e44; --warn: #f08c00; --bad: #e03131; --accent: #4dabf7;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg:#f6f7f9; --panel:#fff; --line:#e4e7ec; --text:#101828; --muted:#667085; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 ui-sans-serif,system-ui,"Segoe UI",sans-serif; }
  header { padding:16px 20px; border-bottom:1px solid var(--line); display:flex; gap:16px; align-items:center; flex-wrap:wrap; }
  h1 { font-size:16px; margin:0; font-weight:600; }
  main { padding:20px; display:grid; gap:16px; max-width:1200px; margin:0 auto; }
  .row { display:grid; gap:16px; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
  .card h2 { font-size:12px; margin:0 0 8px; color:var(--muted); font-weight:600; letter-spacing:.03em; }
  .big { font-size:28px; font-weight:650; font-variant-numeric:tabular-nums; }
  .sub { color:var(--muted); font-size:12px; }
  .pill { display:inline-flex; align-items:center; gap:6px; padding:3px 9px; border-radius:999px; font-size:12px; font-weight:600; }
  .pill.ok { background:color-mix(in srgb,var(--ok) 18%,transparent); color:var(--ok); }
  .pill.warn { background:color-mix(in srgb,var(--warn) 18%,transparent); color:var(--warn); }
  .pill.bad { background:color-mix(in srgb,var(--bad) 18%,transparent); color:var(--bad); }
  table { width:100%; border-collapse:collapse; font-variant-numeric:tabular-nums; }
  th,td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); }
  th { color:var(--muted); font-size:12px; font-weight:600; }
  td.num, th.num { text-align:right; }
  .scroll { overflow-x:auto; }
  svg { display:block; width:100%; height:120px; }
  .empty { color:var(--muted); padding:12px 0; }
  button { font:inherit; background:var(--accent); color:#04121f; border:0; border-radius:8px; padding:7px 14px; font-weight:600; cursor:pointer; }
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
    <span style="margin-left:auto" class="sub">갱신 <span id="updated">—</span></span>
  </header>
  <main>
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
      <div id="lookupOut"></div>
      <div id="detailOut"></div>
    </div>
    <p class="sub">
      지연시간은 히스토그램에서 읽은 값이라 버킷 상한까지만 정확하다("이 값 이하"라는 뜻).
      태스크별 p95를 평균 내면 p95가 아니게 되므로 값 대신 분포를 저장한다.
    </p>
  </main>
</div>

<script>
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
  const width = 1000, height = 120, gap = 2;
  const barWidth = Math.max(1, width / points.length - gap);
  const peak = Math.max(1, ...points.map((p) => p.requests));
  const bars = points.map((point, index) => {
    const x = index * (barWidth + gap);
    const total = Math.round((point.requests / peak) * (height - 20));
    const bad = Math.round((point.errors5xx / peak) * (height - 20));
    const okPart = '<rect x="' + x + '" y="' + (height - total) + '" width="' + barWidth + '" height="' + Math.max(0, total - bad) + '" fill="var(--accent)" opacity=".75"><title>' + esc(labelOf(point)) + " · " + point.requests + "건 · p95 " + ms(point.p95Ms) + "</title></rect>";
    const badPart = bad > 0 ? '<rect x="' + x + '" y="' + (height - bad) + '" width="' + barWidth + '" height="' + bad + '" fill="var(--bad)"><title>5xx ' + point.errors5xx + "건</title></rect>" : "";
    return okPart + badPart;
  }).join("");
  return '<svg viewBox="0 0 ' + width + " " + height + '" preserveAspectRatio="none">' + bars + "</svg>";
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
  $("inference").innerHTML = data.inferenceHealthy ? pill("추론 정상", "ok") : pill("추론 응답 없음", "bad");
  $("analysis").innerHTML = data.analysisEnabled ? pill("분석 켜짐", "ok") : pill("분석 중단됨", "warn");
  $("tasks").textContent = "태스크 BFF " + (data.tasks.bff || 0) + " · 추론 " + (data.tasks.inference || 0);
  $("updated").textContent = new Date(data.now).toLocaleTimeString("ko-KR");

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

function refineCard(row) {
  return '<div class="cand">' +
    (row.thumbnailUrl ? '<img src="' + esc(row.thumbnailUrl) + '" alt="">' : '<div class="sub">미리보기 없음</div>') +
    '<div style="margin:6px 0 4px">' + (row.refined ? pill("조정됨", "ok") : pill("조정 안 함", "warn")) + "</div>" +
    '<div class="sub mono" title="' + esc(row.poseId) + '">' + esc(String(row.poseId).slice(0, 16)) + "</div>" +
    '<div class="sub">' + esc(row.reason || "—") + "</div>" +
    (row.limbs && row.limbs.length ? '<div class="sub">' + esc(row.limbs.join(", ")) + "</div>" : "") +
    (row.bvhUrl ? '<div class="sub" style="margin-top:4px"><a href="' + esc(row.bvhUrl) + '" target="_blank" rel="noopener">BVH</a></div>' : "") +
    "</div>";
}

function detailRender(detail) {
  releaseDetailBlobs();
  const byPerson = groupBy(detail.candidates, "person_index");
  const refinedByPerson = groupBy(detail.refined, "personIndex");
  const chosen = new Map((detail.selections || []).map((s) => [s.person_index, s.candidate_id]));

  const people = (detail.people || []).map((person) => {
    const index = person.person_index;
    const candidates = byPerson.get(index) || [];
    const refined = refinedByPerson.get(index) || [];
    const selectedId = chosen.get(index);
    return "<h3>인물 " + index + " · 후보 " + candidates.length + "개" +
      (person.confidence ? " · 신뢰도 " + esc(person.confidence) : "") +
      (selectedId ? " · " + pill("선택 있음", "ok") : " · " + pill("선택 없음", "warn")) +
      (person.candidate_shortfall_reason ? ' <span class="sub">' + esc(person.candidate_shortfall_reason) + "</span>" : "") +
      "</h3>" +
      (candidates.length
        ? '<div class="cands">' + candidates.map((row) => candidateCard(row, selectedId)).join("") + "</div>"
        : '<p class="empty">후보가 없습니다.</p>') +
      (refined.length
        ? "<h3>refine 결과</h3><div class=\"cands\">" + refined.map(refineCard).join("") + "</div>"
        : "");
  }).join("");

  $("detailOut").innerHTML =
    '<div class="detail">' +
    '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
    '<span class="mono">' + esc(detail.jobId) + "</span>" + jobStatus({ status: detail.status, personCount: (detail.people || []).length }) +
    '<span class="sub">' + when(detail.createdAt) + "</span>" +
    '<button class="ghost" id="detailClose" style="margin-left:auto">닫기</button></div>' +
    '<div class="side" style="margin-top:12px"><div><h3>원본 러프</h3>' +
    (detail.inputUrl
      ? '<img class="shot" src="' + esc(detail.inputUrl) + '" alt=""><p class="sub">서명 URL은 ' + (detail.inputUrlExpiresInSeconds || 300) + "초 뒤 만료된다.</p>"
      : '<p class="empty">원본이 남아 있지 않습니다(90일 lifecycle).</p>') +
    "</div><div>" +
    (detail.feedback ? "<h3>사용자 피드백</h3><p>" + esc(detail.feedback) + "</p>" : "") +
    (detail.inferenceMetadata
      ? '<h3>추론 메타</h3><details><summary class="sub">펼치기</summary><pre class="mono" style="white-space:pre-wrap">' +
        esc(JSON.stringify(detail.inferenceMetadata, null, 2)) + "</pre></details>"
      : "") +
    "</div></div>" + people + "</div>";

  $("detailOut").querySelectorAll(".cand img[data-pose]").forEach(fillCandidateThumb);
  $("detailClose").addEventListener("click", () => {
    releaseDetailBlobs();
    $("detailOut").innerHTML = "";
  });
  $("detailOut").scrollIntoView({ behavior: "smooth", block: "start" });
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
    lookupRender();
  } catch (error) {
    $("lookupMsg").innerHTML = '<span class="err">' + esc(error.message) + "</span>";
    $("lookupOut").innerHTML = "";
  }
}

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
    '<td class="num">' + item.jobCount + "</td>" +
    '<td class="num' + (item.failedCount ? " err" : "") + '">' + item.failedCount + "</td>" +
    "<td>" + (item.lastJobAt ? when(item.lastJobAt) : '<span class="sub">없음</span>') + "</td>" +
    "<td>" + (item.revokedAt ? pill("철회", "bad") : item.deletionRequestedAt ? pill("삭제 요청", "warn") : "") + "</td></tr>"
  ).join("");

  $("rosterOut").innerHTML =
    '<div class="scroll" style="margin-top:12px"><table><thead><tr><th></th><th>설치</th><th>마지막 접속</th>' +
    '<th>앱 · OS</th><th class="num">Job</th><th class="num">실패</th><th>마지막 분석</th><th></th>' +
    "</tr></thead><tbody>" + rows + "</tbody></table></div>" +
    (roster.nextCursor ? '<p style="margin:10px 0 0"><button class="ghost" id="rosterMore">설치 더 보기</button></p>' : "");

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

$("enter").addEventListener("click", () => {
  token = $("token").value.trim();
  sessionStorage.setItem(KEY, token);
  tick();
});

if (token) { sessionStorage.setItem(KEY, token); tick(); }
else { $("gate").classList.add("show"); }
setInterval(() => { if (token) tick(); }, 30000);
</script>
</body>
</html>`;
