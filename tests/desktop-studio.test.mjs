import test from 'node:test';
import assert from 'node:assert/strict';
import {DesktopStudio,desktopGroupForView,desktopInspectorGroup,desktopInspectorTabs} from '../public/js/desktop-studio.js';
import {DesktopPreviewLayout,DesktopInspectorLayout,DESKTOP_PREVIEW_STORAGE_KEY,DESKTOP_INSPECTOR_STORAGE_KEY,desktopPreviewMetrics,desktopPreviewWidth,readDesktopPreviewSettings,desktopInspectorMetrics,desktopInspectorWidth,readDesktopInspectorSettings} from '../public/js/desktop-layout.js';

test('기존 라이브러리 화면은 새 탐색 묶음으로 모두 연결되고 모르는 화면은 파일로 복귀한다',()=>{
  const destinations={files:['media'],captions:['captions'],sound:['sounds','voice','silence'],design:['quick-format','graphics','transitions'],tools:['mosaic','crop-tracking']};
  const routes=Object.entries(destinations).flatMap(([group,views])=>views.map(view=>({view,group})));
  assert.equal(new Set(routes.map(route=>route.view)).size,10);
  for(const {view,group} of routes)assert.equal(desktopGroupForView(view),group,view);
  for(const unknown of [undefined,null,'','future-tool'])assert.equal(desktopGroupForView(unknown),'files');
});

test('영상·자막·오디오의 속성은 표시되는 탭 하나에만 속해 누락되거나 중복되지 않는다',()=>{
  const selections={
    clip:['변형','원본 맞춤','화면 자르기','키프레임','이미지 모션','원본 오디오','클립 페이드','다음 장면과 전환','트랙','타임라인 위치','클립 구간','자동 편집'],
    caption:['내용','글자 스타일','변형','배치','테두리','텍스트 박스','그림자','키프레임','효과'],
    audio:['오디오','키프레임','트랙','트랙 위치','자동 편집'],
    batch:['화면 설정 대상','변형','글자 스타일','테두리','원본 맞춤','오디오','클립 페이드'],
  };
  for(const [type,titles] of Object.entries(selections)){
    const tabs=desktopInspectorTabs(titles,type);
    const partition=tabs.flatMap(group=>titles.filter(title=>desktopInspectorGroup(title,type)===group));
    assert.deepEqual([...partition].sort(),[...titles].sort(),type+'의 모든 섹션을 한 번씩 표시해야 합니다');
    for(const tab of tabs)assert.ok(titles.some(title=>desktopInspectorGroup(title,type)===tab),type+'에 빈 탭을 만들면 안 됩니다');
  }
});

test('기본 텍스트 편집과 꾸미기·움직임을 구분하고 새로운 속성도 세부 탭에서 찾을 수 있다',()=>{
  assert.equal(desktopInspectorGroup('글자 스타일','caption'),'basic');
  assert.equal(desktopInspectorGroup('텍스트 박스','caption'),'style');
  assert.equal(desktopInspectorGroup('효과','caption'),'motion');
  assert.equal(desktopInspectorGroup('화면 자르기','clip'),'details');
  const future='새로운 색상 보정';
  assert.equal(desktopInspectorGroup(future,'clip'),'details');
  assert.deepEqual(desktopInspectorTabs([future],'clip'),['details']);
});

test('속성 재렌더 순서와 중복 섹션이 달라져도 탭 순서는 고정되고 입력을 바꾸지 않는다',()=>{
  const titles=Object.freeze(['트랙','키프레임','텍스트 박스','내용','키프레임','그림자']);
  const expected=['basic','style','motion','details'];
  assert.deepEqual(desktopInspectorTabs(titles,'caption'),expected);
  assert.deepEqual(desktopInspectorTabs([...titles].reverse(),'caption'),expected);
  assert.deepEqual(desktopInspectorTabs(['오디오','키프레임','트랙 위치'],'audio'),['basic','motion','details']);
  assert.deepEqual(desktopInspectorTabs([],'clip'),[]);
});

test('파일·공백·전환의 전용 속성 화면에는 클립용 탭을 덧씌우지 않는다',()=>{
  for(const [type,title] of [['asset','파일 정보'],['gap','잔물결 삭제'],['transition','장면 전환']]){
    assert.deepEqual(desktopInspectorTabs([title],type),[],type);
  }
});

