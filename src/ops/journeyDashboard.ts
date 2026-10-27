import { JOURNEY_ADVANCED_HTML, JOURNEY_ADVANCED_SCRIPT } from "./journeyAdvancedDashboard.js";
/** Read-only product journey panel. Uses the dashboard's esc/ms/when/token helpers. */
export const JOURNEY_PANEL_HTML = String.raw`
    <div class="card" id="journeyPanel">
      <h2>사용 흐름 — 결과 확인부터 실제 파일 저장까지</h2>
      <div class="controls">
        <label class="sub">설치 구분
          <select id="journeyAudience">
            <option value="all">전체 열람 범위</option>
            <option value="unclassified">미분류 설치</option>
            <option value="internal">내부 테스트</option>
          </select>
        </label>
        <label class="sub">후속 행동 관찰 시간
          <select id="journeyIdle">
            <option value="30" selected>30분</option>
            <option value="60">1시간</option>
            <option value="1440">24시간</option>
          </select>
        </label>
        <button class="ghost" id="journeyGo">불러오기</button>
        <span id="journeyMsg" class="sub" role="status" aria-live="polite"></span>
      </div>
      <p class="sub">상단 기간과 개발자 제외 설정이 함께 적용됩니다. 미분류 설치에는 내부 테스트가 섞일 수 있으며, 설치 수는 사람 수와 다릅니다.</p>
      ${JOURNEY_ADVANCED_HTML}
      <div id="journeyOut" aria-busy="false"></div>
    </div>`;

