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
