// PC는 작업의 목적별로 도구를 보여줍니다. 편집 데이터와 기존 입력 노드는 공유합니다.
const $=id=>document.getElementById(id);
const groups={files:{label:'파일',view:'media',icon:'folder'},captions:{label:'자막',view:'captions',icon:'text'},sound:{label:'소리',view:'sounds',icon:'sound'},design:{label:'디자인',view:'quick-format',icon:'design'},tools:{label:'트래킹',view:'mosaic',icon:'tools'}};
const subviews={files:[],captions:[['styles','자막'],['create','자동자막'],['list','자막 목록']],sound:[['sounds','효과음'],['voice','AI TTS'],['silence','무음 컷']],design:[['quick-format','퀵포맷'],['graphics','그래픽'],['transitions','장면 전환']],tools:[['mosaic','모자이크'],['crop-tracking','크롭']]};
const groupLabels={basic:'기본',style:'꾸미기',motion:'움직임',details:'세부'};
const icons={folder:'M3 7V5h6l2 2h10v12H3Z',text:'M4 5h16M12 5v14M8 19h8',sound:'M4 10v4m4-7v10m4-14v18m4-14v10m4-7v4',design:'m12 3 2.8 6.2L21 12l-6.2 2.8L12 21l-2.8-6.2L3 12l6.2-2.8Z',tools:'M4 7h16M4 17h16M8 4v6m8 4v6',close:'m6 6 12 12M6 18 18 6',more:'M5 12h.01M12 12h.01M19 12h.01',down:'m7 10 5 5 5-5',add:'M12 5v14M5 12h14',export:'M12 16V3m-4 4 4-4 4 4M5 13v7h14v-7',split:'M12 3v18M3 6h5v12H3m18-12h-5v12h5',copy:'M8 8h12v12H8ZM4 16V4h12',trash:'M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7',undo:'M8 4 3 9l5 5M3 9h10a6 6 0 0 1 6 6v3',redo:'m16 4 5 5-5 5m5-5H11a6 6 0 0 0-6 6v3',arrow:'M4 12h16m-6-6 6 6-6 6',help:'M9.5 8a2.5 2.5 0 1 1 4 2c-1.5 1-1.5 1.5-1.5 3M12 17h.01',save:'M5 3h12l3 3v15H4V3Zm3 0v6h8V3M8 21v-7h8v7'};
const icon=name=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${icons[name]||icons.tools}"/></svg>`;
const button=(id,label,symbol)=>`<button type="button" id="${id}" aria-label="${label}" title="${label}" class="icon-button">${icon(symbol)}</button>`;
const sectionTitle=node=>[...(node.querySelector('h3')?.childNodes||[])].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim();

export function desktopGroupForView(view){return ({media:'files',captions:'captions',sounds:'sound',voice:'sound',silence:'sound','quick-format':'design',graphics:'design',transitions:'design',mosaic:'tools','crop-tracking':'tools'})[view]||'files';}
export function desktopInspectorGroup(title,type){
 if(['내용','글자 스타일','변형','배치','원본 맞춤','오디오','원본 오디오','화면 설정 대상'].includes(title))return 'basic';
 if(['테두리','텍스트 박스','그림자'].includes(title))return 'style';
 if(['키프레임','이미지 모션','효과','클립 페이드','다음 장면과 전환','장면 전환'].includes(title))return 'motion';
 return 'details';
}
export function desktopInspectorTabs(titles,type){
 if(['asset','gap','transition'].includes(type))return [];
 const present=new Set(titles.map(title=>desktopInspectorGroup(title,type)));
 return Object.keys(groupLabels).filter(key=>present.has(key));
}