export const JOURNEY_PANEL_SCRIPT = String.raw`
function journeyNum(value) {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("ko-KR") : "—";
}
function journeyTable(headers, rows) {
  if (!rows.length) return '<p class="empty">해당 조건의 기록이 없습니다.</p>';
  return '<div class="scroll"><table><thead><tr>' + headers.map((h) => '<th scope="col">' + esc(h) + '</th>').join('') +
    '</tr></thead><tbody>' + rows.map((cells) => '<tr>' + cells.map((c, i) => '<td' + (i ? ' class="num"' : '') + '>' + esc(c) + '</td>').join('') + '</tr>').join('') +
    '</tbody></table></div>';
}
${JOURNEY_ADVANCED_SCRIPT}
let journeyLatestData;
function journeyRender(data) {
  journeyLatestData = data;
  const t = data.totals, c = data.coverage;
  const names = Object.fromEntries(data.stages.map((s) => [s.key, s.label]));
  const cards = [
    ['분석 요청 작업', t.jobs, t.installations + '개 설치 · 선택 기간에 시작한 작업'],
    ['세부 기록이 있는 작업', t.observableJobs, '단계마다 기록 누락 여부를 따로 확인'],
    ['관찰할 수 없는 작업', t.unobservableJobs, '이탈로 계산하지 않음'],
    ['실제 저장 성공 기록', data.outcomes.saved, '앱이 디스크 쓰기 성공을 확인한 작업'],
  ];
  const outcomes = [
    ['실제 저장 성공', data.outcomes.saved], ['오류 기록', data.outcomes.failed],
    ['취소 기록', data.outcomes.cancelled], ['진행 중·관찰 시간 미경과', data.outcomes.waiting],
    ['후속 행동 미관측', data.outcomes.noNextEvent], ['관찰 불가', data.outcomes.unobservable],
  ];
  const transitions = data.transitions.map((s) => [
    (names[s.from] || s.from) + ' → ' + (names[s.to] || s.to),
    journeyNum(s.reached), journeyNum(s.advanced), journeyNum(s.waiting),
    journeyNum(s.noNextEvent), journeyNum(s.failed), journeyNum(s.cancelled), journeyNum(s.unobservable),
  ]);
  return '<div class="kpis">' + cards.map(([label, value, hint]) =>
    '<div class="kpi"><div class="label">' + esc(label) + '</div><div class="value">' + journeyNum(value) +
    '</div><div class="hint">' + esc(hint) + '</div></div>').join('') + '</div>' +
    '<p class="sub">후속 행동 미관측은 ' + esc(data.window.idleMinutes) + '분 동안 이어지는 기록이 없다는 뜻입니다. 이탈 확정이나 원인 판정이 아니며, 나중에 돌아오면 집계가 달라집니다.</p>' +
    '<h3>분석 요청 전 입력 행동</h3>' +
    '<p class="sub">선택 기간에 발생한 입력 이벤트입니다. 아직 작업이 만들어지기 전의 기록이므로 아래 작업 수와 직접 나누지 않습니다. 캡처·파일 입력의 취소와 실패를 함께 확인하세요.</p>' +
    journeyTable(['입력 행동', '이벤트', '설치'], (data.inputs || []).map((i) => [i.label, journeyNum(i.events), journeyNum(i.installations)])) +
    '<h3>단계별 도달 기록</h3>' +
    '<p class="sub">각 단계에서 확인한 작업을 독립적으로 셉니다. 작업 기록에서 다시 열거나 중간 기록이 빠지면 뒤 단계가 더 많을 수 있으므로 단순히 빼서 이탈률을 계산하지 않습니다.</p>' +
    journeyTable(['단계', '작업', '설치'], data.stages.map((s) => [s.label, journeyNum(s.jobs), journeyNum(s.installations)])) +
    '<h3>어느 구간에서 후속 행동이 없었나</h3>' +
    '<p class="sub">같은 작업의 시간 순서로 연결합니다. 체형·손 변경은 선택 사항이며 필수 단계에 넣지 않습니다. 준비 완료와 저장 전 화면의 순서는 작업마다 달라질 수 있습니다.</p>' +
    journeyTable(['구간', '시작 단계 도달', '다음 단계 도달', '관찰 중', '후속 미관측', '오류', '취소', '관찰 불가'], transitions) +
    '<h3>작업별 저장 도달·미진행 상태</h3>' +
    '<p class="sub">한 번이라도 실제 저장에 성공한 작업은 성공으로 유지합니다. 이후 재저장 오류는 아래 오류 기록에 따로 표시됩니다.</p>' +
    journeyTable(['상태', '작업'], outcomes.map(([label, n]) => [label, journeyNum(n)])) +
    '<h3>구간별 소요 시간</h3>' +
    '<p class="sub">시작과 끝이 연결된 기록만 포함합니다. 표본 수를 함께 보고, 준비·저장 재시도는 같은 시도끼리 비교합니다. 초 단위 경과 시간이며 대기·화면을 떠나 있던 시간이 포함될 수 있습니다. 시작·끝 누락이나 시간 순서 역전은 0초로 채우지 않습니다.</p>' +
    journeyTable(['구간', '측정 범위', '유효 표본', '미측정', '중앙값', '상위 90% 지점'], data.durations.map((d) => [d.label, ({job_cohort:'작업 코호트',consented_job_cohort:'현재 동의·작업 코호트',consented_event_time:'현재 동의·이벤트 시각'})[d.scope]||d.scope||'범위 미확인', journeyNum(d.samples), journeyNum(d.missingSamples), journeySeconds(d.medianMs), journeySeconds(d.p90Ms)])) +
    journeyAdvancedRender(data) +
    '<h3>발생한 오류·취소</h3>' +
    '<p class="sub">재시도 후 성공한 작업도 포함하는 발생 기록입니다. 위의 작업 상태와 합산하지 않습니다.</p>' +
    journeyTable(['종류', '작업', '이벤트'], (data.diagnostics || []).map((d) => [d.label, journeyNum(d.jobs), journeyNum(d.events)])) +
    '<h3>앱 버전·화면별 기록</h3>' +
    '<p class="sub">설치 등록 당시 버전이 아닌 이벤트가 발생한 앱 버전입니다. 같은 작업을 여러 화면에서 열면 중복 포함되므로 행끼리 합산하지 않습니다.</p>' +
    journeyTable(['앱 버전 · 화면', '작업', '설치', '실제 저장 작업'], (data.segments || []).map((s) => [s.appVersion + ' · ' + (s.surface === 'bar' ? '플로팅 바' : s.surface === 'app' ? '전체 화면' : '미확인'), journeyNum(s.jobs), journeyNum(s.installations), journeyNum(s.savedJobs)])) +
    '<details style="margin-top:16px"><summary>기록 범위와 해석</summary>' +
    journeyTable(['기록 상태', '작업'], [
      ['새 계측 기록 있음', journeyNum(c.version2Jobs)], ['기존 계측만 있음', journeyNum(c.legacyEventJobs)],
      ['클라이언트 기록 없음', journeyNum(c.noClientEventJobs)],
    ]) + journeyTable(['설치 구분', '작업', '설치'], data.audiences.map((a) => [a.key === 'internal' ? '내부 테스트' : a.key === 'unclassified' ? '미분류' : a.key, journeyNum(a.jobs), journeyNum(a.installations)])) +
    '<ul class="sub">' + data.notes.map((note) => '<li>' + esc(note) + '</li>').join('') + '</ul></details>';
}
let journeyRequestNumber = 0;
async function journeyGo() {
  const requestNumber = ++journeyRequestNumber;
  $('journeyMsg').textContent = '불러오는 중…';
  $('journeyOut').innerHTML = '';
  $('journeyOut').setAttribute('aria-busy', 'true');
  const params = new URLSearchParams({ days: $('period').value, audience: $('journeyAudience').value, idleMinutes: $('journeyIdle').value });
  try {
    const res = await fetch('/v1/admin/journey?' + params, { headers: { 'X-Beta-Admin-Token': token }, cache: 'no-store' });
    if (!res.ok) throw new Error(res.status === 404 ? '세부 흐름을 조회할 수 없습니다. 서버 지원 여부와 관리자 권한을 확인해 주세요.' : '조회 실패 (' + res.status + ')');
    const data = await res.json();
    if (requestNumber !== journeyRequestNumber) return;
    $('journeyOut').innerHTML = journeyRender(data);
    $('journeyMsg').textContent = when(data.window.from) + ' ~ ' + when(data.window.to) + ' · 조회 시점 기준';
  } catch (error) {
    if (requestNumber !== journeyRequestNumber) return;
    $('journeyOut').innerHTML = '';
    $('journeyMsg').textContent = error instanceof Error ? error.message : '조회하지 못했습니다.';
  } finally {
    if (requestNumber === journeyRequestNumber) $('journeyOut').setAttribute('aria-busy', 'false');
  }
}
$('journeyGo').addEventListener('click', journeyGo);
$('journeyAudience').addEventListener('change', journeyGo);
$('journeyIdle').addEventListener('change', journeyGo);
for (const id of ['journeyDetailSurface','journeyDetailFeature','journeyDetailCategory']) {
  $(id).addEventListener('change', () => {
    if (journeyLatestData) $('journeyOut').innerHTML = journeyRender(journeyLatestData);
  });
}
`;
