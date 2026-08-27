// 자동 편집 패널은 결과를 먼저 보여주고, 사용자가 적용한 순간에만 프로젝트를 바꿉니다.
import { project, clipDuration, totalDuration, trackLabel, timelineTracks, addTimelineTrack, MAX_TRACKS_PER_KIND } from './state.js';
import { captureDocument, addAsset, makeAudio } from './project-store.js';
import { itemRange, planSilenceCuts, applySilenceCuts, placeTimelineItem, planPlacement } from './timeline-edits.js';
import { extractClipAudio, mixTimeline, findUncaptioned } from './audio.js';
import { encodeWav } from './ai-client.js';
import { analyzeSilence, monoPcm } from './silence.js';
import { normalizedRect, mosaicAt, redactSource, unresolvedMosaics, MAX_MOSAICS } from './mosaic.js';
import { videoFrameReader, trackMosaic } from './video-analysis.js';
import { TTS_MODEL, runLocalAI, whisperCaptions, installedVoices, speakInstalled } from './local-ai.js';
import { uid, clamp } from './util.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const button = (action, text, disabled = false, primary = false) => '<button class="button ' + (primary?'primary':'secondary') + ' wide" data-smart-action="' + action + '" ' + (disabled?'disabled':'') + '>' + text + '</button>';
const progressMarkup = '<div class="smart-progress" hidden><progress max="1" value="0"></progress><p role="status" aria-live="polite"></p><button class="button subtle wide" data-smart-action="cancel">작업 취소</button></div><p class="smart-error" role="alert" hidden></p>';
const rangeInput = (label, key, value, min, max, step, suffix='') => '<label class="property-row"><span>' + label + '</span><input type="range" data-smart-input="' + key + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + value + '" aria-label="' + label + '"><output>' + Number(value).toFixed(step<1?2:0) + suffix + '</output></label>';

function slicedPcm(buffer, start, end) {
  const a=Math.max(0,Math.floor(start*buffer.sampleRate)), b=Math.min(buffer.length,Math.ceil(end*buffer.sampleRate));
  const channels=Array.from({length:buffer.numberOfChannels},(_,i)=>buffer.getChannelData(i).slice(a,b));
  if (b<=a) throw new Error('선택 구간에 소리가 없습니다.');
  return { sampleRate:buffer.sampleRate, numberOfChannels:channels.length, length:b-a, duration:(b-a)/buffer.sampleRate, getChannelData:i=>channels[i] };
}
async function selectedPcm(range, signal, forCaptions = false) {
  if (range.duration>180) throw new Error('자동 편집은 한 번에 3분까지 지원합니다. 필요한 구간으로 트림해 주세요.');
  if (range.type==='audio') {
    if (!range.item.buffer) throw new Error('오디오 소재를 읽지 못했습니다.');
    return slicedPcm(range.item.buffer,range.item.trimStart,range.item.trimEnd);
  }
  const result=await extractClipAudio(range.item,signal,{ignoreMute:true,strict:true,allChannels:true,allowBoundaryGaps:forCaptions});
  if (!result) throw new Error('선택한 영상에서 오디오를 읽지 못했습니다.');
  return result;
}

