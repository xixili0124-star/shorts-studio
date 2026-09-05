// 편집 상태와 명령은 기존 앱을 공유하고 화면 배치와 터치용 진입점만 분리합니다.
const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths={
  media:'M3 5h18v14H3z M3 15l5-5 5 5 3-3 5 5 M16 8h.01',
  captions:'M4 5h16v14H4z M7 9h10 M12 9v7 M9 16h6',
  effects:'m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z',
  voice:'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0z M5 10v2a7 7 0 0 0 14 0v-2 M12 19v3 M8 22h8',
  more:'M5 12h.01 M12 12h.01 M19 12h.01',
  close:'m6 6 12 12 M6 18 18 6',
  select:'M9 3H3v6 M15 3h6v6 M3 15v6h6 M21 15v6h-6 M8 12l3 3 5-6',
  properties:'M4 6h16 M4 12h16 M4 18h16 M8 3v6 M16 9v6 M10 15v6',
  split:'M12 3v18 M3 7h6v10H3z M15 7h6v10h-6z',
  delete:'M4 6h16 M9 6V3h6v3 M6 6l1 15h10l1-15 M10 10v7 M14 10v7',
  save:'M4 3h13l3 3v15H4z M8 3v6h8V3 M8 21v-8h8v8',
  open:'M3 19V5h7l2 3h9v11z M3 11h18',
  undo:'M9 4 4 9l5 5 M4 9h10a6 6 0 0 1 0 12',
  redo:'m15 4 5 5-5 5 M20 9H10a6 6 0 0 0 0 12',
  copy:'M8 8h13v13H8z M16 8V3H3v13h5',
  paste:'M8 5H4v16h16V5h-4 M8 3h8v5H8z M8 13h8 M8 17h6',
  tracks:'M3 5h18v4H3z M3 15h18v4H3z',
  help:'M9 8a3 3 0 1 1 5 2c-2 1-2 2-2 3 M12 17h.01 M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20',
  format:'M4 3h16v18H4z M4 8h16 M4 16h16',
  transition:'M3 5h18v14H3z M9 5l6 7-6 7',
  mosaic:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  sound:'M9 18V5l11-2v13 M9 8l11-2 M9 18a3 3 0 1 1-3-3h3 M20 16a3 3 0 1 1-3-3h3',
};
const icon=name=>`<svg class="mobile-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name]||paths.effects}"/></svg>`;
const button=(id,label,symbol,extra='')=>`<button type="button" id="${id}" aria-label="${label}" ${extra}>${icon(symbol)}<span>${label}</span></button>`;

// 휴대폰 가로 화면도 터치 레이아웃을 유지합니다. 주소 옵션은 화면 검수용이며 저장하지 않습니다.
export function mobileLayout({width,height,coarse=false,override=''}){
  const active=override==='mobile'||(override!=='desktop'&&(width<=760||(coarse&&width<=1100)));
  return {active,landscape:active&&width>height};
}
export const mobileDockView=view=>['media','captions','voice'].includes(view)?view:'effects';

