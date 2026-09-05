// 전용 모바일 화면에 기존 편집 DOM을 옮겨 연결합니다. 프로젝트와 렌더러는 복제하지 않습니다.
const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths={
 add:'M12 5v14 M5 12h14',media:'M3 5h18v14H3z M3 15l5-5 5 5 3-3 5 5 M16 8h.01',text:'M4 5h16 M12 5v15 M8 20h8',sound:'M9 18V5l11-2v13 M9 8l11-2 M9 18a3 3 0 1 1-3-3h3 M20 16a3 3 0 1 1-3-3h3',
 graphic:'m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z',format:'M4 3h16v18H4z M4 8h16 M4 16h16',back:'m14 5-7 7 7 7',more:'M5 12h.01 M12 12h.01 M19 12h.01',split:'M12 3v18 M3 7h6v10H3z M15 7h6v10h-6z',
 transform:'M3 8V3h5 M16 3h5v5 M21 16v5h-5 M8 21H3v-5 M8 8h8v8H8z',motion:'m12 3 9 9-9 9-9-9z',volume:'M3 9h4l5-4v14l-5-4H3z M16 8a6 6 0 0 1 0 8 M19 5a10 10 0 0 1 0 14',select:'M9 3H3v6 M15 3h6v6 M3 15v6h6 M21 15v6h-6 M8 12l3 3 5-6',
 delete:'M4 6h16 M9 6V3h6v3 M6 6l1 15h10l1-15 M10 10v7 M14 10v7',copy:'M8 8h13v13H8z M16 8V3H3v13h5',settings:'M4 6h16 M4 12h16 M4 18h16 M8 3v6 M16 9v6 M10 15v6',undo:'m9 5-5 5 5 5 M4 10h10a6 6 0 0 1 0 12',redo:'m15 5 5 5-5 5 M20 10H10a6 6 0 0 0 0 12',
 folder:'M3 19V5h7l2 3h9v11z',save:'M4 3h13l3 3v15H4z M8 3v6h8V3 M8 21v-8h8v8',voice:'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0z M5 10v2a7 7 0 0 0 14 0v-2 M12 19v3',transition:'M3 5h18v14H3z M9 5l6 7-6 7',mosaic:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
 tracks:'m12 3 10 5-10 5L2 8z M2 12l10 5 10-5 M2 16l10 5 10-5',crop:'M7 3v14h14 M3 7h14v14',align:'M12 2v20 M5 6h14v4H5z M8 14h8v4H8z',help:'M9 8a3 3 0 1 1 5 2c-2 1-2 2-2 3 M12 17h.01 M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20'
};
const icon=name=>`<svg class="mobile-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name]||paths.settings}"/></svg>`;
const iconButton=(id,label,symbol)=>`<button type="button" id="${id}" aria-label="${label}" title="${label}">${icon(symbol)}</button>`;
const groupLabels={text:'문구 편집',font:'글꼴과 색',border:'테두리',box:'텍스트 박스',shadow:'그림자',effects:'등장과 퇴장',transform:'위치와 크기',crop:'화면 자르기',fit:'원본 맞춤',motion:'키프레임',volume:'음량',fade:'페이드',all:'세부 편집',transition:'장면 전환'};
export function mobileLayout({width,height,coarse=false,override=''}){const active=override==='mobile'||(override!=='desktop'&&(width<=760||(coarse&&width<=1100)));return{active,landscape:active&&width>height};}
export const mobileDockView=view=>['media','captions','voice'].includes(view)?view:'effects';
export function mobileActions({type,count=0}={}){
 if(count>1)return[['select','선택 완료','select'],['splitClip','분할','split'],['inspector:all','함께 편집','settings'],['deleteClip','삭제','delete'],['menu:clip','더보기','more']];
 if(type==='gap')return[['splitClip','공백 닫기','split'],['menu:tracks','트랙 관리','tracks']];
 if(type==='transition')return[['inspector:transition','전환 편집','transition'],['deleteClip','전환 삭제','delete']];
 if(type==='clip')return[['splitClip','분할','split'],['menu:screen','화면','transform'],['inspector:motion','움직임','motion'],['view:transitions','전환','transition'],['menu:clip','더보기','more']];
 if(type==='caption'||type==='graphic')return[['inspector:text','문구','text'],['inspector:font','글꼴','text'],['menu:decorate','꾸미기','graphic'],[type==='caption'?'inspector:effects':'inspector:motion',type==='caption'?'효과':'움직임','motion'],['menu:clip','더보기','more']];
 if(type==='audio')return[['inspector:volume','음량','volume'],['inspector:fade','페이드','transition'],['splitClip','분할','split'],['duplicateClip','복제','copy'],['menu:clip','더보기','more']];
 return[['view:media','추가','add'],['menu:captions','자막','text'],['menu:sound','소리','sound'],['view:graphics','그래픽','graphic'],['view:quick-format','퀵포맷','format']];
}
export function mobileInspectorMatches(group,title){const terms={text:['내용'],font:['글자 스타일'],border:['테두리'],box:['텍스트 박스'],shadow:['그림자'],effects:['효과'],transform:['변형','배치'],crop:['화면 자르기'],fit:['원본 맞춤'],motion:['키프레임'],volume:['오디오','원본 오디오'],fade:['오디오','클립 페이드'],transition:['장면 전환','다음 장면과 전환']};return group==='all'||(terms[group]||[]).includes(title);}

