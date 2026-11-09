/** Authenticated dashboard only. Data is escaped; no new third-party script. */
export const BLOG_DASHBOARD_SCRIPT = String.raw`
function blogBlock(b) {
  if (!b || b.status !== 'ready') return '<section class="marketing-section"><h3>블로그 유입·읽기</h3><p class="sub">조회하지 못했습니다. 0건이 아닙니다. 다음 새로고침에서 재시도합니다.</p></section>';
  const n=v=>Number(v||0).toLocaleString('ko-KR');
  const ratio=(a,d)=>d>0?(100*Number(a||0)/d).toFixed(1)+'%':'—';
  const seconds=(ms,views)=>views>0?(Number(ms||0)/views/1000).toFixed(1)+'초':'—';
  const sourceNames={google:'Google',naver:'네이버',daum:'다음',bing:'Bing',yahoo:'Yahoo',instagram:'Instagram',facebook:'Facebook',x:'X',youtube:'YouTube',internal:'사이트 내부 이동',referral:'기타 외부 사이트',direct:'직접 / 출처 확인 불가',other:'기타 캠페인'};
  const table=(heads,rows)=>'<div class="scroll"><table><thead><tr>'+heads.map(h=>'<th>'+h+'</th>').join('')+'</tr></thead><tbody>'+rows.join('')+'</tbody></table></div>';
  const t=b.totals||{}, posts=b.posts||[];
  let html='<section id="blog-analytics" class="marketing-section"><h3>블로그 유입·읽기</h3><p class="sub">'+esc(b.measurementStarted)+' 배포 이후, 분석에 동의한 브라우저만 집계합니다. 블로그 목록은 제외하고 글 3편을 비교합니다. 날짜 필터는 위 마케팅 조회 기간을 따릅니다.</p><div class="kpis">';
  for(const [label,value] of [['글 조회',n(t.views)+'회'],['방문 브라우저',n(t.visitors)],['조회당 활성 체류',seconds(t.engagedMs,t.views)],['관련 글 영역 도달',ratio(t.endViews,t.views)],['다운로드 안내 클릭',n(t.downloadCtaViews)+'조회']])html+='<div class="kpi"><div class="label">'+label+'</div><div class="value">'+value+'</div></div>';
  html+='</div><p class="sub">조회는 글을 열어 page_view가 수집된 횟수이며 재방문·새로고침은 별도 조회입니다. 방문 브라우저는 중복을 제거하지만 사람 수는 아닙니다. 같은 브라우저가 여러 글을 읽으므로 글별 방문자를 더하면 전체 방문자와 다를 수 있습니다.</p>';
  if(!t.views)html+='<p class="empty">이 기간에 수집된 블로그 조회가 없습니다. 발행 전·미동의·차단된 방문을 방문 0명으로 해석하지 마세요.</p>';
  html+=table(['글','조회 / 브라우저','조회당 활성 체류','본문 75% 도달','관련 글 영역 도달','다운로드 안내 클릭','모바일 조회'],b.catalog.map(c=>{
    const p=posts.find(p=>p.path===c.path)||{};
    return '<tr><td>'+esc(c.title)+'</td><td>'+n(p.views)+' / '+n(p.visitors)+'</td><td>'+seconds(p.engagedMs,p.views)+'</td><td>'+ratio(p.depth75Views,p.views)+'</td><td>'+ratio(p.endViews,p.views)+'</td><td>'+n(p.downloadCtaViews)+'</td><td>'+n(p.mobileViews)+'</td></tr>';
  }));
  html+='<p class="sub">활성 체류: 보이는 탭에 초점이 있고 최근 60초 내 활동한 시간. 화면에서 가장 넓게 보이는 구간 하나에 배분합니다. 스크롤·구간 도달은 읽었다는 증거가 아니며, 목차로 건너뛴 경우도 포함합니다. 다운로드 안내 클릭은 홈의 다운로드 영역으로 이동한 조회 수로, 파일 다운로드·설치 완료가 아닙니다.</p>';
  for(const c of b.catalog) {
    const p=posts.find(p=>p.path===c.path)||{};
    html+='<details class="marketing-section" open><summary><strong>'+esc(c.title)+'</strong> · 유입과 읽기 구간</summary><h4>어디에서 들어왔나요?</h4>';
    html+=table(['유입 출처','조회','조회 비중'],(b.sources||[]).filter(s=>s.path===c.path).map(s=>'<tr><td>'+esc(sourceNames[s.source]||s.source)+'</td><td>'+n(s.views)+'</td><td>'+ratio(s.views,p.views)+'</td></tr>'));
    html+='<h4>어느 구간이 보였나요?</h4>';
    html+=table(['구간','노출 조회','전체 조회 대비 도달','활성 5초 이상 조회','노출 조회당 활성 체류'],Object.entries(c.sections).map(([id,label])=>{
      const s=(b.sections||[]).find(s=>s.path===c.path&&s.section===id)||{};
      return '<tr><td>'+esc(label)+'</td><td>'+n(s.exposedViews)+'</td><td>'+ratio(s.exposedViews,p.views)+'</td><td>'+n(s.engagedViews)+'</td><td>'+seconds(s.engagedMs,s.exposedViews)+'</td></tr>';
    }));
    html+='</details>';
  }
  html+='<p class="sub">유입은 각 글을 연 시점의 UTM source를 우선하고, 없으면 직전 참조 사이트를 분류합니다. 검색어·전체 URL·본문·입력 내용은 저장하지 않습니다. 사이트 내부 이동은 최초 외부 유입과 구분합니다. Google·네이버 표시는 검색 유입을 확정하지 않으며 광고·공유 링크가 섞일 수 있습니다.</p><h4>일별 블로그 조회 · 한국 시간</h4>';
  html+=table(['날짜 (KST)','조회','방문 브라우저'],(b.daily||[]).map(d=>'<tr><td>'+esc(d.day)+'</td><td>'+n(d.views)+'</td><td>'+n(d.visitors)+'</td></tr>'));
  return html+'<p class="sub">기록이 있는 날짜를 표시합니다. 활성 체류는 사이트 하단을 제외한 합계입니다. 네트워크 실패·탭 종료로 마지막 이벤트가 빠질 수 있습니다. 최대 90일 보관하며 철회·만료 기록은 제외됩니다.</p></section>';
}
`;
