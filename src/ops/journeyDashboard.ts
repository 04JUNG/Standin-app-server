/** Embedded in the authenticated ops dashboard; every server value is escaped. */
export const JOURNEY_DASHBOARD_SCRIPT = String.raw`
function journeyBlock(j) {
  if (!j || j.status !== 'ready') return '<h3>방문·앱 이용 경로</h3><p class="sub">조회하지 못했습니다. 0건이 아닙니다. 다음 새로고침에서 재시도합니다.</p>';
  const sectionNames={page:'페이지',hero:'첫 화면',input:'입력 소개',process:'분석 과정',result:'결과 소개',features:'기능',guides:'사용 가이드',beta:'다운로드',faq:'자주 묻는 질문',footer:'하단'};
  const eventNames={page_view:'페이지 열기',section_view:'구간 진입',cta_click:'버튼 클릭',download_click:'다운로드 클릭',pc_link_copy:'PC 링크 복사',app_open_click:'앱 열기 클릭',page_hidden:'탭 숨김',page_exit:'페이지 떠남',app_started:'앱 시작',input_confirmed:'입력 확정',results_viewed:'결과 확인',candidate_selected:'후보 선택',selection_confirmed:'선택 확정',analysis_started:'분석 요청',analysis_success:'분석 성공',analysis_failed:'분석 실패',export_completed:'저장 완료',export_failed:'저장 실패',capture_failed:'캡처 실패'};
  const creatives={'meta-poster-a':'포스터 A','meta-hook-a':'영상 A',other:'기타'};
  const num=v=>Number(v||0).toLocaleString('ko-KR');
  const seconds=v=>(Number(v||0)/1000).toFixed(1)+'초';
  const name=v=>sectionNames[v]||v;
  const table=(heads,rows)=>'<div class="scroll"><table><thead><tr>'+heads.map(h=>'<th>'+h+'</th>').join('')+'</tr></thead><tbody>'+rows.join('')+'</tbody></table></div>';
  const timeline=events=>!events?.length?'<span class="sub">선택 동의한 단계 이벤트 없음</span>':'<details><summary>최근 '+esc(events.length)+'개 단계</summary><ol>'+events.map(e=>'<li>'+esc(when(e.at))+' · '+esc(eventNames[e.name]||e.name)+(e.section?' · '+esc(name(e.section)):'')+(e.target&&e.target!=='none'?' · '+esc(e.target):'')+'</li>').join('')+'</ol></details>';
  const t=j.totals||{};
  let html='<section class="marketing-section"><h3>방문·다운로드·앱 연결</h3><p class="sub">쿠키 허용 후 수집한 브라우저 기준입니다. 사람 수가 아니며 다른 브라우저·기기는 별도 방문자로 집계합니다. 최근 '+esc(j.rowLimit)+'개 경로를 표시합니다.</p><div class="kpis">';
  for(const [label,value] of [['동의한 방문자',t.visitors],['다운로드 클릭 방문자',t.downloadVisitors],['다운로드 클릭 건수',t.downloadClicks],['앱을 연결한 방문자',t.linkedVisitors],['연결 후 분석 성공',t.analyzedVisitors],['연결 후 저장 완료',t.exportedVisitors]])html+='<div class="kpi"><div class="label">'+label+'</div><div class="value">'+num(value)+'</div></div>';
  html+='</div><p class="sub">다운로드 완료·설치 완료는 브라우저에서 확인할 수 없습니다. 앱 연결은 설치 후 앱 열기 링크와 앱의 선택 동의가 모두 필요합니다. 기존 설치도 연결할 수 있어 위 숫자는 순차 전환 퍼널이 아닙니다. 연결 전 사용은 소급 연결하지 않습니다.</p><h3>어느 구간을 보고 떠났나요?</h3>';
  html+=table(['구간','방문자','활성 체류 / 페이지 평균','마지막 관측 구간'],j.sections.map(s=>'<tr><td>'+esc(name(s.section))+'</td><td>'+num(s.visitors)+'</td><td>'+seconds(Number(s.engagedMs)/Math.max(1,s.pages))+'</td><td>'+num(s.lastObserved)+'</td></tr>'));
  if(!j.sections.length)html+='<p class="sub">수집된 구간 이벤트가 없습니다. 동의 전 방문은 포함하지 않습니다.</p>';
  html+='<p class="sub">활성 체류: 탭이 보이고 초점이 있으며 최근 60초 내 활동한 시간. 가장 많이 보이는 구간 하나만 계산합니다. 마지막 관측: 30분 이상 새 이벤트가 없는 방문자의 마지막 구간이며, 실제 종료 위치·이탈 이유를 확정하지 않습니다. 기기 종료·통신 실패로 마지막 이벤트가 빠질 수 있습니다.</p><h3>방문자별 경로</h3>';
  html+=table(['방문자 / 마지막 관측','유입 / 기기','마지막 구간 / 활성 체류','다운로드 / 앱 진행','경로'],j.visitors.map(v=>{
    const stage=!v.linkedApps?'앱 미연결 · 사용 여부 확인 불가':v.exported?'저장 완료':v.analyzed?'분석 성공 · 이후 저장 미관측':'앱 연결 · 이후 분석 성공 미관측';
    return '<tr><td>'+esc(v.id)+'<br>'+esc(when(v.lastAt))+'</td><td>'+esc(creatives[v.creative]||v.creative)+'<br>'+esc(v.source)+' / '+esc(v.device)+'</td><td>'+esc(name(v.section))+'<br>'+seconds(v.engagedMs)+' · 스크롤 '+num(v.depth)+'%</td><td>클릭 '+num(v.downloads)+'건<br>'+stage+'</td><td>'+timeline(v.timeline)+'</td></tr>';
  }));
  html+='<h3>연결에 동의한 새 설치별 이용 단계</h3><p class="sub">조회 기간에 처음 등록하고 웹 연결에 동의한 설치의 동의 이후 기록입니다. 서버 분석 요청·성공·실패와 앱의 세부 단계·저장 이벤트를 구분합니다. 미동의 설치의 개별 경로는 표시하지 않으며 전체 사용량은 위 운영 합계에서 확인합니다. 원본 파일·이메일·입력 문장·작업 식별자는 표시하지 않습니다. 재설치하면 별도 설치일 수 있습니다.</p>';
  html+=table(['설치 / 버전','첫 등록 / 최근 접속','분석 요청 · 성공 · 실패','마지막 관측 / 웹 연결','세부 단계'],j.installations.map(i=>{
    const last=i.timeline?.[i.timeline.length-1];
    return '<tr><td>'+esc(i.id)+'<br>'+esc(i.os)+' '+esc(i.version)+'</td><td>'+esc(when(i.firstAt))+'<br>'+esc(when(i.lastAt))+'</td><td>'+num(i.started)+' · '+num(i.completed)+' · '+num(i.failed)+'</td><td>'+(last?esc(eventNames[last.name]||last.name):i.completed?'분석 성공':i.started?'분석 요청':'서버 등록')+'<br>'+(i.visitorId?'방문자 '+esc(i.visitorId):'웹 방문 미연결')+'</td><td>'+timeline(i.timeline)+'</td></tr>';
  }));
  return html+'<p class="sub">새 웹·앱 연결 기록은 최대 90일 보관하며 철회·삭제·만료 기록은 제외합니다. v0.2.9 이상 앱과 새 웹 동의 이후부터 수집됩니다. 이전 기간·미동의·차단·네트워크 실패를 사용 0건으로 해석하지 마세요.</p></section>';
}
`;
