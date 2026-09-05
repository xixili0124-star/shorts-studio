// 모니터 조작 UI는 출력 캔버스 밖에 둡니다. 손잡이·스위치·정렬선은 영상에 들어가지 않습니다.
import { captureDocument } from './project-store.js';
import { measureVisual } from './render.js';
import { resolveSelection, selectionKey } from './batch-edits.js';
import { transformOf, visualCorners, croppedBounds, hitVisual, cropFromDrag, resizeFromDrag, snapVisualCenter, transformAroundAnchor, transformPoint } from './visual-transform.js';
import { clamp } from './util.js';
import { KEYFRAME_CHANNELS, quantizeKeyframeTime, setValueAt } from './keyframes.js';

const $=id=>document.getElementById(id);
const clone=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
const normalizedCrop=item=>({left:0,right:0,top:0,bottom:0,...item.crop});
const sameGeometry=(a,b)=>{
  const first={...transformOf(a),...normalizedCrop(a)},second={...transformOf(b),...normalizedCrop(b)};
  return Object.keys(first).every(key=>typeof first[key]==='number'?Math.abs(key==='rotation'?wrapAngle(first[key]-second[key]):first[key]-second[key])<1e-8:first[key]===second[key]);
};
const handles=[['left','top'],['top'],['right','top'],['right'],['right','bottom'],['bottom'],['left','bottom'],['left']];
const wrapAngle=value=>((value+180)%360+360)%360-180;

