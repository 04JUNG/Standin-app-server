/** Feature adoption and diagnostic aggregates; no installation-level identifiers. */
export const JOURNEY_ADVANCED_HTML = String.raw`
      <details style="margin:12px 0"><summary>기능·원인 상세 표시 조건</summary>
        <div class="controls" style="margin-top:8px">
          <label class="sub">화면<select id="journeyDetailSurface"><option value="all">전체 화면·플로팅바 합계</option><option value="app">전체화면</option><option value="bar">플로팅바</option><option value="unknown">화면 미확인</option></select></label>
          <label class="sub">기능<select id="journeyDetailFeature"><option value="all">모든 기능</option><option value="hand_library">손 라이브러리</option><option value="semantic_search">자연어 검색</option><option value="body_selection">체형 더보기</option><option value="body_custom">내 체형 만들기</option><option value="history">작업 기록</option><option value="capture">화면 캡처</option><option value="file_input">파일 입력</option><option value="clipboard">클립보드</option><option value="analysis">분석</option><option value="pose_selection">포즈 선택</option><option value="export">파일 저장</option></select></label>
          <label class="sub">오류 분류<select id="journeyDetailCategory"><option value="all">전체 오류</option><option value="server">서버 오류</option><option value="network">네트워크</option><option value="permission">권한</option><option value="validation">입력·조건 확인</option><option value="client">앱 처리</option><option value="unknown">원인 미확인</option></select></label>
        </div><p class="sub">아래 기능별 행동·오류 상세에만 적용됩니다. 위 작업 전체의 단계별 분모와 첫 성공·재방문 집계는 바뀌지 않습니다.</p>
      </details>`;

