import { KEYFRAME_CHANNELS, KEYFRAME_LIMITS, keyframeValue, keyframeAtTime, quantizeKeyframeTime, setKeyframe, removeKeyframe, moveKeyframe } from './keyframes.js';
const labels={offsetX:'가로 이동',offsetY:'세로 이동',scaleX:'가로 크기',scaleY:'세로 크기',rotation:'회전',opacity:'불투명도',volume:'음량'};
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
export class KeyframeEditor {
  constructor(hooks){this.hooks=hooks;this.channel='offsetX';this.dragging=false;this.wire();}
  channels(range){return range.type==='audio'?['volume']:KEYFRAME_CHANNELS.filter(channel=>channel!=='volume'||range.item.type==='video'&&!range.item.audioSeparated);}
  local(range){return quantizeKeyframeTime(clamp(this.hooks.time()-range.start,0,range.duration),this.hooks.fps(),range.duration);}
  current(keys,local){return keyframeAtTime(keys,local,this.hooks.fps());}
  display(value){return this.channel==='rotation'?value:value*100;}
  valueControl(range,local){
    const channel=this.channel,[minimum,maximum]=KEYFRAME_LIMITS[channel];
    const value=this.display(keyframeValue(range.item,channel,local)),prop=channel==='volume'?'volume':'transform.'+channel;
    return '<label class="property-row keyframe-value-control"><span>'+labels[channel]+'</span><input type="range" data-keyframe-value data-prop="'+prop+'" min="'+this.display(minimum)+'" max="'+this.display(maximum)+'" step="1" value="'+value+'" aria-label="현재 위치 '+labels[channel]+' 값"><output>'+this.format(keyframeValue(range.item,channel,local))+'</output></label>'+
      '<p class="inspector-note">'+(range.item.keyframes?.tracks?.[channel]?.length?'이 속성만 현재 재생 위치에 기록됩니다. 다른 속성은 각각 키를 만들어 주세요.':'키가 없을 때는 클립 전체 값입니다. 키를 추가하면 이 속성만 시간에 따라 바뀝니다.')+'</p>';
  }
  render(range){
    const channels=this.channels(range);if(!channels.includes(this.channel))this.channel=channels[0];
    const keys=range.item.keyframes?.tracks?.[this.channel]||[],local=this.local(range);
    return '<section class="property-section keyframe-section"><h3>키프레임 <span>ANIMATION</span></h3>'+
      '<label class="property-row"><span>속성</span><select data-keyframe-channel aria-label="키프레임 속성">'+channels.map(channel=>'<option value="'+channel+'" '+(channel===this.channel?'selected':'')+'>'+labels[channel]+'</option>').join('')+'</select></label>'+
      this.valueControl(range,local)+
      '<div class="keyframe-actions"><button class="button subtle" data-keyframe-command="previous" aria-label="이전 키프레임">‹</button><button class="button secondary" data-keyframe-command="toggle" aria-label="현재 위치 키프레임 추가 또는 삭제">◇ 키 추가</button><button class="button subtle" data-keyframe-command="next" aria-label="다음 키프레임">›</button></div>'+
      '<div class="keyframe-ruler" aria-label="키프레임 위치"><span class="keyframe-playhead"></span>'+keys.map(key=>'<button class="keyframe-point" data-keyframe-time="'+key.time+'" style="left:'+clamp(key.time/range.duration*100,0,100)+'%" aria-label="'+key.time.toFixed(2)+'초 키프레임" title="끌어서 시각 이동">◆</button>').join('')+'</div>'+
      '<p class="keyframe-time" aria-live="off"></p>'+
      (keys.length?'<label class="property-row"><span>연결 방식</span><select data-keyframe-easing aria-label="키프레임 연결 방식"><option value="linear">부드럽게 연결</option><option value="hold">다음 키까지 유지</option></select></label><div class="keyframe-rows">'+keys.map(key=>'<div class="keyframe-row"><input type="number" data-keyframe-move="'+key.time+'" value="'+key.time.toFixed(2)+'" min="0" max="'+range.duration+'" step="'+1/this.hooks.fps()+'" aria-label="키프레임 시각"><span>초</span><output>'+this.format(key.value)+'</output><button data-keyframe-delete="'+key.time+'" aria-label="'+key.time.toFixed(2)+'초 키프레임 삭제">×</button></div>').join('')+'</div>':'')+
      '<p class="inspector-note">현재 위치에서 ◆ 키를 만든 뒤 위 슬라이더로 값을 정하세요. 재생 막대를 옮겨 같은 속성의 다음 키와 값을 만들면 두 값 사이가 움직입니다. ◆는 클릭하거나 끌어 이동합니다.</p></section>';
  }
  format(value){return this.channel==='rotation'?value.toFixed(1)+'°':(value*100).toFixed(0)+'%';}
  update(){
    if(this.dragging)return;const range=this.hooks.range(),host=this.hooks.host;
    if(!range||!host.querySelector('.keyframe-section'))return;
    const local=this.local(range),keys=range.item.keyframes?.tracks?.[this.channel]||[];
    const current=this.current(keys,local);
    const active=this.hooks.time()>=range.start-1e-6&&this.hooks.time()<=range.end+1e-6;
    const button=host.querySelector('[data-keyframe-command="toggle"]');
    button.textContent=current?'◆ 키 삭제':'◇ 키 추가';button.disabled=!active;
    host.querySelector('.keyframe-time').textContent='클립 안 '+local.toFixed(2)+'초 · '+this.format(keyframeValue(range.item,this.channel,local));
    host.querySelector('.keyframe-playhead').style.left=clamp(local/range.duration*100,0,100)+'%';
    host.querySelectorAll('[data-keyframe-time]').forEach(point=>point.classList.toggle('current',!!this.current([{time:Number(point.dataset.keyframeTime)}],local)));
    const easing=host.querySelector('[data-keyframe-easing]');
    if(easing){const left=keys.filter(key=>key.time<=local+1e-6).at(-1)||keys[0];easing.value=left?.easing||'linear';}
    const frame=Math.round(local*this.hooks.fps());
    host.querySelector('[data-keyframe-command="previous"]').disabled=!keys.some(key=>Math.round(key.time*this.hooks.fps())<frame);
    host.querySelector('[data-keyframe-command="next"]').disabled=!keys.some(key=>Math.round(key.time*this.hooks.fps())>frame);
  }
  startDrag(event){
    const point=event.target.closest('[data-keyframe-time]');
    if(!point||event.button!==0||event.isPrimary===false||this.dragging||this.hooks.busy())return;
    const range=this.hooks.range(),box=point.parentElement?.getBoundingClientRect(),fps=this.hooks.fps();
    if(!range||!(range.duration>0)||!box||!(box.width>0)||!(fps>0))return;
    const channel=this.channel,from=Number(point.dataset.keyframeTime),pointer=event.pointerId,initialX=event.clientX;
    if(!Number.isFinite(from)||!range.item.keyframes?.tracks?.[channel]?.some(key=>Math.abs(key.time-from)<1e-6))return;
    const signature=JSON.stringify(range.item.keyframes);
    let to=from,moved=false,done=false;
    const current=()=>{
      const live=this.hooks.range();
      return !this.hooks.busy()&&this.channel===channel&&this.hooks.fps()===fps&&live?.item===range.item
        &&live.type===range.type&&live.start===range.start&&live.end===range.end&&live.duration===range.duration
        &&JSON.stringify(live.item.keyframes)===signature;
    };
    const finish=cancel=>{
      if(done)return;done=true;
      const stale=!cancel&&!current();cancel ||= stale;
      point.removeEventListener('pointermove',move);point.removeEventListener('pointerup',up);
      point.removeEventListener('pointercancel',abort);point.removeEventListener('lostpointercapture',abort);
      window.removeEventListener('lostpointercapture',abort,true);window.removeEventListener('blur',blur);
      window.removeEventListener('keydown',escape,true);this.dragging=false;
      try{if(point.hasPointerCapture(pointer))point.releasePointerCapture(pointer);}catch{}
      clearTimeout(this.suppressTimer);this.suppressClick=cancel?null:point;
      if(this.suppressClick)this.suppressTimer=setTimeout(()=>{this.suppressClick=null;},0);
      if(stale)this.hooks.error?.('드래그 중 선택 또는 키프레임이 변경되어 이동을 취소했습니다.');
      let committed=true;
      if(!cancel&&moved&&Math.abs(to-from)>1e-6){
        committed=this.hooks.edit('키프레임 이동',()=>moveKeyframe(range.item,channel,from,to,{duration:range.duration,fps}))!==false;
      }else point.style.left=(from/range.duration*100)+'%';
      if(!cancel&&committed)this.hooks.seek(range.start+(moved?to:quantizeKeyframeTime(from,fps,range.duration)));else this.update();
    };
    const move=e=>{
      if(e.pointerId!==pointer||!Number.isFinite(e.clientX))return;
      if(!current()){finish(false);return;}
      to=quantizeKeyframeTime(clamp((e.clientX-box.left)/box.width*range.duration,0,range.duration),fps,range.duration);
      moved ||= Math.abs(e.clientX-initialX)>3;point.style.left=(to/range.duration*100)+'%';
    };
    const up=e=>{if(e.pointerId===pointer)finish(false);},abort=e=>{if(e.pointerId===pointer)finish(true);};
    const blur=()=>finish(true),escape=e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();finish(true);}};
    event.preventDefault();event.stopPropagation();this.hooks.pause();this.dragging=true;
    clearTimeout(this.suppressTimer);this.suppressClick=null;
    try{point.setPointerCapture(pointer);}catch{this.dragging=false;return;}
    point.addEventListener('pointermove',move);point.addEventListener('pointerup',up);
    point.addEventListener('pointercancel',abort);point.addEventListener('lostpointercapture',abort);
    // 패널이 다시 그려져 점이 사라진 경우의 캡처 해제도 창에서 정리합니다.
    window.addEventListener('lostpointercapture',abort,true);window.addEventListener('blur',blur);
    window.addEventListener('keydown',escape,true);
  }
  wire(){
    const host=this.hooks.host;
    host.addEventListener('click',event=>{
      if(this.hooks.busy()||this.dragging)return;
      if(this.suppressClick){
        const point=this.suppressClick;this.suppressClick=null;
        if(event.target.closest('[data-keyframe-time]')===point)return;
      }
      const range=this.hooks.range();if(!range)return;
      const local=this.local(range),keys=range.item.keyframes?.tracks?.[this.channel]||[];
      const point=event.target.closest('[data-keyframe-time]');
      if(point){this.hooks.seek(range.start+quantizeKeyframeTime(Number(point.dataset.keyframeTime),this.hooks.fps(),range.duration));return;}
      const remove=event.target.closest('[data-keyframe-delete]');
      if(remove){this.hooks.edit('키프레임 삭제',()=>removeKeyframe(range.item,this.channel,Number(remove.dataset.keyframeDelete),{duration:range.duration,fps:this.hooks.fps()}));return;}
      const action=event.target.closest('[data-keyframe-command]')?.dataset.keyframeCommand;
      if(action==='toggle'){
        const fps=this.hooks.fps(),current=this.current(keys,local);
        const changed=this.hooks.edit(current?'키프레임 삭제':'키프레임 추가',()=>{
          if(current)removeKeyframe(range.item,this.channel,current.time,{duration:range.duration,fps});
          else setKeyframe(range.item,this.channel,local,keyframeValue(range.item,this.channel,local),{duration:range.duration,fps});
        });
        if(changed!==false){this.hooks.seek(range.start+local);this.update();}
      }
      if(action==='previous'||action==='next'){
        const frame=Math.round(local*this.hooks.fps()),key=action==='previous'?keys.filter(key=>Math.round(key.time*this.hooks.fps())<frame).at(-1):keys.find(key=>Math.round(key.time*this.hooks.fps())>frame);
        if(key)this.hooks.seek(range.start+quantizeKeyframeTime(key.time,this.hooks.fps(),range.duration));
      }
    });
    host.addEventListener('change',event=>{
      if(this.hooks.busy()||this.dragging)return;const range=this.hooks.range();if(!range)return;
      if(event.target.matches('[data-keyframe-channel]')){this.channel=event.target.value;this.hooks.render();this.update();}
      if(event.target.matches('[data-keyframe-move]')){
        const from=Number(event.target.dataset.keyframeMove),value=Number(event.target.value);
        if(!Number.isFinite(value)||!event.target.value.trim())return;
        const fps=this.hooks.fps(),to=quantizeKeyframeTime(clamp(value,0,range.duration),fps,range.duration);
        if(this.hooks.edit('키프레임 시각 변경',()=>moveKeyframe(range.item,this.channel,from,to,{duration:range.duration,fps}))!==false)this.hooks.seek(range.start+to);
      }
      if(event.target.matches('[data-keyframe-easing]')){
        const keys=range.item.keyframes?.tracks?.[this.channel]||[],local=this.local(range),left=keys.filter(key=>key.time<=local+1e-6).at(-1)||keys[0];
        if(left)this.hooks.edit('키프레임 연결 변경',()=>setKeyframe(range.item,this.channel,left.time,left.value,{easing:event.target.value,duration:range.duration,fps:this.hooks.fps()}));
      }
    });
    host.addEventListener('pointerdown',event=>this.startDrag(event));
  }
}
