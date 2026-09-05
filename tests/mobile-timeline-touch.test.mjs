import test from 'node:test';
import assert from 'node:assert/strict';
import {MobileTimelineGestures} from '../public/js/mobile-timeline-gestures.js';
import {Timeline} from '../public/js/timeline.js';
import {project} from '../public/js/state.js';

class Events {
  constructor(){this.listeners=new Map();}
  addEventListener(name,listener){if(!this.listeners.has(name))this.listeners.set(name,new Set());this.listeners.get(name).add(listener);}
  removeEventListener(name,listener){this.listeners.get(name)?.delete(listener);}
  emit(name,event={}){for(const listener of [...(this.listeners.get(name)||[])])listener(event);}
  get count(){return [...this.listeners.values()].reduce((sum,entries)=>sum+entries.size,0);}
}
const classes=()=>{const values=new Set();return {contains:name=>values.has(name),toggle(name,on){if(on)values.add(name);else values.delete(name);},add:name=>values.add(name),remove:name=>values.delete(name)};};
function fixture(){
  const window=new Events(),document=new Events(),captured=new Set(),timers=new Map(),calls={tap:[],menu:[],drag:[],move:[],cancel:0,zoom:[]};let clock=0,nextTimer=0;
  document.body={classList:classes()};document.body.classList.add('mobile-ui');
  const canvas={isConnected:true,classList:classes(),setPointerCapture:id=>captured.add(id),hasPointerCapture:id=>captured.has(id),releasePointerCapture:id=>captured.delete(id)};
  const owner={canvas,zoom:100,dragging:false,scroll:{scrollLeft:100,scrollTop:80,getBoundingClientRect:()=>({left:10,width:400})},callbacks:{busy:()=>false},closeMenu(){},
    mobileTouchEvent:event=>event,mobileTap:event=>calls.tap.push(event),openMenu:event=>calls.menu.push(event),
    pointerDown(event,bypass){assert.equal(bypass,true);calls.drag.push(event);this.dragging=true;this.movePointerDrag=value=>calls.move.push(value);this.cancelPointerDrag=()=>{calls.cancel++;this.dragging=false;this.cancelPointerDrag=null;this.movePointerDrag=null;};},
    setZoom(value,anchor){this.zoom=Math.max(3,Math.min(720,value));calls.zoom.push({value:this.zoom,anchor});},
  };
  const gestures=new MobileTimelineGestures(owner,{window,document,now:()=>clock,setTimeout(fn,delay){const id=++nextTimer;timers.set(id,{fn,at:clock+delay});return id;},clearTimeout:id=>timers.delete(id)});
  const advance=ms=>{clock+=ms;for(const [id,timer] of [...timers])if(timer.at<=clock){timers.delete(id);timer.fn();}};
  return{owner,gestures,window,document,captured,timers,calls,advance};
}
function target(kind='clip'){
  const hit={dataset:{type:'caption',id:'caption'},isConnected:true};
  hit.closest=selector=>{
    if(selector==='.timeline-block')return kind==='clip'||kind==='trim'?hit:null;
    if(selector==='[data-edge]')return kind==='trim'?hit:null;
    return null;
  };return hit;
}
function pointer(id,x,y=100,hit=target(),type='touch'){
  return{pointerId:id,pointerType:type,clientX:x,clientY:y,target:hit,button:0,isPrimary:id===1,detail:1,prevented:false,stopped:false,
    preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;}};
}

test('touch gate leaves desktop and mouse handling alone',()=>{
  const f=fixture(),mouse=pointer(1,100,100,target(),'mouse');
  assert.equal(f.gestures.pointerDown(mouse),false);assert.equal(mouse.prevented,false);assert.equal(f.window.count,0);
  f.document.body.classList.remove('mobile-ui');const touch=pointer(1,100);
  assert.equal(f.gestures.pointerDown(touch),false);assert.equal(touch.prevented,false);assert.equal(f.timers.size,0);
});

test('default browser timers retain the host receiver when stored on the gesture object',t=>{
  const f=fixture();let scheduled=0,cleared=0;
  t.mock.method(globalThis,'setTimeout',function(callback,delay){assert.equal(this,globalThis);assert.equal(typeof callback,'function');assert.equal(delay,300);scheduled++;return 43;});
  t.mock.method(globalThis,'clearTimeout',function(id){assert.equal(this,globalThis);assert.equal(id,43);cleared++;});
  const gestures=new MobileTimelineGestures(f.owner,{window:f.window,document:f.document});
  gestures.pointerDown(pointer(1,100));gestures.pointerUp(pointer(1,100));
  assert.equal(scheduled,1);assert.equal(cleared,1);assert.equal(f.calls.tap.length,1);
});