export const JOURNEY_ADVANCED_SCRIPT = String.raw`
const journeyFeatureNames = {hand_library:'손 라이브러리',semantic_search:'자연어 검색',body_selection:'체형 더보기',body_custom:'내 체형 만들기',history:'작업 기록',capture:'화면 캡처',file_input:'파일 입력',clipboard:'클립보드',analysis:'분석',pose_selection:'포즈 선택',export:'파일 저장',unknown:'기능 미확인'};
const journeyActionNames = {exposure:'기능 노출',open:'열기',search_started:'검색 실행',search_completed:'검색 결과 표시',search_failed:'검색 실패',cancelled:'취소',selected:'직접 선택',applied:'적용',adjusted:'수치 조절',reset:'초기화',creation_started:'만들기 시작',saved:'체형 저장',reused:'재사용',failed:'실패',upload_started:'업로드 요청',upload_completed:'작업 접수',upload_failed:'업로드 실패',preview_started:'미리보기 로드 시작',preview_completed:'미리보기 표시',preview_failed:'미리보기 표시 실패'};
const journeyCategoryNames = {server:'서버 오류',network:'네트워크',permission:'권한',validation:'입력·조건 확인',client:'앱 처리',unknown:'원인 미확인'};
const journeyOutcomeNames = {saved:'실제 저장',failed:'오류',cancelled:'취소',waiting:'진행 중·관찰 중',noNextEvent:'후속 행동 미관측',unobservable:'관찰 불가'};
const journeyPhaseNames = {input:'입력',upload:'업로드',analysis:'분석',results:'결과 확인',selection:'포즈 선택',review:'저장 전 확인',preparing:'파일 준비',preparation:'파일 준비',confirmation:'저장 확인',writing:'로컬 저장 처리',candidate_image:'후보 이미지',review_image:'최종 이미지',review_model:'최종 3D',hand_selection:'손 선택',body_selection:'체형 선택',body_custom:'체형 만들기',history:'작업 기록',folder:'폴더 선택',thumbnail:'썸네일',unknown:'단계 미확인'};
const journeySourceNames = {capture:'화면 캡처',file:'파일 입력',semantic:'자연어 검색',clipboard:'클립보드',history:'작업 기록',image:'이미지 입력',unknown:'미확인'};
function journeySourceName(value) {return journeySourceNames[value]||value||'미확인';}
function journeySurfaceName(value) {return value==='app'?'전체화면':value==='bar'?'플로팅바':'화면 미확인';}
function journeyFeatureName(value) {return journeyFeatureNames[value]||value||'기능 미확인';}
function journeySeconds(value) {return typeof value==='number'&&Number.isFinite(value)&&value>=0 ? (value/1000).toLocaleString('ko-KR',{maximumFractionDigits:2})+'초' : '—';}
function journeyRatio(n,d) {return typeof n==='number'&&typeof d==='number'&&d>0 ? journeyNum(n)+' / '+journeyNum(d)+' ('+Math.round(n/d*1000)/10+'%)' : '—';}
function journeyDetailsFilter(row,withCategory) {
  const surface=$('journeyDetailSurface')?.value||'all', feature=$('journeyDetailFeature')?.value||'all',category=$('journeyDetailCategory')?.value||'all';
  return (surface==='all'||row.surface===surface)&&(feature==='all'||row.feature===feature)&&(!withCategory||category==='all'||row.category===category);
}
function journeyAdvancedRender(data) {
 const a=data.advanced;
 if(!a) return '<h3>기능별 사용과 재방문</h3><p class="empty">이 응답에는 확장 지표가 없습니다. 서버 지원 버전을 확인하세요.</p>';
 const summary=(a.featureSummary||[]).map(f=>{
   const app=(f.surfaces||[]).find(s=>s.surface==='app'),bar=(f.surfaces||[]).find(s=>s.surface==='bar');
   return [journeyFeatureName(f.feature),journeyNum(f.exposedInstallations),journeyNum(f.usedInstallations),journeyNum(app?.usedInstallations??0),journeyNum(bar?.usedInstallations??0),journeyRatio(f.usedAmongExposedInstallations,f.exposedInstallations),journeyRatio(f.savedAfterApplyInstallations,f.appliedInstallations),journeyNum(f.savedWithFeatureJobs),journeyNum(f.events)];
 });
 const actions=(a.featureSegments||[]).filter(r=>journeyDetailsFilter(r,false));
 const failures=(a.failures||[]).filter(r=>journeyDetailsFilter(r,true));
 const stageOutcomes=(a.stageOutcomes||[]).filter(r=>journeyDetailsFilter(r,false));
 const durationSegments=(a.durationSegments||[]).filter(r=>journeyDetailsFilter(r,false));
 const exits=(a.exits||[]).filter(r=>journeyDetailsFilter(r,false));
 const activation=a.activation||{}, ret=a.retention||[];
 const search=a.searchOutcomes||{}, results=a.results||{};
 const recovery=(a.recovery||[]).filter(r=>journeyDetailsFilter(r,false));
 return '<h3>기능별 사용 현황 — 실제로 열고 조작했나</h3><button class="ghost" data-replay-metric="features">관련 기능 세션 보기</button>'+
 '<p class="sub">선택 기간에 발생한 동의된 기능 이벤트 기준입니다. 전체화면·플로팅바의 같은 설치는 합계에서 한 번만 셉니다. 사용은 직접 열기·검색·선택·조절 등이며 자동 기본값과 단순 노출을 제외합니다. 노출 대비 이용은 기능이 제공·표시된 설치와 이용 설치의 교집합입니다. 표시 기록은 가용 컨트롤이 렌더되었다는 뜻이며, 사용자의 시선을 확인한 것은 아닙니다. 기록 0은 실제 미사용을 확정하지 않습니다. 기능 미사용은 필수 흐름의 이탈이 아닙니다.</p>'+
 journeyTable(['기능','노출 설치','고유 이용 설치','전체화면 이용','플로팅바 이용','노출 대비 이용 · 설치','적용 후 실제 저장 · 설치','이용 기록이 연결된 저장 작업','기능 기록'],summary)+
 '<p class="sub">적용 후 저장은 같은 작업에서 시간 순서가 연결된 관측입니다. 기능을 사용해서 저장률이 높아졌다는 인과관계나 그 설정 그대로 저장했다는 증거는 아닙니다. 작업 밖에서 만든 체형은 재사용 시 별도로 관측합니다.</p>'+
 '<h3>결과 화면에서 무엇을 받았나</h3>'+
 journeyTable(['결과 표시 작업','전체 후보 0개','일부 인물 후보 0개','후보 수 미기록','인물별 후보 수 미기록','썸네일 실패 작업','후보 변경 이벤트'],[[journeyNum(results.viewedJobs),journeyNum(results.zeroCandidateJobs),journeyNum(results.partialZeroCandidateJobs),journeyNum(results.candidateCountMissingJobs),journeyNum(results.personCandidateCountMissingJobs),journeyNum(results.thumbnailFailedJobs),journeyNum(results.candidateChangeEvents)]])+
 '<p class="sub">선택 기간에 시작한 작업의 결과 표시 기록 기준입니다. 후보 변경은 이미 고른 후보에서 다른 후보를 고른 행동이며 첫 선택과 구분합니다. 썸네일 실패는 후보가 없다는 뜻과 다릅니다.</p>'+
 '<h3>자연어 검색 결과</h3><p class="sub">같은 검색 시도에서 완료·0건 결과·실패·취소를 구분합니다. 재검색은 해당 검색 화면에서 두 번째 이후 실행한 횟수이며 같은 문장을 반복했다는 뜻은 아닙니다.</p>'+
 journeyTable(['검색 시작','검색 완료','결과 0건','실패','취소','재검색','고유 설치'],[[journeyNum(search.started),journeyNum(search.completed),journeyNum(search.zeroResult),journeyNum(search.failed),journeyNum(search.cancelled),journeyNum(search.repeated),journeyNum(search.installations)]])+
 journeyTable(['화면','검색 시작','검색 완료','결과 0건','실패','취소','재검색','결과 수 미기록'],(search.surfaces||[]).map(r=>[journeySurfaceName(r.surface),journeyNum(r.started),journeyNum(r.completed),journeyNum(r.zeroResult),journeyNum(r.failed),journeyNum(r.cancelled),journeyNum(r.repeated),journeyNum(r.resultCountMissing)]))+
 '<details style="margin-top:14px"><summary>화면·기능별 세부 행동</summary>'+journeyTable(['기능','행동','화면','OS','입력 방식','앱 버전','이벤트','고유 설치','연결 작업'],actions.map(r=>[journeyFeatureName(r.feature),journeyActionNames[r.action]||r.action,journeySurfaceName(r.surface),r.osName||'미확인',journeySourceName(r.source),r.appVersion||'미확인',journeyNum(r.events),journeyNum(r.installations),journeyNum(r.jobs)]))+'</details>'+
 '<h3>단계별 미진행 상태 — 어떤 기능·화면이었나</h3>'+
 '<p class="sub">위 단계별 도달 표와 같은 작업 생성 코호트입니다. 아래 기능 활동·재방문 표의 현재 동의 범위와 표본 수가 다를 수 있습니다. 후속 행동 미관측은 원인 미확인입니다. 서버 오류나 명시적 취소와 구분하고, 화면 전환 뒤의 성공도 작업 전체에서 확인합니다.</p>'+
 journeyTable(['단계','기능','화면','입력 방식','상태','작업'],stageOutcomes.map(r=>[r.label||journeyPhaseNames[r.stage]||r.stage,journeyFeatureName(r.feature),journeySurfaceName(r.surface),journeySourceName(r.source),journeyOutcomeNames[r.outcome]||r.outcome,journeyNum(r.jobs)]))+
 '<h3>오류 원인과 발생 환경</h3><button class="ghost" data-replay-metric="errors">관련 오류 세션 보기</button>'+
 '<p class="sub">보고된 오류 증거를 분류합니다. HTTP 상태와 오류 코드가 없으면 원인을 추정하지 않습니다. 이벤트 시간 기준으로 작업 생성 전 실패도 포함하며, 같은 작업에서 여러 오류가 발생할 수 있습니다. 서버 작업 상태와 앱 보고는 같은 실패를 중복 관측할 수 있으므로 두 출처의 건수를 합산하지 않습니다.</p>'+
 journeyTable(['기록 출처','분류','기능','단계','화면','OS','입력 방식','앱 버전','오류 코드','HTTP','기록','작업','설치'],failures.map(r=>[r.origin==='server_job'?'서버 작업 상태':'앱 보고',journeyCategoryNames[r.category]||r.category,journeyFeatureName(r.feature),journeyPhaseNames[r.phase]||r.phase||'미확인',journeySurfaceName(r.surface),r.osName||'미확인',journeySourceName(r.source),r.appVersion||'미확인',r.code||'미확인',r.httpStatus??'—',journeyNum(r.events),journeyNum(r.jobs),journeyNum(r.installations)]))+
 '<h3>오류 후 복구</h3><p class="sub">동일 시도에서 실패 뒤 성공이 연결된 경우와, 실패 후 같은 작업·기능에서 재시도하거나 성공한 경우를 구분합니다. 다른 시도의 성공이 동일 설정을 복구했다는 뜻은 아닙니다. 취소와 단순 미관측은 서버 실패로 세지 않습니다.</p>'+
 journeyTable(['단계·기능','화면','오류 시도','동일 시도 성공 / 오류 시도','실패 작업','재시도 작업','이후 성공 작업','연결 불가 오류'],recovery.map(r=>[(journeyPhaseNames[r.phase]||r.phase||'단계 미확인')+' · '+journeyFeatureName(r.feature),journeySurfaceName(r.surface),journeyNum(r.failedAttempts),journeyRatio(r.recoveredAttempts,r.failedAttempts),journeyNum(r.failedJobs),journeyNum(r.retriedJobs),journeyNum(r.laterSuccessJobs),journeyNum(r.unmatchedFailures)]))+
 '<details style="margin-top:14px"><summary>화면·기능별 구간 시간</summary><p class="sub">시작과 끝이 연결된 관측의 경과 시간입니다. 실제로 조작한 시간만 뜻하지 않으며, 앱을 떠나 있던 시간도 포함될 수 있습니다.</p>'+
 journeyTable(['구간','화면','기능','유효 표본','미측정','중앙값','상위 90% 지점'],durationSegments.map(r=>[r.label||r.key,journeySurfaceName(r.surface),journeyFeatureName(r.feature),journeyNum(r.samples),journeyNum(r.missingSamples),journeySeconds(r.medianMs),journeySeconds(r.p90Ms)]))+'</details>'+
 '<details style="margin-top:14px"><summary>명시적으로 뒤로가기·홈·취소한 기록</summary><p class="sub">화면을 떠난 행동 기록입니다. 이후 복귀하거나 저장할 수 있으므로 최종 이탈 건수로 합산하지 않습니다. 강제 종료는 이 기록으로 판단하지 않습니다.</p>'+
 journeyTable(['단계','기능','화면','이동·취소','이벤트','설치'],exits.map(r=>[journeyPhaseNames[r.phase]||r.phase||'미확인',journeyFeatureName(r.feature),journeySurfaceName(r.surface),({back:'뒤로가기',home:'홈으로',close:'닫기',cancel:'취소'})[r.reason]||r.reason,journeyNum(r.events),journeyNum(r.installations)]))+'</details>'+
 '<h3>첫 실제 저장과 다음 작업</h3><p class="sub">현재 유효한 동의와 새 계측이 확인된 신규 설치를 기준으로 합니다. 설치는 사람 수가 아닙니다. 전체 신규 설치의 전환율로 해석하지 않습니다. 관측 범위: '+esc(activation.historyFrom||a.scope?.historyFrom||'미확인')+' 이후.</p>'+
 journeyTable(['항목','고유 설치','비율'],[
 ['관찰 가능한 신규 설치',journeyNum(activation.eligibleInstallations),'기준 집단'],
 ['첫 실제 저장 도달',journeyNum(activation.firstSaveInstallations),journeyRatio(activation.firstSaveInstallations,activation.eligibleInstallations)],
 ['첫 저장 뒤 새 작업 시작',journeyNum(activation.nextJobInstallations),journeyRatio(activation.nextJobInstallations,activation.firstSaveInstallations)],
 ['첫 저장 뒤 다른 작업도 실제 저장',journeyNum(activation.repeatSaveInstallations),journeyRatio(activation.repeatSaveInstallations,activation.firstSaveInstallations)],
 ['같은 작업을 다시 실제 저장',journeyNum(activation.sameJobResaveInstallations),journeyRatio(activation.sameJobResaveInstallations,activation.firstSaveInstallations)]
 ])+
 '<h3>다시 돌아와 사용했나 — D1·D7</h3><p class="sub">최초 새 계측 관측일 기준 한국 시간 다음 날·7일 뒤를 각각 확인합니다. 해당 날짜가 완전히 지난 설치만 분모에 넣습니다. 앱 행동 관측·분석·실제 저장을 구분하며, 꺼진 동의나 기록 누락은 복원할 수 없습니다.</p>'+
 journeyTable(['기간','관찰 기간 충족 설치','앱 행동 재관측','재분석','실제 재저장'],ret.map(r=>['D'+r.day,journeyNum(r.eligibleInstallations),journeyRatio(r.returnedInstallations,r.eligibleInstallations),journeyRatio(r.analyzedInstallations,r.eligibleInstallations),journeyRatio(r.savedInstallations,r.eligibleInstallations)]))+
 '<ul class="sub">'+(a.notes||[]).map(n=>'<li>'+esc(n)+'</li>').join('')+'</ul>';
}
`;