export class MonitorEditor {
  constructor(callbacks){
    this.callbacks=callbacks;this.player=callbacks.player;this.canvas=$('preview');this.stage=$('viewerStage');
    this.layer=$('monitorOverlay');this.svg=$('monitorOutline');this.tools=$('monitorTools');this.mode='transform';this.drag=null;this.guides={};
    this.buttons=handles.map(edges=>{
      const button=document.createElement('button');button.type='button';button.className='monitor-handle';button.dataset.edges=edges.join(' ');
      button.setAttribute('aria-label',edges.map(e=>({left:'왼쪽',right:'오른쪽',top:'위',bottom:'아래'})[e]).join(' ')+' 경계 드래그');
      this.layer.append(button);return button;
    });
    this.rotate=document.createElement('button');this.rotate.type='button';this.rotate.className='monitor-handle rotate-handle';this.rotate.dataset.edges='rotate';this.rotate.textContent='↻';this.rotate.setAttribute('aria-label','회전 손잡이');this.layer.append(this.rotate);
    this.player.selectionOverlay=true;this.player.onDraw=()=>this.update();
    this.stage.addEventListener('pointerdown',e=>this.begin(e));
    this.tools.addEventListener('click',e=>{
      const mode=e.target.closest('[data-monitor-mode]'),align=e.target.closest('[data-monitor-align]');
      if(this.dragging||this.callbacks.busy())return;
      if(mode){if(mode.dataset.monitorMode==='crop'&&!this.canCrop())return;this.mode=mode.dataset.monitorMode;this.update();}
      if(align)this.callbacks.align(align.dataset.monitorAlign);
    });
    window.addEventListener('resize',()=>this.update());
    if(typeof ResizeObserver!=='undefined'){this.resizeObserver=new ResizeObserver(()=>{this.frameSize=null;this.update();});this.resizeObserver.observe(this.stage);}
  }
  get dragging(){return !!this.drag;}
  fitCanvas(){
    if(typeof getComputedStyle!=='function')return;
    const key=[this.stage.clientWidth,this.stage.clientHeight,this.canvas.width,this.canvas.height,window.innerWidth,window.innerHeight].join(':');
    if(key===this.frameSize)return;this.frameSize=key;
    const style=getComputedStyle(this.stage),width=this.stage.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight),height=this.stage.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom);
    const fitted=Math.max(1,Math.min(width,height*this.canvas.width/this.canvas.height));
    this.canvas.style.width=fitted+'px';this.canvas.style.height=fitted*this.canvas.height/this.canvas.width+'px';
  }
  point(event){const r=this.canvas.getBoundingClientRect();return{x:(event.clientX-r.left)/r.width*this.canvas.width,y:(event.clientY-r.top)/r.height*this.canvas.height};}
  entries(){
    const refs=this.callbacks.selections();return refs.length?resolveSelection(refs).filter(r=>r.type!=='audio'):[];
  }
  canCrop(entries=this.entries()){return !!entries.length&&entries.every(entry=>entry.type==='clip');}
  localTime(entry){return clamp(this.player.time-entry.start,0,Math.max(0,entry.end-entry.start-1e-7));}
  editLocalTime(entry){
    const duration=Math.max(0,entry.end-entry.start),fps=Number(this.callbacks.fps?.())||30;
    return quantizeKeyframeTime(this.localTime(entry),fps,duration);
  }
  current(entries=this.entries()){
    const visible=entries.filter(r=>this.player.time>=r.start&&this.player.time<r.end),primary=this.callbacks.selection();
    return visible.find(r=>primary&&selectionKey(r)===selectionKey(primary))||visible.at(-1);
  }
  bounds(entry){
    return measureVisual(this.player.ctx,entry.type,entry.item,this.canvas.width,this.canvas.height,clamp(this.player.time,entry.start,Math.max(entry.start,entry.end-1e-7)));
  }
  update(){
    this.fitCanvas();
    const entries=this.entries(),current=this.current(entries),hidden=!current||this.player.playing||this.canvas.hidden;
    if(this.mode==='crop'&&!this.canCrop(entries))this.mode='transform';
    this.layer.hidden=hidden;this.tools.hidden=hidden;if(hidden)return;
    const frame=this.canvas.getBoundingClientRect(),stage=this.stage.getBoundingClientRect(),W=this.canvas.width,H=this.canvas.height;
    const screen=p=>({x:frame.left-stage.left+p.x/W*frame.width,y:frame.top-stage.top+p.y/H*frame.height});
    const polygons=entries.filter(r=>this.player.time>=r.start&&this.player.time<r.end).map(r=>{
      const points=visualCorners(this.bounds(r),r.item,W,H,this.localTime(r)).map(screen);
      return '<polygon points="'+points.map(p=>p.x+','+p.y).join(' ')+'" class="'+(r.id===current.id?'primary':'secondary')+'"/>';
    });
    if(this.guides.x){const p=screen({x:W/2,y:0}),q=screen({x:W/2,y:H});polygons.push('<line class="center-guide" x1="'+p.x+'" y1="'+p.y+'" x2="'+q.x+'" y2="'+q.y+'"/>');}
    if(this.guides.y){const p=screen({x:0,y:H/2}),q=screen({x:W,y:H/2});polygons.push('<line class="center-guide" x1="'+p.x+'" y1="'+p.y+'" x2="'+q.x+'" y2="'+q.y+'"/>');}
    this.svg.innerHTML=polygons.join('');
    const corners=visualCorners(this.bounds(current),current.item,W,H,this.localTime(current)).map(screen),mid=(a,b)=>({x:(a.x+b.x)/2,y:(a.y+b.y)/2});
    const points=[corners[0],mid(corners[0],corners[1]),corners[1],mid(corners[1],corners[2]),corners[2],mid(corners[2],corners[3]),corners[3],mid(corners[3],corners[0])];
    const position=(node,p)=>{node.style.left=clamp(p.x,9,this.stage.clientWidth-9)+'px';node.style.top=clamp(p.y,9,this.stage.clientHeight-9)+'px';};
    this.buttons.forEach((button,i)=>{position(button,points[i]);button.classList.toggle('crop-handle',this.mode==='crop');});
    position(this.rotate,{x:Math.max(...corners.map(p=>p.x))+24,y:Math.min(...corners.map(p=>p.y))+24});this.rotate.hidden=this.mode!=='transform';
    this.tools.querySelectorAll('[data-monitor-mode]').forEach(button=>{
      const crop=button.dataset.monitorMode==='crop',allowed=!crop||this.canCrop(entries),active=button.dataset.monitorMode===this.mode;
      button.hidden=!allowed;button.disabled=!allowed;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));
    });
    $('monitorSelectionCount').textContent=entries.length>1?entries.length+'개에 적용':'';
    this.tools.style.left=clamp((Math.min(...corners.map(p=>p.x))+Math.max(...corners.map(p=>p.x)))/2-this.tools.offsetWidth/2,5,Math.max(5,this.stage.clientWidth-this.tools.offsetWidth-5))+'px';
    this.tools.style.top=clamp(Math.min(...corners.map(p=>p.y))-this.tools.offsetHeight-13,4,Math.max(4,this.stage.clientHeight-this.tools.offsetHeight-4))+'px';
    this.stage.dataset.monitorMode=this.mode;
  }
  begin(event){
    if(event.button!==0||event.isPrimary===false||this.dragging||this.callbacks.busy()||event.target.closest('#monitorTools'))return;
    if(/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName))document.activeElement.blur();
    const entries=this.entries(),current=this.current(entries);if(!current)return;
    if(this.mode==='crop'&&!this.canCrop(entries))this.mode='transform';
    const W=this.canvas.width,H=this.canvas.height,p=this.point(event),bounds=this.bounds(current);
    const handle=event.target.closest('[data-edges]'),edges=handle?.dataset.edges.split(' ')||['move'];
    if(!handle&&!hitVisual(p,bounds,current.item,W,H,this.localTime(current)))return;
    this.player.pause();event.preventDefault();this.callbacks.gestureStart?.();
    const targets=entries.map(entry=>{const localTime=this.editLocalTime(entry),fps=Number(this.callbacks.fps?.())||30;return({
      entry,item:entry.item,bounds:this.bounds(entry),localTime,fps,
      initial:{transform:clone(transformOf(entry.item,localTime)),crop:clone(entry.item.crop)},
      original:{transform:clone(entry.item.transform),crop:clone(entry.item.crop),keyframes:clone(entry.item.keyframes)},
      autoKey:typeof this.callbacks.autoKey==='function'?!!this.callbacks.autoKey(entry):!!this.callbacks.autoKey,
    });});
    const primary=targets.find(t=>t.entry.id===current.id),visible=croppedBounds(bounds,current.item.crop);
    const center=transformPoint({x:visible.x+visible.w/2,y:visible.y+visible.h/2},bounds,current.item,W,H,this.localTime(current));
    this.drag={pointer:event.pointerId,from:p,targets,primary,edges,center,before:captureDocument(),moved:false,mode:this.mode};
    this.stage.setPointerCapture(event.pointerId);document.body.classList.add('monitor-dragging');
    const move=e=>this.move(e),up=e=>{if(e.pointerId===this.drag?.pointer)this.finish(false);},cancel=e=>{if(e.pointerId===this.drag?.pointer)this.finish(true);},abort=()=>this.finish(true),escape=e=>{
      if(e.key==='Escape'){e.preventDefault();this.finish(true);}else if(this.drag){e.preventDefault();e.stopImmediatePropagation();}
    };
    this.drag.cleanup=()=>{this.stage.removeEventListener('pointermove',move);this.stage.removeEventListener('pointerup',up);this.stage.removeEventListener('pointercancel',cancel);this.stage.removeEventListener('lostpointercapture',cancel);window.removeEventListener('keydown',escape,true);window.removeEventListener('blur',abort);};
    this.stage.addEventListener('pointermove',move);this.stage.addEventListener('pointerup',up);this.stage.addEventListener('pointercancel',cancel);this.stage.addEventListener('lostpointercapture',cancel);window.addEventListener('keydown',escape,true);window.addEventListener('blur',abort);
  }
  applyTransform(target,next){
    // 드래그 중 임시 키가 누적되지 않도록 매번 제스처 시작 상태에서 계산합니다.
    for(const name of ['transform','keyframes']){
      if(target.original[name]===undefined)delete target.item[name];else target.item[name]=clone(target.original[name]);
    }
    const initial=transformOf(target.initial);
    for(const channel of KEYFRAME_CHANNELS){
      if(channel==='volume'||!Number.isFinite(next[channel])||Math.abs(next[channel]-initial[channel])<1e-9)continue;
      setValueAt(target.item,channel,target.localTime,next[channel],{autoKey:target.autoKey,duration:target.entry.end-target.entry.start,fps:target.fps});
    }
  }
  move(event){
    const d=this.drag;if(!d||event.pointerId!==d.pointer)return;
    const p=this.point(event),W=this.canvas.width,H=this.canvas.height,rect=this.canvas.getBoundingClientRect(),primary=d.primary,from=primary.initial;
    if(!d.moved&&Math.hypot((p.x-d.from.x)/W*rect.width,(p.y-d.from.y)/H*rect.height)<2)return;
    d.moved=true;this.guides={};
    if(d.mode==='crop'){
      const crop=cropFromDrag(from,primary.bounds,W,H,d.from,p,d.edges),base=normalizedCrop(from);
      for(const target of d.targets){
        const old=normalizedCrop(target.initial),next={...old};
        if(d.edges.includes('move')){
          const horizontal=old.left+old.right,vertical=old.top+old.bottom;
          next.left=clamp(old.left+crop.left-base.left,Math.max(0,horizontal-.95),Math.min(.95,horizontal));next.right=horizontal-next.left;
          next.top=clamp(old.top+crop.top-base.top,Math.max(0,vertical-.95),Math.min(.95,vertical));next.bottom=vertical-next.top;
        }else for(const edge of d.edges){const opposite={left:'right',right:'left',top:'bottom',bottom:'top'}[edge];next[edge]=clamp(old[edge]+crop[edge]-base[edge],0,Math.min(.95,.98-old[opposite]));}
        target.item.crop=next;
      }
    }else if(d.edges.includes('move')){
      const original=transformOf(from),candidate={...original,offsetX:clamp(original.offsetX+(p.x-d.from.x)/W,-3,3),offsetY:clamp(original.offsetY+(p.y-d.from.y)/H,-3,3)};
      const snap=event.altKey?{transform:candidate,guides:{}}:snapVisualCenter({...from,transform:candidate},primary.bounds,W,H,{x:7*W/rect.width,y:7*H/rect.height});
      this.guides=snap.guides;
      for(const target of d.targets){const t=transformOf(target.initial);this.applyTransform(target,{...t,offsetX:clamp(t.offsetX+snap.transform.offsetX-original.offsetX,-3,3),offsetY:clamp(t.offsetY+snap.transform.offsetY-original.offsetY,-3,3)});}
    }else if(d.edges.includes('rotate')){
      let delta=(Math.atan2(p.y-d.center.y,p.x-d.center.x)-Math.atan2(d.from.y-d.center.y,d.from.x-d.center.x))*180/Math.PI;
      if(event.shiftKey)delta=Math.round(delta/15)*15;
      for(const target of d.targets){const t=transformOf(target.initial),b=croppedBounds(target.bounds,target.initial.crop);this.applyTransform(target,transformAroundAnchor(target.initial,target.bounds,W,H,{...t,rotation:wrapAngle(t.rotation+delta)},{x:b.x+b.w/2,y:b.y+b.h/2}));}
    }else{
      const original=transformOf(from),next=resizeFromDrag(from,primary.bounds,W,H,d.from,p,d.edges,!event.shiftKey),rx=next.scaleX/original.scaleX,ry=next.scaleY/original.scaleY;
      for(const target of d.targets){
        const t=transformOf(target.initial),b=croppedBounds(target.bounds,target.initial.crop);
        const anchor={x:d.edges.includes('left')?b.x+b.w:d.edges.includes('right')?b.x:b.x+b.w/2,y:d.edges.includes('top')?b.y+b.h:d.edges.includes('bottom')?b.y:b.y+b.h/2};
        this.applyTransform(target,transformAroundAnchor(target.initial,target.bounds,W,H,{...t,scaleX:clamp(t.scaleX*rx,.05,10),scaleY:clamp(t.scaleY*ry,.05,10)},anchor));
      }
    }
    this.player.invalidate();
  }
  finish(cancel){
    const d=this.drag;if(!d)return;this.drag=null;d.cleanup();this.guides={};
    if(this.stage.hasPointerCapture(d.pointer))this.stage.releasePointerCapture(d.pointer);
    document.body.classList.remove('monitor-dragging');
    const changed=d.targets.some(t=>!sameGeometry(t.initial,{transform:transformOf(t.item,t.localTime),crop:t.item.crop}));
    if(cancel||!changed)for(const target of d.targets){
      if(!resolveSelection([target.entry]).some(entry=>entry.item===target.item))continue;
      for(const key of ['transform','crop','keyframes'])if(target.original[key]===undefined)delete target.item[key];else target.item[key]=clone(target.original[key]);
    }
    if(!cancel&&changed)this.callbacks.commit(d.before,d.mode==='crop'?'선택 요소 화면 자르기':'선택 요소 화면 변형');
    else this.callbacks.refresh();
    this.callbacks.gestureEnd?.();this.update();
  }
}