test('미리보기 기본 폭은 세로 화면 높이를 반영하면서 작업 공간 500px을 남긴다',()=>{
  const short=desktopPreviewMetrics(1280,700),tall=desktopPreviewMetrics(1280,1000);
  assert.ok(tall.defaultWidth>short.defaultWidth);
  for(const [width,height] of [[768,700],[900,720],[1280,800],[1920,1080],[2560,1440]]){
    const metrics=desktopPreviewMetrics(width,height);
    assert.ok(metrics.min<=metrics.defaultWidth&&metrics.defaultWidth<=metrics.max);
    assert.ok(width-metrics.max>=500,'기본 PC 폭에서 작업 공간의 최소 폭을 보장해야 합니다.');
    assert.ok(metrics.max<=480);assert.equal(metrics.compact,200);
    assert.equal(desktopPreviewWidth(width,height,{width:9999}),metrics.max);
    assert.equal(desktopPreviewWidth(width,height,{width:-1}),metrics.min);
  }
  assert.equal(desktopPreviewWidth(900,720,{compact:true,width:450}),200);
});

test('잘못된 화면 크기와 저장값을 안전하게 복구하고 작은 화면의 보정을 저장폭에 덮어쓰지 않는다',()=>{
  for(const invalid of [null,'',undefined,'broken','[]','{"version":2,"width":420}','{"version":1,"width":"300"}','{"version":1,"width":9999}']){
    assert.deepEqual(readDesktopPreviewSettings(invalid),{width:null,compact:false});
  }
  const preferences=readDesktopPreviewSettings('{"version":1,"width":440,"compact":true}');
  assert.deepEqual(preferences,{width:440,compact:true});
  assert.equal(desktopPreviewWidth(1280,800,preferences),200);
  preferences.compact=false;
  assert.equal(desktopPreviewWidth(768,700,preferences),268);
  assert.equal(desktopPreviewWidth(1920,1080,preferences),440);
  assert.equal(preferences.width,440);
  assert.deepEqual(desktopPreviewMetrics(NaN,0),desktopPreviewMetrics(1280,800));
});

test('속성 너비는 미리보기를 제외한 영역만 나누며 라이브러리 최소 폭을 남긴다',()=>{
  assert.deepEqual(desktopInspectorMetrics(500),{min:240,max:260,defaultWidth:240});
  assert.deepEqual(desktopInspectorMetrics(650),{min:240,max:410,defaultWidth:299});
  assert.deepEqual(desktopInspectorMetrics(900),{min:240,max:480,defaultWidth:300});
  for(const left of [500,650,800,1200])assert.ok(left-desktopInspectorMetrics(left).max>=240);
  assert.equal(desktopInspectorWidth(650,{width:480}),410);
  assert.equal(desktopInspectorWidth(900,{width:480}),480);
  assert.equal(desktopInspectorWidth(900,{width:-20}),240);
  for(const raw of [null,'bad','[]','{"version":2,"width":300}','{"version":1,"width":200}','{"version":1,"width":"300"}'])assert.deepEqual(readDesktopInspectorSettings(raw),{width:null});
  assert.deepEqual(readDesktopInspectorSettings('{"version":1,"width":450}'),{width:450});
});

