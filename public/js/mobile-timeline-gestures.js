// 한 손가락은 시각 이동, 두 손가락은 화면 이동·확대에 사용하고 선택한 클립만 편집합니다.
const SLOP = 8;
const DECIDE_MS = 120;
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
  clearDecision(){if(this.decisionTimer!==undefined)this.clearTimer(this.decisionTimer);this.decisionTimer=undefined;}
  clearTimers(){this.clearHold();this.clearDecision();}
  setMode(mode){
    this.mode=mode;
    for(const [name,value] of [['mobile-touch-seek','seek'],['mobile-touch-pan','pan'],['mobile-touch-hold','held'],['mobile-touch-pinch','pinch']])this.owner.canvas.classList.toggle(name,mode===value);
  }
  pointerDown(event){
    if(event.pointerType!=='touch')return false;
    if(!this.enabled()){this.reset();return false;}
    event.preventDefault();
    if(!this.points.size&&(this.owner.callbacks.busy?.()||this.owner.dragging))return true;
    if(this.points.has(event.pointerId))return true;
    this.suppressUntil=this.now()+700;this.owner.closeMenu();
    this.points.set(event.pointerId,{...position(event),event});this.listen();
    if(this.points.size>1){
      // 편집 취소가 포인터 캡처 해제 이벤트를 보내도 제스처 전체가 초기화되지 않게 먼저 전환합니다.
      this.clearTimers();this.setMode('pinch');this.owner.cancelPointerDrag?.();
      for(const id of this.points.keys())this.capture(id);
      this.beginPinch();return true;
    }
    this.origin={...position(event),event};this.moved=false;this.decided=false;
    this.editable=this.owner.mobileCanEditTouch?.(event)===true;
    this.edge=!!event.target.closest('[data-edge]');
    this.setMode('pending');
    this.capture(event.pointerId);
    this.decisionTimer=this.setTimer(()=>{
      this.decisionTimer=undefined;
      if(this.mode!=='pending')return;
      if(!this.enabled()||this.owner.canvas.isConnected===false){this.reset();return;}
      this.decided=true;
      if(this.moved)this.resolveMove([...this.points.values()][0]?.event||event);
    },DECIDE_MS);
    const clip=event.target.closest('.timeline-block');
    if(clip&&!this.edge&&!event.target.closest('[data-clip-setting],[data-mosaic-warn]'))this.timer=this.setTimer(()=>{
      this.timer=undefined;
      if(this.mode!=='pending')return;
      if(!this.enabled()||this.owner.canvas.isConnected===false){this.reset();return;}
      this.setMode('held');
    },HOLD_MS);
    return true;
  }
  resolveMove(event){
    if(this.mode==='pending'&&!this.decided)return;
    const edit=this.editable&&((this.mode==='held')||(this.mode==='pending'&&this.edge));
    if(edit){this.handoff(this.origin.event,event);return;}
    this.clearTimers();this.setMode('seek');this.owner.mobileSeek?.(event);
  }
  handoff(start,current){
    this.clearTimers();
    if(!this.editable||this.owner.mobileCanEditTouch?.(start)!==true){this.setMode('seek');this.owner.mobileSeek?.(current);return;}
    this.setMode('edit');this.release(start.pointerId);
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
    this.points.set(event.pointerId,{...position(event),event});
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
    if(this.mode==='blocked')return;
    const delta=distance(position(event),this.origin);
    if(delta>SLOP){this.moved=true;this.clearHold();}
    if((this.mode==='pending'||this.mode==='held')&&this.moved){this.resolveMove(event);return;}
    if(this.mode==='seek')this.owner.mobileSeek?.(event);
  }
  pointerUp(event){
    if(!this.points.has(event.pointerId))return;
    event.preventDefault();this.suppressUntil=this.now()+700;
    const mode=this.mode,initial=this.origin?.event;
    if((mode==='pending'||mode==='held')&&this.origin&&distance(position(event),this.origin)>SLOP)this.moved=true;
    this.points.delete(event.pointerId);this.release(event.pointerId);this.clearTimers();
    if(this.points.size){
      event.stopPropagation();
      if(this.points.size>1)this.beginPinch();
      else this.setMode('blocked');
      return;
    }
    this.unlisten();this.setMode(null);this.origin=null;this.pinch=null;
    // 편집 중인 pointerup은 전파를 유지해 기존 이동/트림 명령이 한 번만 확정됩니다.
    if(mode==='edit')return;
    event.stopPropagation();
    if(!this.enabled()||this.owner.canvas.isConnected===false||this.owner.callbacks.busy?.())return;
    if(mode==='seek'||(mode==='pending'||mode==='held')&&this.moved){this.owner.mobileSeek?.(event);return;}
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
    this.clearTimers();this.points.clear();
    try{if(this.mode==='edit')this.owner.cancelPointerDrag?.();}
    finally{
      for(const id of [...this.captured])this.release(id);
      this.unlisten();this.setMode(null);this.origin=null;this.pinch=null;this.editable=false;this.edge=false;this.moved=false;this.decided=false;
    }
  }
  destroy(){this.reset();this.disposed=true;}
}