test('a clip tap selects once and suppresses only the following physical touch click',()=>{
  const f=fixture(),hit=target();f.gestures.pointerDown(pointer(1,100,100,hit));f.advance(80);f.window.emit('pointerup',pointer(1,103,102,hit));
  assert.equal(f.calls.tap.length,1);assert.equal(f.calls.menu.length,0);assert.equal(f.calls.drag.length,0);
  assert.equal(f.gestures.consumeClick(pointer(1,103)),true);assert.equal(f.gestures.consumeClick({...pointer(1,103),detail:0}),false);
  assert.equal(f.gestures.consumeClick(pointer(1,103,102,hit,'mouse')),false);
  assert.equal(f.window.count+f.document.count,0);assert.equal(f.captured.size,0);assert.equal(f.timers.size,0);
});

test('swiping a clip or empty area pans both axes without moving or selecting clips',()=>{
  for(const kind of ['clip','empty']){
    const f=fixture(),hit=target(kind);f.gestures.pointerDown(pointer(1,150,150,hit));f.window.emit('pointermove',pointer(1,110,120,hit));f.advance(500);
    assert.equal(f.owner.scroll.scrollLeft,140);assert.equal(f.owner.scroll.scrollTop,110);assert.equal(f.gestures.mode,'pan');
    f.window.emit('pointerup',pointer(1,110,120,hit));assert.equal(f.calls.tap.length+f.calls.menu.length+f.calls.drag.length,0);assert.equal(f.window.count,0);
  }
});

test('holding stationary opens the menu once while holding then moving enters the existing drag once',()=>{
  const f=fixture(),hit=target();f.gestures.pointerDown(pointer(1,100,100,hit));f.advance(301);assert.equal(f.gestures.mode,'held');
  f.window.emit('pointerup',pointer(1,101,100,hit));assert.equal(f.calls.menu.length,1);assert.equal(f.calls.tap.length+f.calls.drag.length,0);
  f.gestures.pointerDown(pointer(1,100,100,hit));f.advance(301);const move=pointer(1,125,100,hit);f.window.emit('pointermove',move);
  assert.equal(f.calls.drag.length,1);assert.equal(f.calls.move.length,1);assert.equal(move.stopped,true);assert.equal(f.gestures.mode,'edit');
  const up=pointer(1,125,100,hit);f.window.emit('pointerup',up);
  assert.equal(up.stopped,false,'기존 클립 pointerup까지 전파해 한 번만 확정합니다');assert.equal(f.calls.cancel,0);assert.equal(f.calls.menu.length,1);assert.equal(f.calls.tap.length,0);
});

test('trim handles enter the existing editor immediately and a second finger cancels the edit before pinch',()=>{
  const f=fixture(),hit=target('trim');f.gestures.pointerDown(pointer(1,100,100,hit));
  assert.equal(f.calls.drag.length,1);assert.equal(f.timers.size,0);
  f.gestures.pointerDown(pointer(2,200,100));assert.equal(f.calls.cancel,1);assert.equal(f.owner.dragging,false);assert.equal(f.gestures.mode,'pinch');
  f.window.emit('pointercancel',pointer(2,200));assert.equal(f.gestures.points.size,0);assert.equal(f.window.count+f.document.count,0);assert.equal(f.captured.size,0);
});

test('pinch keeps the original midpoint time anchored while its center moves and does not leave a tap behind',()=>{
  const f=fixture();f.gestures.pointerDown(pointer(1,100));f.gestures.pointerDown(pointer(2,200));
  const anchor=(100+150-10)/100;
  f.window.emit('pointermove',pointer(2,300));assert.equal(f.owner.zoom,200);assert.equal(f.owner.scroll.scrollLeft,290);
  f.window.emit('pointermove',pointer(1,120));assert.equal(f.owner.zoom,180);
  assert.ok(Math.abs((f.owner.scroll.scrollLeft+210-10)/f.owner.zoom-anchor)<1e-9);
  f.window.emit('pointerup',pointer(1,120));const left=f.owner.scroll.scrollLeft;f.window.emit('pointermove',pointer(2,280));assert.equal(f.owner.scroll.scrollLeft,left+20);
  f.window.emit('pointerup',pointer(2,280));assert.equal(f.calls.tap.length+f.calls.menu.length+f.calls.drag.length,0);assert.equal(f.timers.size,0);
});

test('cancellation, hidden pages, mode changes and disposal remove pending timers and listeners',()=>{
  for(const stop of [f=>f.window.emit('pointercancel',pointer(1,100)),f=>f.window.emit('blur'),f=>{f.document.hidden=true;f.document.emit('visibilitychange');},f=>{f.document.body.classList.remove('mobile-ui');f.window.emit('pointermove',pointer(1,110));},f=>{f.owner.canvas.isConnected=false;f.advance(301);},f=>f.gestures.destroy()]){
    const f=fixture();f.gestures.pointerDown(pointer(1,100));stop(f);f.advance(500);
    assert.equal(f.timers.size,0);assert.equal(f.window.count+f.document.count,0);assert.equal(f.captured.size,0);assert.equal(f.gestures.points.size,0);assert.equal(f.calls.menu.length+f.calls.drag.length,0);
  }
});