// 브라우저의 배치 자체가 아니라 포인터·키보드·저장·모바일 격리 계약을 검사하는 작은 DOM 대역입니다.
function layoutEnvironment(){
  const saved=new Map(),frames=new Map();let frameId=0;
  const original=new Map(['window','document','innerWidth','innerHeight','localStorage','requestAnimationFrame','cancelAnimationFrame'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  class Element extends EventTarget{
    constructor(){super();this.attributes=new Map();this.properties=new Map();this.tokens=new Set();this.textContent='';this.disabled=false;
      this.classList={contains:key=>this.tokens.has(key),add:(...keys)=>keys.forEach(key=>this.tokens.add(key)),remove:(...keys)=>keys.forEach(key=>this.tokens.delete(key)),toggle:(key,on)=>{on=on??!this.tokens.has(key);if(on)this.tokens.add(key);else this.tokens.delete(key);return on;}};
      this.style={setProperty:(key,value)=>this.properties.set(key,value),removeProperty:key=>this.properties.delete(key),getPropertyValue:key=>this.properties.get(key)||''};
    }
    setAttribute(key,value){this.attributes.set(key,String(value));}getAttribute(key){return this.attributes.get(key)??null;}
    removeAttribute(key){this.attributes.delete(key);}focus(){}setPointerCapture(id){this.pointer=id;}hasPointerCapture(id){return this.pointer===id;}releasePointerCapture(){this.pointer=null;}
    querySelector(){return this.label??=new Element();}
  }
  const body=new Element(),workbench=new Element(),separator=new Element(),compactButton=new Element(),toggle=new Element(),duration=new Element(),total=new Element();
  const elements={toggleInspector:toggle,desktopDuration:duration,totalDuration:total,desktopPreviewResizer:separator};
  let size={width:1280,height:800};workbench.getBoundingClientRect=()=>({...size});
  const window=new EventTarget();Object.assign(globalThis,{window,document:{body,getElementById:id=>elements[id],querySelectorAll:()=>[]},innerWidth:1280,innerHeight:800,localStorage:{getItem:key=>saved.get(key)??null,setItem:(key,value)=>saved.set(key,String(value))},requestAnimationFrame:callback=>{frames.set(++frameId,callback);return frameId;},cancelAnimationFrame:id=>frames.delete(id)});
  return {body,workbench,separator,compactButton,toggle,saved,window,resize:value=>{size={...size,...value};window.dispatchEvent(new Event('resize'));},flush:()=>{const pending=[...frames.values()];frames.clear();for(const callback of pending)callback();},restore:()=>{for(const [key,descriptor] of original){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}}};
}
function dispatch(target,type,values={}){const event=new Event(type,{cancelable:true});Object.assign(event,values);target.dispatchEvent(event);return event;}

test('가로 경계의 키보드와 축소 버튼은 원래 폭을 복원하고 접근성 값을 함께 갱신한다',()=>{
  const env=layoutEnvironment();let calls=0,busy=false;
  try{
    const layout=new DesktopPreviewLayout({...env,layout:()=>calls++,busy:()=>busy});layout.setActive(true);env.flush();
    const initial=layout.currentWidth();dispatch(env.separator,'keydown',{key:'ArrowLeft'});assert.equal(layout.currentWidth(),initial+12);
    assert.equal(env.separator.getAttribute('aria-valuenow'),String(initial+12));
    const storedWidth=JSON.parse(env.saved.get(DESKTOP_PREVIEW_STORAGE_KEY)).width;
    dispatch(env.compactButton,'click');assert.equal(layout.currentWidth(),200);assert.equal(env.compactButton.getAttribute('aria-pressed'),'true');
    dispatch(env.compactButton,'click');assert.equal(layout.currentWidth(),storedWidth);assert.equal(env.compactButton.getAttribute('aria-pressed'),'false');
    dispatch(env.separator,'keydown',{key:'End'});assert.equal(layout.currentWidth(),480);
    dispatch(env.separator,'keydown',{key:'ArrowRight',shiftKey:true});assert.equal(layout.currentWidth(),432);
    dispatch(env.separator,'keydown',{key:'Home'});assert.equal(layout.currentWidth(),initial);assert.equal(layout.preferences.width,null);
    busy=true;dispatch(env.compactButton,'click');dispatch(env.separator,'keydown',{key:'End'});assert.equal(layout.currentWidth(),initial);
    assert.equal(calls,1,'입력 처리 중 타임라인 노드를 동기로 다시 그리면 안 됩니다.');env.flush();assert.equal(calls,2);
  }finally{env.restore();}
});

test('가로 드래그는 포인터를 구분하고 완료 시 저장하며 취소와 모바일 전환에는 되돌린다',()=>{
  const env=layoutEnvironment();let calls=0;
  try{
    const layout=new DesktopPreviewLayout({...env,layout:()=>calls++,busy:()=>false});layout.setActive(true);env.flush();
    const initial=layout.currentWidth();dispatch(env.separator,'pointerdown',{button:0,pointerId:1,clientX:900});
    dispatch(env.window,'pointermove',{pointerId:2,clientX:830});assert.equal(layout.currentWidth(),initial);
    dispatch(env.window,'pointermove',{pointerId:1,clientX:870});assert.equal(layout.currentWidth(),initial+30);assert.equal(env.saved.size,0);
    dispatch(env.window,'pointerup',{pointerId:2});assert.ok(layout.drag);
    dispatch(env.window,'pointerup',{pointerId:1});assert.equal(layout.drag,null);assert.equal(JSON.parse(env.saved.get(DESKTOP_PREVIEW_STORAGE_KEY)).width,initial+30);
    dispatch(env.separator,'pointerdown',{button:0,pointerId:3,clientX:800});dispatch(env.window,'pointermove',{pointerId:3,clientX:950});
    dispatch(env.window,'pointercancel',{pointerId:3});assert.equal(layout.currentWidth(),initial+30);
    const saved=env.saved.get(DESKTOP_PREVIEW_STORAGE_KEY);dispatch(env.separator,'pointerdown',{button:0,pointerId:4,clientX:800});dispatch(env.window,'pointermove',{pointerId:4,clientX:700});
    env.body.classList.add('mobile-ui');layout.setActive(false);assert.equal(layout.drag,null);assert.equal(env.workbench.style.getPropertyValue('--desktop-preview-width'),'');
    env.flush();const beforeCalls=calls;dispatch(env.separator,'keydown',{key:'End'});dispatch(env.compactButton,'click');env.resize({width:390,height:844});env.flush();
    assert.equal(calls,beforeCalls);assert.equal(env.saved.get(DESKTOP_PREVIEW_STORAGE_KEY),saved);assert.equal(env.body.classList.contains('desktop-preview-resizing'),false);
    env.body.classList.remove('mobile-ui');env.resize({width:1280,height:800});layout.setActive(true);assert.equal(layout.currentWidth(),initial+30);
  }finally{env.restore();}
});

test('속성 패널은 선택할 때 열리고 수동 닫기를 유지하다 같은 클립 재선택 시 다시 열린다',()=>{
  const env=layoutEnvironment();let state={type:null,id:null,count:0},calls=0;
  try{
    const studio=Object.assign(Object.create(DesktopStudio.prototype),{active:true,inspectorOpen:false,inspectorFrame:null,hooks:{selection:()=>state,layout:()=>calls++,busy:()=>false},refreshInspector(){}});
    studio.sync();assert.equal(studio.inspectorOpen,false);assert.equal(env.toggle.disabled,true);
    state={type:'caption',id:'a',count:1};studio.onSelection();assert.equal(studio.inspectorOpen,true);assert.equal(calls,0);assert.equal(env.toggle.getAttribute('aria-pressed'),'true');env.flush();assert.equal(calls,1);
    studio.toggleInspector(false);studio.sync();assert.equal(studio.inspectorOpen,false);assert.equal(env.body.classList.contains('desktop-inspector-hidden'),true);
    studio.onSelection();assert.equal(studio.inspectorOpen,true);assert.equal(env.body.classList.contains('desktop-inspector-hidden'),false);
    studio.toggleInspector(false);state={type:'caption',id:'b',count:1};studio.sync();assert.equal(studio.inspectorOpen,true);
    state={type:null,id:null,count:0};studio.sync();studio.toggleInspector(true);assert.equal(studio.inspectorOpen,false);assert.equal(env.toggle.getAttribute('aria-expanded'),'false');assert.equal(env.toggle.disabled,true);
    studio.active=false;state={type:'clip',id:'c',count:1};studio.onSelection();env.flush();assert.equal(studio.inspectorOpen,false);assert.equal(calls,1,'모바일에서는 대기 중인 PC 배치 콜백을 실행하면 안 됩니다.');
  }finally{env.restore();}
});

test('속성 경계는 독립 저장하며 미리보기와 화면 폭 변화에는 표시 폭만 보정한다',()=>{
  const env=layoutEnvironment();let inspector,available=true,busy=false;
  try{
    const separator=new env.separator.constructor();
    const preview=new DesktopPreviewLayout({...env,layout:()=>{},busy:()=>busy||!!inspector?.drag,onWidthChange:()=>inspector?.refresh()});
    inspector=new DesktopInspectorLayout({...env,separator,available:()=>available,busy:()=>busy||!!preview.drag,previewWidth:()=>preview.currentWidth(),layout:()=>{}});
    preview.setActive(true);inspector.setActive(true);
    assert.equal(inspector.currentWidth(),300);const previewCss=env.workbench.style.getPropertyValue('--desktop-preview-width');
    dispatch(separator,'keydown',{key:'ArrowLeft'});assert.equal(inspector.currentWidth(),312);
    assert.equal(env.workbench.style.getPropertyValue('--desktop-preview-width'),previewCss);
    assert.equal(separator.getAttribute('aria-valuenow'),'312');assert.equal(env.saved.has(DESKTOP_PREVIEW_STORAGE_KEY),false);
    assert.equal(JSON.parse(env.saved.get(DESKTOP_INSPECTOR_STORAGE_KEY)).width,312);
    dispatch(separator,'keydown',{key:'End'});assert.equal(inspector.currentWidth(),480);
    const saved=env.saved.get(DESKTOP_INSPECTOR_STORAGE_KEY);
    env.resize({width:1000});assert.equal(inspector.currentWidth(),420);assert.equal(env.workbench.style.getPropertyValue('--desktop-inspector-width'),'420px');assert.equal(env.saved.get(DESKTOP_INSPECTOR_STORAGE_KEY),saved);
    dispatch(env.separator,'keydown',{key:'End'});assert.equal(preview.currentWidth(),480);assert.equal(inspector.currentWidth(),280);assert.equal(env.workbench.style.getPropertyValue('--desktop-inspector-width'),'280px');
    env.resize({width:1280});assert.equal(inspector.currentWidth(),480);assert.equal(env.saved.get(DESKTOP_INSPECTOR_STORAGE_KEY),saved);
    busy=true;dispatch(separator,'keydown',{key:'ArrowRight'});assert.equal(inspector.currentWidth(),480);busy=false;
    dispatch(separator,'keydown',{key:'Home'});assert.equal(inspector.preferences.width,null);assert.equal(inspector.currentWidth(),300);
  }finally{env.restore();}
});

test('속성 드래그는 닫힌 패널에서 동작하지 않고 취소·모바일 전환 때 원래 선호 폭을 보존한다',()=>{
  const env=layoutEnvironment();let available=false,calls=0;
  try{
    const inspector=new DesktopInspectorLayout({...env,available:()=>available,previewWidth:()=>400,busy:()=>false,layout:()=>calls++});
    inspector.setActive(true);assert.equal(env.separator.tabIndex,-1);assert.equal(env.separator.getAttribute('aria-disabled'),'true');
    dispatch(env.separator,'pointerdown',{button:0,pointerId:10,clientX:500});assert.equal(inspector.drag,null);
    available=true;inspector.refresh();assert.equal(env.separator.tabIndex,0);
    dispatch(env.separator,'pointerdown',{button:0,pointerId:10,clientX:500});dispatch(env.window,'pointermove',{pointerId:10,clientX:464});
    assert.equal(inspector.currentWidth(),336);assert.equal(calls,0);assert.equal(env.body.classList.contains('desktop-inspector-resizing'),true);
    assert.equal(env.body.classList.contains('desktop-preview-resizing'),false);assert.equal(env.saved.size,0);
    dispatch(env.window,'pointerup',{pointerId:10});const saved=env.saved.get(DESKTOP_INSPECTOR_STORAGE_KEY);assert.equal(JSON.parse(saved).width,336);
    dispatch(env.separator,'pointerdown',{button:0,pointerId:11,clientX:500});dispatch(env.window,'pointermove',{pointerId:11,clientX:476});assert.equal(inspector.currentWidth(),360);
    dispatch(env.window,'pointercancel',{pointerId:11});assert.equal(inspector.currentWidth(),336);assert.equal(env.saved.get(DESKTOP_INSPECTOR_STORAGE_KEY),saved);
    dispatch(env.separator,'pointerdown',{button:0,pointerId:12,clientX:500});dispatch(env.window,'pointermove',{pointerId:12,clientX:450});available=false;inspector.refresh();
    assert.equal(inspector.drag,null);assert.equal(inspector.preferences.width,336);assert.equal(env.separator.tabIndex,-1);
    available=true;inspector.refresh();assert.equal(env.workbench.style.getPropertyValue('--desktop-inspector-width'),'336px');
    env.body.classList.add('mobile-ui');inspector.setActive(false);env.flush();assert.equal(env.workbench.style.getPropertyValue('--desktop-inspector-width'),'');assert.equal(env.body.classList.contains('desktop-inspector-resizing'),false);
    dispatch(env.separator,'keydown',{key:'End'});env.resize({width:390});assert.equal(env.saved.get(DESKTOP_INSPECTOR_STORAGE_KEY),saved);assert.equal(calls,0);
    env.body.classList.remove('mobile-ui');env.resize({width:1280});inspector.setActive(true);assert.equal(inspector.currentWidth(),336);env.flush();assert.equal(calls,1);
  }finally{env.restore();}
});