export class StudioTools {
  constructor(hooks) {
    this.hooks=hooks;this.job=null;this.state=null;
    this.voice={text:'안녕하세요. 오늘은 짧은 영상을 함께 편집합니다.',engine:'local',voice:'F1',speed:1,steps:5,systemVoice:'',accepted:false};
    this.captionScope='selected';this.cutOptions={thresholdDb:-38,minSilence:.45,padding:.1};
    this.dialog=document.createElement('dialog');this.dialog.className='modal smart-modal';this.dialog.id='smartToolsDialog';
    this.dialog.innerHTML='<div class="modal-heading"><h2 id="smartToolsTitle"></h2><button class="icon-button" data-smart-action="cancel" aria-label="작업 창 닫기">×</button></div><div class="modal-body smart-body"></div>';
    this.dialog.setAttribute('aria-labelledby','smartToolsTitle');document.body.append(this.dialog);
    this.dialog.addEventListener('cancel',event=>{event.preventDefault();this.close();});
    this.dialog.addEventListener('close',()=>this.cleanup());
    for (const host of [document.getElementById('libraryContent'),document.getElementById('inspectorContent'),this.dialog]) {
      host.addEventListener('click',event=>{
        const action=event.target.closest('[data-smart-action]');if(!action)return;
        event.preventDefault();event.stopPropagation();this.action(action.dataset.smartAction,action).catch(error=>this.showError(error));
      });
      host.addEventListener('input',event=>this.input(event.target));
      host.addEventListener('change',event=>this.change(event.target));
    }
    if (typeof speechSynthesis!=='undefined') speechSynthesis.addEventListener('voiceschanged',()=>{if(this.hooks.view()==='voice'&&this.voice.engine==='device')this.hooks.renderLibrary();});
  }
  get busy(){return !!this.job;}
  get body(){return this.dialog.querySelector('.smart-body');}
  currentRange(){const s=this.hooks.selection();return s?itemRange(s.type,s.id):null;}
  audioRange(){const r=this.currentRange();return r&&(r.type==='audio'||(r.type==='clip'&&r.item.type==='video'))?r:null;}
  videoRange(){const r=this.currentRange();return r?.type==='clip'?r:null;}
  showError(error){if(error.name==='AbortError')return;const box=this.dialog.open&&this.body.querySelector('.smart-error');if(box){box.hidden=false;box.textContent=error.message;}else this.hooks.toast(error.message);}
  cleanup(){
    this.job?.abort();this.readerCtrl?.abort();this.readerCtrl=null;
    this.state?.reader?.close();this.state=null;
    this.dialog.querySelectorAll('audio,video').forEach(el=>el.pause());
    for(const url of this.urls||[])URL.revokeObjectURL(url);this.urls=[];
  }
  close(abort=true){if(abort)this.job?.abort();if(this.dialog.open)this.dialog.close();else this.cleanup();}
  open(title,html){
    if(this.busy)throw new Error('현재 작업을 마치거나 취소해 주세요.');
    this.cleanup();this.dialog.querySelector('h2').textContent=title;this.setBody(html);
    if(!this.dialog.open)this.dialog.showModal();this.hooks.player.pause();
  }
  setBody(html){this.dialog.querySelectorAll('audio,video').forEach(el=>el.pause());this.body.innerHTML=html;}
  objectUrl(blob){const url=URL.createObjectURL(blob);(this.urls||=[]).push(url);return url;}
  progress(value,message){const box=this.body.querySelector('.smart-progress');if(!box)return;box.hidden=false;const bar=box.querySelector('progress');if(Number.isFinite(value))bar.value=clamp(value,0,1);else bar.removeAttribute('value');box.querySelector('p').textContent=message;}
  async run(kind,work){
    if(this.busy)throw new Error('다른 처리가 진행 중입니다.');
    const ctrl=new AbortController();this.job=ctrl;
    const controls=[...this.body.querySelectorAll('button:not([data-smart-action="cancel"]),input,select,textarea')].map(el=>[el,el.disabled]);
    for(const [el] of controls)el.disabled=true;
    this.body.querySelector('.smart-error')?.setAttribute('hidden','');
    try{return await work(ctrl.signal);}finally{
      if(this.job===ctrl)this.job=null;
      for(const [el,disabled] of controls)if(el.isConnected)el.disabled=disabled;
      this.body.querySelector('.smart-progress')?.setAttribute('hidden','');
    }
  }
  inspector(type,item){
    if(type==='clip')return '<section class="property-section"><h3>자동 편집</h3>'+button('mosaic','▦ 모자이크 · 영역 / 추적')+(item.type==='video'?button('silence','✂ 무음 구간 자동 컷')+button('captions-selected','T 자동 자막 · 이 클립'):'')+'<p class="inspector-note">'+(item.mosaics?.length?'모자이크 '+item.mosaics.length+'개 적용됨':'원본 파일을 바꾸지 않습니다.')+'</p></section>';
    if(type==='audio')return '<section class="property-section"><h3>자동 편집</h3>'+button('silence','✂ 무음 구간 자동 컷')+button('captions-selected','T 자동 자막 · 이 오디오')+'</section>';
    return '';
  }
  captionControls(){
    const r=this.audioRange();
    return '<section class="smart-card"><h3>자동 자막 <span class="local-badge">기기에서 처리</span></h3><p class="note">API 키 없이 한국어 말소리를 인식해요. 기존 자막은 보존하고 새 영상 트랙에 추가합니다.</p><label class="field-label">인식 범위<select data-smart-input="caption-scope"><option value="selected" '+(this.captionScope==='selected'?'selected':'')+'>선택한 영상 / 오디오</option><option value="sequence" '+(this.captionScope==='sequence'?'selected':'')+'>전체 말소리 · 영상 + 보이스</option></select></label><p class="inspector-note">'+(this.captionScope==='selected'?(r?esc(r.item.name)+' · '+r.duration.toFixed(2)+'초':'타임라인에서 영상 또는 오디오를 선택하세요.'):'배경음악·효과음·음소거한 클립은 제외합니다.')+'</p>'+button('captions','자동 자막 만들기',this.captionScope==='selected'?!r:totalDuration()<=0,true)+'<p class="inspector-note">최초 약 66MB(모델·엔진) 다운로드 · 최대 3분<br>숫자·고유명사·소음이 있는 부분은 직접 확인해 주세요.</p></section>';
  }
  render(view,host){
    if(view==='voice'){this.renderVoice(host);return;}
    if(view==='mosaic'){
      const r=this.videoRange(),item=r?.item;
      host.innerHTML='<div class="smart-feature-art mosaic-feature" aria-hidden="true"><span>▦</span><strong>가릴 곳만, 따라가며.</strong></div><p class="preset-intro">사각형을 그려 대상을 지정하고<br>움직임 추적과 강도를 조절하세요.</p><div class="smart-card"><h3>선택 클립</h3><p class="note">'+(item?esc(item.name):'타임라인에서 영상 또는 이미지를 선택하세요.')+'</p>'+button('mosaic','영역 지정 · 모자이크 설정',!r,true)+'</div><ol class="smart-steps"><li>원본 화면에 가릴 영역을 그립니다.</li><li>영상이면 자동 추적을 실행합니다.</li><li>결과를 확인하고 적용합니다.</li></ol><p class="inspector-note">최대 4개 영역 · 클립당 3분<br>급격한 이동·가림·장면 전환에서는 재지정이 필요합니다. 추적 실패 구간은 회색으로 가리며, 보정 전에는 내보내지 않습니다.</p><p class="note warning">.shorts 프로젝트에는 원본 영상도 들어 있습니다. 가려진 결과를 공유할 때는 완성 MP4를 사용하세요.</p>';
      return;
    }
    const r=this.audioRange();
    host.innerHTML='<div class="smart-feature-art silence-feature" aria-hidden="true"><span>▥</span><strong>말 사이의 공백을 짧게.</strong></div><p class="preset-intro">조용한 구간을 먼저 확인하고<br>원하는 부분만 골라서 줄이세요.</p><div class="smart-card"><h3>선택 클립</h3><p class="note">'+(r?esc(r.item.name)+' · '+r.duration.toFixed(2)+'초':'타임라인에서 영상 또는 오디오를 선택하세요.')+'</p>'+button('silence','무음 구간 분석',!r,true)+'</div><p class="inspector-note">음량 기준·최소 무음 길이·말 앞뒤 여유를 조절할 수 있습니다. 원본의 소리를 분석하므로 편집기의 음소거·볼륨 설정과 무관합니다.</p><p class="note warning">선택한 클립과 같은 트랙만 당깁니다. 다른 트랙의 자막·음악은 움직이지 않으니 컷 적용 후 싱크를 확인해 주세요.</p>';
  }
  renderVoice(host){
    const v=this.voice,voices=installedVoices();if(!voices.some(x=>x.voiceURI===v.systemVoice))v.systemVoice=voices[0]?.voiceURI||'';
    host.innerHTML='<p class="preset-intro">원고를 음성으로.<br>API 키 없이 이 브라우저에서 만듭니다.</p><label class="field-label">실행 방식<select data-smart-input="voice-engine"><option value="local" '+(v.engine==='local'?'selected':'')+'>기기 내 AI · 음성 파일 생성</option><option value="device" '+(v.engine==='device'?'selected':'')+'>설치된 기기 음성 · 미리듣기</option></select></label>'+(v.engine==='local'?'<div class="voice-card"><div class="voice-avatar">≋</div><div><strong>Supertonic 2</strong><p>한국어 · 10가지 목소리 · 로컬 생성</p></div></div><label class="field-label">보이스<select data-smart-input="voice-id">'+TTS_MODEL.voices.map(id=>'<option value="'+id+'" '+(id===v.voice?'selected':'')+'>'+(id[0]==='F'?'여성':'남성')+' '+id[1]+' · '+id+'</option>').join('')+'</select></label><label class="field-label">생성 품질<select data-smart-input="voice-steps">'+[[3,'빠르게'],[5,'균형'],[8,'정교하게']].map(([id,label])=>'<option value="'+id+'" '+(id===v.steps?'selected':'')+'>'+label+'</option>').join('')+'</select></label>':'<label class="field-label">기기에 설치된 음성<select data-smart-input="system-voice">'+(voices.length?voices.map(x=>'<option value="'+esc(x.voiceURI)+'" '+(x.voiceURI===v.systemVoice?'selected':'')+'>'+esc(x.name)+' · '+esc(x.lang)+'</option>').join(''):'<option>설치된 음성이 없습니다</option>')+'</select></label><p class="note warning">브라우저 기본 음성 API는 소리를 파일로 돌려주지 않습니다. 이 모드는 미리듣기 전용이며, 영상에 넣으려면 위의 기기 내 AI 모드를 선택하세요.</p>')+
      rangeInput('속도','voice-speed',v.speed,.75,1.5,.05,'×')+'<label class="field-label">원고<textarea class="tts-text" data-smart-input="voice-text" maxlength="2000">'+esc(v.text)+'</textarea></label><p class="inspector-note" id="smartVoiceCount">'+v.text.length+' / 2,000자</p>'+(v.engine==='local'?'<label class="smart-consent"><input type="checkbox" data-smart-input="tts-consent" '+(v.accepted?'checked':'')+'><span>최초 약 276MB(모델·엔진) 다운로드와 <a href="vendor/supertonic/MODEL-LICENSE" target="_blank" rel="noopener">모델 이용 조건</a>에 동의합니다. 결과를 게시할 때 AI 생성 음성임을 표시하겠습니다.</span></label>'+button('voice','음성 만들기',false,true):button('voice','설치된 음성으로 미리듣기',!voices.length,true))+'<p class="library-hint">원고와 생성된 소리는 외부로 보내지 않습니다.<br>모델은 브라우저에 캐시되지만 저장 공간이 부족하면 다음에 다시 내려받을 수 있습니다.</p>';
  }
  async action(action,node){
    if(action==='cancel'){this.close();return;}
    if(this.busy)return;
    if(action==='mosaic')return this.openMosaic();
    if(action==='silence')return this.openSilence();
    if(action==='captions-selected'){this.captionScope='selected';return this.openCaptions();}
    if(action==='captions')return this.openCaptions();
    if(action==='voice')return this.openVoice();
    if(action==='track')return this.track();
    if(action==='save-mosaic')return this.saveMosaic(false);
    if(action==='static-mosaic')return this.saveMosaic(true);
    if(action==='add-mask'){
      if(this.state.effects.length>=MAX_MOSAICS)throw new Error('클립마다 모자이크 영역을 4개까지 추가할 수 있습니다.');
      this.state.effects.push(this.newMask());this.state.index=this.state.effects.length-1;this.renderMosaic();return;
    }
    if(action==='remove-mask'){const [removed]=this.state.effects.splice(this.state.index,1);this.state.edited.delete(removed?.id);this.state.index=Math.max(0,this.state.index-1);this.renderMosaic();return;}
    if(action==='seek-mask'){this.state.time=Number(node.dataset.time);return this.seekMosaic(this.state.time);}
    if(action==='apply-cut')return this.applyCut();
    if(action==='listen-cut')return this.listenCut();
    if(action==='apply-captions')return this.applyCaptions();
    if(action==='apply-voice')return this.applyVoice();
  }
  input(input){
    if(input.dataset.captionIndex!==undefined&&this.state?.kind==='captions'&&!this.busy)this.state.captions[Number(input.dataset.captionIndex)].text=input.value;
    const key=input.dataset.smartInput;if(!key||this.busy)return;
    const value=input.type==='checkbox'?input.checked:input.type==='range'||input.type==='number'?Number(input.value):input.value;
    if(key==='voice-text'){this.voice.text=value;const c=document.getElementById('smartVoiceCount');if(c)c.textContent=value.length+' / 2,000자';}
    if(key==='voice-speed')this.voice.speed=value;
    if(key==='voice-id')this.voice.voice=value;
    if(key==='voice-steps')this.voice.steps=Number(value);
    if(key==='system-voice')this.voice.systemVoice=value;
    if(key==='tts-consent')this.voice.accepted=value;
    if(key.startsWith('cut-')){
      const map={'cut-threshold':'thresholdDb','cut-minimum':'minSilence','cut-padding':'padding'};
      if(map[key])this.cutOptions[map[key]]=value;
    }
    const state=this.state;
    if(state?.kind==='mosaic'){
      const effect=state.effects[state.index];
      if(key==='mosaic-time'){state.time=value;this.seekMosaic(value).catch(error=>this.showError(error));}
      if(key==='mosaic-preview'){state.preview=value;this.drawMosaic();}
      if(effect){
        if(key==='mosaic-strength')effect.strength=value;
        if(key==='mosaic-padding')effect.padding=value/100;
        if(key==='mosaic-enabled')effect.enabled=value;
        if(key.startsWith('rect-')){effect.rect=normalizedRect({...effect.rect,[key.slice(5)]:value/100});if(effect.mode==='tracked')state.edited.add(effect.id);}
        if(key!=='mosaic-time')this.drawMosaic();
      }
    }
    if(input.type==='range'){const out=input.parentElement.querySelector('output'),suffix=key==='voice-speed'?'×':key==='cut-threshold'?' dBFS':key==='cut-minimum'||key==='cut-padding'||key==='mosaic-time'?'초':'%';if(out)out.textContent=Number(value).toFixed(Number(input.step)<1?2:0)+suffix;}
  }
  change(input){
    const key=input.dataset.smartInput;if(this.busy)return;
    if(key==='voice-engine'){this.voice.engine=input.value;this.hooks.renderLibrary();}
    if(key==='caption-scope'){this.captionScope=input.value;this.hooks.renderLibrary();}
    if(key==='mosaic-index'){this.state.index=Number(input.value);this.renderMosaic();}
    if(key?.startsWith('cut-')&&this.state?.buffer){this.reanalyze();}
    if(input.dataset.cutIndex!==undefined&&this.state?.kind==='silence'){
      const i=Number(input.dataset.cutIndex);input.checked?this.state.enabled.add(i):this.state.enabled.delete(i);this.renderCut();
    }
    if(input.dataset.captionIndex!==undefined&&this.state?.kind==='captions')this.state.captions[Number(input.dataset.captionIndex)].text=input.value;
  }
  newMask(){return {id:uid(),enabled:true,mode:'static',rect:{x:.35,y:.2,w:.3,h:.3},strength:75,padding:.12,keyframes:[]};}
  async openMosaic(){
    const range=this.videoRange();if(!range)throw new Error('타임라인에서 영상 또는 이미지를 선택해 주세요.');
    this.open('트래킹 모자이크','<p class="note">원본 프레임을 준비하고 있어요.</p>'+progressMarkup);
    const clip=range.item,position=clip.type==='video'?clip.trimStart+clamp(this.hooks.player.time-range.start,0,range.duration-.001):0;
    const state={kind:'mosaic',clip,range,before:captureDocument(),effects:structuredClone(clip.mosaics||[]),index:0,time:position,preview:true,edited:new Set()};
    if(!state.effects.length)state.effects.push(this.newMask());this.state=state;
    await this.run('mosaic-open',async signal=>{
      if(clip.type==='video'){this.readerCtrl=new AbortController();signal.addEventListener('abort',()=>this.readerCtrl?.abort(),{once:true});state.reader=await videoFrameReader(clip,this.readerCtrl.signal);}
      this.renderMosaic();await this.seekMosaic(position);
    });
  }
  renderMosaic(){
    const s=this.state;if(s?.kind!=='mosaic')return;const e=s.effects[s.index],isVideo=s.clip.type==='video';
    this.setBody('<p class="note"><strong>'+esc(s.clip.name)+'</strong><br>변형 전 원본에서 드래그해 영역을 다시 지정하세요.</p><div class="mosaic-stage"><canvas id="mosaicEditor" width="640" height="360" aria-label="모자이크 영역 지정"></canvas></div>'+(isVideo?rangeInput('원본 시각','mosaic-time',s.time,s.clip.trimStart,Math.max(s.clip.trimStart,s.clip.trimEnd-.001),.01)+'<p class="inspector-note" id="mosaicTimeLabel"></p>':'')+'<label class="check-label"><input type="checkbox" data-smart-input="mosaic-preview" '+(s.preview?'checked':'')+'>모자이크 결과 미리보기 · 끄면 원본</label><div class="field-grid"><label class="field-label">영역<select data-smart-input="mosaic-index">'+s.effects.map((m,i)=>'<option value="'+i+'" '+(i===s.index?'selected':'')+'>영역 '+(i+1)+' · '+(m.mode==='tracked'?'추적':'고정')+'</option>').join('')+'</select></label><div>'+button('add-mask','＋ 영역 추가',s.effects.length>=MAX_MOSAICS)+button('remove-mask','선택 영역 삭제',!e)+'</div></div>'+(e?'<label class="check-label"><input type="checkbox" data-smart-input="mosaic-enabled" '+(e.enabled?'checked':'')+'>선택 영역 켜기</label>'+rangeInput('모자이크 강도','mosaic-strength',e.strength,1,100,1,'%')+rangeInput('가림 여유','mosaic-padding',e.padding*100,0,50,1,'%')+'<details class="smart-details"><summary>영역 위치·크기 숫자로 조절</summary>'+['x','y','w','h'].map((k,i)=>rangeInput(['가로 위치','세로 위치','너비','높이'][i],'rect-'+k,e.rect[k]*100,k==='w'||k==='h'?.5:0,100,.5,'%')).join('')+'</details>'+(isVideo?button('track','현재 위치에서 자동 추적',false,true):''):'')+'<p class="smart-mask-status" id="mosaicStatus" role="status"></p>'+progressMarkup+'<div class="smart-result-actions">'+button('save-mosaic','모자이크 적용',false,true)+(e&&isVideo?button('static-mosaic','추적 없이 고정 영역으로 적용'):'')+'</div><p class="inspector-note">큰 강도일수록 블록이 커집니다. 가림은 완전히 불투명합니다. 추적이 끊기면 원본 보기를 켜 대상을 다시 지정한 뒤 추적을 실행하세요.</p>');
    const canvas=this.body.querySelector('canvas');let drag=null;
    const point=event=>{const r=canvas.getBoundingClientRect();return{x:clamp((event.clientX-r.left)/r.width,0,1),y:clamp((event.clientY-r.top)/r.height,0,1)};};
    canvas.onpointerdown=event=>{if(event.button!==0||this.busy||!s.effects[s.index])return;event.preventDefault();drag={start:point(event),old:{...s.effects[s.index].rect},edited:s.edited.has(s.effects[s.index].id)};canvas.setPointerCapture(event.pointerId);};
    canvas.onpointermove=event=>{if(!drag)return;const p=point(event),a=drag.start,mask=s.effects[s.index];mask.rect=normalizedRect({x:Math.min(a.x,p.x),y:Math.min(a.y,p.y),w:Math.max(.005,Math.abs(p.x-a.x)),h:Math.max(.005,Math.abs(p.y-a.y))});if(mask.mode==='tracked')s.edited.add(mask.id);this.drawMosaic();};
    canvas.onpointerup=()=>{drag=null;this.drawMosaic();};
    canvas.onpointercancel=()=>{if(drag){s.effects[s.index].rect=drag.old;if(!drag.edited)s.edited.delete(s.effects[s.index].id);}drag=null;this.drawMosaic();};
    this.drawMosaic();
  }
  async seekMosaic(time){
    const s=this.state;if(s?.kind!=='mosaic')return;s.queuedTime=time;if(s.seeking)return;
    s.seeking=true;
    try{while(s.queuedTime!==undefined&&this.state===s){const target=s.queuedTime;s.queuedTime=undefined;
      const frame=s.clip.type==='image'?{canvas:s.clip.bitmap,time:0}:await s.reader.frame(target);
      if(this.state!==s)return;
      const scale=Math.min(1,720/s.clip.natW,400/s.clip.natH),w=Math.max(1,Math.round(s.clip.natW*scale)),h=Math.max(1,Math.round(s.clip.natH*scale));
      s.raw||=document.createElement('canvas');s.raw.width=w;s.raw.height=h;s.raw.getContext('2d').drawImage(frame.canvas,0,0,w,h);s.frameTime=frame.time;
      if(s.queuedTime===undefined)this.drawMosaic();
    }}finally{s.seeking=false;}
  }
  drawMosaic(){
    const s=this.state,canvas=this.body.querySelector('#mosaicEditor');if(s?.kind!=='mosaic'||!canvas||!s.raw)return;
    if(canvas.width!==s.raw.width||canvas.height!==s.raw.height){canvas.width=s.raw.width;canvas.height=s.raw.height;}
    const ctx=canvas.getContext('2d'),e=s.effects[s.index];
    let source={img:s.raw,w:s.raw.width,h:s.raw.height,sourceTime:s.frameTime};
    if(s.preview)source=redactSource(ctx,source,{mosaics:s.effects.map(m=>s.edited.has(m.id)?{...m,mode:'static'}:m)},s.frameTime);
    ctx.drawImage(source.img,0,0,canvas.width,canvas.height);
    const changed=e&&s.edited.has(e.id),current=e?(changed?e.rect:mosaicAt(e,s.frameTime)):null,rect=current&&!current.full?current:e?.rect;
    if(rect){ctx.save();ctx.strokeStyle='#d5ffa0';ctx.lineWidth=2;ctx.setLineDash([7,4]);ctx.strokeRect(rect.x*canvas.width,rect.y*canvas.height,rect.w*canvas.width,rect.h*canvas.height);ctx.restore();}
    const label=this.body.querySelector('#mosaicTimeLabel');if(label)label.textContent='원본 '+s.frameTime.toFixed(2)+'초 · 전체 '+s.clip.srcDuration.toFixed(2)+'초';
    const status=this.body.querySelector('#mosaicStatus'),lost=e?.keyframes.filter(k=>k.lost).length||0;
    status.textContent=!e?'모든 모자이크를 제거할 수 있습니다.':changed?'영역이 변경됐습니다. 다시 추적하거나 고정 영역으로 적용하세요.':e.mode==='tracked'?(lost?'추적 끊김 '+lost+'개 지점 · 보정 전 내보내기 차단':'추적 '+e.keyframes.length+'개 위치 · 재생하며 결과를 확인해 주세요.'):'고정 영역 · 자동 추적 전입니다.';
    if(rect)for(const k of ['x','y','w','h']){const input=this.body.querySelector('[data-smart-input="rect-'+k+'"]');if(input&&document.activeElement!==input){input.value=e.rect[k]*100;input.nextElementSibling.textContent=(e.rect[k]*100).toFixed(1)+'%';}}
  }
  async track(){
    const s=this.state,e=s.effects[s.index];if(!e||s.clip.type!=='video')return;
    await this.run('tracking',async signal=>{
      const result=await trackMosaic(s.clip,e,s.time,{signal,onProgress:(p,m)=>this.progress(p,m)});
      if(signal.aborted)return;s.effects[s.index]=result;s.edited.delete(e.id);this.drawMosaic();
    });
  }
  async saveMosaic(fixed){
    const s=this.state;if(s?.kind!=='mosaic')return;
    if(JSON.stringify(captureDocument())!==JSON.stringify(s.before))throw new Error('편집 내용이 바뀌었습니다. 창을 닫고 다시 선택해 주세요.');
    const e=s.effects[s.index];
    if(fixed&&e){e.mode='static';e.keyframes=[];delete e.range;s.edited.delete(e.id);}
    if(s.edited.size)throw new Error('변경한 영역이 있습니다. 해당 영역에서 다시 추적하거나 고정 영역으로 적용해 주세요.');
    await this.run('mosaic-apply',async signal=>{
      if(s.reader&&s.clip.el&&s.effects.some(m=>m.enabled&&m.mode==='tracked')){
        const time=s.clip.trimStart+clamp(this.hooks.player.time-s.range.start,0,s.range.duration-.00001);
        const frame=await s.reader.frame(time);if(signal.aborted)return;
        this.hooks.player.rememberPresentedFrame(s.clip.el,frame.canvas,frame.time);
      }
      if(JSON.stringify(captureDocument())!==JSON.stringify(s.before))throw new Error('편집 내용이 바뀌었습니다. 창을 닫고 다시 선택해 주세요.');
      s.clip.mosaics=structuredClone(s.effects);this.hooks.commit(s.before,'모자이크 적용');
      const warning=unresolvedMosaics(s.clip).length;this.job=null;this.close(false);this.hooks.toast(warning?'모자이크를 저장했어요. 추적이 끊긴 구간을 보정해야 내보낼 수 있습니다.':'모자이크를 적용했어요. 미리보기와 완성 영상에 함께 반영됩니다.');
    });
  }
  async openSilence(){
    const range=this.audioRange();if(!range)throw new Error('영상 또는 오디오 클립을 선택해 주세요.');
    this.open('무음 구간 자동 컷','<p class="note">선택한 클립의 원본 소리를 읽고 있어요.</p>'+progressMarkup);
    const s={kind:'silence',range,before:captureDocument()};this.state=s;
    await this.run('silence-analysis',async signal=>{this.progress(.1,'원본 소리 분석 준비 중…');s.buffer=await selectedPcm(range,signal);if(signal.aborted)return;this.reanalyze();});
  }
  reanalyze(){const s=this.state;if(s?.kind!=='silence'||!s.buffer)return;s.analysis=analyzeSilence(s.buffer,{...this.cutOptions,fps:project.fps,duration:s.range.duration});s.enabled=new Set(s.analysis.removed.map((_,i)=>i));this.renderCut();}
  selectedCuts(){const s=this.state;return s.analysis.removed.filter((_,i)=>s.enabled.has(i));}
  renderCut(){
    const s=this.state,a=s.analysis,cuts=this.selectedCuts(),amount=cuts.reduce((n,r)=>n+r.end-r.start,0);
    this.setBody('<p class="note"><strong>'+esc(s.range.item.name)+'</strong> · '+trackLabel(s.range.trackId)+'<br>원본 '+s.range.duration.toFixed(2)+'초 → 적용 후 '+(s.range.duration-amount).toFixed(2)+'초</p><canvas id="silenceWaveform" class="silence-waveform" width="1000" height="120" aria-label="주황색이 삭제할 무음 구간"></canvas><p class="inspector-note">초록색: 소리 · 주황색: 선택한 삭제 구간</p>'+rangeInput('음량 기준','cut-threshold',this.cutOptions.thresholdDb,-70,-10,1,' dBFS')+rangeInput('최소 무음','cut-minimum',this.cutOptions.minSilence,.1,3,.05,'초')+rangeInput('말 앞뒤 여유','cut-padding',this.cutOptions.padding,0,.5,.01,'초')+'<p class="note">'+a.removed.length+'개 후보 · 선택한 '+amount.toFixed(2)+'초 삭제'+(a.allSilent?' · 전체가 무음으로 감지돼 적용을 막았습니다.':'')+'</p><div class="cut-candidates">'+(a.removed.length?a.removed.map((r,i)=>'<label><input type="checkbox" data-cut-index="'+i+'" '+(s.enabled.has(i)?'checked':'')+'><span>'+r.start.toFixed(2)+' → '+r.end.toFixed(2)+'초</span><small>'+(r.end-r.start).toFixed(2)+'초</small></label>').join(''):'<p class="note">현재 기준으로 삭제할 무음 구간이 없습니다.</p>')+'</div><p class="note warning">선택한 클립과 같은 트랙만 당깁니다. 다른 트랙의 자막·보이스·음악은 그대로입니다. 겹침 전환은 먼저 제거해 주세요.</p>'+button('listen-cut','남길 소리 미리듣기',!cuts.length||a.allSilent)+'<div id="cutAudioPreview"></div>'+progressMarkup+button('apply-cut','선택한 구간 적용 · '+amount.toFixed(2)+'초 줄이기',!cuts.length||a.allSilent,true));
    const canvas=this.body.querySelector('canvas'),ctx=canvas.getContext('2d');ctx.fillStyle='#101315';ctx.fillRect(0,0,1000,120);
    for(let x=0;x<1000;x+=2){const from=Math.floor(x/1000*a.levels.length),to=Math.max(from+1,Math.floor((x+2)/1000*a.levels.length));let level=0;for(let i=from;i<to;i++)level=Math.max(level,a.levels[i]||0);const h=Math.max(1,Math.min(55,level/Math.max(.03,a.peak)*55));ctx.fillStyle='#9daea0';ctx.fillRect(x,60-h,1,2*h);}
    ctx.fillStyle='#e7a15966';for(const r of cuts)ctx.fillRect(r.start/a.duration*1000,0,(r.end-r.start)/a.duration*1000,120);
  }
  listenCut(){
    const s=this.state,plan=planSilenceCuts({type:s.range.type,id:s.range.id},this.selectedCuts(),s.before),mono=monoPcm(s.buffer,16000);
    const parts=plan.kept.map(r=>mono.slice(Math.floor(r.start*16000),Math.floor(r.end*16000))),length=parts.reduce((sum,p)=>sum+p.length,0),joined=new Float32Array(length);let offset=0;
    for(const p of parts){joined.set(p,offset);offset+=p.length;}
    const url=this.objectUrl(encodeWav({length,numberOfChannels:1,sampleRate:16000,getChannelData:()=>joined}));
    const host=this.body.querySelector('#cutAudioPreview');host.querySelector('audio')?.pause();host.innerHTML='<audio controls src="'+url+'" aria-label="자동 컷 후 소리 미리듣기"></audio>';host.querySelector('audio').play().catch(()=>{});
  }
  async applyCut(){
    const s=this.state,plan=planSilenceCuts({type:s.range.type,id:s.range.id},this.selectedCuts(),s.before);
    await this.run('silence-apply',async signal=>{
      this.progress(.5,'선택한 트랙에 컷 적용 중…');const result=await applySilenceCuts(plan,{signal});
      this.hooks.commit(s.before,'무음 구간 자동 컷');this.hooks.select(result.type,result.id);this.hooks.timeline.reveal(result);
      this.job=null;this.close(false);this.hooks.toast(result.count+'개 클립으로 정리 · '+result.removedDuration.toFixed(2)+'초 줄였어요. 다른 트랙은 그대로입니다.');
    });
  }
  async openVoice(){
    const v={...this.voice};if(!v.text.trim())throw new Error('읽을 원고를 입력해 주세요.');
    if(v.engine==='local'&&!v.accepted)throw new Error('모델 다운로드와 이용 조건 동의에 체크해 주세요. API 비용은 없습니다.');
    this.open(v.engine==='local'?'브라우저 음성 생성':'설치된 음성 미리듣기','<p class="note">'+(v.engine==='local'?'원고는 이 기기 안에서 처리합니다. 첫 실행에는 모델 다운로드가 필요합니다.':'기기에 설치된 음성으로 읽습니다. 이 모드는 파일을 생성하지 않습니다.')+'</p>'+progressMarkup);
    const state={kind:'voice',before:captureDocument(),start:this.hooks.player.time,trackId:this.hooks.timeline.preferredTrack('voice'),voice:v};this.state=state;
    await this.run('voice',async signal=>{
      if(v.engine==='device'){this.progress(NaN,'미리듣기 중…');await speakInstalled(v.text,v.systemVoice,{rate:v.speed,signal});this.setBody('<p class="note">미리듣기를 마쳤습니다. 영상에 넣을 파일은 기기 내 AI 모드에서 만들 수 있습니다.</p>'+button('cancel','닫기'));return;}
      const result=await runLocalAI('tts',{text:v.text,voice:v.voice,speed:v.speed,steps:v.steps},{signal,onProgress:(p,m)=>this.progress(p,m)});
      if(signal.aborted)return;
      state.file=new File([result.wav],'AI 음성 '+v.voice+' '+new Date().toTimeString().slice(0,8).replace(/:/g,'-')+'.wav',{type:'audio/wav'});
      const url=this.objectUrl(state.file);
      this.setBody('<div class="smart-success">음성을 만들었어요.</div><p class="note">'+v.voice+' · '+result.duration.toFixed(2)+'초 · 44.1kHz WAV</p><audio controls src="'+url+'" aria-label="생성된 AI 음성 미리듣기"></audio><p class="note">'+esc(v.text)+'</p><p class="note warning">숫자·날짜·금액·이름을 먼저 들어보고 확인하세요. 게시할 때 AI 생성 음성임을 표시해야 합니다.</p>'+progressMarkup+button('apply-voice','보이스 트랙에 추가',false,true)+'<a class="button subtle wide" href="'+url+'" download="'+esc(state.file.name)+'">WAV 파일 다운로드</a>');
    });
  }
  async applyVoice(){
    const s=this.state;if(!s?.file)return;
    if(project.audio.tracks.length>=1000)throw new Error('오디오 클립은 최대 1,000개입니다. WAV 파일로 먼저 저장해 주세요.');
    await this.run('voice-add',async signal=>{
      const asset=await addAsset(s.file,{aiGenerated:true});
      if(signal.aborted||JSON.stringify(captureDocument())!==JSON.stringify(s.before)){this.hooks.saveDraft();this.hooks.refresh();this.hooks.toast('생성 음성은 소재함에 보관했어요. 원하는 위치로 끌어 넣을 수 있습니다.');this.job=null;this.close(false);return;}
      const before=captureDocument(),registry=timelineTracks();
      const existing=registry.find(row=>row.id===s.trackId&&row.kind==='audio')||registry.find(row=>row.role==='voice');
      if(!existing&&registry.filter(row=>row.kind==='audio').length>=MAX_TRACKS_PER_KIND){this.hooks.saveDraft();this.hooks.refresh();throw new Error('보이스 트랙을 추가할 공간이 없습니다. 생성 음성은 소재함에 보관했어요.');}
      const track=makeAudio(asset.id,{volume:1,fadeIn:0,fadeOut:0,role:'voice'});
      const target=existing?.id||addTimelineTrack('audio',{role:'voice'}).id;
      const result=placeTimelineItem('audio',track,planPlacement(s.start,asset.duration,target));
      this.hooks.commit(before,'브라우저 AI 음성 추가');this.hooks.select('audio',track.id);this.hooks.timeline.reveal(result);
      this.job=null;this.close(false);this.hooks.toast('음성을 보이스 트랙에 추가했어요. 완성 영상에도 포함됩니다.');
    });
  }
  async openCaptions(){
    const range=this.captionScope==='selected'?this.audioRange():null;
    if(this.captionScope==='selected'&&!range)throw new Error('타임라인에서 영상 또는 오디오 클립을 선택해 주세요.');
    if(!range&&totalDuration()<=0)throw new Error('먼저 영상 또는 말소리 오디오를 추가해 주세요.');
    if((range?.duration||totalDuration())>180)throw new Error('자동 자막은 한 번에 3분까지 지원합니다. 클립을 선택하거나 구간을 나눠 주세요.');
    if(!confirm('처음 사용하면 공개 자막 모델·엔진 약 66MB를 내려받습니다. 음성은 서버에 보내지 않고 이 기기에서 인식합니다. 기존 자막은 유지합니다. 시작할까요?'))return;
    this.open('자동 자막 · 한국어','<p class="note">말소리를 읽고 있어요. 원본 오디오는 이 기기 안에서 처리됩니다.</p>'+progressMarkup);
    const s={kind:'captions',before:captureDocument(),range};this.state=s;
    await this.run('captions',async signal=>{
      this.progress(.01,'인식할 소리 준비 중…');
      const buffer=range?await selectedPcm(range,signal,true):await mixTimeline({includeBgm:false,includeVoice:true,signal,strictSources:true});
      if(!buffer)throw new Error('인식할 영상 소리 또는 보이스 오디오가 없습니다.');
      const pcm=monoPcm(buffer,16000);let energy=0;for(const x of pcm)energy+=x*x;
      if(Math.sqrt(energy/pcm.length)<.0002)throw new Error('인식할 말소리가 너무 작거나 무음입니다. 기존 자막은 유지합니다.');
      const duration=Math.min(range?.duration??totalDuration(),buffer.length/buffer.sampleRate);
      const result=await runLocalAI('asr',{audio:pcm},{signal,onProgress:(p,m)=>this.progress(p,m)});
      if(signal.aborted)return;
      const normalized=whisperCaptions(result,duration,range?.start||0);
      if(!normalized.captions.length)throw new Error('유효한 시각이 있는 자막을 만들지 못했습니다. 말소리가 분명한 구간으로 다시 시도해 주세요.');
      Object.assign(s,normalized);s.gaps=findUncaptioned(buffer,s.captions.map(c=>({...c,start:c.start-(range?.start||0),end:c.end-(range?.start||0)})));
      this.setBody('<div class="smart-success">'+s.captions.length+'개 자막을 만들었어요.</div><p class="note">틀린 문구는 여기서 고친 뒤 적용하세요. 기존 자막은 지우지 않습니다.</p><p class="note warning">숫자·이름은 틀릴 수 있습니다.'+(s.skipped?' 시각이 불확실한 '+s.skipped+'개 항목은 제외했습니다.':'')+(s.gaps.length?' 소리는 있으나 자막이 없는 '+s.gaps.length+'개 구간도 확인해 주세요.':'')+'</p><div class="smart-caption-review">'+s.captions.map((c,i)=>'<label><span>'+c.start.toFixed(2)+' → '+c.end.toFixed(2)+'초</span><textarea data-caption-index="'+i+'" maxlength="3000" aria-label="자막 '+(i+1)+' 내용">'+esc(c.text)+'</textarea></label>').join('')+'</div><details class="smart-details"><summary>전체 인식 원문</summary><p>'+esc(s.text)+'</p></details>'+progressMarkup+button('apply-captions','새 자막 트랙에 추가',false,true));
    });
  }
  applyCaptions(){
    const s=this.state;if(s?.kind!=='captions'||!s.captions)return;
    if(JSON.stringify(captureDocument())!==JSON.stringify(s.before))throw new Error('인식 중 편집 내용이 바뀌었습니다. 적용하지 않고 현재 편집을 유지합니다.');
    const captions=s.captions.filter(c=>c.text.trim());if(!captions.length)throw new Error('추가할 자막 내용이 없습니다.');
    if(project.captions.length+captions.length>5000)throw new Error('자막은 최대 5,000개입니다. 구간을 나눠 작업해 주세요.');
    const track=addTimelineTrack('visual',{role:'caption'});
    for(const c of captions)c.trackId=track.id;
    project.captions.push(...captions);this.hooks.commit(s.before,'브라우저 자동 자막 추가');
    this.hooks.select('caption',captions[0].id);this.hooks.timeline.reveal({...captions[0],type:'caption'});
    this.close(false);this.hooks.toast(captions.length+'개 자막을 '+trackLabel(track.id)+'에 추가했어요. 기존 자막은 그대로입니다.');
  }
}
