// 모바일의 스크롤·선택·길게 누르기를 구분한 뒤 기존 편집 엔진에 이동을 맡깁니다.
const SLOP = 8;
const HOLD_MS = 300;
const position = event => ({x:event.clientX,y:event.clientY});
const distance = (a,b) => Math.hypot(a.x-b.x,a.y-b.y);
const midpoint = (a,b) => ({x:(a.x+b.x)/2,y:(a.y+b.y)/2});

export class MobileTimelineGestures {
  constructor(owner,environment={}) {
    this.owner=owner;this.window=environment.window||globalThis.window;this.document=environment.document||globalThis.document;
    // 브라우저 타이머를 객체 메서드로 호출해도 Window 수신자가 유지되어야 합니다.
    this.setTimer=environment.setTimeout||globalThis.setTimeout.bind(globalThis);this.clearTimer=environment.clearTimeout||globalThis.clearTimeout.bind(globalThis);
    this.now=environment.now||Date.now;this.points=new Map();this.captured=new Set();this.mode=null;this.listening=false;this.disposed=false;
    this.move=event=>this.pointerMove(event);this.up=event=>this.pointerUp(event);this.cancel=event=>{if(this.points.has(event.pointerId))this.reset();};
    this.lost=event=>{
      if(!this.points.has(event.pointerId))return;
      if(this.owner.canvas.isConnected===false||(this.mode==='edit'&&event.target!==this.owner.canvas))this.reset();
    };
    this.abort=()=>this.reset();this.visibility=()=>{if(this.document.hidden)this.reset();};
  }
  enabled(){return !this.disposed&&this.document.body?.classList.contains('mobile-ui');}
  listen(){
    if(this.listening)return;this.listening=true;
    this.window.addEventListener('pointermove',this.move,{capture:true,passive:false});
    this.window.addEventListener('pointerup',this.up,true);this.window.addEventListener('pointercancel',this.cancel,true);
    this.window.addEventListener('lostpointercapture',this.lost,true);this.window.addEventListener('blur',this.abort);
    this.document.addEventListener('visibilitychange',this.visibility);
  }
  unlisten(){
    if(!this.listening)return;this.listening=false;
    this.window.removeEventListener('pointermove',this.move,true);this.window.removeEventListener('pointerup',this.up,true);
    this.window.removeEventListener('pointercancel',this.cancel,true);this.window.removeEventListener('lostpointercapture',this.lost,true);
    this.window.removeEventListener('blur',this.abort);this.document.removeEventListener('visibilitychange',this.visibility);
  }
  capture(id){try{this.owner.canvas.setPointerCapture(id);this.captured.add(id);}catch{}}
  release(id){
    this.captured.delete(id);
    try{if(this.owner.canvas.hasPointerCapture(id))this.owner.canvas.releasePointerCapture(id);}catch{}
  }
  clearHold(){if(this.timer!==undefined)this.clearTimer(this.timer);this.timer=undefined;}
  setMode(mode){
    this.mode=mode;
    for(const [name,value] of [['mobile-touch-pan','pan'],['mobile-touch-hold','held'],['mobile-touch-pinch','pinch']])this.owner.canvas.classList.toggle(name,mode===value);
  }
  pointerDown(event){
    if(event.pointerType!=='touch')return false;
    if(!this.enabled()){this.reset();return false;}
    event.preventDefault();
    if(this.owner.callbacks.busy?.()||(!this.points.size&&this.owner.dragging))return true;
    this.suppressUntil=this.now()+700;this.owner.closeMenu();
    this.points.set(event.pointerId,{...position(event),event});this.listen();
    if(this.points.size>1){
      this.clearHold();this.owner.cancelPointerDrag?.();
      for(const id of this.points.keys())this.capture(id);
      this.beginPinch();return true;
    }
    this.origin={...position(event),left:this.owner.scroll.scrollLeft,top:this.owner.scroll.scrollTop,event};
    this.setMode('pending');
    if(event.target.closest('[data-edge]')){this.handoff(event,event);return true;}
    this.capture(event.pointerId);
    const clip=event.target.closest('.timeline-block');
    if(clip&&!event.target.closest('[data-clip-setting],[data-mosaic-warn]'))this.timer=this.setTimer(()=>{
      this.timer=undefined;
      if(this.mode!=='pending')return;
      if(!this.enabled()||this.owner.canvas.isConnected===false){this.reset();return;}
      this.setMode('held');
    },HOLD_MS);
    return true;
  }
  handoff(start,current){
    this.clearHold();this.setMode('edit');this.release(start.pointerId);
    const event=this.owner.mobileTouchEvent(start);
    if(!event){this.setMode('blocked');return;}
    this.owner.pointerDown(event,true);
    if(!this.owner.dragging){this.setMode('blocked');return;}
    // 길게 누른 뒤 처음 움직인 프레임도 버리지 않고 기존 미리보기 계산에 전달합니다.
    if(current!==start)this.owner.movePointerDrag?.(current);
  }
  beginPinch(){
    const [a,b]=[...this.points.values()];if(!b)return;
    const center=midpoint(a,b),rect=this.owner.scroll.getBoundingClientRect();
    this.pinch={distance:Math.max(1,distance(a,b)),zoom:this.owner.zoom,
      time:(this.owner.scroll.scrollLeft+center.x-rect.left)/this.owner.zoom,center,top:this.owner.scroll.scrollTop};
    this.setMode('pinch');
  }
  pointerMove(event){
    if(!this.points.has(event.pointerId))return;
    if(!this.enabled()||this.owner.canvas.isConnected===false){this.reset();return;}
    this.points.set(event.pointerId,{...this.points.get(event.pointerId),...position(event)});
    if(this.mode==='edit')return; // 잡은 클립의 기존 pointermove가 편집을 처리합니다.
    event.preventDefault();event.stopPropagation();
    if(this.mode==='pinch'){
      const [a,b]=[...this.points.values()];if(!b)return;
      const center=midpoint(a,b),rect=this.owner.scroll.getBoundingClientRect();
      this.owner.setZoom(this.pinch.zoom*distance(a,b)/this.pinch.distance,center.x);
      // 중점이 움직여도 처음 두 손가락 사이의 같은 시각을 계속 가리킵니다.
      this.owner.scroll.scrollLeft=Math.max(0,this.pinch.time*this.owner.zoom-(center.x-rect.left));
      this.owner.scroll.scrollTop=Math.max(0,this.pinch.top-(center.y-this.pinch.center.y));return;
    }
    const delta=distance(position(event),this.origin);
    if(this.mode==='held'&&delta>SLOP){this.handoff(this.origin.event,event);return;}
    if(this.mode==='pending'&&delta>SLOP){this.clearHold();this.setMode('pan');}
    if(this.mode==='pan'){
      this.owner.scroll.scrollLeft=Math.max(0,this.origin.left-(event.clientX-this.origin.x));
      this.owner.scroll.scrollTop=Math.max(0,this.origin.top-(event.clientY-this.origin.y));
    }
  }
  pointerUp(event){
    if(!this.points.has(event.pointerId))return;
    event.preventDefault();this.suppressUntil=this.now()+700;
    const mode=this.mode,initial=this.origin?.event;
    this.points.delete(event.pointerId);this.release(event.pointerId);this.clearHold();
    if(this.points.size){
      if(this.points.size>1)this.beginPinch();
      else{
        const point=[...this.points.values()][0];
        this.origin={...point,left:this.owner.scroll.scrollLeft,top:this.owner.scroll.scrollTop};this.setMode('pan');
      }
      return;
    }
    this.unlisten();this.setMode(null);this.origin=null;this.pinch=null;
    // 편집 중인 pointerup은 전파를 유지해 기존 이동/트림 명령이 한 번만 확정됩니다.
    if(mode==='edit')return;
    event.stopPropagation();
    if(!this.enabled()||this.owner.canvas.isConnected===false||this.owner.callbacks.busy?.())return;
    const resolved=initial&&this.owner.mobileTouchEvent(initial);if(!resolved)return;
    if(mode==='held')this.owner.openMenu(resolved);
    else if(mode==='pending')this.owner.mobileTap(resolved);
  }
  consumeClick(event){
    if(!this.enabled()||event.detail===0)return false;
    return this.now()<(this.suppressUntil||0)&&(event.pointerType==='touch'||event.sourceCapabilities?.firesTouchEvents||!event.pointerType);
  }
  consumeContextMenu(event){return this.enabled()&&(this.points.size>0||event.pointerType==='touch'&&this.now()<(this.suppressUntil||0));}
  reset(){
    this.clearHold();this.points.clear();
    try{if(this.mode==='edit')this.owner.cancelPointerDrag?.();}
    finally{
      for(const id of [...this.captured])this.release(id);
      this.unlisten();this.setMode(null);this.origin=null;this.pinch=null;
    }
  }
  destroy(){this.reset();this.disposed=true;}
}
