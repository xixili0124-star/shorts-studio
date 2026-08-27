// 타임라인 조작: 드래그 중에는 잡은 요소를 다시 만들지 않습니다.
import { project, buildLayout, clipDuration, totalDuration, syncAnchoredItems, anchorItem } from './state.js';
import { assets, captureDocument, restoreDocument } from './project-store.js';
import { clamp } from './util.js';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const stamp = t => `${Math.floor(t/60).toString().padStart(2,'0')}:${Math.floor(t%60).toString().padStart(2,'0')}`;

export class Timeline {
  constructor(callbacks) {
    this.callbacks=callbacks;this.zoom=70;this.snapping=true;this.selection=null;this.time=0;this.dragging=false;
    this.scroll=$('timelineScroll');this.canvas=$('timelineCanvas');
    $('timelineZoom').oninput=e=>{this.zoom=Number(e.target.value);this.render();};
    $('zoomIn').onclick=()=>this.setZoom(this.zoom*1.25);
    $('zoomOut').onclick=()=>this.setZoom(this.zoom/1.25);
    $('fitTimeline').onclick=()=>this.fit();
    $('snap').onclick=()=>this.toggleSnap();
    this.canvas.addEventListener('pointerdown',e=>this.pointerDown(e));
    this.canvas.addEventListener('dragover',e=>{
      if(e.dataTransfer.types.includes('application/x-shorts-asset')||e.dataTransfer.types.includes('application/x-shorts-preset')){e.preventDefault();e.dataTransfer.dropEffect='copy';e.target.closest('.track')?.classList.add('drop-target');}
    });
    this.canvas.addEventListener('dragleave',e=>e.target.closest('.track')?.classList.remove('drop-target'));
    this.canvas.addEventListener('drop',e=>{
      document.querySelectorAll('.drop-target').forEach(n=>n.classList.remove('drop-target'));
      const asset=e.dataTransfer.getData('application/x-shorts-asset'),preset=e.dataTransfer.getData('application/x-shorts-preset');
      if(!asset&&!preset)return;e.preventDefault();e.stopPropagation();
      const t=this.xTime(e.clientX);const lane=e.target.closest('.track')?.dataset.track;
      this.callbacks.drop(asset ? 'asset':'preset',asset||preset,t,lane);
    });
    this.scroll.addEventListener('wheel',e=>{
      if(e.ctrlKey||e.metaKey){e.preventDefault();this.setZoom(this.zoom*(e.deltaY<0?1.12:.89));}
    },{passive:false});
  }
  setZoom(value){this.zoom=clamp(value,18,180);$('timelineZoom').value=this.zoom;this.render();}
  fit(){this.setZoom((this.scroll.clientWidth-70)/Math.max(4,totalDuration()));}
  toggleSnap(){this.snapping=!this.snapping;$('snap').classList.toggle('active',this.snapping);$('snap').setAttribute('aria-pressed',this.snapping);}
  xTime(x){const rect=this.canvas.getBoundingClientRect();return Math.max(0,(x-rect.left)/this.zoom);}
  select(type,id){this.selection={type,id};this.canvas.querySelectorAll('.timeline-block').forEach(n=>n.classList.toggle('selected',n.dataset.id===id&&n.dataset.type===type));}
  tick(t){this.time=t;$('playhead').style.left=`${t*this.zoom}px`;}
  snapTime(t,exclude){
    if(!this.snapping)return Math.max(0,t);
    const e=buildLayout().entries;
    const candidates=[0,this.time,...e.filter(a=>a.clip.id!==exclude).flatMap(a=>[a.start,a.end]),...project.captions.filter(c=>c.id!==exclude).flatMap(c=>[c.start,c.end])];
    let closest=t,min=8/this.zoom;
    for(const v of candidates){if(Math.abs(v-t)<min){min=Math.abs(v-t);closest=v;}}
    return Math.max(0,closest);
  }
  render(){
    if(this.dragging)return;
    const layout=buildLayout(),pps=this.zoom;
    const width=Math.max(this.scroll.clientWidth,Math.ceil(layout.total*pps)+90);
    this.canvas.style.width=`${width}px`;
    const increment=pps<35?5:pps<65?2:1;
    let ruler='';
    for(let t=0;t<width/pps;t+=increment){ruler+=`<div class="ruler-mark" style="left:${t*pps}px"><span>${stamp(t)}</span></div>`;for(let k=1;k<4;k++)ruler+=`<div class="ruler-mark minor" style="left:${(t+increment*k/4)*pps}px"></div>`;}
    $('ruler').innerHTML=ruler;
    $('graphicTrack').innerHTML=project.overlays.filter(o=>o.end>o.start).map(o=>this.block('graphic',o,o.start,o.end-o.start)).join('');
    $('captionTrack').innerHTML=project.captions.filter(c=>c.end>c.start).map(c=>this.block('caption',c,c.start,c.end-c.start)).join('');
    $('videoTrack').innerHTML=layout.entries.map(e=>this.block('clip',e.clip,e.start,e.duration)).join('')+layout.entries.filter(e=>e.overlapOut>0).map(e=>`<button class="transition-chip" aria-label="${esc(e.clip.name)} 뒤 전환 편집" data-transition="${e.clip.id}" style="left:${(e.end-e.overlapOut)*pps}px;width:${Math.max(16,e.overlapOut*pps)}px" title="${e.overlapOut.toFixed(2)}초 전환">◩</button>`).join('');
    for(const lane of ['music','voice']){
      $(lane==='music'?'audioTrack':'voiceTrack').innerHTML=(project.audio.tracks||[]).filter(t=>(t.lane||'music')===lane).map(t=>this.block('audio',t,t.start,t.trimEnd-t.trimStart)).join('');
    }
    $('totalDuration').textContent=stamp(layout.total);
    $('sequenceInfo').textContent=`${project.clips.length} 클립 · ${layout.total.toFixed(1)}초`;
    this.tick(this.time);
    if(this.selection)this.select(this.selection.type,this.selection.id);
  }
  block(type,item,start,duration){
    const klass={clip:'video',caption:'caption',graphic:'graphic',audio:'audio'}[type];
    const label=item.name||item.text||'클립';
    let detail='';
    if(type==='clip'&&item.thumb){const n=Math.min(100,Math.ceil(duration*this.zoom/46)+1);detail=`<div class="thumb-strip">${Array(n).fill(`<img src="${item.thumb}" alt="" draggable="false">`).join('')}</div>`;}
    if(type==='audio'){
      const a=assets.get(item.assetId),wave=a?.waveform||[];const n=Math.min(500,Math.max(10,Math.ceil(duration*this.zoom/4)));
      detail=`<div class="waveform">${Array.from({length:n},(_,i)=>{const at=(item.trimStart+i/n*duration)/(a?.duration||1),v=wave[Math.min(wave.length-1,Math.floor(at*wave.length))]||0;return `<i style="height:${Math.max(2,v*100)}%"></i>`;}).join('')}</div>`;
    }
    const prefix={clip:'▧',caption:'T',graphic:'✧',audio:'♫'}[type];
    return `<div tabindex="0" role="button" aria-label="${esc(label)} · ${duration.toFixed(2)}초" class="timeline-block ${klass}-block" data-type="${type}" data-id="${item.id}" style="left:${start*this.zoom}px;width:${Math.max(12,duration*this.zoom-2)}px" title="${esc(label)} · ${start.toFixed(2)}–${(start+duration).toFixed(2)}초"><span class="block-grip start" data-edge="start"></span>${detail}<span class="block-label">${prefix} ${esc(label)}</span><span class="block-grip end" data-edge="end"></span></div>`;
  }
  pointerDown(event){
    if(event.button!==0)return;
    const transition=event.target.closest('[data-transition]');
    if(transition){this.callbacks.transition(transition.dataset.transition);return;}
    const node=event.target.closest('.timeline-block');
    if(!node){
      event.preventDefault();this.callbacks.pause();
      const seek=e=>this.callbacks.seek(Math.min(totalDuration(),this.xTime(e.clientX)));
      seek(event);const move=e=>seek(e);const up=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);window.removeEventListener('pointercancel',up);};
      window.addEventListener('pointermove',move);window.addEventListener('pointerup',up,{once:true});window.addEventListener('pointercancel',up,{once:true});return;
    }
    event.preventDefault();
    const {type,id}=node.dataset;
    this.callbacks.pause();this.select(type,id);this.callbacks.select(type,id);
    const collection=type==='clip'?project.clips:type==='caption'?project.captions:type==='graphic'?project.overlays:project.audio.tracks;
    const item=collection.find(o=>o.id===id);if(!item)return;
    const before=captureDocument();const old={...item,anchor:item.anchor?{...item.anchor}:undefined};
    const entry=type==='clip'?buildLayout().entries.find(e=>e.clip.id===id):null;
    const initialStart=entry?.start??item.start;
    const duration=type==='clip'?clipDuration(item):type==='audio'?item.trimEnd-item.trimStart:item.end-item.start;
    const startX=event.clientX,startScroll=this.scroll.scrollLeft,edge=event.target.dataset.edge;
    let delta=0,moved=false;
    node.setPointerCapture(event.pointerId);this.dragging=true;
    const move=e=>{
      delta=(e.clientX-startX+this.scroll.scrollLeft-startScroll)/this.zoom;
      if(Math.abs(e.clientX-startX)>3)moved=true;
      if(!moved)return;
      node.classList.add('dragging');
      const frame=1/project.fps;
      if(type==='clip'){
        if(edge==='start'&&item.type==='video')item.trimStart=clamp(old.trimStart+delta,0,old.trimEnd-frame);
        else if(edge==='start'&&item.type==='image')item.imgDuration=clamp(old.imgDuration-delta,.2,600);
        else if(edge==='end'&&item.type==='video')item.trimEnd=clamp(old.trimEnd+delta,old.trimStart+frame,item.srcDuration);
        else if(edge==='end'&&item.type==='image')item.imgDuration=clamp(old.imgDuration+delta,.2,600);
        if(edge)node.style.width=`${Math.max(12,clipDuration(item)*this.zoom-2)}px`;
        else node.style.left=`${Math.max(0,initialStart+delta)*this.zoom}px`;
      }else if(type==='audio'){
        if(edge==='start'){const d=clamp(delta,Math.max(-old.trimStart,-old.start),old.trimEnd-old.trimStart-frame);item.trimStart=old.trimStart+d;item.start=old.start+d;}
        else if(edge==='end')item.trimEnd=clamp(old.trimEnd+delta,old.trimStart+frame,assets.get(item.assetId).duration);
        else item.start=this.snapTime(old.start+delta,id);
        node.style.left=`${item.start*this.zoom}px`;node.style.width=`${Math.max(12,(item.trimEnd-item.trimStart)*this.zoom-2)}px`;
      }else{
        if(edge==='start')item.start=clamp(this.snapTime(old.start+delta,id),0,old.end-frame);
        else if(edge==='end')item.end=Math.max(old.start+frame,this.snapTime(old.end+delta,id));
        else{item.start=this.snapTime(old.start+delta,id);item.end=item.start+duration;}
        if(old.anchor)anchorItem(item,old.anchor.clipId);
        node.style.left=`${item.start*this.zoom}px`;node.style.width=`${Math.max(12,(item.end-item.start)*this.zoom-2)}px`;
      }
      syncAnchoredItems();this.callbacks.preview();
      const rect=this.scroll.getBoundingClientRect();if(e.clientX>rect.right-22)this.scroll.scrollLeft+=8;if(e.clientX<rect.left+22)this.scroll.scrollLeft-=8;
    };
    const finish=e=>{
      node.removeEventListener('pointermove',move);node.removeEventListener('pointerup',finish);node.removeEventListener('pointercancel',cancel);
      try{node.releasePointerCapture(event.pointerId);}catch{}
      this.dragging=false;
      if(moved&&type==='clip'&&!edge){
        const position=Math.max(0,initialStart+delta+duration/2);
        const rest=buildLayout().entries.filter(e=>e.clip.id!==id);
        let index=rest.findIndex(e=>position<(e.start+e.end)/2);if(index<0)index=rest.length;
        project.clips.splice(project.clips.findIndex(c=>c.id===id),1);project.clips.splice(index,0,item);
      }
      if(moved)this.callbacks.commit(before,edge?'구간 조절':'항목 이동');else this.callbacks.seek(Math.min(totalDuration(),initialStart));
      this.render();
    };
    const cancel=()=>{node.removeEventListener('pointermove',move);node.removeEventListener('pointerup',finish);try{node.releasePointerCapture(event.pointerId);}catch{}this.dragging=false;restoreDocument(before);this.callbacks.preview();this.render();};
    node.addEventListener('pointermove',move);node.addEventListener('pointerup',finish);node.addEventListener('pointercancel',cancel,{once:true});
  }
}
