// 드래그 중에는 잡은 DOM을 유지하고, 놓을 때 한 번만 편집 명령을 적용합니다.
import { project, buildLayout, totalDuration, transitionPairs, syncAnchoredItems, timelineTracks, trackIdFor, trackLabel, trackItems, trackKind, TRACK_ROLES, isTrackLocked } from './state.js';
import { assets, captureDocument } from './project-store.js';
import { trackBadge } from './state.js';
import { TRANSITIONS } from './presets.js';
import { frameTime, itemRange, planVideoPlacement, placeVideoClip, planClipTrim, applyClipTrim, setItemRange, planPlacement, placeTimelineItem, trackGaps, planItemTrim, applyItemTrim, planLinkedTrim, applyLinkedTrim, LOCKED_TRACK_REASON } from './timeline-edits.js';
import { clamp } from './util.js';
import { selectionKey, selectionRefs, combineSelection, marqueeHits, planBatchMove, applyBatchMove } from './batch-edits.js';
import { expandLinked, linkedRefs, activeLinkIds } from './link-groups.js';
import { uncertainMosaicRanges } from './mosaic.js';
import { MobileTimelineGestures } from './mobile-timeline-gestures.js';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const stamp = t => Math.floor(t/60).toString().padStart(2,'0')+':'+Math.floor(t%60).toString().padStart(2,'0');
const precise = t => stamp(t)+'.'+Math.floor((t % 1) * 100).toString().padStart(2,'0');
export const MIN_TIMELINE_ZOOM = 3;
export const MAX_TIMELINE_ZOOM = 720;
export const normalizeTimelineZoom = value => clamp(Number(value)||MIN_TIMELINE_ZOOM,MIN_TIMELINE_ZOOM,MAX_TIMELINE_ZOOM);
export const TIMELINE_OVERVIEW_ZOOM = 18;
export const isTimelineOverviewZoom = value => normalizeTimelineZoom(value)<TIMELINE_OVERVIEW_ZOOM;
const RULER_STEPS = [1,2,5,10,20,30,60,120,300,600,1200,3600];
/** 라벨이 겹치지 않도록 현재 배율에서 약 50px 이상 떨어지는 눈금 간격을 고릅니다. */
export const timelineRulerIncrement = value => {
  const zoom=normalizeTimelineZoom(value);
  return RULER_STEPS.find(step=>step*zoom>=50)||RULER_STEPS.at(-1);
};
export const timelineBlockPixelWidth = (duration,value) => {
  const span=Math.max(0,Number(duration)||0)*normalizeTimelineZoom(value);
  // 개요 배율에서는 최소 12px를 강제하면 이웃 클립의 클릭 영역까지 덮습니다.
  return isTimelineOverviewZoom(value)?span-Math.min(2,span*.2):Math.max(12,span-2);
};


