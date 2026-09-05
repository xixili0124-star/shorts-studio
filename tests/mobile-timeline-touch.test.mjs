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