test('mobile multi-select taps toggle a clip without starting a desktop drag',()=>{
  const saved={document:globalThis.document,captions:project.captions};project.captions=[{id:'caption',start:0,end:2,trackId:'v3',text:'자막'}];globalThis.document={activeElement:null};
  const hit={dataset:{type:'caption',id:'caption'},closest:selector=>selector==='.timeline-block,.timeline-gap,.transition-chip'?hit:null};
  const selections=[],owner=Object.assign(Object.create(Timeline.prototype),{mobileMultiSelect:true,selections:[],explicit:[],dragging:false,
    callbacks:{busy:()=>false,pause(){},selectMany:refs=>selections.push(refs)},mobileTouchEvent:event=>event,refuseLocked:()=>false,
    selectMany(refs,primary){this.selections=refs;this.explicit=refs;this.selection=primary;}});
  try{
    owner.mobileTap(pointer(1,100,100,hit));assert.deepEqual(selections[0],[{type:'caption',id:'caption'}]);
    owner.mobileTap(pointer(1,100,100,hit));assert.deepEqual(selections[1],[]);assert.equal(owner.dragging,false);
  }finally{globalThis.document=saved.document;project.captions=saved.captions;}
});

function trackViewFixture(run){
  const savedDocument=globalThis.document,saved=Object.fromEntries(['clips','captions','overlays','audio','timelineTracks'].map(key=>[key,project[key]]));
  const registry=[{id:'v1',kind:'visual',role:'video',hidden:true},{id:'v4',kind:'visual',role:'video'},{id:'v2',kind:'visual',role:'graphic'},{id:'a1',kind:'audio',role:'audio',muted:true}];
  Object.assign(project,{clips:[],captions:[],overlays:[],audio:{...project.audio,tracks:[]},timelineTracks:registry});
  const body={classList:classes()};body.classList.add('mobile-ui');
  const nodes=new Map(),panel={dataset:{}},rows=[],heads=[];
  const row=id=>({dataset:{track:id},querySelector:()=>null});
  const head=id=>({dataset:{},querySelector:()=>({dataset:{trackSelect:id}})});
  const host=id=>{if(!nodes.has(id))nodes.set(id,{dataset:{},style:{},querySelectorAll:()=>[]});return nodes.get(id);};
  Object.defineProperty(host('timelineRows'),'innerHTML',{set(value){rows.splice(0,rows.length,...[...value.matchAll(/class="track [^"]*" data-track="([^"]+)"/g)].map(match=>row(match[1])));}});
  Object.defineProperty(host('trackHeaders'),'innerHTML',{set(value){heads.splice(0,heads.length,...[...value.matchAll(/data-track-select="([^"]+)"/g)].map(match=>head(match[1])));}});
  host('trackHeaders').querySelectorAll=selector=>selector==='.track-head'?heads:[];
  globalThis.document={body,getElementById:host,activeElement:null};
  const effects={cancel:0,preview:0,scroll:0},canvas={style:{},closest:()=>panel,querySelectorAll:selector=>selector==='.track'?rows:[]};
  const owner=Object.assign(Object.create(Timeline.prototype),{canvas,scroll:{clientWidth:600,scrollTop:40,scrollLeft:120},zoom:80,time:0,dragging:false,
    activeTrackId:'v1',activeRoleTracks:{video:'v4'},activeHeaderId:'v1',selections:[],explicit:[],callbacks:{},
    closeMenu(){},cancelMobileGestures(){effects.cancel++;},clearPreview(){effects.preview++;},stopScroll(){effects.scroll++;}});
  try{owner.render();return run({owner,body,panel,rows,heads,effects,registry});}
  finally{globalThis.document=savedDocument;Object.assign(project,saved);}
}

test('모바일은 일반 선택 안내를 토스트로 옮기지 않고 편집 거절 경고만 보존한다',()=>{
  const saved=globalThis.document,body={classList:classes()},host={textContent:'',dataset:{}},errors=[];
  globalThis.document={body,getElementById:()=>host};
  const owner=Object.assign(Object.create(Timeline.prototype),{callbacks:{error:message=>errors.push(message)}});
  try{
    owner.notice('PC 선택 안내');assert.equal(host.textContent,'PC 선택 안내');
    owner.notice('PC 트랙 잠김','warn');assert.deepEqual(errors,[]);
    body.classList.add('mobile-ui');
    owner.notice('클립 선택');assert.deepEqual(errors,[]);
    owner.notice('잠긴 트랙은 편집할 수 없습니다.','warn');assert.deepEqual(errors,['잠긴 트랙은 편집할 수 없습니다.']);
    assert.equal(host.dataset.tone,'warn');
  }finally{globalThis.document=saved;}
});

test('mobile focus filters matching rows and heads without changing document visibility or rendering again',()=>trackViewFixture(({owner,rows,heads,panel,effects})=>{
  const before=JSON.stringify(project),originalRows=rows.slice();
  assert.deepEqual(owner.setMobileTrackView({all:false}),{all:false,trackId:'v4'});
  assert.equal(panel.dataset.mobileTrackView,'focus');
  assert.deepEqual(rows.filter(node=>node.dataset.mobileVisible==='true').map(node=>node.dataset.track),['v4']);
  assert.equal(heads.filter(node=>node.dataset.mobileVisible==='true').length,1);
  assert.equal(heads.find(node=>node.dataset.mobileVisible==='true').querySelector().dataset.trackSelect,'v4');
  assert.deepEqual(rows,originalRows,'행 DOM을 다시 만들지 않습니다');assert.equal(owner.scroll.scrollLeft,120);assert.equal(owner.scroll.scrollTop,0);
  owner.setMobileTrackView({all:false,trackId:'v4'});assert.equal(effects.cancel,1,'같은 트랙 동기화가 진행 중 제스처를 취소하지 않습니다');
  owner.setMobileTrackView({all:true,trackId:'v4'});assert.ok([...rows,...heads].every(node=>node.dataset.mobileVisible==='true'));
  owner.scroll.scrollTop=26;owner.setMobileTrackView({all:true,trackId:'a1'});
  assert.equal(effects.cancel,2,'전체 보기에서 다른 행 선택은 이동을 취소하지 않습니다');assert.equal(owner.scroll.scrollTop,26);
  assert.equal(JSON.stringify(project),before,'미리보기·내보내기에 쓰는 문서의 hidden/muted와 클립 데이터를 바꾸지 않습니다');
}));

test('mobile focus survives render, recovers a removed track and restores every row on desktop',()=>trackViewFixture(({owner,rows,heads,panel,body})=>{
  owner.setMobileTrackView({all:false,trackId:'v2'});const oldRows=rows.slice();owner.render();
  assert.notEqual(rows[0],oldRows[0]);assert.equal(rows.find(node=>node.dataset.track==='v2').dataset.mobileVisible,'true');
  project.timelineTracks=project.timelineTracks.filter(track=>track.id!=='v2');owner.render();
  assert.deepEqual(owner.mobileTrackView,{all:false,trackId:'v4'});assert.equal(rows.find(node=>node.dataset.track==='v4').dataset.mobileVisible,'true');
  owner.restoreMobileTrackView();assert.equal(owner.mobileTrackView,null);assert.equal(panel.dataset.mobileTrackView,undefined);
  assert.ok([...rows,...heads].every(node=>node.dataset.mobileVisible===undefined));
  owner.setMobileTrackView({all:false,trackId:'a1'});body.classList.remove('mobile-ui');owner.render();
  assert.equal(owner.mobileTrackView,null);assert.equal(panel.dataset.mobileTrackView,undefined);assert.ok([...rows,...heads].every(node=>node.dataset.mobileVisible===undefined));
  assert.equal(owner.setMobileTrackView({all:false,trackId:'v1'}),null,'PC에서는 표시 필터를 켜지 않습니다');
}));

test('a filtered mobile row cannot become a stale touch, menu or external drop target',()=>trackViewFixture(({owner,rows,body})=>{
  owner.setMobileTrackView({all:false,trackId:'v4'});
  const hidden=rows.find(node=>node.dataset.track==='v1'),shown=rows.find(node=>node.dataset.track==='v4');
  const target=row=>({isConnected:true,closest:selector=>selector==='.track'?row:null});
  assert.equal(owner.isMobileTargetVisible(target(hidden)),false);assert.equal(owner.isMobileTargetVisible(target(shown)),true);
  assert.equal(owner.mobileTouchEvent(pointer(1,100,100,target(hidden))),null);
  const event=pointer(1,100,100,target(hidden));owner.pointerDown(event);assert.equal(event.prevented,true);assert.equal(owner.dragging,false);
  owner.external={kind:'preset',id:'g:qa'};owner.snapTime=t=>t;owner.xTime=()=>1;
  assert.equal(owner.externalPlan(100,'v1'),null);assert.equal(owner.externalPlan(100,'v4')?.lane,'v4');
  body.classList.remove('mobile-ui');assert.equal(owner.isMobileTargetVisible(target(hidden)),true);assert.equal(owner.externalPlan(100,'v1')?.lane,'v1');
}));
