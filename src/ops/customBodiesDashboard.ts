export const CUSTOM_BODIES_HTML = String.raw`
    <section class="tab" id="tab-bodies"><div class="card">
      <h2>사용자가 저장한 커스텀 체형</h2>
      <p class="sub">현재 품질 검토 동의가 유효한 설치의 저장 카드입니다. 상단 기간과 무관하게 현재 저장된 체형을 조회하며, 개발자 제외 설정은 적용됩니다. 설치는 사람 수와 다릅니다.</p>
      <div class="controls"><label>설치 ID <input id="customBodyOwner" placeholder="전체 설치 또는 inst_…" autocomplete="off"></label><button class="ghost" id="customBodyGo">불러오기</button><span class="sub" id="customBodyMsg" role="status"></span></div>
      <div id="customBodyList"></div><button class="ghost" id="customBodyMore" hidden>설치 더 보기</button>
    </div></section>`;
export const CUSTOM_BODIES_DIALOG = String.raw`
<dialog id="customBodyDialog" style="background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:12px;width:min(920px,94vw);max-height:90vh;padding:20px">
  <div class="controls"><h2 id="customBodyTitle">저장한 체형</h2><button class="ghost" id="customBodyClose" style="margin-left:auto">닫기 ✕</button></div>
  <div id="customBodyDetail"></div>
</dialog>`;
export const CUSTOM_BODIES_SCRIPT = String.raw`
const customBodyReasons={INVALID_INPUT:'설치 ID와 조회 조건을 확인해 주세요.',MODEL_UNAVAILABLE:'현재 카탈로그에서 기본 모델을 사용할 수 없습니다.',CONTROLS_INCOMPATIBLE:'저장된 수치와 현재 모델의 조절 범위가 다릅니다.',RUNTIME_UNAVAILABLE:'이 모델을 재현할 미리보기 자산이 없습니다.',RUNTIME_UNSUPPORTED:'이 체형 계산 버전은 관리자 미리보기에서 지원하지 않습니다.',RUNTIME_INTEGRITY:'미리보기 자산과 현재 모델의 버전이 일치하지 않습니다.',PREVIEW_UNAVAILABLE:'체형 미리보기를 만들지 못했습니다.',MESH_INVALID:'체형 메시를 재현하지 못했습니다.',BODY_CHANGED:'체형이 변경되었습니다. 목록을 새로 불러와 주세요.',PREVIEW_BUSY:'다른 체형을 그리는 중입니다. 잠시 후 다시 시도해 주세요.'};
function customBodyReason(code){return customBodyReasons[code]||'현재 체형을 미리볼 수 없습니다.';}
function customBodyGroups(groups){
 return groups.map(g=>'<h3>'+esc(g.installationId)+' <span class="sub">'+esc(g.appVersion||'버전 미확인')+' · '+esc(g.osName||'OS 미확인')+'</span></h3><div class="scroll"><table><thead><tr><th>체형 이름</th><th>기본 모델</th><th>저장</th><th>수정</th><th>조회</th></tr></thead><tbody>'+g.cards.map(c=>'<tr><td>'+esc(c.name)+'</td><td>'+esc(c.modelName)+'</td><td>'+when(c.createdAt)+'</td><td>'+when(c.updatedAt)+'</td><td><button class="ghost" data-body-owner="'+esc(g.installationId)+'" data-body-card="'+esc(c.cardId)+'">체형 보기</button>'+(c.previewStatus==='available'?'':'<div class="sub">'+esc(customBodyReason(c.previewReason))+'</div>')+'</td></tr>').join('')+'</tbody></table></div>').join('');
}
let customBodyListOwner='',customBodyGroupsLoaded=[],customBodyNext=null,customBodyListRequest=0,customBodyPreviewRequest=0,customBodyBlob=null,customBodyAbort=null,customBodyCurrent=null;
function releaseCustomBodyPreview(){
 customBodyPreviewRequest++;if(customBodyAbort)customBodyAbort.abort();customBodyAbort=null;
 if(customBodyBlob)URL.revokeObjectURL(customBodyBlob);customBodyBlob=null;
 const image=$('customBodyPreview');if(image)image.removeAttribute('src');
}
function closeCustomBody(){releaseCustomBodyPreview();customBodyCurrent=null;$('customBodyDetail').innerHTML='';if($('customBodyDialog').open)$('customBodyDialog').close();}
async function customBodyFetch(path,signal){
 const response=await fetch(path,{headers:{'X-Beta-Admin-Token':token},cache:'no-store',signal});
 if(!response.ok){let code;try{code=(await response.json()).error?.code;}catch{}const e=new Error(response.status===404?'저장된 체형이 없거나 현재 열람할 수 없습니다.':customBodyReason(code));e.status=response.status;throw e;}
 return response;
}
async function customBodiesGo(cursor){
 const request=++customBodyListRequest;closeCustomBody();$('customBodyMsg').textContent='불러오는 중…';$('customBodyMore').hidden=true;
 if(!cursor){customBodyGroupsLoaded=[];$('customBodyList').innerHTML='';}
 const params=new URLSearchParams({limit:'20'}),owner=cursor?customBodyListOwner:$('customBodyOwner').value.trim();if(!cursor)customBodyListOwner=owner;if(owner)params.set('installationId',owner);if(cursor)params.set('cursor',cursor);
 try{const data=await(await customBodyFetch('/v1/admin/review/custom-bodies?'+params)).json();if(request!==customBodyListRequest)return;
  customBodyGroupsLoaded=cursor?customBodyGroupsLoaded.concat(data.installations):data.installations;customBodyNext=data.nextCursor;
  $('customBodyList').innerHTML=customBodyGroupsLoaded.length?customBodyGroups(customBodyGroupsLoaded):'<p class="empty">열람 범위에 저장된 커스텀 체형이 없습니다.</p>';
  $('customBodyMsg').textContent=customBodyGroupsLoaded.length+'개 설치 · '+customBodyGroupsLoaded.reduce((n,g)=>n+g.cards.length,0)+'개 체형';$('customBodyMore').hidden=!customBodyNext;
 }catch(e){if(request!==customBodyListRequest)return;$('customBodyMsg').textContent=e.message;if(!cursor)$('customBodyList').innerHTML='';else $('customBodyMore').hidden=!customBodyNext;}
}
async function loadCustomBodyPreview(view){
 if(!customBodyCurrent)return;releaseCustomBodyPreview();const request=customBodyPreviewRequest,body=customBodyCurrent;
 $('customBodyPreviewMsg').textContent='저장된 수치로 그리는 중…';customBodyAbort=new AbortController();
 try{const response=await customBodyFetch(body.previewUrl+'&view='+encodeURIComponent(view),customBodyAbort.signal);
  if(!response.headers.get('content-type')?.startsWith('image/svg+xml'))throw new Error('미리보기 형식을 확인하지 못했습니다.');
  const blob=await response.blob();if(request!==customBodyPreviewRequest)return;
  customBodyBlob=URL.createObjectURL(blob);$('customBodyPreview').src=customBodyBlob;$('customBodyPreviewMsg').textContent=({front:'정면',side:'측면',back:'후면'})[view]+' · 현재 모델과 저장 수치로 재현';
 }catch(e){if(request===customBodyPreviewRequest){$('customBodyPreviewMsg').textContent=e.message;if(e.status===404){customBodyCurrent=null;$('customBodyDetail').innerHTML='<p class="empty">'+esc(e.message)+'</p>';}}}
}
async function openCustomBody(owner,card){
 closeCustomBody();const request=customBodyPreviewRequest;$('customBodyTitle').textContent='저장한 체형';$('customBodyDetail').innerHTML='<p role="status">불러오는 중…</p>';$('customBodyDialog').showModal();
 customBodyAbort=new AbortController();
 try{const body=await(await customBodyFetch('/v1/admin/review/custom-bodies/'+encodeURIComponent(owner)+'/'+encodeURIComponent(card),customBodyAbort.signal)).json();if(request!==customBodyPreviewRequest)return;
  customBodyCurrent=body;$('customBodyTitle').textContent=body.name;
  $('customBodyDetail').innerHTML='<p class="sub">'+esc(body.modelName)+' · 저장 '+when(body.createdAt)+' · 수정 '+when(body.updatedAt)+'</p><p class="sub">현재 승인된 모델 자산에 저장 수치를 적용한 중립 체형입니다. 저장 당시의 사진이나 최종 포즈 파일을 보여 주는 것은 아닙니다. 체형 설정을 변경하지 않습니다.</p><div class="side"><div>'+(body.previewUrl?'<div class="controls"><button class="ghost" data-body-view="front">정면</button><button class="ghost" data-body-view="side">측면</button><button class="ghost" data-body-view="back">후면</button></div><img id="customBodyPreview" alt="저장된 수치를 반영한 커스텀 체형" style="width:100%;max-height:580px;object-fit:contain;aspect-ratio:3/4;background:#39414b;border-radius:10px"><p class="sub" role="status" id="customBodyPreviewMsg"></p>':'<p class="empty">'+esc(customBodyReason(body.previewReason))+'</p>')+'</div><div class="scroll"><table><thead><tr><th>조절 항목</th><th>저장값</th></tr></thead><tbody>'+body.controls.map(c=>'<tr><td>'+esc(c.label)+'</td><td>'+esc(c.value)+'</td></tr>').join('')+'</tbody></table></div></div>';
  if(body.previewUrl)void loadCustomBodyPreview('front');
 }catch(e){if(request===customBodyPreviewRequest)$('customBodyDetail').innerHTML='<p class="empty">'+esc(e.message)+'</p>';}
}
$('customBodyGo').addEventListener('click',()=>customBodiesGo(null));
$('customBodyMore').addEventListener('click',()=>customBodiesGo(customBodyNext));
$('customBodyOwner').addEventListener('keydown',e=>{if(e.key==='Enter')customBodiesGo(null);});
$('customBodyClose').addEventListener('click',closeCustomBody);
$('customBodyDialog').addEventListener('close',()=>{if($('customBodyDialog').open)return;releaseCustomBodyPreview();customBodyCurrent=null;$('customBodyDetail').innerHTML='';});
document.addEventListener('click',e=>{const button=e.target.closest?.('button[data-body-owner]');if(button)void openCustomBody(button.dataset.bodyOwner,button.dataset.bodyCard);const view=e.target.closest?.('button[data-body-view]');if(view)void loadCustomBodyPreview(view.dataset.bodyView);});
`;