export class DesktopStudio{
 constructor(hooks){
  this.hooks=hooks;this.active=false;this.captionTab='styles';this.inspectorTab='basic';this.selectionType=null;this.lastView=null;this.memory={};this.mount();this.syncMode();
  addEventListener('resize',()=>this.syncMode());
  this.modeObserver=new MutationObserver(()=>this.syncMode());this.modeObserver.observe(document.body,{attributes:true,attributeFilter:['class']});
 }
 mount(){
  const nav=document.createElement('nav');nav.id='desktopNav';nav.className='desktop-only desktop-navigation';nav.setAttribute('aria-label','추가할 항목');
  nav.innerHTML=Object.entries(groups).map(([key,g])=>`<button type="button" data-desktop-group="${key}" aria-pressed="false">${icon(g.icon)}<span>${g.label}</span></button>`).join('');$('library').prepend(nav);
  const tabs=document.createElement('nav');tabs.id='desktopLibraryTabs';tabs.className='desktop-only desktop-tabs';tabs.setAttribute('aria-label','라이브러리 세부 작업');$('library').querySelector('.section-heading').after(tabs);
  const inspectorTabs=document.createElement('nav');inspectorTabs.id='desktopInspectorTabs';inspectorTabs.className='desktop-only desktop-tabs';inspectorTabs.setAttribute('aria-label','선택 항목 편집');$('inspector').querySelector('.section-heading').after(inspectorTabs);
  const overview=document.createElement('div');overview.id='desktopInspectorEmpty';overview.className='desktop-only desktop-project-overview';overview.innerHTML=`<span class="desktop-eyebrow">YOUR NEXT STORY</span><h2>이야기에 집중하세요.</h2><p>파일을 넣고, 필요한 만큼 다듬으면<br>나만의 숏츠가 완성됩니다.</p><div class="desktop-project-facts"><div><span>화면 비율</span><strong>9:16</strong></div><div><span>전체 길이</span><strong id="desktopDuration">00:00</strong></div></div><span class="desktop-section-label">이어서 만들기</span><button type="button" class="desktop-quick-action" data-desktop-action="import">${icon('folder')}<div><strong>파일 가져오기</strong><small>영상 · 사진 · 오디오</small></div>${icon('arrow')}</button><button type="button" class="desktop-quick-action" data-desktop-action="captions">${icon('text')}<div><strong>자막 넣기</strong><small>직접 입력하거나 자동으로</small></div>${icon('arrow')}</button><button type="button" class="desktop-quick-action" data-desktop-action="format">${icon('design')}<div><strong>퀵포맷 적용</strong><small>배경과 상하단 문구를 한 번에</small></div>${icon('arrow')}</button><p class="desktop-selection-hint">클립을 선택하면 여기에 편집 도구가 열립니다.</p>`;$('inspectorContent').after(overview);
  const close=document.createElement('div');close.className='desktop-only';close.innerHTML=button('desktopCloseInspector','편집 패널 접기','close');$('inspector').querySelector('.section-heading').append(close);
  const menu=document.createElement('details');menu.className='desktop-only desktop-project-menu';menu.innerHTML=`<summary class="project-menu-trigger" aria-label="프로젝트 메뉴">프로젝트 ${icon('down')}</summary><div class="desktop-popover"></div>`;document.querySelector('.brand').after(menu);
  const pop=menu.querySelector('.desktop-popover');pop.append($('saveProject'),$('openProject'));pop.insertAdjacentHTML('beforeend',`<button type="button" data-desktop-command="newProject">새 프로젝트</button><button type="button" data-desktop-command="resetDemo">동영상 샘플 열기</button><button type="button" data-desktop-command="helpButton">도움말 · 단축키</button>`);
  const more=document.createElement('details');more.id='desktopEditMore';more.className='desktop-only desktop-more';more.innerHTML=`<summary aria-label="추가 편집 도구" title="추가 편집 도구">${icon('more')}</summary><div class="desktop-popover"></div>`;document.querySelector('.edit-tools').append(more);more.querySelector('.desktop-popover').append($('rippleDeleteClip'),$('copyClipSettings'),$('pasteClipSettings'));
  for(const [id,symbol] of [['undo','undo'],['redo','redo']])$(id).innerHTML=icon(symbol);
  for(const [id,symbol] of [['splitClip','split'],['duplicateClip','copy'],['deleteClip','trash']]){const label=$(id).querySelector('span');$(id).replaceChildren();$(id).insertAdjacentHTML('afterbegin',icon(symbol));$(id).append(label);}
  // 원래 버튼을 이동했으므로 PC와 모바일의 실행 명령·활성 조건은 그대로입니다.
  const savedExport=$('openExport');savedExport.innerHTML=icon('export')+'<span>내보내기</span>';
  nav.addEventListener('click',event=>{const target=event.target.closest('[data-desktop-group]');if(!target||this.hooks.busy())return;const group=target.dataset.desktopGroup,next=this.memory[group]||groups[group].view;this.hooks.setView(next);if(group==='tools')this.hooks.openTracking?.(next);});
  tabs.addEventListener('click',event=>{const target=event.target.closest('[data-desktop-tab]');if(!target||this.hooks.busy())return;const key=target.dataset.desktopTab;if(desktopGroupForView(this.hooks.view())==='captions'){this.captionTab=key;this.refreshLibrary();}else{this.hooks.setView(key);if(desktopGroupForView(key)==='tools')this.hooks.openTracking?.(key);}});
  inspectorTabs.addEventListener('click',event=>{const target=event.target.closest('[data-desktop-inspector]');if(!target||this.hooks.busy())return;this.inspectorTab=target.dataset.desktopInspector;this.refreshInspector();$('inspectorContent').scrollTop=0;});
  $('desktopCloseInspector').onclick=()=>this.toggleInspector(false);
  document.addEventListener('click',event=>{
   if(!this.active)return;
   const command=event.target.closest('[data-desktop-command]');if(command&&!this.hooks.busy()){const original=$(command.dataset.desktopCommand);if(original&&!original.disabled)original.click();}
   const action=event.target.closest('[data-desktop-action]');if(action&&!this.hooks.busy()){const key=action.dataset.desktopAction;if(key==='import')this.hooks.route('import');else if(key==='captions'){this.captionTab='styles';this.hooks.setView('captions');}else this.hooks.setView('quick-format');}
   for(const detail of document.querySelectorAll('.desktop-only[open]'))if(!detail.contains(event.target)||event.target.closest('button'))detail.open=false;
  });
  document.addEventListener('keydown',event=>{if(!this.active||event.key!=='Escape')return;for(const detail of document.querySelectorAll('.desktop-only[open]')){detail.open=false;detail.querySelector('summary')?.focus();}if(innerWidth<=1000)this.toggleInspector(false);});
 }
 syncMode(){
  const active=!document.body.classList.contains('mobile-ui');if(this.active===active)return;this.active=active;document.body.classList.toggle('desktop-ui',active);
  if(active){this.refreshLibrary();this.refreshInspector();this.sync();}else{for(const detail of document.querySelectorAll('.desktop-only[open]'))detail.open=false;}
 }
 toggleInspector(open){
  if(!this.active)return;const narrow=innerWidth<=1000;
  const next=open??(narrow?!document.body.classList.contains('desktop-inspector-open'):document.body.classList.contains('desktop-inspector-hidden'));
  document.body.classList.toggle('desktop-inspector-hidden',!next);document.body.classList.toggle('desktop-inspector-open',next);$('toggleInspector').setAttribute('aria-pressed',String(next));this.hooks.layout();
 }
 refreshLibrary(){
  if(!this.active)return;const view=this.hooks.view(),group=desktopGroupForView(view);this.memory[group]=view;
  for(const node of $('desktopNav').children)node.setAttribute('aria-pressed',String(node.dataset.desktopGroup===group));
  const key=group==='captions'?this.captionTab:view,tabs=$('desktopLibraryTabs'),signature=group+':'+key;
  if(tabs.dataset.signature!==signature){tabs.dataset.signature=signature;tabs.innerHTML=subviews[group].map(([value,label])=>`<button type="button" data-desktop-tab="${value}" aria-pressed="${key===value}">${label}</button>`).join('');}tabs.hidden=!subviews[group].length;
  document.body.dataset.desktopView=view;
  const host=$('libraryContent');
  // 안내나 경고는 남기고, 자막 입력·스타일·목록만 목적에 맞게 분리합니다.
  for(const child of host.children){delete child.dataset.desktopHidden;if(view!=='captions')continue;
   const style=child.matches('[data-action="add-caption"],.segmented,.preset-grid')||(child.matches('.section-label')&&child.textContent.startsWith('자막 스타일'));
   const list=child.matches('#captionList,.field-grid')||(child.matches('.section-label')&&child.textContent.startsWith('자막 편집'));
   const visible=this.captionTab==='styles'?style:this.captionTab==='list'?list:!style&&!list;
   if(!visible)child.dataset.desktopHidden='true';
  }
  if(view!==this.lastView){this.lastView=view;host.scrollTop=0;}
 }
 refreshInspector(){
  if(!this.active)return;const state=this.hooks.selection(),type=state.type,host=$('inspectorContent'),sections=[...host.children].filter(node=>node.matches('.property-section'));
  const titles=sections.map(sectionTitle);
  // 섹션 밖의 설정 복사·삭제·글꼴 이용 조건도 세부 탭에서 항상 접근할 수 있습니다.
  if(host.querySelector(':scope > .settings-actions,:scope > .delete-action,:scope > .font-license,:scope > .inspector-note'))titles.push('클립 관리');
  const tabs=desktopInspectorTabs(titles,type);
  if(type!==this.selectionType||!tabs.includes(this.inspectorTab)){this.inspectorTab=tabs[0]||'basic';this.selectionType=type;}
  const tabHost=$('desktopInspectorTabs'),signature=type+':'+tabs.join(',')+':'+this.inspectorTab;
  if(tabHost.dataset.signature!==signature){tabHost.dataset.signature=signature;tabHost.innerHTML=tabs.map(key=>`<button type="button" data-desktop-inspector="${key}" aria-pressed="${key===this.inspectorTab}">${groupLabels[key]}</button>`).join('');}tabHost.hidden=tabs.length<2;
  for(const node of host.children){delete node.dataset.desktopHidden;if(!type){node.dataset.desktopHidden='true';continue;}if(!tabs.length)continue;
   if(node.matches('.property-section')){if(desktopInspectorGroup(sectionTitle(node),type)!==this.inspectorTab)node.dataset.desktopHidden='true';}
   else if(node.matches('.settings-actions,.delete-action,.font-license,.inspector-note')&&this.inspectorTab!=='details')node.dataset.desktopHidden='true';
  }
  $('desktopInspectorEmpty').hidden=!!type;host.classList.toggle('desktop-empty',!type);document.body.classList.toggle('desktop-has-selection',!!type);
  const title=$('inspector').querySelector('.section-heading h2');title.textContent=type?'클립 편집':'프로젝트';
 }
 sync(){
  if(!this.active)return;const state=this.hooks.selection(),key=[state.type,state.id,state.count].join(':');
  if(key!==this.selectionKey){const previous=this.selectionKey;this.selectionKey=key;this.refreshInspector();if(state.type&&previous!==undefined&&innerWidth<=1000)this.toggleInspector(true);}
  $('desktopDuration').textContent=$('totalDuration').textContent;
  const busy=!!this.hooks.busy();
  if(this.lastBusy!==busy){this.lastBusy=busy;for(const node of document.querySelectorAll('[data-desktop-group],[data-desktop-tab],[data-desktop-inspector],[data-desktop-action],[data-desktop-command]'))node.disabled=busy;}
 }
}