export class Timeline {
  constructor(callbacks) {
    this.callbacks=callbacks;this.zoom=70;this.snapping=true;this.selection=null;this.selections=[];this.explicit=[];this.linkIds=new Set();this.menu=null;this.time=0;this.dragging=false;
    this.activeTrackId='v1';this.activeAudioTrackId='a1';
    this.activeRoleTracks=Object.fromEntries(TRACK_ROLES.map(role=>[role.id,timelineTracks().find(t=>t.role===role.id)?.id]));
    this.activeHeaderId='v1';
    this.scroll=$('timelineScroll');this.canvas=$('timelineCanvas');this.external=null;this.preview=null;
    this.mobileMultiSelect=false;this.mobileTrackView=null;this.mobileGestures=new MobileTimelineGestures(this);
    $('timelineZoom').oninput=e=>this.setZoom(Number(e.target.value));
    $('zoomIn').onclick=()=>this.setZoom(this.zoom*1.25);
    $('zoomOut').onclick=()=>this.setZoom(this.zoom/1.25);
    $('fitTimeline').onclick=()=>this.fit();$('snap').onclick=()=>this.toggleSnap();
    this.canvas.addEventListener('pointerdown',e=>this.pointerDown(e));
    this.canvas.addEventListener('contextmenu',e=>{if(this.mobileGestures.consumeContextMenu(e)){e.preventDefault();return;}this.openMenu(e);});
    this.canvas.addEventListener('click',e=>{
      if(!this.isMobileTargetVisible(e.target)){e.preventDefault();return;}
      if(this.mobileGestures.consumeClick(e)){e.preventDefault();e.stopPropagation();return;}
      const warn=e.target.closest('[data-mosaic-warn]');
      if(warn){
        e.preventDefault();e.stopPropagation();
        if(this.dragging||this.callbacks.busy?.())return;
        const at=Number(warn.dataset.mosaicWarn);
        this.callbacks.pause();this.callbacks.seek(at);this.ensureWidth(at);
        this.notice('추적을 놓친 구간으로 이동했습니다 · '+precise(at)+' · 모자이크 위치를 확인하고 다시 추적하세요.','warn');
        return;
      }
      const settings=e.target.closest('[data-clip-setting]');
      if(settings){e.preventDefault();e.stopPropagation();if(this.dragging||this.callbacks.busy?.())return;const block=settings.closest('.timeline-block');this.callbacks[settings.dataset.clipSetting==='copy'?'copySettings':'pasteSettings']?.({type:block.dataset.type,id:block.dataset.id});return;}
      const button=e.target.closest('[data-transition]');
      if(button&&!this.dragging){e.stopPropagation();this.callbacks.transition(button.dataset.transition,button.dataset.right);}
    });
    $('trackHeaders').addEventListener('click',e=>{
      if(this.callbacks.busy?.())return;
      const toggle=e.target.closest('[data-track-switch]');
      if(toggle){this.callbacks.trackSwitch?.(toggle.dataset.track,toggle.dataset.trackSwitch);return;}
      const add=e.target.closest('[data-add-track]');
      if(add){this.callbacks.addTrack?.(add.dataset.addTrack);return;}
      const remove=e.target.closest('[data-remove-track]');
      if(remove){this.callbacks.removeTrack?.(remove.dataset.removeTrack);return;}
      const head=e.target.closest('[data-track-select]');
      if(head)this.activateTrack(head.dataset.trackSelect);
    });
    this.scroll.addEventListener('scroll',()=>{$('trackHeaders').style.transform='translateY(-'+this.scroll.scrollTop+'px)';});
    this.canvas.addEventListener('keydown',e=>{
      if(!this.isMobileTargetVisible(e.target))return;
      if(!['Enter',' '].includes(e.key)||this.callbacks.busy?.())return;
      if(e.target.closest('[data-clip-setting]'))return;
      const button=e.target.closest('.timeline-block,.timeline-gap,.transition-chip');
      if(!button)return;e.preventDefault();e.stopPropagation();
      const hitRange=button.dataset.type==='gap'?null:itemRange(button.dataset.type==='transition'?'clip':button.dataset.type,button.dataset.id);
      if(hitRange&&this.refuseLocked(hitRange.trackId))return;
      if(button.dataset.type==='gap')this.chooseGap(button.dataset.id);
      else if(button.dataset.type==='transition')this.callbacks.transition(button.dataset.id,button.dataset.right);
      else if(e.shiftKey||e.ctrlKey||e.metaKey){const ref={type:button.dataset.type,id:button.dataset.id};this.selectMany(combineSelection(this.selections,[ref],'toggle'),ref);this.callbacks.selectMany?.(this.explicit,this.selection);}
      else{this.select(button.dataset.type,button.dataset.id);this.callbacks.select(button.dataset.type,button.dataset.id);}
    });
    this.canvas.addEventListener('dragover',e=>this.externalOver(e));
    this.canvas.addEventListener('dragleave',e=>{if(!this.canvas.contains(e.relatedTarget)){this.clearPreview();this.stopScroll();}});
    this.canvas.addEventListener('drop',e=>this.externalDrop(e));
    document.addEventListener('dragend',()=>this.endExternalDrag());
    this.scroll.addEventListener('wheel',e=>{
      if(e.ctrlKey||e.metaKey){e.preventDefault();this.setZoom(this.zoom*(e.deltaY<0?1.12:.89),e.clientX);}
    },{passive:false});
  }
  /** 모바일은 상시 안내줄 없이 편집하고, 거절 사유만 기존 토스트로 알립니다. */
  notice(text,tone='info'){
    if(document.body?.classList.contains('mobile-ui')&&tone==='warn'&&text)this.callbacks.error?.(text);
    const host=$('timelineNotice');if(!host)return;
    host.textContent=text||'';host.dataset.tone=tone;
  }
  setZoom(value,anchorClientX=null){
    if(this.dragging)return;
    const next=normalizeTimelineZoom(value),previous=this.zoom;
    const rect=this.scroll.getBoundingClientRect();
    const anchor=Number.isFinite(anchorClientX)?clamp(anchorClientX-rect.left,0,rect.width):rect.width/2;
    const time=(this.scroll.scrollLeft+anchor)/Math.max(MIN_TIMELINE_ZOOM,previous);
    this.zoom=next;$('timelineZoom').value=String(next);this.render();
    this.scroll.scrollLeft=Math.max(0,time*next-anchor);
  }
  fit(){this.setZoom((this.scroll.clientWidth-70)/Math.max(4,totalDuration()),this.scroll.getBoundingClientRect().left);this.scroll.scrollLeft=0;}
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
  /** 모바일의 행 표시는 편집 문서의 숨김·음소거와 별개로 관리합니다. */
  setMobileTrackView({all=this.mobileTrackView?.all??false,trackId=this.mobileTrackView?.trackId}={}){
    if(!document.body?.classList.contains('mobile-ui')){this.restoreMobileTrackView();return null;}
    const next=this.resolveMobileTrackView({all:all===true,trackId}),previous=this.mobileTrackView;
    const changed=!previous||previous.all!==next.all||(!next.all&&previous.trackId!==next.trackId);
    if(changed){
      this.cancelMobileGestures();this.cancelPointerDrag?.();this.closeMenu();this.clearPreview();this.stopScroll();
    }
    this.mobileTrackView=next;this.applyMobileTrackView();
    if(changed){this.scroll.scrollTop=0;const headers=$('trackHeaders');if(headers)headers.style.transform='translateY(0px)';}
    return {...this.mobileTrackView};
  }
  resolveMobileTrackView(view){
    const tracks=timelineTracks(),video=id=>tracks.find(track=>track.id===id&&track.role==='video');
    const selected=tracks.find(track=>track.id===view.trackId)||video(this.activeRoleTracks?.video)||video(this.activeTrackId)||tracks.find(track=>track.role==='video')||tracks[0];
    return {all:view.all===true,trackId:selected?.id||null};
  }
  applyMobileTrackView(){
    const headers=$('trackHeaders'),panel=this.canvas.closest?.('.timeline-panel');
    const nodes=[...this.canvas.querySelectorAll('.track'),...(headers?.querySelectorAll('.track-head')||[])];
    if(!document.body?.classList.contains('mobile-ui')||!this.mobileTrackView){
      this.mobileTrackView=null;
      for(const node of nodes)delete node.dataset.mobileVisible;
      if(panel)delete panel.dataset.mobileTrackView;
      return null;
    }
    this.mobileTrackView=this.resolveMobileTrackView(this.mobileTrackView);
    const {all,trackId}=this.mobileTrackView;
    if(panel)panel.dataset.mobileTrackView=all?'all':'focus';
    for(const node of nodes){
      const id=node.dataset.track||node.querySelector('[data-track-select]')?.dataset.trackSelect;
      const visible=String(all||id===trackId);if(node.dataset.mobileVisible!==visible)node.dataset.mobileVisible=visible;
    }
    return {...this.mobileTrackView};
  }
  restoreMobileTrackView(){
    const previous=this.mobileTrackView;this.mobileTrackView=null;
    if(previous){this.cancelMobileGestures();this.cancelPointerDrag?.();this.closeMenu();this.clearPreview();this.stopScroll();}
    this.applyMobileTrackView();
  }
  isMobileTrackVisible(id){
    return !document.body?.classList.contains('mobile-ui')||!this.mobileTrackView||this.mobileTrackView.all||id===this.mobileTrackView.trackId;
  }
  isMobileTargetVisible(target){
    const row=target?.closest?.('.track');return !row||this.isMobileTrackVisible(row.dataset.track);
  }
  select(type,id,rightId){
    const gap=type==='gap'?timelineTracks().flatMap(t=>trackGaps(t.id)).find(g=>g.id===id):null;
    this.selection=type?{type,id,rightId,...(gap||{})}:null;
    // 연결된 짝은 화면 표시와 구조 편집에만 더합니다. 속성 편집은 클릭한 항목만 씁니다.
    this.explicit=['clip','caption','graphic','audio'].includes(type)?[{type,id}]:[];
    this.selections=selectionRefs(expandLinked(this.explicit,project));
    const range=type==='transition'?itemRange('clip',id):itemRange(type,id);
    if(gap||range)this.activateTrack((gap||range).trackId);
    this.paintSelection();
  }
  selectMany(refs,primary){
    this.explicit=selectionRefs(refs);
    this.selections=selectionRefs(expandLinked(this.explicit,project));
    this.selection=this.selections.find(ref=>primary&&selectionKey(ref)===selectionKey(primary))||this.explicit.at(-1)||this.selections.at(-1)||null;
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
  refuseLocked(trackId){
    if(!isTrackLocked(trackId))return false;
    this.notice(trackLabel(trackId)+' · '+LOCKED_TRACK_REASON,'warn');
    return true;
  }
  chooseGap(id) {
    const gap=timelineTracks().flatMap(t=>trackGaps(t.id)).find(g=>g.id===id);if(!gap)return;
    if(this.refuseLocked(gap.trackId))return;
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
    const increment=timelineRulerIncrement(this.zoom);let html='';
    for(let t=0;t<width/this.zoom;t+=increment){
      html+='<div class="ruler-mark" style="left:'+t*this.zoom+'px"><span>'+stamp(t)+'</span></div>';
      for(let k=1;k<4;k++)html+='<div class="ruler-mark minor" style="left:'+(t+increment*k/4)*this.zoom+'px"></div>';
    }
    $('ruler').innerHTML=html;
  }
  render(){
    if(this.dragging)return;
    this.closeMenu();this.linkIds=activeLinkIds(project);
    const layout=buildLayout(),width=Math.max(this.scroll.clientWidth,Math.ceil((Math.max(layout.total,this.time)+3)*this.zoom));
    this.canvas.style.width=width+'px';this.renderRuler(width);
    const registry=timelineTracks();
    const rows=[...registry.filter(t=>t.kind==='visual').reverse(),...registry.filter(t=>t.kind==='audio')];
    const pairs=transitionPairs();
    $('timelineRows').innerHTML=rows.map(track=>{
      const items=trackItems(track.id,project,layout);
      const state=(track.locked?' is-locked':'')+(track.hidden?' is-hidden':'')+(track.muted?' is-muted':'')+(track.solo?' is-solo':'');
      return '<div id="track-'+track.id+'" class="track '+(track.kind==='audio'?'audio-track':'visual-track')+' '+track.role+'-track'+state+'" data-track="'+track.id+'" data-kind="'+track.kind+'">'+
        trackGaps(track.id).map(gap=>'<div tabindex="0" role="button" aria-pressed="false" aria-label="'+trackLabel(track.id)+' 빈 공간 '+gap.duration.toFixed(2)+'초 · S로 닫기" class="timeline-gap" data-type="gap" data-id="'+gap.id+'" style="left:'+gap.start*this.zoom+'px;width:'+Math.max(1,gap.duration*this.zoom-1)+'px"><span>빈 공간 · '+gap.duration.toFixed(2)+'초</span></div>').join('')+
        items.map(e=>this.block(e.type,e.item,e.start,e.duration,e.start+(e.overlapIn||0)/2,e.end-(e.overlapOut||0)/2)).join('')+
        pairs.filter(p=>p.trackId===track.id).map(pair=>this.transitionButton(pair)).join('')+'</div>';
    }).join('');
    $('trackHeaders').innerHTML=rows.map(track=>{
      const count=trackItems(track.id,project,layout).length;
      const active=track.id===this.activeHeaderId,role=TRACK_ROLES.find(role=>role.id===track.role);
      const sw=(name,symbol,label,on)=>'<button type="button" class="track-switch switch-'+name+(on?' on':'')+'" data-track-switch="'+name+'" data-track="'+track.id+'" aria-pressed="'+on+'" aria-label="'+esc(trackLabel(track.id)+' '+label)+'" title="'+esc(label)+'">'+symbol+'</button>';
      const switches='<div class="track-switches">'
        +(track.kind==='visual'
          ?sw('hidden',track.hidden?'◌':'◉','화면에서 숨기기 · 클립에 붙은 소리는 그대로 납니다',track.hidden===true)
          :sw('muted','M','음소거 · 미리보기와 내보내기 양쪽에서 뺍니다',track.muted===true)
            +sw('solo','S','이 트랙만 듣기 · 미리보기에서만 적용되고 내보내기는 따르지 않습니다',track.solo===true))
        +sw('locked','L','편집 잠금 · 화면과 소리는 그대로입니다',track.locked===true)+'</div>';
      return '<div class="track-head '+track.kind+'-head '+track.role+'-head"><button class="track-selector '+(active?'active':'')+'" data-track-select="'+track.id+'" aria-pressed="'+active+'" title="이 용도의 새 클립을 추가할 트랙"><span class="track-code">'+trackBadge(track.id)+'</span><strong>'+trackLabel(track.id)+'</strong><small>'+count+'</small></button>'+switches+'<button class="add-track" data-add-track="'+track.id+'" aria-label="'+trackLabel(track.id)+(track.kind==='visual'?' 바로 위에 ':' 바로 아래에 ')+role.label+' 트랙 추가" title="'+(track.kind==='visual'?'바로 위에':'바로 아래에')+' '+role.label+' 트랙 추가" '+(registry.filter(t=>t.kind===track.kind).length>=24?'disabled':'')+'>+</button><button class="remove-track" data-remove-track="'+track.id+'" aria-label="'+trackLabel(track.id)+' 빈 트랙 삭제" '+(count||(!role.optional&&registry.filter(t=>t.role===track.role).length<2)?'disabled':'')+'>×</button></div>';
    }).join('');
    $('trackHeaders').style.transform='translateY(-'+this.scroll.scrollTop+'px)';
    $('totalDuration').textContent=stamp(layout.total);$('sequenceInfo').textContent=layout.items.length+' 클립 · '+layout.total.toFixed(1)+'초';
    this.applyMobileTrackView();this.tick(this.time);this.paintSelection();this.updateSettingButtons();
  }
  transitionButton(pair){
    const name=TRANSITIONS.find(transition=>transition.id===pair.type)?.name||'전환';
    const label=(pair.left.clip.name||'앞 클립')+' ↔ '+(pair.right.clip.name||'뒤 클립')+' · '+name+(pair.duration?' '+pair.duration.toFixed(2)+'초':'');
    const band=pair.duration?'<span class="transition-band" style="left:'+pair.start*this.zoom+'px;width:'+pair.duration*this.zoom+'px"></span>':'';
    // 25px 버튼이 여러 편집점을 덮는 개요 배율에서는 실제 전환 구간만 남깁니다.
    if(isTimelineOverviewZoom(this.zoom))return band;
    return band+'<button type="button" class="transition-chip '+(pair.duration?'':'cut-connector')+'" data-type="transition" data-id="'+pair.left.clip.id+'" data-transition="'+pair.left.clip.id+'" data-right="'+pair.right.clip.id+'" aria-label="'+esc(label)+' 전환 편집" aria-pressed="false" style="left:'+pair.center*this.zoom+'px" title="'+esc(label)+' · 클릭하여 편집">'+'<span class="'+(pair.duration?'transition-symbol':'plus-symbol')+'" aria-hidden="true"></span></button>';
  }
  block(type,item,start,duration,visibleStart=start,visibleEnd=start+duration){
    const klass={clip:'video',caption:'caption',graphic:'graphic',audio:'audio'}[type],label=item.name||item.text||'클립';
    const overview=isTimelineOverviewZoom(this.zoom),width=timelineBlockPixelWidth(visibleEnd-visibleStart,this.zoom);let detail='';
    if(type==='clip'&&item.thumb){const n=Math.min(100,Math.ceil(width/46)+1);detail='<div class="thumb-strip">'+Array(n).fill('<img src="'+item.thumb+'" alt="" draggable="false">').join('')+'</div>';}
    if(type==='audio'){
      const a=assets.get(item.assetId),wave=a?.waveform||[],n=Math.min(500,Math.max(10,Math.ceil(width/4)));
      detail='<div class="waveform">'+Array.from({length:n},(_,i)=>{const at=(item.trimStart+i/n*duration)/(a?.duration||1),v=wave[Math.min(wave.length-1,Math.floor(at*wave.length))]||0;return '<i style="height:'+Math.max(2,v*100)+'%"></i>';}).join('')+'</div>';
    }
    const prefix={clip:'▧',caption:'T',graphic:'✧',audio:'♫'}[type];
    const linked=this.linkIds?.has(item.linkId);
    // 추적을 놓친 구간은 재생 막대를 옮겨 봐야만 알 수 있었습니다. 클립 위에 바로 표시합니다.
    let warnings='',warnCount=0;
    if(type==='clip'){
      for(const range of uncertainMosaicRanges(item)){
        const from=Math.max(start,start+range.start-item.trimStart),to=Math.min(start+duration,start+range.end-item.trimStart);
        if(to-from<=1e-6)continue;
        warnCount++;
        const left=Math.max(0,(from-visibleStart)*this.zoom),right=Math.min(width,(to-visibleStart)*this.zoom);
        const label='추적을 놓친 구간 '+from.toFixed(2)+'–'+to.toFixed(2)+'초 · 눌러서 이동';
        warnings+='<button type="button" class="mosaic-warn" data-mosaic-warn="'+from+'" aria-label="'+esc(label)+'" title="'+esc(label)+'" style="left:'+left+'px;width:'+Math.max(2,right-left)+'px"></button>';
      }
    }
    const linkMark=linked?'<span class="link-mark" aria-hidden="true" title="연결된 클립 · 함께 움직입니다">⛓</span>':'';
    const actions='<div class="clip-settings '+(width<84?'compact':'')+'"><button type="button" data-clip-setting="copy" aria-label="'+esc(label)+' 설정 복사" title="설정 복사 · Ctrl+Alt+C"><span class="settings-copy-symbol" aria-hidden="true"></span></button><button type="button" data-clip-setting="paste" aria-label="'+esc(label)+'에 설정 붙여넣기" title="설정 붙여넣기 · 선택 묶음이면 함께 적용 · Ctrl+Alt+V"><span class="settings-paste-symbol" aria-hidden="true"></span></button></div>';
    return '<div tabindex="0" role="button" aria-pressed="false" aria-label="'+esc(label)+' · '+duration.toFixed(2)+'초'+(linked?' · 연결됨':'')+'" class="timeline-block '+klass+'-block '+(linked?'linked-block ':'')+(overview?'timeline-overview-block ':'')+(width<30?'short-block':'')+'" data-type="'+type+'" data-id="'+item.id+'" data-start="'+start+'" data-end="'+(start+duration)+'" style="left:'+visibleStart*this.zoom+'px;width:'+width+'px" title="'+esc(label)+' · '+start.toFixed(2)+'–'+(start+duration).toFixed(2)+'초"><span class="block-grip start" data-edge="start"></span>'+detail+'<span class="block-label">'+prefix+' '+esc(label)+'</span>'+linkMark+warnings+actions+'<span class="block-grip end" data-edge="end"></span></div>';
  }
  beginExternalDrag(kind,id){this.external={kind,id};this.callbacks.pause();}
  endExternalDrag(){this.external=null;this.clearPreview();this.stopScroll();}
  externalPlan(clientX,lane){
    if(!this.external||!this.isMobileTrackVisible(lane))return null;
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
    const track=$('track-'+(plan.trackId||plan.lane));if(!track||!this.isMobileTrackVisible(plan.trackId||plan.lane))return;
    const invalid=plan.placement?.ok===false,swap=plan.placement?.swap;
    track.classList.add('drop-target');this.ensureWidth(Math.max(plan.end,swap?.end||0));
    const ghost=document.createElement('div');ghost.className='timeline-insert-preview '+(invalid?'invalid ':'')+(plan.type==='transition'?'connection-preview':'');
    ghost.style.left=plan.start*this.zoom+'px';ghost.style.width=Math.max(12,(plan.end-plan.start)*this.zoom)+'px';
    ghost.setAttribute('aria-hidden','true');ghost.textContent=plan.name||'';track.append(ghost);
    if(swap){
      const other=document.createElement('div');other.className='timeline-insert-preview swap-preview'+(invalid?' invalid':'');
      other.style.left=swap.start*this.zoom+'px';other.style.width=Math.max(12,swap.duration*this.zoom)+'px';
      other.setAttribute('aria-hidden','true');other.textContent='↔ '+swap.name;track.append(other);
    }
    const guide=document.createElement('div');guide.className='insertion-guide';guide.style.left=plan.start*this.zoom+'px';this.canvas.append(guide);
    const text=document.createElement('div');text.className='insertion-label';
    text.style.top=(this.scroll.scrollTop+2)+'px';
    text.style.left=clamp(plan.start*this.zoom,this.scroll.scrollLeft+4,Math.max(this.scroll.scrollLeft+4,this.scroll.scrollLeft+this.scroll.clientWidth-290))+'px';
    const shifted=plan.placement?.shifts?.length?' · 뒤 '+plan.placement.shifts.length+'개 +'+plan.placement.shift.toFixed(2)+'초':'';
    text.textContent=invalid?plan.placement.reason:label||trackLabel(plan.trackId||plan.lane)+' · '+precise(plan.start)+' → '+precise(plan.end)+' · '+(plan.end-plan.start).toFixed(2)+'초'+(swap?' · 두 클립만 자리 교환':shifted);
    this.notice(text.textContent,invalid?'warn':'info');
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
    this.notice((result.type==='transition'?'전환 선택':result.mode==='swap'?'두 클립 자리 교환':'클립 배치')+': '+precise(result.start||0)+(result.end!=null?'부터 '+(result.end-result.start).toFixed(2)+'초':''));
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
    const boxes=[...this.canvas.querySelectorAll('.track:not(.is-locked) .timeline-block')].filter(node=>this.isMobileTargetVisible(node)).map(node=>{
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
      this.notice(chosen.length+'개 클립 선택 · Shift는 더하기 · Ctrl은 선택 반전');
    };
    const move=e=>{if(e.pointerId!==pointer)return;last=e;update();this.trackScroll(e,update);};
    const finish=cancel=>{
      if(done)return;done=true;
      this.canvas.removeEventListener('pointermove',move);this.canvas.removeEventListener('pointerup',up);this.canvas.removeEventListener('pointercancel',cancelPointer);this.canvas.removeEventListener('lostpointercapture',cancelPointer);
      window.removeEventListener('keydown',escape);window.removeEventListener('blur',abort);
      this.stopScroll();this.dragging=false;this.canvas.classList.remove('is-marquee');marquee.remove();
      if(this.canvas.hasPointerCapture(pointer))this.canvas.releasePointerCapture(pointer);
      if(cancel){if(primary&&['gap','transition'].includes(primary.type))this.select(primary.type,primary.id,primary.rightId);else this.selectMany(initial,primary);return;}
      if(moved){this.selectMany(chosen,chosen.at(-1));this.callbacks.selectMany?.(this.explicit,this.selection);}
      else if(mode==='replace'&&gapId)this.chooseGap(gapId);
      else if(mode==='replace'){this.selectMany([],null);this.callbacks.selectMany?.([],null);this.callbacks.seek(frameTime(origin.x/this.zoom));}
    };
    const up=e=>{if(e.pointerId===pointer)finish(false);},cancelPointer=e=>{if(e.pointerId===pointer)finish(true);},abort=()=>finish(true),escape=e=>{if(e.key==='Escape'){e.preventDefault();finish(true);}};
    this.canvas.addEventListener('pointermove',move);this.canvas.addEventListener('pointerup',up);this.canvas.addEventListener('pointercancel',cancelPointer);this.canvas.addEventListener('lostpointercapture',cancelPointer);
    window.addEventListener('keydown',escape);window.addEventListener('blur',abort);
  }
  dragGroup(event,node,range){
    const before=captureDocument(),refs=this.selections.slice(),origin=this.xTime(event.clientX),pointer=event.pointerId,excluded=new Set(refs.map(ref=>ref.id));
    const linkedMove=refs.length>this.explicit.length,canRetarget=this.explicit.length<=1;
    let last=event,pending=null,changed=false,done=false;
    this.dragging=true;this.canvas.classList.add('is-dragging');node.setPointerCapture(pointer);
    const update=()=>{
      const delta=this.xTime(last.clientX)-origin;
      // 묶음을 대표해 하나만 잡았을 때만 행을 옮깁니다. 여러 개를 직접 고른 선택은 원래 행에 둡니다.
      const hovered=canRetarget?document.elementFromPoint(last.clientX,last.clientY)?.closest('.track')?.dataset.track:null;
      const retarget=hovered&&hovered!==range.trackId&&timelineTracks().some(t=>t.id===hovered&&t.kind===trackKind(range.type))
        ?{type:range.type,id:range.id,trackId:hovered}:null;
      if(!changed&&Math.abs(delta*this.zoom)<3&&!retarget)return;
      changed=true;const time=this.snapTime(range.start+delta,excluded,range.duration);
      pending=planBatchMove(refs,time-range.start,before,{retarget});this.clearPreview();
      this.canvas.querySelectorAll('.timeline-block.selected').forEach(n=>n.classList.add('dragging'));
      for(const move of pending.moves||[]){
        const row=$('track-'+move.trackId);if(!row)continue;
        const ghost=document.createElement('div');ghost.className='timeline-insert-preview'+(pending.ok?'':' invalid');ghost.style.left=move.start*this.zoom+'px';ghost.style.width=Math.max(12,move.duration*this.zoom)+'px';row.append(ghost);this.ensureWidth(move.end);
      }
      this.notice(pending.ok?(linkedMove?'연결된 ':'')+refs.length+'개 함께 이동 · 트랙과 클립 사이 간격 유지':pending.reason,pending.ok?'info':'warn');
    };
    const move=e=>{if(e.pointerId!==pointer)return;last=e;update();this.trackScroll(e,update);};
    const finish=cancel=>{
      if(done)return;done=true;node.removeEventListener('pointermove',move);node.removeEventListener('pointerup',up);node.removeEventListener('pointercancel',cancelPointer);node.removeEventListener('lostpointercapture',cancelPointer);window.removeEventListener('keydown',escape);window.removeEventListener('blur',abort);
      if(this.cancelPointerDrag===abort){this.cancelPointerDrag=null;this.movePointerDrag=null;}
      this.stopScroll();this.clearPreview();this.dragging=false;this.canvas.classList.remove('is-dragging');
      if(node.hasPointerCapture(pointer))node.releasePointerCapture(pointer);
      try{if(!cancel&&changed&&pending){if(applyBatchMove(pending))this.callbacks.commit(before,linkedMove?'연결 클립 함께 이동':'선택 클립 함께 이동');}}
      catch(error){this.callbacks.error?.(error.message);}
      if(this.canvas.isConnected!==false)this.render();
    };
    const up=e=>{if(e.pointerId===pointer)finish(false);},cancelPointer=e=>{if(e.pointerId===pointer)finish(true);},abort=()=>finish(true),escape=e=>{if(e.key==='Escape'){e.preventDefault();finish(true);}};
    this.cancelPointerDrag=abort;this.movePointerDrag=move;
    node.addEventListener('pointermove',move);node.addEventListener('pointerup',up);node.addEventListener('pointercancel',cancelPointer);node.addEventListener('lostpointercapture',cancelPointer);window.addEventListener('keydown',escape);window.addEventListener('blur',abort);
  }
  /**
   * 우클릭(또는 메뉴 키)으로 클립 메뉴를 엽니다.
   * 빈 곳에서는 브라우저 기본 메뉴를 그대로 두어 새로고침·검사를 막지 않습니다.
   */
  openMenu(event){
    if(!this.isMobileTargetVisible(event.target))return;
    const hit=event.target.closest('.timeline-block');
    if(!hit)return;
    event.preventDefault();
    if(this.dragging||this.callbacks.busy?.())return;
    const ref={type:hit.dataset.type,id:hit.dataset.id},hitRange=itemRange(ref.type,ref.id);
    if(!hitRange||this.refuseLocked(hitRange.trackId))return;
    this.callbacks.pause();
    // 이미 선택한 묶음 안을 누르면 선택을 유지합니다. 밖을 누르면 그 클립만 고릅니다.
    if(this.selections.some(entry=>selectionKey(entry)===selectionKey(ref))){
      this.selectMany(this.explicit,ref);this.callbacks.selectMany?.(this.explicit,this.selection);
    }else{this.select(ref.type,ref.id);this.callbacks.select(ref.type,ref.id);}
    const box=hit.getBoundingClientRect();
    // 키보드로 연 메뉴는 좌표가 없으므로 클립 자리에 붙입니다.
    const keyboard=event.button===-1||(!event.clientX&&!event.clientY);
    this.showMenu(ref,keyboard?{x:box.left+12,y:box.bottom-4}:{x:event.clientX,y:event.clientY},hit);
  }
  showMenu(ref,at,anchorNode){
    this.closeMenu();
    const entries=this.callbacks.menuItems?.(ref)||[];
    if(!entries.length)return;
    const menu=document.createElement('div');
    menu.className='timeline-menu';menu.setAttribute('role','menu');menu.setAttribute('aria-label','타임라인 클립 메뉴');
    menu.innerHTML=entries.map(entry=>entry.separator?'<hr>'
      :'<button type="button" role="menuitem" data-menu="'+esc(entry.id)+'"'+(entry.disabled?' disabled':'')
        +(entry.title?' title="'+esc(entry.title)+'"':'')+'><span>'+esc(entry.label)+'</span>'
        +(entry.hint?'<small>'+esc(entry.hint)+'</small>':'')+'</button>').join('');
    document.body.append(menu);
    const width=menu.offsetWidth,height=menu.offsetHeight;
    menu.style.left=Math.max(6,Math.min(at.x,window.innerWidth-width-6))+'px';
    menu.style.top=(at.y+height>window.innerHeight-6?Math.max(6,at.y-height):at.y)+'px';
    const buttons=()=>[...menu.querySelectorAll('button:not([disabled])')];
    const close=restore=>{
      if(this.menu!==state)return;
      this.menu=null;menu.remove();
      document.removeEventListener('pointerdown',outside,true);
      window.removeEventListener('blur',away);window.removeEventListener('resize',away);
      this.scroll.removeEventListener('scroll',away);
      if(restore&&anchorNode?.isConnected)anchorNode.focus({preventScroll:true});
    };
    const state={close};
    const outside=event=>{if(!menu.contains(event.target))close(false);};
    const away=()=>close(false);
    menu.addEventListener('click',event=>{
      const button=event.target.closest('button[data-menu]');
      if(!button||button.disabled)return;
      close(false);this.callbacks.menuAction?.(button.dataset.menu,ref);
    });
    menu.addEventListener('keydown',event=>{
      const list=buttons(),index=list.indexOf(document.activeElement);
      if(event.key==='Escape'){event.preventDefault();close(true);}
      else if(event.key==='ArrowDown'){event.preventDefault();list[(index+1)%list.length]?.focus();}
      else if(event.key==='ArrowUp'){event.preventDefault();list[(index-1+list.length)%list.length]?.focus();}
      else if(event.key==='Home'){event.preventDefault();list[0]?.focus();}
      else if(event.key==='End'){event.preventDefault();list.at(-1)?.focus();}
      else if(event.key==='Tab'){event.preventDefault();close(true);}
    });
    document.addEventListener('pointerdown',outside,true);
    window.addEventListener('blur',away);window.addEventListener('resize',away);
    this.scroll.addEventListener('scroll',away);
    this.menu=state;buttons()[0]?.focus({preventScroll:true});
  }
  closeMenu(){this.menu?.close(false);}
  cancelMobileGestures(){this.mobileGestures?.reset();}
  destroyMobileGestures(){this.mobileGestures?.destroy();}
  /** 눌렀던 클립이 다시 그려져도 현재 DOM에서 같은 항목과 손잡이를 찾습니다. */
  mobileTouchEvent(event){
    const hit=event.target.closest('.timeline-block,.timeline-gap,.transition-chip');
    let target=event.target;
    if(hit){
      target=[...this.canvas.querySelectorAll('.timeline-block,.timeline-gap,.transition-chip')].find(node=>node.dataset.type===hit.dataset.type&&node.dataset.id===hit.dataset.id&&node.dataset.right===hit.dataset.right);
      if(!target)return null;
      for(const [selector,key] of [['[data-edge]','edge'],['[data-clip-setting]','clipSetting'],['[data-mosaic-warn]','mosaicWarn']]){
        const child=event.target.closest(selector);
        if(child){target=[...target.querySelectorAll(selector)].find(node=>node.dataset[key]===child.dataset[key])||target;break;}
      }
    }else if(target.isConnected===false)target=this.canvas;
    if(!this.isMobileTargetVisible(target))return null;
    return {target,button:0,isPrimary:true,pointerType:'touch',pointerId:event.pointerId,clientX:event.clientX,clientY:event.clientY,
      ctrlKey:false,metaKey:false,shiftKey:false,preventDefault:()=>event.preventDefault(),stopPropagation:()=>event.stopPropagation()};
  }
  mobileTap(event){
    if(this.callbacks.busy?.()||this.dragging)return;
    if(/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName))document.activeElement.blur();
    event=this.mobileTouchEvent(event);if(!event)return;
    const action=event.target.closest('[data-clip-setting],[data-mosaic-warn]');
    if(action){action.click();return;}
    const hit=event.target.closest('.timeline-block,.timeline-gap,.transition-chip');
    if(hit?.dataset.type==='transition'){this.callbacks.transition(hit.dataset.id,hit.dataset.right);return;}
    if(hit?.dataset.type==='gap'){this.chooseGap(hit.dataset.id);return;}
    this.callbacks.pause();
    if(!hit){
      const row=event.target.closest('.track');if(row)this.activateTrack(row.dataset.track);
      if(!this.mobileMultiSelect){this.selectMany([],null);this.callbacks.selectMany?.([],null);}
      this.callbacks.seek(frameTime(this.xTime(event.clientX)));return;
    }
    const ref={type:hit.dataset.type,id:hit.dataset.id},range=itemRange(ref.type,ref.id);
    if(!range||this.refuseLocked(range.trackId))return;
    if(this.mobileMultiSelect){this.selectMany(combineSelection(this.selections,[ref],'toggle'),ref);this.callbacks.selectMany?.(this.explicit,this.selection);}
    else{this.select(ref.type,ref.id);this.callbacks.select(ref.type,ref.id);}
  }
  pointerDown(event,mobileHandoff=false){
    if(!this.isMobileTargetVisible(event.target)){event.preventDefault();return;}
    if(!mobileHandoff&&this.mobileGestures?.pointerDown(event))return;
    // 모바일의 명시적 선택 모드는 연결한 마우스나 펜으로도 같은 동작을 합니다.
    if(!mobileHandoff&&this.mobileMultiSelect&&document.body.classList.contains('mobile-ui')&&event.button===0&&event.target.closest('.timeline-block')&&!event.target.closest('[data-edge],[data-clip-setting],[data-mosaic-warn]')){event.preventDefault();this.mobileTap(event);return;}
    if(event.button!==0||this.dragging||this.callbacks.busy?.()||event.isPrimary===false)return;
    if(event.target.closest('[data-clip-setting],[data-mosaic-warn]'))return;
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
    if(this.refuseLocked(range.trackId))return;
    this.callbacks.pause();const ref={type,id},edge=event.target.closest('[data-edge]')?.dataset.edge;
    if(event.ctrlKey||event.metaKey||event.shiftKey){this.selectMany(combineSelection(this.selections,[ref],'toggle'),ref);this.callbacks.selectMany?.(this.explicit,this.selection);return;}
    if(!edge&&this.selections.length>1&&this.selections.some(r=>selectionKey(r)===selectionKey(ref))){this.selectMany(this.explicit,ref);this.callbacks.selectMany?.(this.explicit,this.selection);this.dragGroup(event,node,range);return;}
    // 연결된 클립 하나를 끌면 묶음 전체가 간격을 유지한 채 함께 움직입니다.
    if(!edge&&linkedRefs(ref,project).length>1){
      this.select(type,id);this.callbacks.select(type,id);this.dragGroup(event,node,range);return;
    }
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
          :planPlacement(time,range.duration,target,id,project,{targetTime:this.xTime(lastEvent.clientX)});
      }else{
        const time=this.snapTime((edge==='end'?range.end:range.start)+delta,id);
        const trim=planLinkedTrim(ref,edge,time);
        pending=trim?{...trim,trackId:trim.trackId??range.trackId}:null;
      }
      if(!pending){this.clearPreview();return;}
      this.showPreview({type,lane:target,trackId:target,name:original.name||original.text,start:pending.start,end:pending.end,placement:pending});
    };
    const move=e=>{if(e.pointerId!==event.pointerId)return;lastEvent=e;update();this.trackScroll(e,update);};
    const finish=cancel=>{
      if(done)return;done=true;
      node.removeEventListener('pointermove',move);node.removeEventListener('pointerup',up);node.removeEventListener('pointercancel',cancelPointer);node.removeEventListener('lostpointercapture',cancelPointer);window.removeEventListener('keydown',escape);window.removeEventListener('blur',abort);
      if(this.cancelPointerDrag===abort){this.cancelPointerDrag=null;this.movePointerDrag=null;}
      this.stopScroll();this.clearPreview();this.dragging=false;this.canvas.classList.remove('is-dragging');
      if(node.hasPointerCapture(event.pointerId))node.releasePointerCapture(event.pointerId);
      if(!cancel&&changed&&pending&&!pending.noop){
        try{
          if(JSON.stringify(captureDocument())!==JSON.stringify(before))throw new Error('드래그 중 편집 내용이 변경되었습니다. 다시 시도해 주세요.');
          if(!edge)placeTimelineItem(type,range.item,pending);
          else applyLinkedTrim(pending);
          syncAnchoredItems();this.callbacks.commit(before,edge?(pending.linked?'연결 클립 구간 조절':'클립 구간 조절'):pending.swap?'클립 자리 교환':'클립 위치 이동');
          this.reveal({type,id,trackId:pending.trackId,start:pending.start,end:pending.end,mode:pending.mode});
        }catch(error){this.callbacks.error?.(error.message);this.render();}
      }else if(this.canvas.isConnected!==false)this.render();
    };
    const up=e=>{if(e.pointerId===event.pointerId)finish(false);},cancelPointer=e=>{if(e.pointerId===event.pointerId)finish(true);},abort=()=>finish(true),escape=e=>{if(e.key==='Escape'){e.preventDefault();finish(true);}};
    this.cancelPointerDrag=abort;this.movePointerDrag=move;
    node.addEventListener('pointermove',move);node.addEventListener('pointerup',up);node.addEventListener('pointercancel',cancelPointer);node.addEventListener('lostpointercapture',cancelPointer);window.addEventListener('keydown',escape);window.addEventListener('blur',abort);
  }
}