export class MobileStudio{
 constructor(hooks){
  this.hooks=hooks;this.active=false;this.sheet=null;this.inspectorGroup='all';this.librarySection=null;this.allTracks=false;this.trackId=null;this.menuPage='project';this.selectionKey='';this.filtered=new Set();
  this.coarse=matchMedia('(pointer: coarse)');this.override=new URLSearchParams(location.search).get('ui')||'';this.mount();
  addEventListener('resize',()=>this.resize());this.coarse.addEventListener('change',()=>this.resize());window.visualViewport?.addEventListener('resize',()=>this.viewport());
  document.addEventListener('keydown',event=>{
   if(!this.active||!this.sheet||document.querySelector('dialog[open]'))return;
   if(event.key==='Escape'){event.preventDefault();this.closeSheet();}
   if(event.key==='Tab'){const nodes=[...$('mobilePanel').querySelectorAll('button,input,textarea,select,a[href],[tabindex="0"]')].filter(n=>!n.disabled&&n.getClientRects().length&&!n.closest('[data-mobile-filtered]'));const first=nodes[0],last=nodes.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}
  },true);this.resize();
 }
 mount(){
  this.records=[document.querySelector('.viewer'),document.querySelector('.timeline-panel'),$('library'),$('inspector')].map(node=>{const marker=document.createComment('PC '+(node.id||node.className));node.before(marker);return{node,marker};});
  const shell=document.createElement('section');shell.id='mobileStudioShell';shell.className='mobile-only';shell.setAttribute('aria-label','모바일 숏츠 편집기');
  shell.innerHTML=`<header class="mobile-header">${iconButton('mobileProjectMenu','프로젝트 메뉴','folder')}<div class="mobile-project-title"><strong id="mobileProjectTitle"></strong><small id="mobileSaveStatus">자동 저장</small></div><button type="button" id="mobileExport">완성 ${icon('save')}</button></header><div id="mobileViewerHost"></div><section id="mobileEditDeck" aria-label="모바일 타임라인"><div class="mobile-edit-heading"><h2>타임라인</h2><button type="button" id="mobileOverview" aria-pressed="false">${icon('tracks')}<span>전체 트랙</span></button><div class="mobile-history">${iconButton('mobileUndo','실행 취소','undo')}${iconButton('mobileRedo','다시 실행','redo')}</div></div><nav id="mobileLayerBar" aria-label="편집할 트랙"></nav><div id="mobileTimelineHost"></div></section><nav id="mobileActionDock" aria-label="현재 작업 도구"></nav><div id="mobileParking" hidden></div>`;document.body.append(shell);
  const backdrop=document.createElement('button');backdrop.type='button';backdrop.id='mobileBackdrop';backdrop.className='mobile-only';backdrop.tabIndex=-1;backdrop.setAttribute('aria-label','편집 패널 닫기');document.body.append(backdrop);
  const panel=document.createElement('section');panel.id='mobilePanel';panel.className='mobile-only';panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');panel.setAttribute('aria-labelledby','mobilePanelTitle');panel.innerHTML=`<header class="mobile-panel-header">${iconButton('mobilePanelBack','이전 메뉴','back')}<h2 id="mobilePanelTitle"></h2><button type="button" id="mobilePanelDone">완료</button></header><nav id="mobilePanelTabs" aria-label="세부 작업" hidden></nav><div id="mobilePanelBody"><div id="mobileMenu"></div></div>`;document.body.append(panel);
  $('mobileProjectMenu').onclick=()=>this.openMenu('project');$('mobileExport').onclick=()=>this.command('openExport');$('mobileUndo').onclick=()=>this.command('undo');$('mobileRedo').onclick=()=>this.command('redo');
  $('mobileOverview').onclick=()=>{if(this.hooks.busy())return;this.allTracks=!this.allTracks;this.syncTracks();this.hooks.layout?.(true);};
  $('mobileLayerBar').onclick=event=>{const chip=event.target.closest('[data-mobile-track]');if(chip)this.focusTrack(chip.dataset.mobileTrack);if(event.target.closest('#mobileTrackManager'))this.openMenu('tracks');};
  $('mobileActionDock').onclick=event=>{const action=event.target.closest('[data-mobile-action]');if(action)this.action(action.dataset.mobileAction);};
  $('mobilePanelDone').onclick=()=>this.closeSheet();backdrop.onclick=()=>this.closeSheet();$('mobilePanelBack').onclick=()=>{if(this.backPage)this.openMenu(this.backPage);else this.closeSheet();};
  $('mobilePanel').addEventListener('click',event=>{const item=event.target.closest('[data-mobile-action]');if(item){this.action(item.dataset.mobileAction);return;}const track=event.target.closest('[data-mobile-track-action]');if(track&&!this.hooks.busy()){this.hooks.trackAction(this.trackMenuId,track.dataset.mobileTrackAction);this.renderMenu();this.syncTracks();}});
  $('mobilePanel').addEventListener('change',event=>{if(event.target.id==='mobileRename')this.hooks.rename(event.target.value);});
  // 값은 기존 입력에서 확정합니다. 프레임마다 작업 버튼 DOM을 재생성하지 않습니다.
  document.addEventListener('click',()=>{if(this.active)requestAnimationFrame(()=>{this.syncSelection();if(this.sheet==='menu')this.updateMenuDisabled();});});
 }
 viewport(){if(!this.active)return;const vv=window.visualViewport,height=vv&&vv.scale===1?vv.height:innerHeight;document.body.style.setProperty('--mobile-vh',height+'px');document.body.style.setProperty('--mobile-keyboard-inset',Math.max(0,innerHeight-height-(vv?.offsetTop||0))+'px');}
 resize(){
  const typing=/INPUT|TEXTAREA/.test(document.activeElement?.tagName);if(this.active&&typing&&this.layoutWidth===innerWidth&&innerHeight<this.layoutHeight-100){this.viewport();return;}this.layoutWidth=innerWidth;this.layoutHeight=innerHeight;
  const next=mobileLayout({width:innerWidth,height:innerHeight,coarse:this.coarse.matches,override:this.override}),changed=next.active!==this.active,rotated=next.landscape!==document.body.classList.contains('mobile-landscape');if(changed||rotated)this.hooks.timeline.cancelMobileGestures?.();
  if(changed){this.closeSheet(false);this.active=next.active;this.hooks.timeline.mobileMultiSelect=false;this.dockKey='';document.body.classList.toggle('mobile-ui',this.active);$('workbench').classList.remove('show-library','show-inspector');
   if(this.active){$('mobileViewerHost').append(this.records[0].node);$('mobileTimelineHost').append(this.records[1].node);$('mobileParking').append($('library'),$('inspector'));this.hooks.timeline.activateTrack(this.trackId||this.hooks.tracks().find(t=>t.role==='video')?.id);}
   else{this.hooks.timeline.restoreMobileTrackView?.();for(const {node,marker} of this.records)marker.after(node);delete document.body.dataset.mobileTimeline;document.body.style.removeProperty('--mobile-vh');document.body.style.removeProperty('--mobile-keyboard-inset');}
  }
  document.body.classList.toggle('mobile-landscape',next.landscape);this.viewport();this.syncSelection();if(changed||rotated)requestAnimationFrame(()=>this.hooks.layout?.(this.active));
 }
 syncTracks(){
  if(!this.active)return;const tracks=this.hooks.tracks(),normalized=this.hooks.timeline.setMobileTrackView?.({all:this.allTracks,trackId:this.trackId})||{trackId:this.trackId||tracks.find(t=>t.role==='video')?.id};this.trackId=normalized.trackId;
  document.body.dataset.mobileTimeline=this.allTracks?'all':'focus';$('mobileOverview').setAttribute('aria-pressed',String(this.allTracks));$('mobileOverview').querySelector('span').textContent=this.allTracks?'한 트랙씩':'전체 트랙';
  const signature=JSON.stringify([this.trackId,tracks.map(t=>[t.id,t.label,t.count])]);if(signature!==this.trackSignature){this.trackSignature=signature;$('mobileLayerBar').innerHTML=tracks.map(track=>`<button type="button" class="mobile-layer-chip" data-mobile-track="${esc(track.id)}" aria-pressed="${track.id===this.trackId}"><span>${esc(track.label)}</span>${track.count?`<small>${track.count}</small>`:''}</button>`).join('')+iconButton('mobileTrackManager','트랙 관리','settings');}
 }
 focusTrack(id){if(this.hooks.busy())return;this.trackId=id;this.hooks.timeline.activateTrack(id);if(!this.hooks.timeline.mobileMultiSelect)this.hooks.clearSelection();this.syncTracks();}
 syncSelection(){
  if(!this.active)return;const state=this.hooks.selection(),busy=!!this.hooks.busy(),key=[state.type,state.id,state.count,state.trackId].join(':');
  if(key!==this.selectionKey){this.selectionKey=key;if(state.trackId)this.trackId=state.trackId;if(this.sheet==='library'&&state.type&&state.type!=='asset'&&this.librarySection!=='caption-styles')this.closeSheet(false);}
  $('mobileProjectTitle').textContent=$('projectName').value;const saveStatus=$('saveStatus').textContent;$('mobileSaveStatus').textContent=/필요|실패/.test(saveStatus)?saveStatus:saveStatus.includes('저장 중')?'저장 중':'자동 저장';for(const [proxy,original] of [['mobileUndo','undo'],['mobileRedo','redo'],['mobileExport','openExport']])$(proxy).disabled=busy||$(original).disabled;
  const selected=state.type&&state.type!=='asset';
  const rowNode=$('timelineRows').firstElementChild;if(rowNode!==this.lastRows||this.lastTrackId!==this.trackId||!this.trackSignature){this.lastRows=rowNode;this.syncTracks();this.lastTrackId=this.trackId;}
  const dockKey=JSON.stringify([state.type,state.count>1,this.hooks.timeline.mobileMultiSelect]);if(dockKey!==this.dockKey){this.dockKey=dockKey;$('mobileActionDock').innerHTML=(selected?`<button type="button" class="mobile-action-back" data-mobile-action="deselect" aria-label="선택 해제">${icon('back')}</button>`:'')+`<div class="mobile-action-scroll">${mobileActions(state).map(([action,label,symbol])=>`<button type="button" class="mobile-action-button" data-mobile-action="${action}">${icon(symbol)}<span>${action==='select'&&!this.hooks.timeline.mobileMultiSelect?'여러 선택':label}</span></button>`).join('')}</div>`;}
  for(const node of $('mobileActionDock').querySelectorAll('[data-mobile-action]')){const target=$(node.dataset.mobileAction);node.disabled=busy||!!target?.disabled;}
 }
 clearFilters(){for(const node of this.filtered)node.removeAttribute('data-mobile-filtered');this.filtered.clear();}
 hide(node,hidden){if(hidden){node.dataset.mobileFiltered='true';this.filtered.add(node);}else{node.removeAttribute('data-mobile-filtered');this.filtered.delete(node);}}
 refreshPanel(){
  if(!this.active||!this.sheet)return;
  if(this.sheet==='inspector')for(const child of $('inspectorContent').children){const section=child.matches('.property-section'),title=section?[...(child.querySelector('h3')?.childNodes||[])].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim():'';this.hide(child,this.inspectorGroup==='all'?false:!section||!mobileInspectorMatches(this.inspectorGroup,title));if(section&&['volume','fade'].includes(this.inspectorGroup))for(const field of child.querySelectorAll(':scope > label')){const prop=field.querySelector('[data-prop]')?.dataset.prop;this.hide(field,prop&&(this.inspectorGroup==='volume'?!['volume','muted'].includes(prop):!['fadeIn','fadeOut'].includes(prop)));}}
  else if(this.sheet==='library'&&this.hooks.view()==='captions')for(const child of $('libraryContent').children)this.hide(child,this.librarySection==='automatic'?!child.matches('.smart-card'):this.librarySection==='caption-styles'?!child.matches('.preset-grid,.segmented'):false);
 }
 onSelection(){this.syncSelection();}
 onViewChange(){if(this.active)this.openSheet('library');}
 library(view,section=null){this.librarySection=section;this.hooks.setView(view);}
 showInspector(group='all'){this.inspectorGroup=group;this.openSheet('inspector');}
 openSheet(name){
  if(!this.active||this.hooks.busy()||document.querySelector('dialog[open]'))return;this.hooks.timeline.cancelMobileGestures?.();this.hooks.timeline.closeMenu();this.hooks.pause();if(!this.sheet)this.returnFocus=document.activeElement;
  this.clearFilters();$('mobileParking').append($('library'),$('inspector'));$('mobileMenu').hidden=name!=='menu';this.sheet=name;document.body.dataset.mobileSheet=name;document.body.classList.add('mobile-sheet-open');$('mobileStudioShell').inert=true;if(name!=='menu')$('mobilePanelBody').append($(name));
  $('mobilePanelTitle').textContent=name==='inspector'?groupLabels[this.inspectorGroup]:name==='library'?({media:'파일 추가',captions:this.librarySection==='automatic'?'자동 자막':'자막 스타일',graphics:'그래픽 추가',sounds:'효과음',voice:'음성 만들기','quick-format':'퀵포맷',transitions:'장면 전환',mosaic:'모자이크',silence:'무음 컷'}[this.hooks.view()]||'편집'):this.menuTitle;
  this.backPage=name==='menu'?({screen:'clip',decorate:'clip',track:'tracks'}[this.menuPage]||null):name==='library'&&['sounds','voice'].includes(this.hooks.view())?'sound':name==='library'&&this.hooks.view()==='captions'?'captions':null;$('mobilePanelBack').hidden=!this.backPage;this.refreshPanel();$('mobilePanelBody').scrollTop=0;$('mobilePanelDone').focus({preventScroll:true});requestAnimationFrame(()=>{if(this.active)this.hooks.layout?.(true);});
 }
 closeSheet(restoreFocus=true){
  if(!this.sheet)return;const focus=this.returnFocus;this.sheet=null;this.clearFilters();$('mobileStudioShell').inert=false;$('mobileParking').append($('library'),$('inspector'));delete document.body.dataset.mobileSheet;document.body.classList.remove('mobile-sheet-open');this.returnFocus=null;this.syncSelection();requestAnimationFrame(()=>{if(this.active)this.hooks.layout?.(true);});if(restoreFocus){const target=focus?.isConnected&&focus.getClientRects().length?focus:$('mobileProjectMenu');target?.focus({preventScroll:true});}
 }
 command(id){if(this.hooks.busy())return;const target=$(id);if(!target||target.disabled)return;this.closeSheet(false);target.click();this.syncSelection();}
 action(action){
  if(this.hooks.busy())return;
  if(action==='deselect'){this.hooks.timeline.mobileMultiSelect=false;this.hooks.clearSelection();return;}
  if(action==='select'){this.closeSheet(false);this.hooks.timeline.mobileMultiSelect=!this.hooks.timeline.mobileMultiSelect;this.syncSelection();return;}
  if(action==='new-caption'){this.closeSheet(false);this.hooks.addCaption();this.showInspector('text');return;}
  if(action==='automatic'){this.library('captions','automatic');return;}
  if(action==='caption-styles'){this.library('captions','caption-styles');return;}
  const [kind,value]=action.split(':');if(kind==='menu')this.openMenu(value);else if(kind==='view')this.library(value);else if(kind==='inspector')this.showInspector(value);else if(kind==='route'){this.closeSheet(false);this.hooks.route(value);}else if(kind==='timeline'){this.closeSheet(false);this.hooks.menuAction(value);}else if(kind==='track'){this.trackMenuId=value;this.openMenu('track');}else if(kind==='focus'){this.closeSheet(false);this.focusTrack(value);}else this.command(action);
 }
 openMenu(page){if(!this.active||this.hooks.busy())return;this.menuPage=page;this.renderMenu();this.openSheet('menu');}
 updateMenuDisabled(){for(const node of $('mobileMenu').querySelectorAll('[data-mobile-command]'))node.disabled=!!$(node.dataset.mobileCommand)?.disabled;}
 renderMenu(){
  const row=(label,symbol,action,hint='',disabled=false)=>`<button type="button" class="mobile-option-row" data-mobile-action="${esc(action)}" ${$(action)?`data-mobile-command="${action}"`:''} ${disabled?'disabled':''}>${icon(symbol)}<div><strong>${label}</strong>${hint?`<small>${hint}</small>`:''}</div><span class="mobile-option-arrow" aria-hidden="true">›</span></button>`;
  const command=(label,symbol,id,hint='')=>row(label,symbol,id,hint,$(id)?.disabled);let html='';
  if(this.menuPage==='captions'){this.menuTitle='자막';html=row('텍스트 입력','text','new-caption','지금 위치에 새 자막')+row('자동 자막','voice','automatic','말소리를 자막으로')+row('자막 스타일','graphic','caption-styles','선택한 자막의 모양 바꾸기')+row('자막 파일 가져오기','folder','route:import-srt');}
  else if(this.menuPage==='sound'){this.menuTitle='소리';html=row('오디오 파일','folder','view:media','음악과 녹음 파일 가져오기')+row('효과음','sound','view:sounds','클릭, 등장, 알림 소리')+row('음성 만들기','voice','view:voice','텍스트로 내레이션 만들기');}
  else if(this.menuPage==='screen'){this.menuTitle='화면 편집';html=row('위치와 크기','transform','inspector:transform')+row('화면 자르기','crop','inspector:crop')+row('원본 맞춤','format','inspector:fit')+row('가로 중앙 정렬','align','route:align-x')+row('세로 중앙 정렬','align','route:align-y');}
  else if(this.menuPage==='decorate'){this.menuTitle='자막 꾸미기';html=row('테두리','text','inspector:border')+row('텍스트 박스','format','inspector:box')+row('그림자','graphic','inspector:shadow')+row('위치와 크기','transform','inspector:transform')+row('키프레임','motion','inspector:motion');}
  else if(this.menuPage==='clip'){this.menuTitle='클립 편집';html=row(this.hooks.timeline.mobileMultiSelect?'선택 완료':'여러 클립 선택','select','select')+row('세부 편집','settings','inspector:all');for(const item of this.hooks.menuItems().filter(item=>!item.separator))html+=row(item.label,({duplicate:'copy',delete:'delete','ripple-delete':'delete',split:'split'})[item.id]||'settings','timeline:'+item.id,'',item.disabled);if(this.hooks.selection().type==='clip')html+=row('모자이크','mosaic','view:mosaic')+row('무음 컷','split','view:silence');}
  else if(this.menuPage==='tracks'){this.menuTitle='트랙 관리';html=this.hooks.tracks().map(track=>row(esc(track.label),'tracks','track:'+track.id,track.count+'개 클립'+(track.locked?' · 잠김':''))).join('');}
  else if(this.menuPage==='track'){
   const track=this.hooks.tracks().find(track=>track.id===this.trackMenuId);if(!track){this.menuPage='tracks';this.renderMenu();return;}this.menuTitle=track.label;html=row('이 트랙 편집','tracks','focus:'+track.id);
   for(const [key,label] of (track.kind==='visual'?[['hidden','화면 숨기기'],['locked','편집 잠금']]:[['muted','음소거'],['solo','이 트랙만 듣기'],['locked','편집 잠금']]))html+=`<button type="button" class="mobile-option-row" data-mobile-track-action="${key}" aria-pressed="${track[key]===true}"><div><strong>${label}</strong></div><span class="mobile-row-switch" aria-hidden="true"></span></button>`;
   html+=`<button type="button" class="mobile-option-row" data-mobile-track-action="add">${icon('add')}<div><strong>같은 종류의 트랙 추가</strong></div></button><button type="button" class="mobile-option-row" data-mobile-track-action="remove" ${track.count?'disabled':''}>${icon('delete')}<div><strong>빈 트랙 삭제</strong></div></button>`;
  }else{this.menuTitle='프로젝트';html=`<label class="mobile-name-field">프로젝트 이름<input id="mobileRename" value="${esc($('projectName').value)}" maxlength="100"></label>`+command('프로젝트 저장','save','saveProject')+command('프로젝트 열기','folder','openProject')+row('트랙 관리','tracks','menu:tracks')+command('안전영역','format','safeArea')+command('스냅 '+($('snap').getAttribute('aria-pressed')==='true'?'끄기':'켜기'),'select','snap')+command('반복 재생 '+($('loop').getAttribute('aria-pressed')==='true'?'끄기':'켜기'),'redo','loop')+command('도움말','help','helpButton');}
  $('mobileMenu').innerHTML=`<div class="mobile-option-list">${html}</div>`;
 }
}
