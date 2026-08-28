// 드래그 중에는 잡은 DOM을 유지하고, 놓을 때 한 번만 편집 명령을 적용합니다.
import { project, buildLayout, totalDuration, transitionPairs, syncAnchoredItems, timelineTracks, trackIdFor, trackLabel, trackItems, trackKind, TRACK_ROLES } from './state.js';
import { assets, captureDocument } from './project-store.js';
import { frameTime, itemRange, planVideoPlacement, placeVideoClip, planClipTrim, applyClipTrim, setItemRange, planPlacement, placeTimelineItem, trackGaps, planItemTrim, applyItemTrim } from './timeline-edits.js';
import { clamp } from './util.js';
import { selectionKey, selectionRefs, combineSelection, marqueeHits, planBatchMove, applyBatchMove } from './batch-edits.js';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const stamp = t => Math.floor(t/60).toString().padStart(2,'0')+':'+Math.floor(t%60).toString().padStart(2,'0');
const precise = t => stamp(t)+'.'+Math.floor((t % 1) * 100).toString().padStart(2,'0');


export class Timeline {
  constructor(callbacks) {
    this.callbacks=callbacks;this.zoom=70;this.snapping=true;this.selection=null;this.selections=[];this.time=0;this.dragging=false;
    this.activeTrackId='v1';this.activeAudioTrackId='a1';
    this.activeRoleTracks=Object.fromEntries(TRACK_ROLES.map(role=>[role.id,timelineTracks().find(t=>t.role===role.id)?.id]));
    this.activeHeaderId='v1';
    this.scroll=$('timelineScroll');this.canvas=$('timelineCanvas');this.external=null;this.preview=null;
    $('timelineZoom').oninput=e=>this.setZoom(Number(e.target.value));
    $('zoomIn').onclick=()=>this.setZoom(this.zoom*1.25);
    $('zoomOut').onclick=()=>this.setZoom(this.zoom/1.25);
    $('fitTimeline').onclick=()=>this.fit();$('snap').onclick=()=>this.toggleSnap();
    this.canvas.addEventListener('pointerdown',e=>this.pointerDown(e));
    this.canvas.addEventListener('click',e=>{
      const settings=e.target.closest('[data-clip-setting]');
      if(settings){e.preventDefault();e.stopPropagation();if(this.dragging||this.callbacks.busy?.())return;const block=settings.closest('.timeline-block');this.callbacks[settings.dataset.clipSetting==='copy'?'copySettings':'pasteSettings']?.({type:block.dataset.type,id:block.dataset.id});return;}
      const button=e.target.closest('[data-transition]');
      if(button&&!this.dragging){e.stopPropagation();this.callbacks.transition(button.dataset.transition,button.dataset.right);}
    });
    $('trackHeaders').addEventListener('click',e=>{
      if(this.callbacks.busy?.())return;
      const add=e.target.closest('[data-add-track]');
      if(add){this.callbacks.addTrack?.(add.dataset.addTrack);return;}
      const remove=e.target.closest('[data-remove-track]');
      if(remove){this.callbacks.removeTrack?.(remove.dataset.removeTrack);return;}
      const head=e.target.closest('[data-track-select]');
      if(head)this.activateTrack(head.dataset.trackSelect);
    });
    this.scroll.addEventListener('scroll',()=>{$('trackHeaders').style.transform='translateY(-'+this.scroll.scrollTop+'px)';});
    this.canvas.addEventListener('keydown',e=>{
      if(!['Enter',' '].includes(e.key)||this.callbacks.busy?.())return;
      if(e.target.closest('[data-clip-setting]'))return;
      const button=e.target.closest('.timeline-block,.timeline-gap,.transition-chip');
      if(!button)return;e.preventDefault();e.stopPropagation();
      if(button.dataset.type==='gap')this.chooseGap(button.dataset.id);
      else if(button.dataset.type==='transition')this.callbacks.transition(button.dataset.id,button.dataset.right);
      else if(e.shiftKey||e.ctrlKey||e.metaKey){const ref={type:button.dataset.type,id:button.dataset.id};this.selectMany(combineSelection(this.selections,[ref],'toggle'),ref);this.callbacks.selectMany?.(this.selections,this.selection);}
      else{this.select(button.dataset.type,button.dataset.id);this.callbacks.select(button.dataset.type,button.dataset.id);}
    });
    this.canvas.addEventListener('dragover',e=>this.externalOver(e));
    this.canvas.addEventListener('dragleave',e=>{if(!this.canvas.contains(e.relatedTarget)){this.clearPreview();this.stopScroll();}});
    this.canvas.addEventListener('drop',e=>this.externalDrop(e));
    document.addEventListener('dragend',()=>this.endExternalDrag());
    this.scroll.addEventListener('wheel',e=>{
      if(e.ctrlKey||e.metaKey){e.preventDefault();this.setZoom(this.zoom*(e.deltaY<0?1.12:.89));}
    },{passive:false});
  }
  setZoom(value){if(this.dragging)return;this.zoom=clamp(value,18,180);$('timelineZoom').value=this.zoom;this.render();}
  fit(){this.setZoom((this.scroll.clientWidth-70)/Math.max(4,totalDuration()));}
  toggleSnap(){this.snapping=!this.snapping;$('snap').classList.toggle('active',this.snapping);$('snap').setAttribute('aria-pressed',this.snapping);}
  xTime(x){return clamp((x-this.canvas.getBoundingClientRect().left)/this.zoom,0,86400);}
  preferredTrack(kind) {
    const role=TRACK_ROLES.find(role=>role.id===kind);
    if(role){const id=this.activeRoleTracks?.[role.id];return timelineTracks().find(t=>t.id===id&&t.role===role.id)?.id||timelineTracks().find(t=>t.role===role.id)?.id;}
    const id=kind==='audio'?this.activeAudioTrackId:this.activeTrackId;
    return timelineTracks().find(t=>t.id===id&&t.kind===kind)?.id||timelineTracks().find(t=>t.kind===kind)?.id;
  }
  activateTrack(id) {
    const track=timelineTracks().find(t=>t.id===id);if(!track)return;
    if(track.kind==='audio')this.activeAudioTrackId=id;else this.activeTrackId=id;
    this.activeRoleTracks||={};this.activeRoleTracks[track.role]=id;this.activeHeaderId=id;
    $('trackHeaders').querySelectorAll('[data-track-select]').forEach(n=>{
      const active=n.dataset.trackSelect===id;
      n.classList.toggle('active',active);n.setAttribute('aria-pressed',String(active));
    });
  }
  select(type,id,rightId){
    const gap=type==='gap'?timelineTracks().flatMap(t=>trackGaps(t.id)).find(g=>g.id===id):null;
    this.selection=type?{type,id,rightId,...(gap||{})}:null;
    this.selections=['clip','caption','graphic','audio'].includes(type)?[{type,id}]:[];
    const range=type==='transition'?itemRange('clip',id):itemRange(type,id);
    if(gap||range)this.activateTrack((gap||range).trackId);
    this.paintSelection();
  }
  selectMany(refs,primary){
    this.selections=selectionRefs(refs);this.selection=this.selections.find(ref=>primary&&selectionKey(ref)===selectionKey(primary))||this.selections.at(-1)||null;
    const range=this.selection&&itemRange(this.selection.type,this.selection.id);if(range)this.activateTrack(range.trackId);
    this.paintSelection();
  }
  paintSelection(){
    const keys=new Set((this.selections||[]).map(selectionKey)),primary=this.selection;
    this.canvas.querySelectorAll('.timeline-block,.transition-chip,.timeline-gap').forEach(node=>{
      const selected=!!(keys.has(selectionKey({type:node.dataset.type,id:node.dataset.id}))||(primary&&node.dataset.type===primary.type&&node.dataset.id===primary.id&&(!primary.rightId||node.dataset.right===primary.rightId)));
      node.classList.toggle('selected',selected);node.setAttribute('aria-pressed',String(selected));
    });
  }
  updateSettingButtons(){this.canvas.querySelectorAll('[data-clip-setting="paste"]').forEach(button=>button.disabled=!this.callbacks.canPasteSettings?.());}
  chooseGap(id) {
    const gap=timelineTracks().flatMap(t=>trackGaps(t.id)).find(g=>g.id===id);if(!gap)return;
    this.callbacks.pause();this.select('gap',id);this.callbacks.gap?.(gap);
  }
  tick(t){this.time=t;$('playhead').style.left=t*this.zoom+'px';}
  snapTime(t,exclude,duration=0){
    let result=frameTime(t);
    if(!this.snapping)return result;
    const layout=buildLayout();
    const ranges=[...layout.entries.map(e=>({id:e.clip.id,start:e.start,end:e.end})),...project.captions,...project.overlays,
      ...(project.audio.tracks||[]).map(a=>({id:a.id,start:a.start,end:a.start+a.trimEnd-a.trimStart}))];
    const exclusions=exclude instanceof Set?exclude:new Set([exclude]);
    const candidates=[0,this.time,...ranges.filter(a=>!exclusions.has(a.id)).flatMap(a=>[a.start,a.end])];
    let closest=8/this.zoom;
    for(const edge of candidates)for(const offset of duration?[0,duration]:[0]){
      const start=edge-offset,distance=Math.abs(start-t);
      if(start>=0&&distance<closest){closest=distance;result=start;}
    }
    return Math.max(0,result);
  }
  ensureWidth(end){
    const width=Math.max(this.scroll.clientWidth,Math.ceil((end+Math.max(3,70/this.zoom))*this.zoom));
    if(width>this.canvas.offsetWidth){this.canvas.style.width=width+'px';this.renderRuler(width);}
  }
  renderRuler(width){
    const increment=this.zoom<35?5:this.zoom<65?2:1;let html='';
    for(let t=0;t<width/this.zoom;t+=increment){
      html+='<div class="ruler-mark" style="left:'+t*this.zoom+'px"><span>'+stamp(t)+'</span></div>';
      for(let k=1;k<4;k++)html+='<div class="ruler-mark minor" style="left:'+(t+increment*k/4)*this.zoom+'px"></div>';
    }
    $('ruler').innerHTML=html;
  }
  render(){
    if(this.dragging)return;
    const layout=buildLayout(),width=Math.max(this.scroll.clientWidth,Math.ceil((Math.max(layout.total,this.time)+3)*this.zoom));
    this.canvas.style.width=width+'px';this.renderRuler(width);
    const registry=timelineTracks();
    const rows=[...registry.filter(t=>t.kind==='visual').reverse(),...registry.filter(t=>t.kind==='audio')];
    const pairs=transitionPairs();
    $('timelineRows').innerHTML=rows.map(track=>{
      const items=trackItems(track.id,project,layout);
      return '<div id="track-'+track.id+'" class="track '+(track.kind==='audio'?'audio-track':'visual-track')+' '+track.role+'-track" data-track="'+track.id+'" data-kind="'+track.kind+'">'+
        trackGaps(track.id).map(gap=>'<div tabindex="0" role="button" aria-pressed="false" aria-label="'+trackLabel(track.id)+' 빈 공간 '+gap.duration.toFixed(2)+'초 · S로 닫기" class="timeline-gap" data-type="gap" data-id="'+gap.id+'" style="left:'+gap.start*this.zoom+'px;width:'+Math.max(1,gap.duration*this.zoom-1)+'px"><span>빈 공간 · '+gap.duration.toFixed(2)+'초</span></div>').join('')+
        items.map(e=>this.block(e.type,e.item,e.start,e.duration,e.start+(e.overlapIn||0)/2,e.end-(e.overlapOut||0)/2)).join('')+
        pairs.filter(p=>p.trackId===track.id).map(pair=>this.transitionButton(pair)).join('')+'</div>';
    }).join('');
    $('trackHeaders').innerHTML=rows.map(track=>{
      const count=trackItems(track.id,project,layout).length;
      const active=track.id===this.activeHeaderId,role=TRACK_ROLES.find(role=>role.id===track.role);
      return '<div class="track-head '+track.kind+'-head '+track.role+'-head"><button class="track-selector '+(active?'active':'')+'" data-track-select="'+track.id+'" aria-pressed="'+active+'" title="이 용도의 새 클립을 추가할 트랙"><span class="track-code">'+role.code+'</span><strong>'+trackLabel(track.id)+'</strong><small>'+count+'</small></button><button class="add-track" data-add-track="'+track.id+'" aria-label="'+trackLabel(track.id)+(track.kind==='visual'?' 바로 위에 ':' 바로 아래에 ')+role.label+' 트랙 추가" title="'+(track.kind==='visual'?'바로 위에':'바로 아래에')+' '+role.label+' 트랙 추가" '+(registry.filter(t=>t.kind===track.kind).length>=24?'disabled':'')+'>+</button><button class="remove-track" data-remove-track="'+track.id+'" aria-label="'+trackLabel(track.id)+' 빈 트랙 삭제" '+(count||registry.filter(t=>t.role===track.role).length<2?'disabled':'')+'>×</button></div>';
    }).join('');
    $('trackHeaders').style.transform='translateY(-'+this.scroll.scrollTop+'px)';
    $('totalDuration').textContent=stamp(layout.total);$('sequenceInfo').textContent=layout.items.length+' 클립 · '+layout.total.toFixed(1)+'초';
    this.tick(this.time);this.paintSelection();this.updateSettingButtons();
  }
  transitionButton(pair){
    const name={cut:'바로 연결',dissolve:'디졸브',fade:'검정 페이드',flash:'화이트 플래시'}[pair.type];
    const label=(pair.left.clip.name||'앞 클립')+' ↔ '+(pair.right.clip.name||'뒤 클립')+' · '+name+(pair.duration?' '+pair.duration.toFixed(2)+'초':'');
    const band=pair.duration?'<span class="transition-band" style="left:'+pair.start*this.zoom+'px;width:'+pair.duration*this.zoom+'px"></span>':'';
    return band+'<button type="button" class="transition-chip '+(pair.duration?'':'cut-connector')+'" data-type="transition" data-id="'+pair.left.clip.id+'" data-transition="'+pair.left.clip.id+'" data-right="'+pair.right.clip.id+'" aria-label="'+esc(label)+' 전환 편집" aria-pressed="false" style="left:'+pair.center*this.zoom+'px" title="'+esc(label)+' · 클릭하여 편집">'+'<span class="'+(pair.duration?'transition-symbol':'plus-symbol')+'" aria-hidden="true"></span></button>';
  }
  block(type,item,start,duration,visibleStart=start,visibleEnd=start+duration){
    const klass={clip:'video',caption:'caption',graphic:'graphic',audio:'audio'}[type],label=item.name||item.text||'클립';
    const width=Math.max(12,(visibleEnd-visibleStart)*this.zoom-2);let detail='';
    if(type==='clip'&&item.thumb){const n=Math.min(100,Math.ceil(width/46)+1);detail='<div class="thumb-strip">'+Array(n).fill('<img src="'+item.thumb+'" alt="" draggable="false">').join('')+'</div>';}
    if(type==='audio'){
      const a=assets.get(item.assetId),wave=a?.waveform||[],n=Math.min(500,Math.max(10,Math.ceil(width/4)));
      detail='<div class="waveform">'+Array.from({length:n},(_,i)=>{const at=(item.trimStart+i/n*duration)/(a?.duration||1),v=wave[Math.min(wave.length-1,Math.floor(at*wave.length))]||0;return '<i style="height:'+Math.max(2,v*100)+'%"></i>';}).join('')+'</div>';
    }
    const prefix={clip:'▧',caption:'T',graphic:'✧',audio:'♫'}[type];
    const actions='<div class="clip-settings '+(width<84?'compact':'')+'"><button type="button" data-clip-setting="copy" aria-label="'+esc(label)+' 설정 복사" title="설정 복사 · Ctrl+Alt+C"><span class="settings-copy-symbol" aria-hidden="true"></span></button><button type="button" data-clip-setting="paste" aria-label="'+esc(label)+'에 설정 붙여넣기" title="설정 붙여넣기 · 선택 묶음이면 함께 적용 · Ctrl+Alt+V"><span class="settings-paste-symbol" aria-hidden="true"></span></button></div>';
    return '<div tabindex="0" role="button" aria-pressed="false" aria-label="'+esc(label)+' · '+duration.toFixed(2)+'초" class="timeline-block '+klass+'-block '+(width<30?'short-block':'')+'" data-type="'+type+'" data-id="'+item.id+'" data-start="'+start+'" data-end="'+(start+duration)+'" style="left:'+visibleStart*this.zoom+'px;width:'+width+'px" title="'+esc(label)+' · '+start.toFixed(2)+'–'+(start+duration).toFixed(2)+'초"><span class="block-grip start" data-edge="start"></span>'+detail+'<span class="block-label">'+prefix+' '+esc(label)+'</span>'+actions+'<span class="block-grip end" data-edge="end"></span></div>';
  }
  beginExternalDrag(kind,id){this.external={kind,id};this.callbacks.pause();}
  endExternalDrag(){this.external=null;this.clearPreview();this.stopScroll();}
  externalPlan(clientX,lane){
    if(!this.external)return null;
    const track=timelineTracks().find(t=>t.id===lane);if(!track)return null;
    const {kind,id}=this.external;let duration,type,name;
    if(kind==='asset'){
      const asset=assets.get(id);if(!asset)return null;
      duration=asset.kind==='image'?3:asset.duration;name=asset.file.name;
      type=asset.kind==='audio'?'audio':'clip';
    }else{
      const [preset,key]=id.split(':');
      if(preset==='t'){
        const time=this.xTime(clientX),pair=transitionPairs().filter(p=>p.trackId===lane).sort((a,b)=>Math.abs(a.center-time)-Math.abs(b.center-time))[0];
        if(!pair||Math.abs(pair.center-time)>Math.max(.3,30/this.zoom))return null;
        return {kind,id,type:'transition',lane,trackId:lane,start:pair.center,end:pair.center,name:'이 연결에 전환 적용',leftId:pair.left.id,rightId:pair.right.id};
      }
      if(preset!=='g'&&preset!=='c'&&preset!=='sfx')return null;
      if(preset==='sfx'){
        const effect=this.callbacks.sound?.(key);if(!effect)return null;
        type='audio';duration=effect.duration;name=effect.name;
      }else{
        type=preset==='g'?'graphic':'caption';duration=preset==='g'?(this.callbacks.graphic?.(key)?.duration||3):2.5;name=key;
      }
    }
    if(track.kind!==trackKind(type))return null;
    const time=this.snapTime(this.xTime(clientX),null,duration),placement=planPlacement(time,duration,lane);
    return {kind,id,type,lane,trackId:lane,name,duration,start:placement.start,end:placement.end,placement};
  }
  showPreview(plan,label){
    this.clearPreview();if(!plan)return;
    const track=$('track-'+(plan.trackId||plan.lane));if(!track)return;
    track.classList.add('drop-target');this.ensureWidth(plan.end);
    const ghost=document.createElement('div');ghost.className='timeline-insert-preview '+(plan.type==='transition'?'connection-preview':'');
    ghost.style.left=plan.start*this.zoom+'px';ghost.style.width=Math.max(12,(plan.end-plan.start)*this.zoom)+'px';
    ghost.setAttribute('aria-hidden','true');ghost.textContent=plan.name||'';track.append(ghost);
    const guide=document.createElement('div');guide.className='insertion-guide';guide.style.left=plan.start*this.zoom+'px';this.canvas.append(guide);
    const text=document.createElement('div');text.className='insertion-label';
    text.style.top=(this.scroll.scrollTop+2)+'px';
    text.style.left=clamp(plan.start*this.zoom,this.scroll.scrollLeft+4,Math.max(this.scroll.scrollLeft+4,this.scroll.scrollLeft+this.scroll.clientWidth-290))+'px';
    const shifted=plan.placement?.shifts?.length?' · 뒤 '+plan.placement.shifts.length+'개 +'+plan.placement.shift.toFixed(2)+'초':'';
    text.textContent=label||trackLabel(plan.trackId||plan.lane)+' · '+precise(plan.start)+' → '+precise(plan.end)+' · '+(plan.end-plan.start).toFixed(2)+'초'+shifted;
    this.canvas.append(text);this.preview=plan;
  }
  clearPreview(){
    this.canvas.querySelectorAll('.timeline-insert-preview,.insertion-guide,.insertion-label').forEach(node=>node.remove());
    this.canvas.querySelectorAll('.drop-target').forEach(node=>node.classList.remove('drop-target'));this.preview=null;
  }
  externalOver(event){
    if(!this.external||this.callbacks.busy?.())return;
    event.preventDefault();event.stopPropagation();
    const update=()=>{
      const lane=document.elementFromPoint(event.clientX,event.clientY)?.closest('.track')?.dataset.track;
      const plan=this.externalPlan(event.clientX,lane);event.dataTransfer.dropEffect=plan?'copy':'none';
      this.showPreview(plan,plan?.type==='transition'?'두 클립 사이에 전환 적용':undefined);
    };
    update();this.trackScroll(event,update);
  }
  async externalDrop(event){
    const asset=event.dataTransfer.getData('application/x-shorts-asset'),preset=event.dataTransfer.getData('application/x-shorts-preset');
    if(!asset&&!preset)return;event.preventDefault();event.stopPropagation();
    if(this.callbacks.busy?.()){this.endExternalDrag();return;}
    this.external={kind:asset?'asset':'preset',id:asset||preset};
    const plan=this.externalPlan(event.clientX,event.target.closest('.track')?.dataset.track);
    this.endExternalDrag();
    if(!plan){this.callbacks.error?.('영상·자막·그래픽은 영상 트랙에, 소리는 오디오 트랙에 놓아 주세요. 전환은 두 미디어 사이에 놓습니다.');return;}
    try{const result=await this.callbacks.drop(plan.kind,plan.id,plan.start,plan.lane,plan);if(result)this.reveal(result);}
    catch(error){this.callbacks.error?.(error.message);}
  }
  reveal(result,{preserveSelection=false}={}){
    if(!result)return;if(!preserveSelection)this.select(result.type,result.id,result.rightId);this.ensureWidth(result.end??result.start);
    const left=(result.start||0)*this.zoom;
    if(left<this.scroll.scrollLeft||left>this.scroll.scrollLeft+this.scroll.clientWidth-70)this.scroll.scrollLeft=Math.max(0,left-50);
    const node=[...this.canvas.querySelectorAll('.timeline-block,.transition-chip,.timeline-gap')].find(n=>n.dataset.type===result.type&&n.dataset.id===result.id);
    if(node){
      const row=node.closest('.track'),top=row?.offsetTop||0;
      if(top<this.scroll.scrollTop+27)this.scroll.scrollTop=Math.max(0,top-27);
      else if(top+(row?.offsetHeight||54)>this.scroll.scrollTop+this.scroll.clientHeight)this.scroll.scrollTop=top+(row?.offsetHeight||54)-this.scroll.clientHeight;
      node.classList.add('just-added');setTimeout(()=>node.classList.remove('just-added'),1600);}
    const notice=$('timelineNotice');if(notice)notice.textContent=(result.type==='transition'?'전환 선택':'클립 배치')+': '+precise(result.start||0)+(result.end!=null?'부터 '+(result.end-result.start).toFixed(2)+'초':'');
  }
  trackScroll(event,update){
    this.scrollPoint={x:event.clientX,y:event.clientY};this.scrollUpdate=update;
    if(this.scrollRaf)return;
    const run=()=>{
      this.scrollRaf=0;if(!this.scrollPoint)return;
      const rect=this.scroll.getBoundingClientRect(),{x,y}=this.scrollPoint;
      const delta=y<rect.top||y>rect.bottom?0:x>rect.right-30?Math.min(16,(x-rect.right+30)/2):x<rect.left+30?-Math.min(16,(rect.left+30-x)/2):0;
      const vertical=x<rect.left||x>rect.right?0:y>rect.bottom-24?Math.min(12,(y-rect.bottom+24)/2):y<rect.top+48?-Math.min(12,(rect.top+48-y)/2):0;
      if(delta||vertical){
        if(delta>0)this.ensureWidth((this.scroll.scrollLeft+this.scroll.clientWidth+delta)/this.zoom);
        const previous=this.scroll.scrollLeft,previousTop=this.scroll.scrollTop;
        this.scroll.scrollLeft=Math.max(0,previous+delta);this.scroll.scrollTop=Math.max(0,previousTop+vertical);
        if(previous!==this.scroll.scrollLeft||previousTop!==this.scroll.scrollTop)this.scrollUpdate?.();
      }
      this.scrollRaf=requestAnimationFrame(run);
    };this.scrollRaf=requestAnimationFrame(run);
  }
  stopScroll(){cancelAnimationFrame(this.scrollRaf);this.scrollRaf=0;this.scrollPoint=null;this.scrollUpdate=null;}
  startMarquee(event,gapId){
    const initial=this.selections.slice(),primary=this.selection,pointer=event.pointerId;
    const mode=event.ctrlKey||event.metaKey?'toggle':event.shiftKey?'add':'replace';
    const point=e=>{const rect=this.canvas.getBoundingClientRect();return{x:Math.max(0,e.clientX-rect.left),y:Math.max(27,e.clientY-rect.top)};};
    const origin=point(event),rect=this.canvas.getBoundingClientRect();
    const boxes=[...this.canvas.querySelectorAll('.timeline-block')].map(node=>{
      const r=node.getBoundingClientRect();return{type:node.dataset.type,id:node.dataset.id,left:r.left-rect.left,right:r.right-rect.left,top:r.top-rect.top,bottom:r.bottom-rect.top};
    });
    let last=event,moved=false,done=false,chosen=initial;
    const marquee=document.createElement('div');marquee.className='timeline-marquee';marquee.hidden=true;this.canvas.append(marquee);
    this.callbacks.pause();this.dragging=true;this.canvas.classList.add('is-marquee');this.canvas.setPointerCapture(pointer);
    const update=()=>{
      const p=point(last);if(!moved&&Math.hypot(last.clientX-event.clientX,last.clientY-event.clientY)<4)return;
      moved=true;marquee.hidden=false;
      Object.assign(marquee.style,{left:Math.min(origin.x,p.x)+'px',top:Math.min(origin.y,p.y)+'px',width:Math.abs(p.x-origin.x)+'px',height:Math.abs(p.y-origin.y)+'px'});
      chosen=combineSelection(initial,marqueeHits(origin,p,boxes),mode);this.selectMany(chosen,chosen.at(-1));
      const notice=$('timelineNotice');if(notice)notice.textContent=chosen.length+'개 클립 선택 · Shift는 더하기 · Ctrl은 선택 반전';
    };
    const move=e=>{if(e.pointerId!==pointer)return;last=e;update();this.trackScroll(e,update);};
    const finish=cancel=>{
      if(done)return;done=true;
      this.canvas.removeEventListener('pointermove',move);this.canvas.removeEventListener('pointerup',up);this.canvas.removeEventListener('pointercancel',cancelPointer);this.canvas.removeEventListener('lostpointercapture',cancelPointer);
      window.removeEventListener('keydown',escape);window.removeEventListener('blur',abort);
      this.stopScroll();this.dragging=false;this.canvas.classList.remove('is-marquee');marquee.remove();
      if(this.canvas.hasPointerCapture(pointer))this.canvas.releasePointerCapture(pointer);
      if(cancel){if(primary&&['gap','transition'].includes(primary.type))this.select(primary.type,primary.id,primary.rightId);else this.selectMany(initial,primary);return;}
      if(moved){this.selectMany(chosen,chosen.at(-1));this.callbacks.selectMany?.(this.selections,this.selection);}
      else if(mode==='replace'&&gapId)this.chooseGap(gapId);
      else if(mode==='replace'){this.selectMany([],null);this.callbacks.selectMany?.([],null);this.callbacks.seek(frameTime(origin.x/this.zoom));}
    };
    const up=e=>{if(e.pointerId===pointer)finish(false);},cancelPointer=e=>{if(e.pointerId===pointer)finish(true);},abort=()=>finish(true),escape=e=>{if(e.key==='Escape'){e.preventDefault();finish(true);}};
    this.canvas.addEventListener('pointermove',move);this.canvas.addEventListener('pointerup',up);this.canvas.addEventListener('pointercancel',cancelPointer);this.canvas.addEventListener('lostpointercapture',cancelPointer);
    window.addEventListener('keydown',escape);window.addEventListener('blur',abort);
  }
  dragGroup(event,node,range){
    const before=captureDocument(),refs=this.selections.slice(),origin=this.xTime(event.clientX),pointer=event.pointerId,excluded=new Set(refs.map(ref=>ref.id));
    let last=event,pending=null,changed=false,done=false;
    this.dragging=true;this.canvas.classList.add('is-dragging');node.setPointerCapture(pointer);
    const update=()=>{
      const delta=this.xTime(last.clientX)-origin;if(!changed&&Math.abs(delta*this.zoom)<3)return;
      changed=true;const time=this.snapTime(range.start+delta,excluded,range.duration);
      pending=planBatchMove(refs,time-range.start,before);this.clearPreview();
      this.canvas.querySelectorAll('.timeline-block.selected').forEach(n=>n.classList.add('dragging'));
      for(const move of pending.moves||[]){
        const row=$('track-'+move.trackId);if(!row)continue;
        const ghost=document.createElement('div');ghost.className='timeline-insert-preview'+(pending.ok?'':' invalid');ghost.style.left=move.start*this.zoom+'px';ghost.style.width=Math.max(12,move.duration*this.zoom)+'px';row.append(ghost);this.ensureWidth(move.end);
      }
      const notice=$('timelineNotice');if(notice)notice.textContent=pending.ok?refs.length+'개 함께 이동 · 트랙과 클립 사이 간격 유지':pending.reason;
    };
    const move=e=>{if(e.pointerId!==pointer)return;last=e;update();this.trackScroll(e,update);};
    const finish=cancel=>{
      if(done)return;done=true;node.removeEventListener('pointermove',move);node.removeEventListener('pointerup',up);node.removeEventListener('pointercancel',cancelPointer);node.removeEventListener('lostpointercapture',cancelPointer);window.removeEventListener('keydown',escape);window.removeEventListener('blur',abort);
      this.stopScroll();this.clearPreview();this.dragging=false;this.canvas.classList.remove('is-dragging');
      if(node.hasPointerCapture(pointer))node.releasePointerCapture(pointer);
      try{if(!cancel&&changed&&pending){if(applyBatchMove(pending))this.callbacks.commit(before,'선택 클립 함께 이동');}}
      catch(error){this.callbacks.error?.(error.message);}
      this.render();
    };
    const up=e=>{if(e.pointerId===pointer)finish(false);},cancelPointer=e=>{if(e.pointerId===pointer)finish(true);},abort=()=>finish(true),escape=e=>{if(e.key==='Escape'){e.preventDefault();finish(true);}};
    node.addEventListener('pointermove',move);node.addEventListener('pointerup',up);node.addEventListener('pointercancel',cancelPointer);node.addEventListener('lostpointercapture',cancelPointer);window.addEventListener('keydown',escape);window.addEventListener('blur',abort);
  }
  pointerDown(event){
    if(event.button!==0||this.dragging||this.callbacks.busy?.()||event.isPrimary===false)return;
    if(event.target.closest('[data-clip-setting]'))return;
    const hit=event.target.closest('.timeline-block,.timeline-gap,.transition-chip');
    const info=hit?{type:hit.dataset.type,id:hit.dataset.id,right:hit.dataset.right}:null;
    const typing=/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
    if(typing)document.activeElement.blur();
    // 속성의 change가 타임라인을 다시 그릴 수 있으므로 포커스를 옮긴 뒤 현재 노드를 찾습니다.
    const target=info?[...this.canvas.querySelectorAll('.timeline-block,.timeline-gap,.transition-chip')].find(n=>n.dataset.type===info.type&&n.dataset.id===info.id):null;
    if(info?.type==='transition'){
      if(typing){event.preventDefault();target?.focus({preventScroll:true});this.callbacks.transition(info.id,info.right);}
      return;
    }
    if(info?.type==='gap'){
      event.preventDefault();this.canvas.focus({preventScroll:true});this.startMarquee(event,info.id);return;
    }
    const node=target;
    (node||this.canvas).focus({preventScroll:true});
    if(!node){
      event.preventDefault();this.callbacks.pause();
      const row=event.target.closest('.track');if(row)this.activateTrack(row.dataset.track);
      if(!event.target.closest('#ruler,#playhead')){this.startMarquee(event);return;}
      const seek=e=>{const time=frameTime(this.xTime(e.clientX));this.ensureWidth(time);this.callbacks.seek(time);};
      const pointer=event.pointerId,finish=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);window.removeEventListener('pointercancel',up);window.removeEventListener('blur',finish);window.removeEventListener('keydown',escape);};
      seek(event);const move=e=>{if(e.pointerId===pointer)seek(e);},up=e=>{if(e.pointerId===pointer)finish();},escape=e=>{if(e.key==='Escape'){e.preventDefault();finish();}};
      window.addEventListener('pointermove',move);window.addEventListener('pointerup',up);window.addEventListener('pointercancel',up);window.addEventListener('blur',finish);window.addEventListener('keydown',escape);return;
    }
    event.preventDefault();const {type,id}=node.dataset,range=itemRange(type,id);if(!range)return;
    this.callbacks.pause();const ref={type,id},edge=event.target.closest('[data-edge]')?.dataset.edge;
    if(event.ctrlKey||event.metaKey||event.shiftKey){this.selectMany(combineSelection(this.selections,[ref],'toggle'),ref);this.callbacks.selectMany?.(this.selections,this.selection);return;}
    if(!edge&&this.selections.length>1&&this.selections.some(r=>selectionKey(r)===selectionKey(ref))){this.selectMany(this.selections,ref);this.callbacks.selectMany?.(this.selections,this.selection);this.dragGroup(event,node,range);return;}
    this.select(type,id);this.callbacks.select(type,id);
    const before=captureDocument(),origin=this.xTime(event.clientX),original={...range.item};
    let changed=false,pending=null,lastEvent=event,done=false;
    this.dragging=true;this.canvas.classList.add('is-dragging');node.setPointerCapture(event.pointerId);
    const update=()=>{
      const delta=this.xTime(lastEvent.clientX)-origin;
      const hovered=document.elementFromPoint(lastEvent.clientX,lastEvent.clientY)?.closest('.track');
      const target=edge?range.trackId:hovered?.dataset.track;
      const compatible=timelineTracks().some(t=>t.id===target&&t.kind===trackKind(type));
      if(!changed&&Math.abs(delta*this.zoom)<3&&target===range.trackId)return;
      changed=true;node.classList.add('dragging');
      if(!compatible){pending=null;this.clearPreview();return;}
      if(!edge){
        const time=this.snapTime(range.start+delta,id,range.duration);
        pending=target===range.trackId&&Math.abs(time-range.start)<1e-6
          ?{start:range.start,end:range.end,trackId:target,noop:true}
          :planPlacement(time,range.duration,target,id);
      }else{
        const time=this.snapTime((edge==='end'?range.end:range.start)+delta,id);
        pending={...planItemTrim(type,id,edge,time),trackId:range.trackId};
      }
      this.showPreview({type,lane:target,trackId:target,name:original.name||original.text,start:pending.start,end:pending.end,placement:!edge?pending:null});
    };
    const move=e=>{if(e.pointerId!==event.pointerId)return;lastEvent=e;update();this.trackScroll(e,update);};
    const finish=cancel=>{
      if(done)return;done=true;
      node.removeEventListener('pointermove',move);node.removeEventListener('pointerup',up);node.removeEventListener('pointercancel',cancelPointer);node.removeEventListener('lostpointercapture',cancelPointer);window.removeEventListener('keydown',escape);window.removeEventListener('blur',abort);
      this.stopScroll();this.clearPreview();this.dragging=false;this.canvas.classList.remove('is-dragging');
      if(node.hasPointerCapture(event.pointerId))node.releasePointerCapture(event.pointerId);
      if(!cancel&&changed&&pending&&!pending.noop){
        try{
          if(JSON.stringify(captureDocument())!==JSON.stringify(before))throw new Error('드래그 중 편집 내용이 변경되었습니다. 다시 시도해 주세요.');
          if(!edge)placeTimelineItem(type,range.item,pending);
          else applyItemTrim(pending);
          syncAnchoredItems();this.callbacks.commit(before,edge?'클립 구간 조절':'클립 위치 이동');
          this.reveal({type,id,trackId:pending.trackId,start:pending.start,end:pending.end});
        }catch(error){this.callbacks.error?.(error.message);this.render();}
      }else this.render();
    };
    const up=e=>{if(e.pointerId===event.pointerId)finish(false);},cancelPointer=e=>{if(e.pointerId===event.pointerId)finish(true);},abort=()=>finish(true),escape=e=>{if(e.key==='Escape'){e.preventDefault();finish(true);}};
    node.addEventListener('pointermove',move);node.addEventListener('pointerup',up);node.addEventListener('pointercancel',cancelPointer);node.addEventListener('lostpointercapture',cancelPointer);window.addEventListener('keydown',escape);window.addEventListener('blur',abort);
  }
}
