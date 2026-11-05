// Interpolated into the existing authenticated dashboard. No external scripts or credentials.
export const MARKETING_ANALYTICS_SCRIPT = String.raw`
function marketingNumber(value, digits) {
  return value === null || value === undefined || !Number.isFinite(Number(value)) ? '—' :
    Number(value).toLocaleString('ko-KR', {maximumFractionDigits:digits || 0});
}
function marketingRatio(numerator, denominator, percent) {
  return denominator > 0 ? marketingNumber(numerator / denominator * (percent ? 100 : 1), percent ? 2 : 0) + (percent ? '%' : '') : '—';
}
function marketingCards(items) {
  return '<div class="kpis">' + items.map(i => '<div class="kpi"><div class="label">' + esc(i[0]) +
    '</div><div class="value">' + esc(i[1]) + '</div><div class="hint">' + esc(i[2] || '') + '</div></div>').join('') + '</div>';
}
function marketingReportStatus(report) {
  return ({ready:'연결됨',stale:'이전 데이터 · 갱신 실패',unavailable:'조회 실패',unconfigured:'API 연결 대기'})[report && report.status] || '연결 대기';
}
function marketingSum(rows, field) { return rows.reduce((sum,r) => sum + (r[field] || 0), 0); }
function marketingScopeRows(rows, scope) {
  return rows.filter(r => scope === 'all' || (scope === 'beta' ? r.phase !== 'supporters' : r.phase === scope));
}
function marketingAdTable(rows, title) {
  if (!rows.length) return '';
  const names = {'meta-poster-a':'포스터 A','meta-hook-a':'영상 A','supporters-poster':'서포터즈 모집'};
  let html = '<h3>' + esc(title) + '</h3><div class="scroll"><table><thead><tr><th>소재</th><th>광고비 (원)</th><th>노출</th><th>링크 클릭</th><th>클릭률</th><th>방문</th><th>방문당 비용 (원)</th><th>다운로드 클릭</th><th>다운로드 클릭당 비용 (원)</th></tr></thead><tbody>';
  html += rows.map(r => '<tr><td>' + esc(names[r.creative] || r.creative) + '</td>' +
    [marketingNumber(r.spend),marketingNumber(r.impressions),marketingNumber(r.clicks),marketingRatio(r.clicks,r.impressions,true),
      marketingNumber(r.landingViews),marketingRatio(r.spend,r.landingViews),r.phase === 'supporters' ? '해당 없음' : marketingNumber(r.downloadClicks),
      r.phase === 'supporters' ? '해당 없음' : marketingRatio(r.spend,r.downloadClicks)].map(v=>'<td>'+esc(v)+'</td>').join('')+'</tr>').join('');
  html += '</tbody></table></div><details><summary>노출·클릭 비용과 소재 반응 자세히</summary><div class="scroll"><table><thead><tr><th>소재</th><th>도달</th><th>평균 노출 빈도</th><th>CPM (원)</th><th>링크 CPC (원)</th><th>클릭 대비 방문 비율</th><th>저장</th><th>공유</th><th>3초 영상 재생</th></tr></thead><tbody>';
  html += rows.map(r => '<tr><td>'+esc(names[r.creative] || r.creative)+'</td>'+[
    marketingNumber(r.reach),marketingNumber(r.frequency,2),marketingRatio(r.spend*1000,r.impressions),
    marketingRatio(r.spend,r.clicks),marketingRatio(r.landingViews,r.clicks,true),marketingNumber(r.saves),marketingNumber(r.shares),
    r.creative === 'meta-hook-a' ? marketingNumber(r.videoViews) : '해당 없음',
  ].map(v=>'<td>'+esc(v)+'</td>').join('')+'</tr>').join('');
  return html + '</tbody></table></div><p class="sub">도달은 해당 소재·기간 내 Meta 추정치입니다. 소재별·일별 도달을 더해 고유 사람 수로 표시하지 않습니다. CPM은 1,000회 노출당 비용, CPC는 링크 클릭당 비용입니다. 비율은 Meta 보고 수치의 단순 비율이며 동일 사용자의 이동을 검증한 퍼널이 아닙니다.</p></details>';
}
function marketingSupportersBlock(report) {
  const s = report && report.snapshot;
  let html = '<section class="marketing-section supporters"><h3>서포터즈 모집 · 총예산 5만 원</h3><p class="sub">예산·누적 실적은 조회 기간 필터와 무관하게 전체 집행 기간을 표시합니다. ' + esc(marketingReportStatus(report)) + '</p>';
  if (!s) html += '<p>예산 현황을 가져오지 못했습니다. 잔여 예산을 0원으로 간주하지 않습니다.</p>';
  else {
    const r = s.lifetime;
    const used = s.lifetimeBudget > 0 ? Math.min(100,100*r.spend/s.lifetimeBudget) : 0;
    const statuses = {ACTIVE:'활성',PAUSED:'일시 중지',CAMPAIGN_PAUSED:'캠페인 일시 중지',ADSET_PAUSED:'광고세트 일시 중지',PENDING_REVIEW:'검토 중',DISAPPROVED:'승인 거절',ARCHIVED:'보관됨',DELETED:'삭제됨'};
    const fetched = Date.parse(s.fetchedAt);
    const schedule = fetched < Date.parse(s.start) ? '시작 전' : fetched >= Date.parse(s.end) ? '일정 종료' : '집행 일정 중';
    html += '<p><span class="pill '+(report.status === 'ready' ? 'ok' : 'warn')+'">'+esc(schedule)+'</span> '+esc(statuses[s.effectiveStatus] || s.effectiveStatus)+'</p>';
    html += marketingCards([
      ['설정 총예산',marketingNumber(s.lifetimeBudget)+'원','Meta 광고세트 기준'],
      ['누적 지출',marketingNumber(r.spend)+'원','소진율 '+marketingRatio(r.spend,s.lifetimeBudget,true)],
      ['잔여 집행 예산',marketingNumber(s.remainingBudget)+'원','Meta 보고값 · 계정 현금 잔액 아님'],
      ['누적 지원 폼 방문',marketingNumber(r.landingViews)+'건','방문당 '+marketingRatio(r.spend,r.landingViews)+'원 · 제출 아님'],
    ]);
    html += '<div class="marketing-progress" role="progressbar" aria-label="서포터즈 예산 소진율" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+used.toFixed(1)+'"><span style="width:'+used.toFixed(1)+'%"></span></div>';
    html += '<p class="sub">'+esc(when(s.start))+' ~ '+esc(when(s.end))+' · 누적 실적 '+esc(s.since || '기록 없음')+' ~ '+esc(s.until || '기록 없음')+' · 조회 '+esc(when(s.fetchedAt))+'</p>';
    html += '<p class="sub">누적 링크 클릭 '+marketingNumber(r.clicks)+'건 · 링크 CPC '+marketingRatio(r.spend,r.clicks)+'원 · 광고세트 전체 누적이며 세금·결제 비용은 별도입니다.</p>';
  }
  return html + '<div class="marketing-note"><strong>실제 지원서 제출 수: 자동 연결 전</strong><p>Google Forms 응답에는 광고 외 경로의 지원도 포함됩니다. 방문 수를 지원 수로 표시하거나 지원당 비용을 계산하지 않습니다.</p><a target="_blank" rel="noopener noreferrer" href="https://docs.google.com/forms/d/1MPcJmgTwK_7n3Mow4VNTzPlR1j8SutwmQeK86LOCg7E/edit#responses">지원서 응답 확인 ↗</a></div></section>';
}
function marketingBars(points, series, title, unit) {
  if (!points.length) return '';
  const width = 960, height = 210, left = 64, top = 20, bottom = 35, plot = height-top-bottom;
  const maximum = Math.max(1,...points.map(p => series.reduce((sum,s) => sum + (p[s.key] || 0),0)));
  const slot = (width-left-12)/points.length, barWidth = Math.max(1,Math.min(48,slot*.72));
  let svg = '<svg class="marketing-chart" viewBox="0 0 '+width+' '+height+'" role="img" aria-label="'+esc(title)+'"><title>'+esc(title)+'</title>';
  [0,.5,1].forEach(f => { const y=top+plot*(1-f); svg += '<line x1="'+left+'" y1="'+y+'" x2="948" y2="'+y+'" stroke="var(--grid)"/><text x="'+(left-8)+'" y="'+(y+4)+'" text-anchor="end">'+marketingNumber(maximum*f)+'</text>'; });
  points.forEach((p,index) => {
    const x = left+slot*(index+.5), values=series.map(s=>s.label+' '+marketingNumber(p[s.key]||0)+unit);
    let accumulated = 0;
    series.forEach(s=>{const value=p[s.key]||0,h=value/maximum*plot,y=top+plot-accumulated-h;
      svg += '<rect x="'+(x-barWidth/2)+'" y="'+y+'" width="'+barWidth+'" height="'+h+'" fill="'+s.color+'"><title>'+esc(p.day+' · '+values.join(' / '))+'</title></rect>';accumulated+=h;});
    if (index===0 || index===points.length-1 || index%Math.max(1,Math.ceil(points.length/7))===0)
      svg += '<text x="'+x+'" y="201" text-anchor="middle">'+esc(p.day.slice(5))+'</text>';
  });
  return '<h4>'+esc(title)+'</h4><p class="sub">'+series.map(s=>'<span style="color:'+s.color+'">●</span> '+esc(s.label)).join('　')+'</p>'+svg+'</svg>';
}
function marketingDailyBlock(report, scope) {
  if (!report || !report.snapshot) return '<h3>광고 일별 추이</h3><p class="sub">일별 보고서를 가져오지 못했습니다. 합계 보고서와 별도로 다시 조회합니다.</p>';
  const snap = report.snapshot, rows = marketingScopeRows(snap.rows,scope), days = [];
  for (let date=snap.since;date<=snap.until;date=new Date(Date.parse(date+'T00:00:00Z')+86400000).toISOString().slice(0,10)) {
    const matching=rows.filter(r=>r.day===date);
    days.push({day:date,landing:marketingSum(matching.filter(r=>r.phase==='landing'),'spend'),download:marketingSum(matching.filter(r=>r.phase==='download'),'spend'),supporters:marketingSum(matching.filter(r=>r.phase==='supporters'),'spend'),
      spend:marketingSum(matching,'spend'),impressions:marketingSum(matching,'impressions'),clicks:marketingSum(matching,'clicks'),landingViews:marketingSum(matching,'landingViews'),downloadClicks:marketingSum(matching.filter(r=>r.phase!=='supporters'),'downloadClicks')});
  }
  const series=[{key:'landing',label:'랜딩 최적화',color:'var(--c-users)'},{key:'download',label:'다운로드 최적화',color:'var(--c-jobs)'},{key:'supporters',label:'서포터즈',color:'var(--c-down)'}].filter(s=>scope==='all'||(scope==='beta'?s.key!=='supporters':s.key===scope));
  return '<section class="marketing-section"><h3>광고 일별 추이</h3><p class="sub">한국시간 '+esc(snap.since)+' ~ '+esc(snap.until)+' · 오늘은 진행 중 · '+esc(marketingReportStatus(report))+' · 조회 '+esc(when(snap.fetchedAt))+'</p>'+marketingBars(days,series,'일별 광고비','원')+
    '<details><summary>일별 지출·유입·다운로드 수치 보기</summary><div class="scroll"><table><thead><tr><th>날짜</th><th>광고비 (원)</th><th>노출</th><th>링크 클릭</th><th>방문</th><th>베타 다운로드 클릭</th><th>CTR</th><th>링크 CPC (원)</th></tr></thead><tbody>'+days.map(d=>'<tr>'+[d.day,marketingNumber(d.spend),marketingNumber(d.impressions),marketingNumber(d.clicks),marketingNumber(d.landingViews),marketingNumber(d.downloadClicks),marketingRatio(d.clicks,d.impressions,true),marketingRatio(d.spend,d.clicks)].map(v=>'<td>'+esc(v)+'</td>').join('')+'</tr>').join('')+'</tbody></table></div></details></section>';
}
function marketingMetaBlock(meta,scope) {
  let html = '<h3>광고 전체 요약 · '+esc(marketingReportStatus(meta))+'</h3>';
  if (meta.reason === 'access_blocked') html += '<p class="sub">Meta가 API 접근을 차단했습니다. Meta 개발자 계정의 확인 안내를 처리해야 광고 조회가 재개됩니다. 성과가 0이라는 뜻은 아닙니다.</p>';
  if (meta.snapshot) {
    const snap=meta.snapshot, rows=marketingScopeRows(snap.rows,scope);
    const spend=marketingSum(rows,'spend'),clicks=marketingSum(rows,'clicks'),impressions=marketingSum(rows,'impressions');
    html += '<p class="sub">한국시간 '+esc(snap.since)+' ~ '+esc(snap.until)+' (오늘 포함) · 조회 '+esc(when(snap.fetchedAt))+' · 선택한 등록 광고 '+rows.length+'개 기준 · 계정 전체 청구액과 다를 수 있습니다.</p>';
    html += marketingCards([['광고비',marketingNumber(spend)+'원','선택 기간 합계'],['노출',marketingNumber(impressions)+'회','고유 사람 수 아님'],['링크 클릭',marketingNumber(clicks)+'건','CTR '+marketingRatio(clicks,impressions,true)],['링크 CPC',marketingRatio(spend,clicks)+'원','광고비 ÷ 링크 클릭']]);
    if (scope==='all'||scope==='supporters') html += marketingSupportersBlock(meta.supporters);
    html += marketingAdTable(rows.filter(r=>r.phase==='supporters'),'서포터즈 모집 · 선택 기간 실적');
    html += marketingAdTable(rows.filter(r=>r.phase==='download'),'다운로드 최적화 / 포스터 A · 영상 A');
    html += marketingAdTable(rows.filter(r=>r.phase==='landing'),'랜딩 최적화 / 포스터 A · 영상 A');
    if (scope !== 'supporters') html += marketingComparison(rows);
    html += '<p class="sub">다운로드 클릭은 Standin | DownloadClick 맞춤 전환에 Meta가 귀속한 수입니다. 2026-10-31 생성 전 기록은 소급 집계하지 않으며 다운로드 완료·설치·사용 수와 다릅니다. 최적화 목표가 다른 단계는 분리했습니다. 수치 비교만으로 통계적 A/B 승자를 판정하지 않습니다.</p>';
  } else {
    html += '<p class="sub">광고 수치를 가져오지 못했습니다. 미연결·조회 실패는 성과 0을 의미하지 않으며 앱 집계는 별도로 갱신됩니다.</p>';
    if (scope==='all'||scope==='supporters') html += marketingSupportersBlock(meta.supporters);
  }
  return html + marketingDailyBlock(meta.daily,scope);
}
function marketingComparison(rows) {
  const summaries = ['download','landing'].map(phase=>{
    const pair=rows.filter(r=>r.phase===phase),poster=pair.find(r=>r.creative==='meta-poster-a'),video=pair.find(r=>r.creative==='meta-hook-a');
    if (!poster || !video) return '';
    const metric=phase==='download'?'downloadClicks':'landingViews',name=phase==='download'?'다운로드 클릭':'랜딩 방문';
    if (!poster[metric] || !video[metric]) return '<li>'+esc(name)+' 비교: 한쪽 또는 양쪽에 기록된 성과가 없어 비용 우열을 계산하지 않습니다.</li>';
    const p=poster.spend/poster[metric],v=video.spend/video[metric];
    if(p===v)return '<li>'+esc(name)+'당 비용이 같습니다. 통계적 동률을 의미하지 않습니다.</li>';
    return '<li>'+esc(name)+'당 비용: 포스터 A '+marketingNumber(p)+'원, 영상 A '+marketingNumber(v)+'원. '+(p<v?'포스터 A':'영상 A')+'가 '+marketingRatio(Math.abs(p-v),Math.max(p,v),true)+' 낮게 관측됐습니다.</li>';
  }).filter(Boolean);
  return summaries.length ? '<div class="marketing-note"><strong>A/B 관측 비교</strong><ul>'+summaries.join('')+'</ul><p class="sub">선택 기간·같은 최적화 목표 안의 단순 비용 비교입니다. 통계적 승자나 실제 설치·사용의 우열을 뜻하지 않습니다.</p></div>' : '';
}
function marketingUsageDetailsBlock(details,usage) {
  if (!details) return '<p class="sub">앱 일별 추이와 반복 이용 집계를 가져오지 못했습니다. 성과 0을 의미하지 않습니다.</p>';
  return '<section class="marketing-section"><h3>앱 활성화와 반복 이용</h3>'+marketingCards([
    ['신규 분석 시작률',usage ? marketingRatio(usage.newStarted,usage.newInstallations,true) : '—','신규 등록 중 분석을 시작한 설치'],
    ['신규 분석 성공률',usage ? marketingRatio(usage.newCompleted,usage.newInstallations,true) : '—','신규 등록 중 분석을 성공한 설치'],
    ['다른 날 다시 분석',marketingNumber(details.repeatAnalyzers)+'곳','선택 기간 중 2개 이상 한국 날짜에 분석'],
    ['분석 실패 / 대기·처리 중',marketingNumber(details.jobsFailed)+' / '+marketingNumber(details.jobsPending),'선택 기간에 시작한 작업의 현재 상태'],
  ])+marketingBars(details.trend,[{key:'newInstallations',label:'신규 앱 등록',color:'var(--c-users)'}],'날짜별 신규 앱 등록','곳')+
    '<p class="sub">최근 N×24시간을 한국 날짜로 나눴습니다. 첫날·오늘은 일부 시간만 포함합니다. 재방문 설치는 사람 수나 D1·D7 유지율과 다릅니다.</p><details><summary>날짜별 앱 등록·분석 수치 보기</summary><div class="scroll"><table><thead><tr><th>한국 날짜</th><th>신규 앱 등록</th><th>분석 시작</th><th>분석 성공</th><th>분석 실패</th></tr></thead><tbody>'+details.trend.map(d=>'<tr>'+[d.day,d.newInstallations,d.jobsStarted,d.jobsCompleted,d.jobsFailed].map(v=>'<td>'+esc(v)+'</td>').join('')+'</tr>').join('')+'</tbody></table></div></details></section>';
}
function marketingSourcesBlock(data) {
  return '<section class="marketing-section"><h3>데이터 연결과 집계 기준</h3><div class="scroll"><table><thead><tr><th>데이터</th><th>상태·갱신 기준</th><th>바로 확인</th></tr></thead><tbody>'+
    '<tr><td>Meta 광고·서포터즈</td><td>'+esc(marketingReportStatus(data.meta))+' · 최대 1분 캐시 · 원본 보고 지연 가능</td><td><a target="_blank" rel="noopener noreferrer" href="https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=1090943087171654">광고 관리자 ↗</a></td></tr>'+
    '<tr><td>앱 등록·분석 기록</td><td>서버 조회 시점 합계 · 화면을 보는 동안 30초 갱신</td><td>전체 또는 베타 보기의 앱 이용 표</td></tr>'+
    '<tr><td>소재별 첫 실행·첫 분석 성공</td><td>한국시간 전날까지 · 11월 5일 수신분부터 0건 표시</td><td>전체 또는 베타 보기의 소재별 건수 표</td></tr>'+
    '<tr><td>웹사이트 GA4</td><td>이 대시보드 자동 연결 전 · 유입 경로·기기·참여도는 GA4에서 확인</td><td><a target="_blank" rel="noopener noreferrer" href="https://analytics.google.com/analytics/web/#/p560926013/reports/intelligenthome">GA4 보고서 ↗</a></td></tr>'+
    '<tr><td>실제 서포터즈 지원서</td><td>Google Forms 자동 연결 전 · 광고 유입과 구분 불가</td><td><a target="_blank" rel="noopener noreferrer" href="https://docs.google.com/forms/d/1MPcJmgTwK_7n3Mow4VNTzPlR1j8SutwmQeK86LOCg7E/edit#responses">지원서 응답 ↗</a></td></tr></tbody></table></div></section>';
}
`;
