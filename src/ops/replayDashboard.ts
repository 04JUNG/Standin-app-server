export const REPLAY_PANEL_HTML = String.raw`
<div class="card" id="replayPanel"><h2>관련 세션 리플레이</h2>
<p class="sub">개발·스테이징 가정 모드 기록. 미수집·누락·만료는 이탈이나 작업 실패로 해석하지 않습니다. 3D는 업로드된 프레임만 표시합니다. 세션 목록의 설치 구분은 아래 필터를 따릅니다.</p>
<div class="controls"><input id="replayInstallation" placeholder="설치 ID"><input id="replayJob" placeholder="작업 ID"><input id="replaySession" placeholder="앱 세션 ID">
<select id="replayEnvironment"><option value="">환경 전체</option><option>development</option><option>staging</option></select>
<select id="replayAudience"><option value="all">설치 전체</option><option value="internal">내부 테스트</option><option value="unclassified">미분류</option></select>
<input id="replayOs" placeholder="OS"><input id="replayVersion" placeholder="앱 버전"><select id="replaySurface"><option value="">화면 전체</option><option>app</option><option>bar</option><option>capture</option></select>
<input id="replayScreen" placeholder="화면 이름"><input id="replayFeature" placeholder="기능 이름"><select id="replayFailed"><option value="">오류 전체</option><option value="true">오류 있음</option><option value="false">오류 보고 없음</option></select>
<select id="replaySaved"><option value="">저장 전체</option><option>saved</option><option>failed</option><option>cancelled</option><option>unknown</option></select><button id="replayGo">세션 조회</button></div>
<p id="replayStatus" role="status"></p><div id="replayList"></div><button id="replayMore" hidden>다음 세션</button>
<dialog id="replayDialog" style="width:96vw;max-width:1250px;max-height:96vh;overflow:auto"><button id="replayClose">닫기</button><h3 id="replayTitle"></h3><p id="replayGaps"></p><select id="replayWindow"></select><div id="replayTimeline" style="display:flex;gap:6px;flex-wrap:wrap"></div>
<iframe id="replayFrame" title="격리된 작업 리플레이" sandbox="allow-same-origin" referrerpolicy="no-referrer" style="width:100%;height:700px;border:0"></iframe>
<div id="replayCompare" style="display:flex;gap:16px;flex-wrap:wrap"></div></dialog></div>`;
export const REPLAY_PANEL_SCRIPT = String.raw`
let replayManifest,replayPlayer,replayAssetUrls=[],replayBundle,replaySelected,replaySeek=0,replayBefore;
const replayErrorNames={REPLAY_EXPIRED:'보관 기간 종료',REPLAY_NOT_FOUND:'삭제되었거나 권한이 없는 기록',REPLAY_AUTHORIZATION_DENIED:'이 환경에서 열람 권한 없음',REPLAY_DISABLED:'기록 기능 꺼짐',REPLAY_STORAGE_UNAVAILABLE:'자산 누락 또는 저장소 연결 실패'};
async function replayFetch(path,binary=false){
 const res=await fetch(path,{headers:{'X-Beta-Admin-Token':token},cache:'no-store'});
 if(!res.ok){const body=await res.json().catch(()=>({}));throw Error(replayErrorNames[body.error?.code]||body.error?.code||('HTTP '+res.status));}
 return binary?res.blob():res.json();
}
async function replayListGo(append=false){
 $('replayStatus').textContent='세션 불러오는 중…';
 try{const q=new URLSearchParams();const map={installationId:'replayInstallation',jobId:'replayJob',appSessionId:'replaySession',environment:'replayEnvironment',audience:'replayAudience',os:'replayOs',appVersion:'replayVersion',surface:'replaySurface',screen:'replayScreen',feature:'replayFeature',failed:'replayFailed',saveState:'replaySaved'};
 for(const [key,id]of Object.entries(map))if($(id).value.trim())q.set(key,$(id).value.trim());
 q.set('from',new Date(Date.now()-Number($('period').value||7)*86400000).toISOString());q.set('to',new Date().toISOString());
 if(append&&replayBefore)q.set('before',replayBefore);
 const data=await replayFetch('/v1/admin/replays?'+q);replayBefore=data.nextBefore;$('replayMore').hidden=!replayBefore;
 if(!append)$('replayList').replaceChildren();
 for(const item of data.items){const button=document.createElement('button');button.className='ghost';button.style.margin='5px';button.textContent=new Date(item.startedAt).toLocaleString()+' · '+item.os+' · '+item.appVersion+' · '+item.state+' · '+item.authorizationMode;button.onclick=()=>replayOpen(item.replayId);$('replayList').appendChild(button);}
 $('replayStatus').textContent=data.items.length?data.items.length+'개 세션 · 기록 상태를 확인하세요':'해당 조건의 수집 기록 없음 · 미수집을 이탈로 해석하지 않습니다.';
 }catch(e){$('replayStatus').textContent=e.message;}
}
function replayCleanup(){replayPlayer?.destroy();replayPlayer=null;$('replayFrame').srcdoc='';for(const url of replayAssetUrls)URL.revokeObjectURL(url);replayAssetUrls=[];}
async function replayOpen(id,seek=0){
 replayCleanup();replaySeek=seek;$('replayDialog').showModal();$('replayTitle').textContent='리플레이 불러오는 중';
 try{replayManifest=await replayFetch('/v1/admin/replays/'+id+'/manifest');const m=replayManifest;
 $('replayTitle').textContent=m.session.appSessionId+' · '+m.session.authorizationMode+' · '+m.session.state;
 $('replayGaps').textContent=(m.gaps.length?m.gaps.map(g=>g.windowInstanceId+': '+g.reason+(g.sequence!==undefined?' #'+g.sequence:'')).join(' / '):'청크 순서 누락 없음')+' · '+(m.assets.some(a=>['canvas_frame','final'].includes(a.kind))?'3D 프레임 기록 있음':'3D 기록 미수집 · DOM으로 WebGL을 재현하지 않음');
 const select=$('replayWindow');select.replaceChildren();for(const st of m.streams){const opt=document.createElement('option');opt.value=st.windowInstanceId;opt.textContent=st.surface+' · '+st.windowInstanceId;select.appendChild(opt);}select.onchange=()=>replayLoadWindow();
 $('replayTimeline').replaceChildren();for(const event of m.timeline){const b=document.createElement('button');b.className='ghost';b.textContent=(event.offsetMs/1000).toFixed(1)+'s '+event.name;b.onclick=()=>{replaySeek=Math.max(0,event.offsetMs-(/error|fail/i.test(event.name)?5000:0));const target=m.streams.find(s=>s.surface===event.surface);if(target&&target.windowInstanceId!==$('replayWindow').value){$('replayWindow').value=target.windowInstanceId;void replayLoadWindow();}else replayPlayer?.seek(replaySeek);};$('replayTimeline').appendChild(b);}
 $('replayCompare').replaceChildren();const assetMap={};let missing=0;
 for(const asset of m.assets){try{const url=URL.createObjectURL(await replayFetch(asset.adminUrl,true));replayAssetUrls.push(url);assetMap[asset.contentHash]=url;if(['rough','final','csp_result'].includes(asset.kind)){const figure=document.createElement('figure');const img=document.createElement('img');img.src=url;img.style.maxWidth='300px';img.alt=asset.kind;const caption=document.createElement('figcaption');caption.textContent=asset.kind+' · '+asset.snapshotVersion+(asset.assessment?' · '+asset.assessment:'')+(asset.kind==='csp_result'?' · BFF 산출물 해시 대조됨 · 선택 스냅샷은 앱 보고 · 가져오기 성공 판정과 별개':'');figure.dataset.assetHash=asset.contentHash;figure.dataset.artifactHash=asset.artifactHash||'';figure.dataset.baseCaption=caption.textContent;figure.append(img,caption);$('replayCompare').appendChild(figure);}}catch{missing++;}}
 if(missing)$('replayGaps').textContent+=' · '+missing+'개 자산 누락/만료';replaySelected=assetMap;
 if(!replayBundle){const blob=await replayFetch('/v1/admin/replay-player.js',true);const moduleUrl=URL.createObjectURL(new Blob([await blob.text()],{type:'application/javascript'}));try{replayBundle=await import(moduleUrl);}finally{URL.revokeObjectURL(moduleUrl);}}
 await replayLoadWindow();
 }catch(e){$('replayTitle').textContent=e.message;}
}
async function replayLoadWindow(){
 try{const m=replayManifest,st=m.streams.find(s=>s.windowInstanceId===$('replayWindow').value);if(!st){$('replayGaps').textContent+=' · 수집된 창 없음';return;}
 replayPlayer?.destroy();$('replayTimeline').querySelectorAll('[data-replay-custom]').forEach(n=>n.remove());let events=[];for(const chunk of st.chunks){try{events.push(...(await replayFetch(chunk.url)).events);}catch(e){$('replayGaps').textContent+=' · 청크 #'+chunk.sequence+' '+e.message;}}
 for(const event of events.filter(e=>e.type===5&&e.data?.tag&&!['surface','visibility','capture_overlay','canvas_frame'].includes(e.data.tag))){const b=document.createElement('button');b.className='ghost';b.dataset.replayCustom='true';const offset=event.timestamp-m.session.startedAt;b.textContent=(offset/1000).toFixed(1)+'s '+event.data.tag+(event.data.tag==='csp_result_assessment'?' · '+({good:'잘 나왔어요',bad:'이상해요',cannot_import:'불러오지 못했어요'})[event.data.payload?.assessment]:'');b.onclick=()=>replayPlayer?.seek(Math.max(0,offset-(/error|fail/i.test(event.data.tag)?5000:0)));$('replayTimeline').appendChild(b);}
 for(const event of events.filter(e=>e.type===5&&e.data?.tag==='csp_result_assessment').sort((a,b)=>a.timestamp-b.timestamp)){const p=event.data.payload||{},assessment=({good:'잘 나왔어요',bad:'이상해요',cannot_import:'불러오지 못했어요'})[p.assessment];if(assessment)for(const figure of $('replayCompare').querySelectorAll('figure'))if(figure.dataset.assetHash===p.assetHash&&figure.dataset.artifactHash===p.artifactHash)figure.querySelector('figcaption').textContent=figure.dataset.baseCaption+' · 사용자 평가: '+assessment;}
 events.sort((a,b)=>a.timestamp-b.timestamp);if(events.length>100000)throw Error('단일 창 재생 상한 초과 · 구간 분리 필요');
 const csp="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src blob: data:; font-src blob:; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src about:; form-action 'none'; base-uri 'none'";
 const frame=$('replayFrame');frame.onload=()=>{try{replayPlayer=replayBundle.createReplayPlayer(frame,{events,assets:replaySelected,surface:st.surface,startedAt:m.session.startedAt,seekMs:replaySeek,onTime:offset=>replaySeek=offset});}catch(e){$('replayGaps').textContent='재생 초기화 실패: '+e.message;}};
 frame.srcdoc='<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="'+csp.replace(/"/g,'&quot;')+'"><meta name="referrer" content="no-referrer"></head><body></body></html>';
 }catch(e){$('replayGaps').textContent=e.message;}
}
function replayForJob(jobId){$('replayJob').value=jobId;$('replayInstallation').value='';selectTab('metrics');$('replayPanel').scrollIntoView({behavior:'smooth'});void replayListGo();}
$('replayGo').onclick=()=>replayListGo();$('replayMore').onclick=()=>replayListGo(true);$('replayClose').onclick=()=>{$('replayDialog').close();replayCleanup();};$('replayDialog').addEventListener('cancel',replayCleanup);
document.addEventListener('click',e=>{const b=e.target.closest('[data-replay-job]');if(b){replayForJob(b.dataset.replayJob);return;}const metric=e.target.closest('[data-replay-metric]');if(metric){$('replayJob').value='';$('replayInstallation').value='';$('replayFailed').value=metric.dataset.replayMetric==='errors'?'true':'';const feature=$('journeyDetailFeature')?.value;$('replayFeature').value=feature&&feature!=='all'?feature:'';$('replayPanel').scrollIntoView({behavior:'smooth'});void replayListGo();}});
`;