export class MobileStudio{
  constructor(hooks){
    this.hooks=hooks;this.active=false;this.sheet=null;this.menuPage='more';this.inertBefore=new Map();this.panelBefore=new Map();
    this.coarse=matchMedia('(pointer: coarse)');this.override=new URLSearchParams(location.search).get('ui')||'';
    this.mount();
    addEventListener('resize',()=>this.resize());this.coarse.addEventListener('change',()=>this.resize());
    window.visualViewport?.addEventListener('resize',()=>this.viewport());
    document.addEventListener('keydown',event=>{if(this.active&&this.sheet&&event.key==='Escape'&&!document.querySelector('dialog[open]')){event.preventDefault();this.closeSheet();}},true);
    this.resize();
  }
  mount(){
    const context=document.createElement('div');context.id='mobileContextBar';context.className='mobile-only';context.setAttribute('aria-label','선택 클립 편집');
    context.innerHTML=`<span class="mobile-selection-name">클립을 선택하세요</span>${button('mobileSelectMode','여러 선택','select','aria-pressed="false"')}${button('mobileProperties','속성','properties')}${button('mobileSplit','분할','split')}${button('mobileDelete','삭제','delete')}`;
    $('workbench').insertBefore(context,document.querySelector('.timeline-panel'));
    const dock=document.createElement('nav');dock.className='mobile-dock mobile-only';dock.setAttribute('aria-label','모바일 편집 도구');
    dock.innerHTML=[['media','라이브러리'],['captions','자막'],['effects','효과'],['voice','음성'],['more','더보기']].map(([view,label])=>`<button type="button" class="mobile-nav-button" data-mobile-view="${view}" aria-pressed="false">${icon(view)}<span>${label}</span></button>`).join('');$('workbench').append(dock);
    const more=document.createElement('button');more.id='mobileTopMore';more.type='button';more.className='mobile-only';more.setAttribute('aria-label','프로젝트 메뉴');more.innerHTML=icon('more');$('openExport').before(more);
    const backdrop=document.createElement('button');backdrop.id='mobileBackdrop';backdrop.type='button';backdrop.className='mobile-only';backdrop.tabIndex=-1;backdrop.setAttribute('aria-label','열린 패널 닫기');document.body.append(backdrop);
    const menu=document.createElement('section');menu.id='mobileMenu';menu.className='mobile-only mobile-menu-sheet';menu.setAttribute('role','dialog');menu.setAttribute('aria-modal','false');menu.setAttribute('aria-labelledby','mobileMenuTitle');
    menu.innerHTML=`<div class="mobile-sheet-heading"><h2 id="mobileMenuTitle">더보기</h2>${button('mobileCloseMenu','메뉴 닫기','close','class="mobile-sheet-close"')}</div><div id="mobileMenuContent" class="mobile-menu-content"></div>`;document.body.append(menu);
    for(const [id,label] of [['library','라이브러리'],['inspector','속성']]){
      const panel=$(id);this.panelBefore.set(panel,{role:panel.getAttribute('role'),modal:panel.getAttribute('aria-modal')});
      const close=document.createElement('button');close.type='button';close.className='mobile-sheet-close mobile-only';close.setAttribute('aria-label',`${label} 닫기`);close.innerHTML=icon('close');close.onclick=()=>this.closeSheet();panel.querySelector('.section-heading').append(close);
    }
    backdrop.onclick=()=>$('mobileCloseMenu').click();$('mobileCloseMenu').onclick=()=>this.closeSheet();more.onclick=()=>this.openMenu('more');
    dock.addEventListener('click',event=>{const target=event.target.closest('[data-mobile-view]');if(!target)return;const next=target.dataset.mobileView;
      if(this.sheet&&target.getAttribute('aria-pressed')==='true'){this.closeSheet();return;}
      if(['effects','more'].includes(next))this.openMenu(next);else this.hooks.setView(next);
    });
    $('mobileProperties').onclick=()=>this.openSheet('inspector');
    $('mobileSelectMode').onclick=()=>{this.hooks.timeline.cancelMobileGestures?.();this.hooks.timeline.mobileMultiSelect=!this.hooks.timeline.mobileMultiSelect;this.syncSelection();};
    $('mobileSplit').onclick=()=>this.command('splitClip');$('mobileDelete').onclick=()=>this.command('deleteClip');
    menu.addEventListener('click',event=>{
      const item=event.target.closest('[data-mobile-command],[data-mobile-tool],[data-mobile-track],[data-mobile-page]');if(!item)return;
      if(item.dataset.mobileCommand)this.command(item.dataset.mobileCommand);
      else if(item.dataset.mobileTool)this.hooks.setView(item.dataset.mobileTool);
      else if(item.dataset.mobilePage)this.openMenu(item.dataset.mobilePage);
      else{const id=item.dataset.mobileTrack,action=item.dataset.trackAction;if(!this.hooks.busy?.()){this.hooks.trackAction(id,action);this.renderMenu();}}
    });
  }
  viewport(){
    if(!this.active)return;
    const viewport=window.visualViewport,height=viewport&&viewport.scale===1?viewport.height:innerHeight;
    document.body.style.setProperty('--mobile-vh',`${height}px`);
    document.body.style.setProperty('--mobile-keyboard-inset',`${Math.max(0,innerHeight-height-(viewport?.offsetTop||0))}px`);
  }
  resize(){
    // 키보드가 올라와 세로 높이만 줄어든 경우 가로 편집기로 바꾸지 않습니다.
    const typing=/INPUT|TEXTAREA/.test(document.activeElement?.tagName);
    if(this.active&&typing&&this.layoutWidth===innerWidth&&innerHeight<this.layoutHeight-100){this.viewport();return;}
    this.layoutWidth=innerWidth;this.layoutHeight=innerHeight;
    const next=mobileLayout({width:innerWidth,height:innerHeight,coarse:this.coarse.matches,override:this.override});
    const changed=next.active!==this.active,rotated=next.landscape!==document.body.classList.contains('mobile-landscape');
    if(changed||rotated)this.hooks.timeline.cancelMobileGestures?.();
    if(changed){
      this.closeSheet(false);this.active=next.active;this.hooks.timeline.mobileMultiSelect=false;
      document.body.classList.toggle('mobile-ui',this.active);$('workbench').classList.remove('show-library','show-inspector');
      for(const [panel,before] of this.panelBefore){for(const [key,value] of [['role',this.active?'dialog':before.role],['aria-modal',this.active?'false':before.modal]]){if(value===null)panel.removeAttribute(key);else panel.setAttribute(key,value);}}
      if(!this.active){document.body.style.removeProperty('--mobile-vh');document.body.style.removeProperty('--mobile-keyboard-inset');}
    }
    document.body.classList.toggle('mobile-landscape',next.landscape);this.viewport();this.syncSelection();
    if(changed||rotated)requestAnimationFrame(()=>this.hooks.layout?.(this.active));
  }
  onViewChange(){if(this.active)this.openSheet('library');}
  onSelection(type){if(this.active&&this.sheet==='library'&&type&&type!=='asset')this.closeSheet();}
  setBackgroundInert(on){
    if(on){for(const node of [document.querySelector('.viewer'),document.querySelector('.timeline-panel'),$('mobileContextBar')]){if(!this.inertBefore.has(node))this.inertBefore.set(node,node.inert);node.inert=true;}}
    else{for(const [node,value] of this.inertBefore)node.inert=value;this.inertBefore.clear();}
  }
  openSheet(name){
    if(!this.active||this.hooks.busy?.()||document.querySelector('dialog[open]'))return;
    this.hooks.timeline.cancelMobileGestures?.();this.hooks.pause();
    if(!this.sheet)this.returnFocus=document.activeElement;
    this.sheet=name;document.body.dataset.mobileSheet=name;document.body.classList.add('mobile-sheet-open');
    this.setBackgroundInert(true);this.syncSelection();
    const panel=name==='menu'?$('mobileMenu'):$(name);panel?.querySelector('.mobile-sheet-close')?.focus({preventScroll:true});
  }
  closeSheet(restoreFocus=true){
    const hadSheet=!!this.sheet;this.sheet=null;delete document.body.dataset.mobileSheet;document.body.classList.remove('mobile-sheet-open');this.setBackgroundInert(false);
    if(hadSheet&&restoreFocus&&this.returnFocus?.isConnected)this.returnFocus.focus({preventScroll:true});
    this.returnFocus=null;this.syncSelection();
  }
  openMenu(page){if(!this.active)return;this.menuPage=page;this.renderMenu();$('mobileMenuContent').scrollTop=0;this.openSheet('menu');}
  command(id){
    if(this.hooks.busy?.())return;const target=$(id);if(!target||target.disabled)return;
    this.closeSheet(false);target.click();this.syncSelection();
  }
  syncSelection(){
    if(!this.active||!$('mobileContextBar'))return;
    const state=this.hooks.selection?.()||{},busy=!!this.hooks.busy?.();
    $('mobileContextBar').querySelector('.mobile-selection-name').textContent=state.count>1?`${state.count}개 선택`:state.name||'클립을 선택하세요';
    $('mobileProperties').disabled=busy||!state.editable;
    for(const [mobile,desktop] of [['mobileSplit','splitClip'],['mobileDelete','deleteClip']])$(mobile).disabled=busy||$(desktop).disabled;
    const splitLabel=$('splitClip').querySelector('span')?.textContent||'분할';$('mobileSplit').querySelector('span').textContent=splitLabel;$('mobileSplit').setAttribute('aria-label',splitLabel);
    const multiple=!!this.hooks.timeline.mobileMultiSelect;$('mobileSelectMode').setAttribute('aria-pressed',String(multiple));$('mobileSelectMode').disabled=busy;
    const active=this.sheet==='menu'?(this.menuPage==='effects'?'effects':'more'):this.sheet==='library'?mobileDockView(this.hooks.view()):'';
    for(const node of document.querySelectorAll('[data-mobile-view]'))node.setAttribute('aria-pressed',String(node.dataset.mobileView===active));
  }
  renderMenu(){
    const item=(label,symbol,attribute,value,disabled=false)=>`<button type="button" class="mobile-menu-item" ${attribute}="${esc(value)}" ${disabled?'disabled':''}>${icon(symbol)}<span>${label}</span></button>`;
    const cmd=(label,symbol,id)=>item(label,symbol,'data-mobile-command',id,$(id)?.disabled);
    let content='';$('mobileMenuTitle').textContent={more:'더보기',effects:'효과',tracks:'트랙 관리'}[this.menuPage]||'더보기';
    if(this.menuPage==='effects')content=`<div class="mobile-menu-grid">${[['퀵포맷','format','quick-format'],['그래픽','effects','graphics'],['장면 전환','transition','transitions'],['효과음','sound','sounds'],['모자이크','mosaic','mosaic'],['무음 컷','split','silence']].map(([label,symbol,view])=>item(label,symbol,'data-mobile-tool',view)).join('')}</div>`;
    else if(this.menuPage==='tracks'){
      const labels={hidden:'숨김',muted:'음소거',solo:'솔로',locked:'잠금'};
      content=`<div class="mobile-track-list">${this.hooks.tracks().map(track=>`<section class="mobile-track-row"><strong>${esc(track.label)}</strong><div class="mobile-track-actions"><button type="button" data-mobile-track="${esc(track.id)}" data-track-action="select" aria-pressed="${track.active}">추가 대상</button>${(track.kind==='visual'?['hidden','locked']:['muted','solo','locked']).map(key=>`<button type="button" data-mobile-track="${esc(track.id)}" data-track-action="${key}" aria-label="${esc(track.label)} ${labels[key]}" aria-pressed="${track[key]===true}">${labels[key]}</button>`).join('')}<button type="button" data-mobile-track="${esc(track.id)}" data-track-action="add" aria-label="${esc(track.label)} 옆에 트랙 추가">＋ 트랙</button><button type="button" data-mobile-track="${esc(track.id)}" data-track-action="remove" aria-label="${esc(track.label)} 빈 트랙 삭제">빈 트랙 삭제</button></div></section>`).join('')}</div>`;
    }else content=`<section class="mobile-menu-section"><h3>프로젝트</h3><div class="mobile-menu-grid">${cmd('저장','save','saveProject')}${cmd('열기','open','openProject')}${cmd('실행 취소','undo','undo')}${cmd('다시 실행','redo','redo')}</div></section><section class="mobile-menu-section"><h3>선택 클립</h3><div class="mobile-menu-grid">${cmd('복제','copy','duplicateClip')}${cmd('당겨 삭제','delete','rippleDeleteClip')}${cmd('설정 복사','copy','copyClipSettings')}${cmd('설정 붙여넣기','paste','pasteClipSettings')}</div></section><section class="mobile-menu-section"><h3>작업 환경</h3><div class="mobile-menu-grid">${item('트랙 관리','tracks','data-mobile-page','tracks')}${cmd('스냅 '+($('snap').getAttribute('aria-pressed')==='true'?'끄기':'켜기'),'select','snap')}${cmd('반복 재생 '+($('loop').getAttribute('aria-pressed')==='true'?'끄기':'켜기'),'redo','loop')}${cmd('안전영역','format','safeArea')}${cmd('도움말','help','helpButton')}</div><p class="mobile-gesture-hint">타임라인을 쓸어 이동 · 두 손가락으로 확대<br>클립을 길게 눌러 이동 · 여러 선택으로 묶음 편집</p></section>`;
    $('mobileMenuContent').innerHTML=content;
  }
}
