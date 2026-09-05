// 자동 편집 패널은 결과를 먼저 보여주고, 사용자가 적용한 순간에만 프로젝트를 바꿉니다.
import { project, clipDuration, clipFadeGain, totalDuration, trackLabel, timelineTracks, addTimelineTrack, ensureAutoCaptionTrack, MAX_TRACKS_PER_KIND } from './state.js';
import { captureDocument, addAsset, makeAudio } from './project-store.js';
import { itemRange, planSilenceCuts, applySilenceCuts, placeTimelineItem, planPlacement } from './timeline-edits.js';
import { extractClipAudio, mixTimeline, findUncaptioned } from './audio.js';
import { encodeWav } from './ai-client.js';
import { analyzeSilence, monoPcm } from './silence.js';
import { normalizedRect, mosaicAt, redactSource, unresolvedMosaics, MAX_MOSAICS } from './mosaic.js';
import { videoFrameReader, trackMosaic } from './video-analysis.js';
import { trackCrop, cropTrackingAt, cropTrackingGeometry, cropTrackingWarnings, validCropTracking } from './crop-tracking.js';
import { clipGeometry, drawClipLayer } from './render.js';
import { evaluateItem } from './keyframes.js';
import { withVisualTransform } from './visual-transform.js';
import { TTS_MODEL, runLocalAI, whisperCaptions, installedVoices, speakInstalled } from './local-ai.js';
import { isPcVoiceOrigin, pcVoiceStatus, saveVoiceReference, deleteVoiceReference, generatePcVoice, decodeVoiceReference, recordVoiceReference } from './pc-voice.js';
import { isPcAsrOrigin, pcAsrStatus, pcAsrCaptions, transcribePcAudio } from './pc-asr.js';
import { transcribeRaw, serverCaptions, isAvailable as sttAvailable } from './transcribe.js';
import { uid, clamp } from './util.js';
import {canUsePcEngine,downloadPcVoiceSetup,pcSetupPlatform,pcVoiceSetupRequested,rememberPcVoiceSetupRequest,forgetPcVoiceSetupRequest,PC_VOICE_SETUP_DOWNLOAD} from './pc-connection.js';
import {PcHelpController} from './pc-help.js';
import {pcTrackingStatus} from './pc-tracking.js';
import {browserTrackingModelInfo} from './browser-tracking-models.js';

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
    if (!range.item.buffer) throw new Error('오디오 파일을 읽지 못했습니다.');
    return slicedPcm(range.item.buffer,range.item.trimStart,range.item.trimEnd);
  }
  const result=await extractClipAudio(range.item,signal,{ignoreMute:true,strict:true,allChannels:true,allowBoundaryGaps:forCaptions});
  if (!result) throw new Error('선택한 영상에서 오디오를 읽지 못했습니다.');
  return result;
}

export class StudioTools {
  constructor(hooks) {
    this.hooks=hooks;this.navigator=hooks.navigator||globalThis.navigator;this.job=null;this.state=null;
    this.voice={text:'안녕하세요. 오늘은 짧은 영상을 함께 편집합니다.',engine:'local',voice:'F1',speed:1,steps:5,systemVoice:'',accepted:false};
    this.pcVoice={status:null,error:'',checking:false,profileId:'',accepted:false};
    this.captionScope='selected';this.captionEngine=sttAvailable()?'server':'local';this.captionEngineChosen=false;
    this.pcAsr={status:null,error:'',checking:false,checked:false};this.cutOptions={thresholdDb:-38,minSilence:.45,padding:.1};
    this.pcTracking={status:null,error:'',checking:false,accepted:false};this.trackingEngine='browser';this.trackingEngineChosen=false;
    this.trackingDownloads={mosaic:false,crop:false};this.pcRefreshAt=0;this.pcStartingChecks=0;
    this.pcHelp=new PcHelpController({onChange:()=>this.refreshPcEngines(),toast:hooks.toast});
    this.dialog=document.createElement('dialog');this.dialog.className='modal smart-modal';this.dialog.id='smartToolsDialog';
    this.dialog.innerHTML='<div class="modal-heading"><h2 id="smartToolsTitle"></h2><button class="icon-button" data-smart-action="cancel" aria-label="작업 창 닫기">×</button></div><div class="modal-body smart-body"></div>';
    this.dialog.setAttribute('aria-labelledby','smartToolsTitle');document.body.append(this.dialog);
    this.dialog.addEventListener('cancel',event=>{event.preventDefault();this.close();});
    this.dialog.addEventListener('close',()=>this.cleanup());
    // Capture before timeline/document import handlers: reference audio is private.
    document.addEventListener('drop',event=>this.interceptPrivateFiles(event),true);
    document.addEventListener('paste',event=>this.interceptPrivateFiles(event),true);
    for (const host of [document.getElementById('libraryContent'),document.getElementById('inspectorContent'),this.dialog]) {
      host.addEventListener('click',event=>{
        const action=event.target.closest('[data-smart-action]');if(!action)return;
        event.preventDefault();event.stopPropagation();this.action(action.dataset.smartAction,action).catch(error=>this.showError(error));
      });
      host.addEventListener('input',event=>this.input(event.target));
      host.addEventListener('change',event=>this.change(event.target));
    }
    if (typeof speechSynthesis!=='undefined') speechSynthesis.addEventListener('voiceschanged',()=>{if(this.hooks.view()==='voice'&&this.voice.engine==='device')this.hooks.renderLibrary();});
    // 설치 확인에는 미디어를 보내지 않습니다. 공개 주소는 사용자가 연결을 승인한 뒤에만 확인합니다.
    globalThis.window?.addEventListener?.('studio-pc-connection',()=>this.refreshPcEngines());
    globalThis.window?.addEventListener?.('focus',()=>{if(Date.now()-this.pcRefreshAt>10000&&!this.busy)this.refreshPcEngines();});
    if(canUsePcEngine())queueMicrotask(()=>this.refreshPcEngines());
  }
  async refreshPcEngines(){
    this.pcRefreshAt=Date.now();
    if(!canUsePcEngine()){
      this.pcAsr.status=this.pcVoice.status=this.pcTracking.status=null;
      this.updatePcAsrStatus();this.updatePcVoiceStatus();this.updateTrackingSettings();return;
    }
    await Promise.allSettled([this.refreshPcAsr(),this.refreshPcVoice(),this.refreshPcTracking()]);
    if(this.pcHelp.status?.engines){
      this.pcHelp.status.engines={voice:this.pcVoice.status,asr:this.pcAsr.status,tracking:this.pcTracking.status};
      if(document.getElementById('helpDialog')?.open)this.pcHelp.render();
    }
    clearTimeout(this.pcStartingTimer);
    if(this.pcVoice.status?.state==='starting'&&this.pcStartingChecks++<40)this.pcStartingTimer=setTimeout(()=>this.refreshPcEngines(),2000);
    else this.pcStartingChecks=0;
  }
  async refreshPcTracking(){
    const pc=this.pcTracking;if(pc.checking||!canUsePcEngine())return;
    pc.checking=true;pc.error='';
    try{pc.status=await pcTrackingStatus();if(pc.status.available&&!this.trackingEngineChosen)this.trackingEngine='pc';}
    catch(error){pc.status=null;pc.error=error.message;}
    finally{pc.checking=false;this.updateTrackingSettings();}
  }
  trackingSettings(task){
    const model=browserTrackingModelInfo(task),pc=this.trackingEngine==='pc',status=this.pcTracking.status;
    const quick=task==='mosaic'?'모바일·브라우저 · 얼굴 빠른 추적':'모바일·브라우저 · 대상 빠른 추적';
    return '<label class="field-label">추적 방식<select data-smart-input="tracking-engine"><option value="pc" '+(pc?'selected':'')+'>Windows PC · 정밀 추적</option><option value="browser" '+(!pc?'selected':'')+'>'+quick+'</option></select></label>'
      +(pc?'<p class="inspector-note">'+esc(this.pcTracking.checking?'정밀 추적 준비 상태 확인 중…':status?.available?'정밀 추적을 사용할 수 있어요.':'정밀 추적 기능을 먼저 준비해 주세요.')+'</p>'
        +'<label class="smart-consent"><input type="checkbox" data-smart-input="tracking-pc-consent" '+(this.pcTracking.accepted?'checked':'')+'><span>이 클립의 원본 파일을 이 PC의 추적 엔진으로 보내 분석합니다. 외부 서버로 보내지 않습니다. 최대 3분 · 원본 256MB.</span></label>'
        +(!status?.available?button('pc-help','도움말 · PC 설치와 연결'):'')
      :'<p class="inspector-note">'+(task==='mosaic'?'얼굴을 검출하고 같은 얼굴을 연결합니다. 얼굴 외 대상은 Windows PC 정밀 추적을 선택하세요.':'사람·고양이·개 등 지원 대상을 검출하고 같은 대상을 연결합니다. 임의의 물체는 Windows PC 정밀 추적을 선택하세요.')+'</p>'
        +'<label class="smart-consent"><input type="checkbox" data-smart-input="tracking-download" '+(this.trackingDownloads[task]?'checked':'')+'><span>최초 '+((model.bytes+model.runtimeBytes)/1000000).toFixed(1)+'MB 필요 파일 다운로드 허용. 영상은 이 브라우저에서만 처리하며, 받은 파일은 재사용합니다.</span></label>')
      +'<p class="inspector-note">재추적하면 현재 클립 구간의 기존 추적 경로를 새 결과로 바꿉니다. 적용 전 결과를 확인하세요.</p>';
  }
  updateTrackingSettings(){
    const host=this.body?.querySelector('#trackingSettings'),task=this.state?.kind==='crop-tracking'?'crop':'mosaic';
    if(host&&!this.busy)host.innerHTML=this.trackingSettings(task);
  }
  trackingOptions(task){
    if(this.trackingEngine==='pc'){
      if(!canUsePcEngine()||!this.pcTracking.status?.available)throw new Error('도움말에서 PC 설치와 연결을 확인해 주세요. 브라우저 모델로 자동 전환하지 않습니다.');
      if(!this.pcTracking.accepted)throw new Error('영상을 이 PC에서 처리하는 안내를 확인해 주세요.');
    }
    return {engine:this.trackingEngine,allowModelDownload:this.trackingDownloads[task]===true};
  }
  get busy(){return !!this.job;}
  get body(){return this.dialog.querySelector('.smart-body');}
  currentRange(){const s=this.hooks.selection();return s?itemRange(s.type,s.id):null;}
  audioRange(){const r=this.currentRange();return r&&(r.type==='audio'||(r.type==='clip'&&r.item.type==='video'))?r:null;}
  videoRange(){const r=this.currentRange();return r?.type==='clip'?r:null;}
  showError(error){if(error.name==='AbortError')return;const box=this.dialog.open&&this.body.querySelector('.smart-error');if(box){box.hidden=false;box.textContent=error.message;}else this.hooks.toast(error.message);}
  cleanup(){
    this.state?.cancelCropDrag?.();
    if(['voice-setup','voice-connect'].includes(this.state?.kind))this.pcHelp.controller?.abort();
    this.referenceRecording?.cancel();this.referenceRecording=null;
    this.job?.abort();this.readerCtrl?.abort();this.readerCtrl=null;
    this.state?.reader?.close();this.state=null;
    this.dialog.querySelectorAll('audio,video').forEach(el=>el.pause());
    for(const url of this.urls||[])URL.revokeObjectURL(url);this.urls=[];
  }
  close(abort=true){this.referenceRecording?.cancel();this.referenceRecording=null;if(abort)this.job?.abort();if(this.dialog.open)this.dialog.close();else this.cleanup();}
  interceptPrivateFiles(event){
    const files=[...(event.dataTransfer?.files||event.clipboardData?.files||[])];
    if(!this.dialog.open||!files.length)return false;
    event.preventDefault();event.stopImmediatePropagation();
    const overlay=document.getElementById('dropOverlay');if(overlay)overlay.hidden=true;
    if(this.state?.kind==='voice-reference'&&!this.busy&&!this.referenceRecording){
      if(files.length!==1)this.showError(new Error('참고 음성은 한 번에 한 파일만 선택해 주세요.'));
      else this.loadVoiceReference(files[0]).catch(error=>this.showError(error));
    }
    return true;
  }
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
    if(type==='clip')return '<section class="property-section"><h3>자동 편집</h3>'+button('mosaic','▦ 모자이크 · 영역 / 추적')+(item.type==='video'?button('crop-tracking','⌖ 크롭 트래킹 · 대상 따라가기')+button('silence','✂ 무음 구간 자동 컷')+button('captions-selected','T 자동 자막 · 이 클립'):'')+'<p class="inspector-note">'+(item.mosaics?.length?'모자이크 '+item.mosaics.length+'개 적용됨':'원본 파일을 바꾸지 않습니다.')+(item.cropTracking?' · 크롭 추적 적용됨':'')+'</p></section>';
    if(type==='audio')return '<section class="property-section"><h3>자동 편집</h3>'+button('silence','✂ 무음 구간 자동 컷')+button('captions-selected','T 자동 자막 · 이 오디오')+'</section>';
    return '';
  }
  captionControls(){
    const r=this.audioRange(),disabled=(this.captionScope==='selected'?!r:totalDuration()<=0)||this.captionPcUnavailable();
    return '<section class="smart-card"><h3>자동 자막</h3><p class="note">말소리를 받아써 자동자막 트랙에 추가합니다. 기존 자막은 그대로 유지합니다.</p><div id="pcAsrSettings">'+this.pcAsrMarkup()+'</div><label class="field-label">인식 범위<select data-smart-input="caption-scope"><option value="selected" '+(this.captionScope==='selected'?'selected':'')+'>선택한 영상 / 오디오</option><option value="sequence" '+(this.captionScope==='sequence'?'selected':'')+'>전체 말소리 · 영상 + 보이스</option></select></label><p class="inspector-note">'+(this.captionScope==='selected'?(r?esc(r.item.name)+' · '+r.duration.toFixed(2)+'초':'타임라인에서 영상 또는 오디오를 선택하세요.'):'배경음악·효과음·음소거한 클립은 제외합니다. 일반 오디오로 등록한 말소리는 해당 클립을 선택해서 인식하세요.')+'</p>'+button('captions','자동 자막 만들기',disabled,true)+'<details class="smart-details"><summary>처리 방식</summary><label class="field-label">처리 위치<select data-smart-input="caption-engine">'+(sttAvailable()?'<option value="server" '+(this.captionEngine==='server'?'selected':'')+'>온라인 · 설치 없이</option>':'')+'<option value="pc" '+(this.captionEngine==='pc'?'selected':'')+'>이 PC · 고정밀</option><option value="local" '+(this.captionEngine==='local'?'selected':'')+'>브라우저 · 기기에서</option></select></label></details><p class="inspector-note">최대 3분 · 숫자·이름·소음이 있는 부분은 결과를 확인해 주세요.</p></section>';
  }
  captionPcUnavailable(){
    return this.captionEngine==='pc'&&(!isPcAsrOrigin()||this.pcAsr.checking||!this.pcAsr.status?.available||this.pcAsr.status?.busy);
  }
  pcAsrMarkup(){
    if(this.captionEngine==='server')return '<p class="inspector-note"><span class="local-badge server-badge">온라인 처리</span> 시작 전에 확인한 뒤 선택 구간의 소리만 자막 서버로 보냅니다.</p>';
    if(this.captionEngine==='local')return '<p class="inspector-note">이 브라우저에서 처리합니다. 처음에는 필요한 파일을 내려받으며, 온라인·PC 방식보다 인식 정확도가 낮을 수 있어요.</p>';
    const pc=this.pcAsr,message=pc.checking?'이 PC의 준비 상태를 확인하는 중…':pc.status?.busy?'이 PC의 다른 작업이 끝나면 다시 시작해 주세요.':pc.status?.available?'이 PC에서 처리합니다. 소리를 외부로 보내지 않습니다.':'이 PC에서 아직 자막을 만들 준비가 되지 않았어요. 처리 방식에서 온라인 또는 브라우저를 선택할 수 있습니다.';
    return '<p class="inspector-note" role="status">'+message+'</p>';
  }
  updatePcAsrStatus(){
    if(this.hooks.view?.()!=='captions')return;
    const library=document.getElementById('libraryContent');
    const settings=document.getElementById('pcAsrSettings');if(settings)settings.innerHTML=this.pcAsrMarkup();
    const engine=library?.querySelector('[data-smart-input="caption-engine"]');if(engine)engine.value=this.captionEngine;
    const create=library?.querySelector('[data-smart-action="captions"]'),r=this.audioRange();
    if(create)create.disabled=this.busy||(this.captionScope==='selected'?!r:totalDuration()<=0)||this.captionPcUnavailable();
  }
  async refreshPcAsr(){
    const pc=this.pcAsr;if(!isPcAsrOrigin())return pc.status;if(pc.promise)return pc.promise;
    pc.checking=true;pc.error='';this.updatePcAsrStatus();
    const work=(async()=>{
      try{pc.status=await pcAsrStatus();if(!this.captionEngineChosen&&pc.status.available&&!pc.status.busy)this.captionEngine='pc';}
      catch(error){pc.status=null;pc.error=error.message;}
      finally{pc.checking=false;pc.checked=true;this.updatePcAsrStatus();}
      return pc.status;
    })();pc.promise=work;
    try{return await work;}finally{if(pc.promise===work)delete pc.promise;}
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
    const choices=[['local','기본 음성'],['pc','내 목소리'],['device','기기 음성 · 미리듣기']];
    let settings='';
    if(v.engine==='pc')settings='<div id="pcVoiceSettings">'+this.pcVoiceMarkup()+'</div>';
    else if(v.engine==='local')settings='<div class="voice-card"><div class="voice-avatar">≋</div><div><strong>기본 음성</strong><p>한국어 · 10가지 목소리</p></div></div><label class="field-label">보이스<select data-smart-input="voice-id">'+TTS_MODEL.voices.map(id=>'<option value="'+id+'" '+(id===v.voice?'selected':'')+'>'+(id[0]==='F'?'여성':'남성')+' '+id[1]+'</option>').join('')+'</select></label><label class="field-label">생성 품질<select data-smart-input="voice-steps">'+[[3,'빠르게'],[5,'균형'],[8,'정교하게']].map(([id,label])=>'<option value="'+id+'" '+(id===v.steps?'selected':'')+'>'+label+'</option>').join('')+'</select></label><p class="inspector-note">처음 사용할 때 필요한 파일을 내려받습니다. <a href="vendor/supertonic/MODEL-LICENSE" target="_blank" rel="noopener">이용 조건</a></p>';
    else settings='<label class="field-label">기기에 설치된 음성<select data-smart-input="system-voice">'+(voices.length?voices.map(x=>'<option value="'+esc(x.voiceURI)+'" '+(x.voiceURI===v.systemVoice?'selected':'')+'>'+esc(x.name)+' · '+esc(x.lang)+'</option>').join(''):'<option>설치된 음성이 없습니다</option>')+'</select></label><p class="note warning">이 모드는 미리듣기 전용입니다. 영상에 넣으려면 기본 음성 또는 내 목소리를 사용해 주세요.</p>';
    let action=button('voice','설치된 음성으로 미리듣기',!voices.length,true);
    if(v.engine==='local')action=button('voice','음성 만들기',false,true);
    if(v.engine==='pc')action='<label class="smart-consent"><input type="checkbox" data-smart-input="pc-voice-consent" '+(this.pcVoice.accepted?'checked':'')+'><span>본인 또는 허락받은 목소리이며, 게시할 때 AI 생성 음성임을 표시하겠습니다.</span></label>'+button('voice','내 목소리로 만들기',!this.pcVoice.profileId||this.pcVoice.status?.profiles?.find(p=>p.id===this.pcVoice.profileId)?.audioAvailable===false||this.pcVoice.checking||['busy','stopping'].includes(this.pcVoice.status?.state),true);
    host.innerHTML='<p class="preset-intro">익숙한 기본 음성, 나만의 목소리.<br>모바일·PC 기본 기능은 그대로 유지됩니다.</p><label class="field-label">실행 방식<select data-smart-input="voice-engine">'+choices.map(([id,label])=>'<option value="'+id+'" '+(v.engine===id?'selected':'')+'>'+label+'</option>').join('')+'</select></label>'+settings+
      rangeInput('속도','voice-speed',v.speed,.75,1.5,.05,'×')+'<label class="field-label">원고<textarea class="tts-text" data-smart-input="voice-text" maxlength="2000">'+esc(v.text)+'</textarea></label><p class="inspector-note" id="smartVoiceCount">'+v.text.length+' / 2,000자</p>'+action+'<p class="library-hint">'+(v.engine==='pc'?'외부 TTS 서비스에 원고·녹음을 보내지 않습니다.<br>참고 녹음은 PC에 별도 보관하며, 완성된 음성만 프로젝트에 넣습니다.':'원고와 생성된 소리는 외부로 보내지 않습니다.<br>기기별 성능과 브라우저 지원에 따라 처리 시간이 달라집니다.')+'</p>';
  }
  pcVoiceMarkup(){
    const pc=this.pcVoice,status=pc.status,profiles=status?.profiles||[];
    const state=pc.checking?'checking':status?.state||'unknown';
    const message=pc.checking?'준비 상태를 확인하는 중…':status?.state==='ready'?'사용할 준비가 됐어요.':status?.state==='starting'?'필요한 기능을 시작하는 중…':status?.state==='busy'?'다른 음성 작업을 마치는 중…':'목소리 등록을 누르면 필요한 준비를 시작합니다.';
    return '<div class="voice-card"><div class="voice-avatar pc-voice-avatar">♬</div><div><strong>내 목소리</strong><p>등록한 목소리로 음성 만들기</p></div></div><div class="pc-engine-status" data-state="'+state+'" role="status"><span class="status-dot"></span><span>'+message+'</span></div>'+
      '<label class="field-label">등록한 목소리<select data-smart-input="pc-voice-profile" '+(!profiles.length?'disabled':'')+'>'+(profiles.length?profiles.map(p=>'<option value="'+esc(p.id)+'" '+(pc.profileId===p.id?'selected':'')+'>'+esc(p.name)+(p.audioAvailable===false?' · 다시 등록 필요':'')+'</option>').join(''):'<option>아직 등록한 목소리가 없습니다</option>')+'</select></label><div class="pc-voice-actions">'+button('voice-reference','목소리 등록',pc.checking||state==='busy')+button('delete-voice-reference','목소리 삭제',!pc.profileId||pc.checking||state==='busy')+'</div><p class="inspector-note">잡음 없는 5~10초 음성과 실제로 읽은 문장을 준비해 주세요.</p>';
  }
  updatePcVoiceStatus(){
    if(this.hooks.view()!=='voice'||this.voice.engine!=='pc')return;
    const host=document.getElementById('pcVoiceSettings');if(!host)return;
    const active=host.contains(document.activeElement)?document.activeElement:null;
    const input=active?.dataset.smartInput,action=active?.dataset.smartAction;
    host.innerHTML=this.pcVoiceMarkup();
    if(input||action){const next=host.querySelector(input?'[data-smart-input="'+input+'"]':'[data-smart-action="'+action+'"]');if(next&&!next.disabled)next.focus();}
    const pc=this.pcVoice,profile=pc.status?.profiles?.find(p=>p.id===pc.profileId);
    const create=document.getElementById('libraryContent')?.querySelector('[data-smart-action="voice"]');
    if(create)create.disabled=pc.checking||pc.status?.state!=='ready'||!profile||profile.audioAvailable===false;
  }
  async refreshPcVoice(){
    const pc=this.pcVoice;if(!isPcVoiceOrigin())return pc.status;if(pc.promise)return pc.promise;
    pc.checking=true;pc.error='';this.updatePcVoiceStatus();
    const work=(async()=>{
      try{pc.status=await pcVoiceStatus();if(!pc.status.profiles?.some(p=>p.id===pc.profileId))pc.profileId=pc.status.profiles?.[0]?.id||'';}
      catch(error){pc.status=null;pc.error=error.message;}
      finally{pc.checking=false;this.updatePcVoiceStatus();}
      return pc.status;
    })();pc.promise=work;
    try{return await work;}finally{if(pc.promise===work)delete pc.promise;}
  }
  pcVoiceInstalled(){
    const status=this.pcVoice.status;
    return status?.localServer===true&&(status.configured===true||status.state==='ready');
  }
  async beginPcVoiceAction(next){
    if(isPcVoiceOrigin()&&!this.pcVoice.status&&!this.pcVoice.checking)await this.refreshPcVoice();
    if(this.pcVoiceInstalled()){forgetPcVoiceSetupRequest();return this.continuePcVoiceAction(next);}
    const platform=pcSetupPlatform(this.navigator);
    if(platform!=='windows'){
      const device=platform==='mobile'?'모바일 기기':platform==='macos'?'Mac':'현재 기기';
      this.open('내 목소리 기능','<p class="note">내 목소리 기능은 현재 Windows PC에서 준비할 수 있어요. '+device+'에서는 기본 음성으로 바로 만들 수 있습니다.</p><div class="smart-result-actions">'+button('use-browser-voice','기본 음성 사용',false,true)+button('cancel','닫기')+'</div>');
      this.state={kind:'voice-unavailable',next};return;
    }
    if(!canUsePcEngine()&&pcVoiceSetupRequested()){
      this.open('내 목소리 준비','<p class="note">앞서 준비한 항목을 이 편집기에서 찾고 있어요.</p>'+progressMarkup);
      this.state={kind:'voice-connect',next};this.progress(NaN,'준비 상태 확인 중…');
      const connected=await this.pcHelp.check(true,{pairStartTimeoutMs:15000});
      if(this.state?.kind!=='voice-connect')return;
      if(connected){
        // 연결 완료 이벤트가 전체 엔진 확인을 이미 시작했어도 같은 요청 결과를 공유합니다.
        await this.refreshPcVoice();
        if(this.pcVoiceInstalled()){forgetPcVoiceSetupRequest();this.close(false);return this.continuePcVoiceAction(next);}
      }
      this.state={kind:'voice-setup',next};
      this.setBody('<p class="note">준비 항목을 찾지 못했어요. 받은 준비 파일을 실행했는지 확인하거나 다시 받아 주세요.</p><div class="smart-result-actions">'+button('confirm-voice-setup','준비 파일 다시 받기',false,true)+button('use-browser-voice','기본 음성 사용')+'</div>');
      return;
    }
    this.open('내 목소리 준비','<p class="note">내 목소리 기능을 처음 사용하려면 필요한 파일을 이 기기에 준비해야 합니다. 지금 준비할까요?</p><div class="smart-result-actions">'+button('confirm-voice-setup','동의',false,true)+button('cancel','취소')+'</div>');
    this.state={kind:'voice-setup',next};
  }
  async confirmPcVoiceSetup(){
    const setup=this.state;if(setup?.kind!=='voice-setup')return;
    const next=setup.next;
    if(pcSetupPlatform(this.navigator)!=='windows'){
      this.setBody('<p class="note">내 목소리 기능은 현재 Windows PC에서 준비할 수 있어요. 이 기기에서는 기본 음성을 사용해 주세요.</p>'+button('use-browser-voice','기본 음성 사용',false,true));return;
    }
    if(canUsePcEngine()){
      this.setBody('<p class="note">설치된 항목을 확인하고 있어요.</p>'+progressMarkup);this.progress(NaN,'준비 상태 확인 중…');
      await this.refreshPcVoice();
    }
    if(this.pcVoiceInstalled()){
      this.close(false);return this.continuePcVoiceAction(next);
    }
    if(!downloadPcVoiceSetup(document,this.navigator))throw new Error('이 기기에서는 Windows 준비 파일을 받을 수 없습니다.');
    rememberPcVoiceSetupRequest();
    this.setBody('<div class="smart-success">준비 파일을 받기 시작했어요.</div><p class="note">브라우저 보안상 받은 파일은 자동으로 실행할 수 없어요. 다운로드가 끝나면 파일을 한 번 실행해 주세요. 준비가 끝난 뒤 목소리 등록을 다시 누르면 자동으로 찾아 시작합니다.</p><a class="button secondary wide" href="'+PC_VOICE_SETUP_DOWNLOAD+'" download="Shorts-Studio-Voice-Setup.cmd">준비 파일 다시 받기</a>'+button('cancel','닫기'));
  }
  async continuePcVoiceAction(next){
    if(next==='register')return this.openVoiceReference();
    if(this.pcVoice.status?.state!=='ready'){
      await this.refreshPcEngines();
      if(this.pcVoice.status?.state!=='ready'){this.hooks.toast('내 목소리 기능을 시작하고 있어요. 잠시 후 다시 눌러 주세요.');return;}
    }
    return this.openVoice();
  }
  openVoiceReference(){
    if(!isPcVoiceOrigin()||!this.pcVoice.status?.localServer)throw new Error('목소리 등록 버튼을 눌러 필요한 준비를 먼저 마쳐 주세요.');
    this.open('내 목소리 등록','');
    this.state={kind:'voice-reference',name:'내 목소리',promptText:'안녕하세요. 제 목소리로 새로운 이야기를 들려드릴게요.',consent:false,reference:null};
    this.renderVoiceReference();
  }
  renderVoiceReference(){
    const s=this.state;if(s?.kind!=='voice-reference')return;
    this.setBody('<p class="note">조용한 곳에서 평소 말투로 <strong>3~10초</strong> 녹음하세요. 아래 문장을 읽거나, 파일을 고르면 실제로 읽은 내용으로 바꿔 주세요.</p><label class="field-label">목소리 이름<input data-smart-input="reference-name" maxlength="60" value="'+esc(s.name)+'"></label><label class="field-label">녹음에서 읽은 문장<textarea data-smart-input="reference-prompt" maxlength="500">'+esc(s.promptText)+'</textarea></label><div class="reference-recorder"><span class="record-indicator" aria-hidden="true"></span><p id="referenceRecordingStatus" role="status">마이크는 녹음 버튼을 눌렀을 때만 켜집니다.</p></div><div class="smart-result-actions">'+button('record-voice-reference','마이크로 녹음',false,true)+button('stop-voice-reference','녹음 마치기',true)+'</div><label class="reference-file-label">또는 짧은 음성 파일 선택<input type="file" accept="audio/*,.wav,.mp3,.m4a,.webm" data-smart-input="reference-file"></label>'+(s.reference?'<div class="reference-preview"><strong>'+s.reference.duration.toFixed(2)+'초 · 참고 음성</strong><audio controls src="'+s.previewUrl+'" aria-label="참고 음성 미리듣기"></audio></div>':'')+'<label class="smart-consent"><input type="checkbox" data-smart-input="reference-consent" '+(s.consent?'checked':'')+'><span>본인 또는 사용 허락을 받은 목소리입니다. 참고 녹음과 읽은 문장을 이 기기에 보관하는 데 동의합니다.</span></label>'+progressMarkup+button('save-voice-reference','이 목소리 등록',!s.reference,true)+'<p class="inspector-note">참고 음성은 라이브러리·자동 저장·프로젝트 파일에 포함되지 않으며, 목소리 삭제 시 함께 지워집니다.</p>');
  }
  async loadVoiceReference(file){
    if(!file)return;const s=this.state;if(s?.kind!=='voice-reference'||this.referenceRecording)return;
    await this.run('reference-decode',async signal=>{this.progress(NaN,'참고 음성 확인 중…');const result=await decodeVoiceReference(file,{signal});if(signal.aborted||this.state!==s)return;s.reference=result;s.previewUrl=this.objectUrl(result.wav);this.renderVoiceReference();});
  }
  async recordVoice(){
    const s=this.state;if(s?.kind!=='voice-reference'||this.referenceRecording)return;
    const label=this.body.querySelector('#referenceRecordingStatus');label.textContent='마이크 권한을 확인하고 있어요…';
    const controls=[...this.body.querySelectorAll('button:not([data-smart-action="cancel"]),input')].map(el=>[el,el.disabled]);for(const [el] of controls)el.disabled=true;
    const recording=recordVoiceReference({onStarted:()=>{if(this.state!==s)return;this.body.querySelector('[data-smart-action="stop-voice-reference"]').disabled=false;this.body.querySelector('.reference-recorder')?.classList.add('recording');},onTick:seconds=>{if(this.state===s)label.textContent='녹음 중 '+seconds.toFixed(1)+'초 / 최대 9초 · 문장을 다 읽으면 마치기를 누르세요.';}});
    this.referenceRecording=recording;
    try{const file=await recording.promise;if(this.state!==s)return;this.referenceRecording=null;await this.loadVoiceReference(file);}
    finally{if(this.referenceRecording===recording)this.referenceRecording=null;for(const [el,disabled] of controls)if(el.isConnected)el.disabled=disabled;if(this.state===s){this.body.querySelector('.reference-recorder')?.classList.remove('recording');if(label.isConnected)label.textContent='녹음이 끝났습니다. 참고 음성을 확인하거나 다시 녹음해 주세요.';}}
  }
  async saveReference(){
    const s=this.state;if(s?.kind!=='voice-reference'||!s.reference)return;
    if(!s.consent)throw new Error('목소리 사용 권한과 PC 보관 안내에 동의해 주세요.');
    try{await this.run('reference-save',async()=>{
      this.progress(NaN,'이 PC에 목소리를 보관하고 있어요. 창을 닫아도 저장은 완료될 수 있습니다.');
      const cancel=this.body.querySelector('.smart-progress [data-smart-action="cancel"]');if(cancel)cancel.textContent='창 닫기';
      // Persistent writes finish independently of closing the preview dialog.
      const result=await saveVoiceReference({name:s.name,promptText:s.promptText,wav:s.reference.wav,consent:s.consent});
      this.pcVoice.profileId=result.profile.id;const closed=this.state!==s||!this.dialog.open;
      this.job=null;if(!closed)this.close(false);
      this.hooks.toast(closed?'창은 닫혔지만 PC에 목소리 등록은 완료됐어요. 등록 목록에서 확인·삭제할 수 있습니다.':'내 목소리를 등록했어요. 원고를 입력해 음성을 만들어 보세요.');
    });}finally{await this.refreshPcVoice();}
  }
  async deleteReference(){
    const id=this.pcVoice.profileId;if(!id)return;
    if(!confirm('이 기기에 보관한 참고 녹음과 읽은 문장을 삭제할까요? 이미 만든 음성과 프로젝트는 유지됩니다.'))return;
    this.open('참고 음성 삭제',progressMarkup);
    const state={kind:'reference-delete'};this.state=state;
    try{await this.run('reference-delete',async()=>{
      this.progress(NaN,'참고 음성 삭제 중… 창을 닫아도 삭제는 완료될 수 있습니다.');
      const cancel=this.body.querySelector('.smart-progress [data-smart-action="cancel"]');if(cancel)cancel.textContent='창 닫기';
      await deleteVoiceReference(id);this.pcVoice.profileId='';this.job=null;
      if(this.state===state&&this.dialog.open)this.close(false);
      this.hooks.toast('PC에 보관한 참고 음성을 삭제했어요.');
    });}finally{await this.refreshPcVoice();}
  }
  async action(action,node){
    if(action==='cancel'){this.close();return;}
    if(action==='stop-voice-reference'){this.referenceRecording?.stop();return;}
    if(this.referenceRecording)return;
    if(this.busy)return;
    if(this.state?.cropDrag)return;
    if(action==='pc-help'){this.pcHelp.show();return;}
    if(action==='pc-asr-refresh')return this.refreshPcAsr();
    if(action==='use-browser-captions'){this.captionEngine='local';this.captionEngineChosen=true;this.hooks.renderLibrary();return;}
    if(action==='pc-voice-refresh')return this.refreshPcVoice();
    if(action==='use-browser-voice'){if(this.dialog?.open)this.close(false);this.voice.engine='local';this.hooks.renderLibrary();return;}
    if(action==='voice-reference')return this.beginPcVoiceAction('register');
    if(action==='confirm-voice-setup')return this.confirmPcVoiceSetup();
    if(action==='record-voice-reference')return this.recordVoice();
    if(action==='save-voice-reference')return this.saveReference();
    if(action==='delete-voice-reference')return this.deleteReference();
    if(action==='mosaic')return this.openMosaic();
    if(action==='crop-tracking')return this.openCropTracking();
    if(action==='track-crop')return this.analyzeCropTracking();
    if(action==='apply-crop-tracking')return this.applyCropTracking(false);
    if(action==='remove-crop-tracking')return this.applyCropTracking(true);
    if(action==='silence')return this.openSilence();
    if(action==='captions-selected'){this.captionScope='selected';return this.openCaptions();}
    if(action==='captions')return this.openCaptions();
    if(action==='voice')return this.voice.engine==='pc'?this.beginPcVoiceAction('create'):this.openVoice();
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
    if(key==='pc-voice-consent')this.pcVoice.accepted=value;
    if(key==='tracking-pc-consent')this.pcTracking.accepted=value;
    if(key==='tracking-download')this.trackingDownloads[this.state?.kind==='crop-tracking'?'crop':'mosaic']=value;
    if(key==='pc-voice-profile'){this.pcVoice.profileId=value;this.updatePcVoiceStatus();}
    if(this.state?.kind==='voice-reference'){
      if(key==='reference-name')this.state.name=value;
      if(key==='reference-prompt')this.state.promptText=value;
      if(key==='reference-consent')this.state.consent=value;
    }
    if(key.startsWith('cut-')){
      const map={'cut-threshold':'thresholdDb','cut-minimum':'minSilence','cut-padding':'padding'};
      if(map[key])this.cutOptions[map[key]]=value;
    }
    const state=this.state;
    if(state?.kind==='crop-tracking'&&!state.cropDrag){
      if(key==='crop-track-time'){state.time=clamp(value,0,state.range.duration-.00001);this.seekCropTracking(state.time).catch(error=>this.showError(error));}
      if(key==='crop-track-zoom'){state.zoom=clamp(value,1,3);if(state.tracking)state.tracking={...state.tracking,zoom:state.zoom};this.drawCropTracking();}
    }
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
    if(input.type==='range'){const out=input.parentElement.querySelector('output'),suffix=key==='voice-speed'||key==='crop-track-zoom'?'×':key==='cut-threshold'?' dBFS':key==='cut-minimum'||key==='cut-padding'||key==='mosaic-time'||key==='crop-track-time'?'초':'%';if(out)out.textContent=Number(value).toFixed(Number(input.step)<1?2:0)+suffix;}
  }
  change(input){
    const key=input.dataset.smartInput;if(this.busy)return;
    if(key==='tracking-engine'&&['pc','browser'].includes(input.value)){this.trackingEngine=input.value;this.trackingEngineChosen=true;this.updateTrackingSettings();if(input.value==='pc')this.refreshPcTracking();}
    if(key==='voice-engine'){this.voice.engine=input.value;this.hooks.renderLibrary();if(input.value==='pc'&&!this.pcVoice.status)this.refreshPcVoice();}
    if(key==='reference-file'){const file=input.files?.[0];input.value='';this.loadVoiceReference(file).catch(error=>this.showError(error));}
    if(key==='caption-engine'&&['local','pc','server'].includes(input.value)){this.captionEngine=input.value;this.captionEngineChosen=true;this.hooks.renderLibrary();if(input.value==='pc'&&!this.pcAsr.status)this.refreshPcAsr();}
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
    this.setBody('<p class="note"><strong>'+esc(s.clip.name)+'</strong><br>변형 전 원본에서 드래그해 영역을 다시 지정하세요.</p>'+(isVideo?'<div id="trackingSettings">'+this.trackingSettings('mosaic')+'</div>':'')+'<div class="mosaic-stage"><canvas id="mosaicEditor" width="640" height="360" aria-label="모자이크 영역 지정"></canvas></div>'+(isVideo?rangeInput('원본 시각','mosaic-time',s.time,s.clip.trimStart,Math.max(s.clip.trimStart,s.clip.trimEnd-.001),.01)+'<p class="inspector-note" id="mosaicTimeLabel"></p>':'')+'<label class="check-label"><input type="checkbox" data-smart-input="mosaic-preview" '+(s.preview?'checked':'')+'>모자이크 결과 미리보기 · 끄면 원본</label><div class="field-grid"><label class="field-label">영역<select data-smart-input="mosaic-index">'+s.effects.map((m,i)=>'<option value="'+i+'" '+(i===s.index?'selected':'')+'>영역 '+(i+1)+' · '+(m.mode==='tracked'?'추적':'고정')+'</option>').join('')+'</select></label><div>'+button('add-mask','＋ 영역 추가',s.effects.length>=MAX_MOSAICS)+button('remove-mask','선택 영역 삭제',!e)+'</div></div>'+(e?'<label class="check-label"><input type="checkbox" data-smart-input="mosaic-enabled" '+(e.enabled?'checked':'')+'>선택 영역 켜기</label>'+rangeInput('모자이크 강도','mosaic-strength',e.strength,1,100,1,'%')+rangeInput('가림 여유','mosaic-padding',e.padding*100,0,50,1,'%')+'<details class="smart-details"><summary>영역 위치·크기 숫자로 조절</summary>'+['x','y','w','h'].map((k,i)=>rangeInput(['가로 위치','세로 위치','너비','높이'][i],'rect-'+k,e.rect[k]*100,k==='w'||k==='h'?.5:0,100,.5,'%')).join('')+'</details>'+(isVideo?button('track','현재 위치에서 자동 추적',false,true):''):'')+'<p class="smart-mask-status" id="mosaicStatus" role="status"></p>'+progressMarkup+'<div class="smart-result-actions">'+button('save-mosaic','모자이크 적용',false,true)+(e&&isVideo?button('static-mosaic','추적 없이 고정 영역으로 적용'):'')+'</div><p class="inspector-note">큰 강도일수록 블록이 커집니다. 가림은 완전히 불투명합니다. 추적이 끊기면 원본 보기를 켜 대상을 다시 지정한 뒤 추적을 실행하세요.</p>');
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
    const options=this.trackingOptions('mosaic');
    await this.run('tracking',async signal=>{
      const result=await trackMosaic(s.clip,e,s.time,{...options,signal,onProgress:(p,m)=>this.progress(p,m)});
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
  async openCropTracking(){
    const range=this.videoRange();
    if(!range||range.item.type!=='video')throw new Error('타임라인에서 영상 클립을 선택해 주세요.');
    if(range.duration>180)throw new Error('크롭 추적은 3분 이내의 클립을 지원합니다. 필요한 구간으로 먼저 트림해 주세요.');
    const clip=range.item,time=clamp(this.hooks.player.time-range.start,0,Math.max(0,range.duration-.00001));
    this.open('크롭 트래킹 · 선택한 대상 따라가기','<p class="note">원본 프레임을 준비하고 있어요.</p>'+progressMarkup);
    const tracking=clip.cropTracking?{...structuredClone(clip.cropTracking),enabled:true,zoom:clamp(clip.cropTracking.zoom,1,3)}:null;
    const point=cropTrackingAt({cropTracking:tracking},time);
    const s={kind:'crop-tracking',clip,range,before:captureDocument(),time,tracking,zoom:clamp(tracking?.zoom??1.15,1,3),
      rect:point?normalizedRect(point):{x:.35,y:.25,w:.3,h:.3},selected:false,pending:false,seedTime:time};
    this.state=s;
    await this.run('crop-open',async signal=>{
      const readerCtrl=new AbortController();this.readerCtrl=readerCtrl;
      signal.addEventListener('abort',()=>readerCtrl.abort(),{once:true});
      s.reader=await videoFrameReader(clip,readerCtrl.signal);
      if(signal.aborted||this.state!==s){s.reader.close();return;}
      this.renderCropTracking();await this.seekCropTracking(time);
    });
    if(this.state===s)this.drawCropTracking();
  }
  renderCropTracking(){
    const s=this.state;if(s?.kind!=='crop-tracking')return;
    this.setBody('<p class="note"><strong>'+esc(s.clip.name)+'</strong><br>원본 화면에서 따라갈 대상을 박스로 지정하세요.</p>'
      +'<div id="trackingSettings">'+this.trackingSettings('crop')+'</div>'
      +'<div class="mosaic-stage"><canvas id="cropTrackingEditor" width="640" height="360" aria-label="따라갈 대상 영역 지정" style="touch-action:none"></canvas></div>'
      +rangeInput('클립 안 시각','crop-track-time',s.time,0,Math.max(0,s.range.duration-.00001),.01,'초')
      +'<p class="inspector-note" id="cropTrackingTime"></p>'+rangeInput('추적 확대','crop-track-zoom',s.zoom,1,3,.05,'×')
      +button('track-crop','박스를 지정한 시각에서 추적',true,true)
      +'<p class="smart-mask-status" id="cropTrackingStatus" role="status" aria-live="polite"></p>'
      +'<div class="smart-card"><h3>9:16 리프레임 미리보기</h3><canvas id="cropTrackingPreview" width="180" height="320" style="display:block;width:180px;max-width:100%;height:auto;margin:auto;background:#101315" aria-label="추적 결과 9대16 미리보기"></canvas>'
      +'<p class="inspector-note">분석 후 시각 슬라이더를 움직여 확인하세요. 해당 클립의 채우기·변형·모자이크만 표시하며 자막과 다른 트랙은 제외합니다. 적용하면 영상 맞춤을 채우기로 바꿉니다.</p></div>'
      +'<p class="note warning">최대 3분 · 급격한 움직임, 가림, 장면 전환에서는 추적이 끊길 수 있습니다. 끊긴 구간은 마지막 위치를 유지합니다. 클립을 나눠 재추적하거나 위치 키프레임으로 보정하세요.</p>'
      +progressMarkup+button('apply-crop-tracking','추적 결과 적용',!s.tracking,true)+button('remove-crop-tracking','기존 크롭 추적 제거',!s.clip.cropTracking));
    this.bindCropSelection();this.drawCropTracking();
  }
  bindCropSelection(){
    const s=this.state,canvas=this.body.querySelector('#cropTrackingEditor');if(!canvas)return;
    const point=event=>{const r=canvas.getBoundingClientRect();return{x:clamp((event.clientX-r.left)/Math.max(1,r.width),0,1),y:clamp((event.clientY-r.top)/Math.max(1,r.height),0,1)};};
    const finish=cancel=>{
      const drag=s.cropDrag;if(!drag)return;s.cropDrag=null;
      if(cancel||!drag.moved)Object.assign(s,drag.old);
      window.removeEventListener('blur',abort);window.removeEventListener('keydown',escape,true);
      if(canvas.hasPointerCapture?.(drag.pointer))canvas.releasePointerCapture(drag.pointer);
      if(this.state===s)this.drawCropTracking();
    };
    const abort=()=>finish(true),escape=event=>{if(event.key==='Escape'&&s.cropDrag){event.preventDefault();event.stopImmediatePropagation();finish(true);}};
    s.cancelCropDrag=abort;
    canvas.onpointerdown=event=>{
      if(event.button!==0||event.isPrimary===false||this.busy||s.seeking||s.cropDrag||!s.raw)return;
      event.preventDefault();s.cropDrag={pointer:event.pointerId,start:point(event),clientX:event.clientX,clientY:event.clientY,moved:false,
        old:{rect:{...s.rect},selected:s.selected,pending:s.pending,seedTime:s.seedTime}};
      canvas.setPointerCapture(event.pointerId);window.addEventListener('blur',abort);window.addEventListener('keydown',escape,true);
      this.drawCropTracking();
    };
    canvas.onpointermove=event=>{
      const drag=s.cropDrag;if(!drag||event.pointerId!==drag.pointer)return;
      if(!drag.moved&&Math.hypot(event.clientX-drag.clientX,event.clientY-drag.clientY)<2)return;
      const p=point(event),start=drag.start;drag.moved=true;
      s.rect=normalizedRect({x:Math.min(start.x,p.x),y:Math.min(start.y,p.y),w:Math.max(.005,Math.abs(start.x-p.x)),h:Math.max(.005,Math.abs(start.y-p.y))});
      s.seedTime=s.frameLocalTime;s.selected=true;s.pending=true;this.drawCropTracking();
    };
    canvas.onpointerup=event=>{if(event.pointerId===s.cropDrag?.pointer)finish(false);};
    canvas.onpointercancel=event=>{if(event.pointerId===s.cropDrag?.pointer)finish(true);};
    canvas.onlostpointercapture=event=>{if(event.pointerId===s.cropDrag?.pointer)finish(true);};
  }
  async seekCropTracking(time){
    const s=this.state;if(s?.kind!=='crop-tracking'||!s.reader)return;
    s.queuedTime=clamp(time,0,Math.max(0,s.range.duration-.00001));s.time=s.queuedTime;if(s.seeking)return;
    s.seeking=true;this.drawCropTracking();
    try{
      while(s.queuedTime!==undefined&&this.state===s){
        const local=s.queuedTime;s.queuedTime=undefined;
        const frame=await s.reader.frame(s.clip.trimStart+local);if(this.state!==s)return;
        const width=s.clip.natW||frame.canvas.width,height=s.clip.natH||frame.canvas.height,scale=Math.min(1,720/width,400/height);
        s.raw||=document.createElement('canvas');s.raw.width=Math.max(1,Math.round(width*scale));s.raw.height=Math.max(1,Math.round(height*scale));
        s.raw.getContext('2d').drawImage(frame.canvas,0,0,s.raw.width,s.raw.height);
        s.sourceFrameTime=frame.time;s.frameLocalTime=clamp(frame.time-s.clip.trimStart,0,s.range.duration);
        if(s.queuedTime===undefined)this.drawCropTracking();
      }
    }finally{s.seeking=false;if(this.state===s)this.drawCropTracking();}
  }
  drawCropTracking(){
    const s=this.state;if(s?.kind!=='crop-tracking')return;
    const canvas=this.body.querySelector('#cropTrackingEditor'),preview=this.body.querySelector('#cropTrackingPreview');if(!canvas||!preview)return;
    const blocked=this.busy||s.seeking||!!s.cropDrag;
    const actions={'track-crop':blocked||!s.selected,'apply-crop-tracking':blocked||!s.tracking||s.pending,'remove-crop-tracking':blocked||!s.clip.cropTracking};
    for(const [action,disabled] of Object.entries(actions)){const node=this.body.querySelector('[data-smart-action="'+action+'"]');if(node)node.disabled=disabled;}
    for(const key of ['crop-track-time','crop-track-zoom']){const node=this.body.querySelector('[data-smart-input="'+key+'"]');if(node)node.disabled=this.busy||!!s.cropDrag;}
    if(!s.raw)return;
    if(canvas.width!==s.raw.width||canvas.height!==s.raw.height){canvas.width=s.raw.width;canvas.height=s.raw.height;}
    const ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(s.raw,0,0);
    const at=cropTrackingAt({cropTracking:s.tracking},s.frameLocalTime);
    const sameSeed=Math.abs(s.frameLocalTime-s.seedTime)<.001;
    const rect=s.pending?(sameSeed?s.rect:null):at||(!s.tracking&&s.selected&&sameSeed?s.rect:null);
    if(rect){ctx.save();ctx.strokeStyle=at?.lost&&!s.pending?'#e7a159':'#d5ffa0';ctx.lineWidth=2;ctx.setLineDash([7,4]);ctx.strokeRect(rect.x*canvas.width,rect.y*canvas.height,rect.w*canvas.width,rect.h*canvas.height);ctx.restore();}
    const label=this.body.querySelector('#cropTrackingTime');if(label)label.textContent='클립 '+s.frameLocalTime.toFixed(2)+'초 · 원본 '+s.sourceFrameTime.toFixed(2)+'초'+(s.seeking?' · 프레임을 읽는 중…':'');
    const status=this.body.querySelector('#cropTrackingStatus');
    if(status)status.textContent=s.pending?'박스가 변경됐습니다. '+s.seedTime.toFixed(2)+'초에서 다시 추적한 뒤 적용하세요.':s.tracking?(s.tracking.keys.length+'개 위치 · '+(at?.lost?'현재 구간에서 대상을 놓쳤습니다. ':'')+(cropTrackingWarnings({cropTracking:s.tracking})[0]||'슬라이더로 움직임을 확인해 주세요.')):'따라갈 대상의 무늬가 잘 보이는 영역을 박스로 지정하세요.';
    this.drawCropPreview(preview,s);
  }
  drawCropPreview(canvas,s){
    const W=canvas.width,H=canvas.height,ctx=canvas.getContext('2d');ctx.setTransform(1,0,0,1,0,0);ctx.globalAlpha=1;ctx.clearRect(0,0,W,H);ctx.fillStyle='#000';ctx.fillRect(0,0,W,H);
    if(!s.tracking||s.pending){ctx.fillStyle='#a4afa7';ctx.font='13px sans-serif';ctx.textAlign='center';ctx.fillText(s.pending?'다시 추적해 주세요':'추적 결과 대기',W/2,H/2);return;}
    const local=s.frameLocalTime,clip=evaluateItem({...s.clip,fit:'cover',cropTracking:{...s.tracking,zoom:s.zoom}},local);
    const source=redactSource(ctx,{img:s.raw,w:s.raw.width,h:s.raw.height,sourceTime:s.sourceFrameTime},clip,s.sourceFrameTime);
    const geometry=cropTrackingGeometry(clip,local,clipGeometry(W,H,s.clip.natW||s.raw.width,s.clip.natH||s.raw.height,clip),W,H);
    const bounds={x:geometry.dx,y:geometry.dy,w:geometry.dw,h:geometry.dh};
    const alpha=(clip.transform?.opacity??1)*clipFadeGain(clip,local,s.range.duration),opaque={...clip,transform:{...clip.transform,opacity:1}};
    // 배경과 영상을 먼저 합친 뒤 불투명도·페이드를 딱 한 번 적용합니다.
    s.previewLayer||=document.createElement('canvas');const plate=s.previewLayer;
    if(plate.width!==W||plate.height!==H){plate.width=W;plate.height=H;}
    const paint=plate.getContext('2d');paint.setTransform(1,0,0,1,0,0);paint.globalAlpha=1;paint.globalCompositeOperation='source-over';paint.filter='none';paint.clearRect(0,0,W,H);
    withVisualTransform(paint,bounds,opaque,W,H,()=>drawClipLayer(paint,W,H,{clip:opaque,local,duration:s.range.duration},source));
    ctx.save();ctx.globalAlpha=alpha;ctx.drawImage(plate,0,0);ctx.restore();
  }
  async analyzeCropTracking(){
    const s=this.state;if(s?.kind!=='crop-tracking'||!s.selected)return;
    if(s.seeking||s.cropDrag)throw new Error('영역 선택과 프레임 준비가 끝난 뒤 추적해 주세요.');
    if(JSON.stringify(captureDocument())!==JSON.stringify(s.before))throw new Error('편집 내용이 바뀌었습니다. 창을 닫고 다시 선택해 주세요.');
    const options=this.trackingOptions('crop');
    await this.run('crop-tracking',async signal=>{
      const result=await trackCrop(s.clip,s.rect,s.seedTime,{...options,signal,zoom:s.zoom,onProgress:(value,message)=>this.progress(value,message)});
      if(signal.aborted||this.state!==s)return;
      s.tracking=result.tracking;s.pending=false;s.selected=false;
    });
    if(this.state===s)this.drawCropTracking();
  }
  applyCropTracking(remove=false){
    const s=this.state;if(s?.kind!=='crop-tracking'||this.busy)return;
    if(s.seeking||s.cropDrag)throw new Error('영역 선택과 프레임 준비가 끝난 뒤 적용해 주세요.');
    if(JSON.stringify(captureDocument())!==JSON.stringify(s.before)||!project.clips.includes(s.clip))throw new Error('편집 내용이 바뀌었습니다. 적용하지 않고 현재 편집을 유지합니다.');
    const tracking=s.tracking?{...s.tracking,zoom:s.zoom}:null;
    if(!remove&&(s.pending||!tracking||!validCropTracking(tracking,s.range.duration)))throw new Error('현재 영역을 추적한 뒤 결과를 적용해 주세요.');
    if(remove){if(!s.clip.cropTracking)return;delete s.clip.cropTracking;}
    else{s.clip.cropTracking=structuredClone(tracking);s.clip.fit='cover';}
    this.hooks.commit(s.before,remove?'크롭 추적 제거':'크롭 트래킹 적용');
    const warnings=remove?[]:cropTrackingWarnings(s.clip);this.close(false);
    this.hooks.toast(remove?'크롭 추적을 제거했어요. 원래 변형 키프레임은 유지됩니다.':warnings.length?'추적을 적용했어요. 대상을 놓친 구간을 확인하고 위치 키프레임으로 보정해 주세요.':'크롭 추적을 적용했어요. 미리보기와 완성 영상에 함께 반영됩니다.');
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
    if(v.engine==='local'&&!v.accepted){
      if(!confirm('기본 음성을 처음 사용하려면 필요한 파일을 내려받습니다. 이용 조건에 동의하고 지금 준비할까요?'))return;
      v.accepted=this.voice.accepted=true;
    }
    const pc=v.engine==='pc',profile=pc?this.pcVoice.status?.profiles?.find(p=>p.id===this.pcVoice.profileId):null;
    if(pc&&(!isPcVoiceOrigin()||this.pcVoice.status?.state!=='ready'||!profile||profile.audioAvailable===false))throw new Error('사용할 목소리를 먼저 등록하거나 선택해 주세요.');
    if(pc&&!this.pcVoice.accepted)throw new Error('목소리 사용 권한을 확인해 주세요.');
    const title=pc?'내 목소리로 만들기':v.engine==='local'?'음성 만들기':'설치된 음성 미리듣기';
    const note=pc?'등록한 목소리로 음성을 만들고 있어요. 창을 닫으면 결과 받기를 멈춥니다.':v.engine==='local'?'원고는 이 기기 안에서 처리합니다.':'기기에 설치된 음성으로 읽습니다. 이 모드는 파일을 생성하지 않습니다.';
    this.open(title,'<p class="note">'+note+'</p>'+progressMarkup);
    const state={kind:'voice',before:captureDocument(),start:this.hooks.player.time,trackId:this.hooks.timeline.preferredTrack('voice'),voice:v};this.state=state;
    try{await this.run('voice',async signal=>{
      if(v.engine==='device'){this.progress(NaN,'미리듣기 중…');await speakInstalled(v.text,v.systemVoice,{rate:v.speed,signal});this.setBody('<p class="note">미리듣기를 마쳤습니다. 영상에 넣을 파일은 기기 내 AI 모드에서 만들 수 있습니다.</p>'+button('cancel','닫기'));return;}
      if(pc)this.progress(NaN,'내 목소리로 음성을 만드는 중…');
      const result=pc?await generatePcVoice({text:v.text,profileId:profile.id,speed:v.speed,consent:true},{signal}):await runLocalAI('tts',{text:v.text,voice:v.voice,speed:v.speed,steps:v.steps},{signal,onProgress:p=>this.progress(p,'음성을 만드는 중…')});
      if(signal.aborted||this.state!==state)return;
      const label=pc?profile.name:v.voice;
      state.file=new File([result.wav],(pc?'AI 내 목소리':'AI 음성 '+v.voice)+' '+new Date().toTimeString().slice(0,8).replace(/:/g,'-')+'.wav',{type:'audio/wav'});
      const url=this.objectUrl(state.file);
      this.setBody('<div class="smart-success">음성을 만들었어요.</div><p class="note">'+esc(label)+' · '+result.duration.toFixed(2)+'초</p><audio controls src="'+url+'" aria-label="생성된 AI 음성 미리듣기"></audio><p class="note">'+esc(v.text)+'</p><p class="note warning">목소리·억양과 숫자·날짜·금액·이름을 먼저 들어보고 확인하세요. 게시할 때 AI 생성 음성임을 표시해야 합니다.</p>'+progressMarkup+button('apply-voice','보이스 트랙에 추가',false,true)+'<a class="button subtle wide" href="'+url+'" download="'+esc(state.file.name)+'">음성 파일 다운로드</a>');
    });}finally{if(pc)await this.refreshPcVoice();}
  }
  async applyVoice(){
    const s=this.state;if(!s?.file)return;
    if(project.audio.tracks.length>=1000)throw new Error('오디오 클립은 최대 1,000개입니다. WAV 파일로 먼저 저장해 주세요.');
    await this.run('voice-add',async signal=>{
      const asset=await addAsset(s.file,{aiGenerated:true});
      if(signal.aborted||JSON.stringify(captureDocument())!==JSON.stringify(s.before)){this.hooks.saveDraft();this.hooks.refresh();this.hooks.toast('생성 음성은 라이브러리에 보관했어요. 원하는 위치로 끌어 넣을 수 있습니다.');this.job=null;this.close(false);return;}
      const before=captureDocument(),registry=timelineTracks();
      const existing=registry.find(row=>row.id===s.trackId&&row.kind==='audio')||registry.find(row=>row.role==='voice');
      if(!existing&&registry.filter(row=>row.kind==='audio').length>=MAX_TRACKS_PER_KIND){this.hooks.saveDraft();this.hooks.refresh();throw new Error('보이스 트랙을 추가할 공간이 없습니다. 생성 음성은 라이브러리에 보관했어요.');}
      const track=makeAudio(asset.id,{volume:1,fadeIn:0,fadeOut:0,role:'voice'});
      const target=existing?.id||addTimelineTrack('audio',{role:'voice'}).id;
      const result=placeTimelineItem('audio',track,planPlacement(s.start,asset.duration,target));
      this.hooks.commit(before,s.voice?.engine==='pc'?'내 목소리 음성 추가':'기본 음성 추가');this.hooks.select('audio',track.id);this.hooks.timeline.reveal(result);
      this.job=null;this.close(false);this.hooks.toast('음성을 보이스 트랙에 추가했어요. 완성 영상에도 포함됩니다.');
    });
  }
  async openCaptions(){
    const range=this.captionScope==='selected'?this.audioRange():null;
    if(this.captionScope==='selected'&&!range)throw new Error('타임라인에서 영상 또는 오디오 클립을 선택해 주세요.');
    if(!range&&totalDuration()<=0)throw new Error('먼저 영상 또는 말소리 오디오를 추가해 주세요.');
    if((range?.duration||totalDuration())>180)throw new Error('자동 자막은 한 번에 3분까지 지원합니다. 클립을 선택하거나 구간을 나눠 주세요.');
    if(isPcAsrOrigin()&&(this.pcAsr.checking||!this.pcAsr.status))await this.refreshPcAsr();
    const engine=this.captionEngine||(sttAvailable()?'server':'local'),pc=engine==='pc',server=engine==='server';
    if(pc&&this.captionPcUnavailable())throw new Error('이 PC에서 지금 자막을 만들 수 없습니다. 잠시 뒤 다시 시도하거나 처리 방식을 직접 바꿔 주세요.');
    if(server&&!confirm('선택한 구간의 소리만 자막 서버(Cloudflare)로 보내 자동 자막을 만듭니다. 영상 파일은 보내지 않습니다. 소리를 보내도 될까요?'))return;
    this.captionEngine=engine;this.captionEngineChosen=true;
    this.open('자동 자막 만들기','<p class="note">'+(server?'선택 구간의 소리를 온라인에서 인식합니다.':pc?'이 PC에서 말소리를 인식합니다.':'이 브라우저에서 말소리를 인식합니다.')+' 기존 자막은 그대로 유지합니다.</p>'+progressMarkup);
    const s={kind:'captions',before:captureDocument(),range,engine};this.state=s;
    try{await this.run('captions',async signal=>{
      this.progress(.01,'인식할 소리 준비 중…');
      const buffer=range?await selectedPcm(range,signal,true):await mixTimeline({includeBgm:false,includeVoice:true,signal,strictSources:true});
      if(!buffer)throw new Error('인식할 영상 소리 또는 보이스 오디오가 없습니다.');
      const pcm=monoPcm(buffer,16000);let energy=0;for(const x of pcm)energy+=x*x;
      if(Math.sqrt(energy/pcm.length)<.0002)throw new Error('인식할 말소리가 너무 작거나 무음입니다. 기존 자막은 유지합니다.');
      const duration=Math.min(range?.duration??totalDuration(),buffer.length/buffer.sampleRate);
      let result;
      if(pc)result=await transcribePcAudio(pcm,{signal,onProgress:p=>this.progress(p,'자동 자막을 만드는 중…')});
      else if(server){
        this.progress(.25,'선택 구간의 소리를 자막 서버로 보내는 중…');
        result=await transcribeRaw(buffer,{lang:'ko',signal});
        this.progress(.95,'결과를 정리하는 중…');
      }else result=await runLocalAI('asr',{audio:pcm},{signal,onProgress:p=>this.progress(p,'자동 자막을 만드는 중…')});
      if(signal.aborted||this.state!==s||!this.dialog.open)return;
      const normalized=pc?pcAsrCaptions(result,duration,range?.start||0):server?serverCaptions(result,duration,range?.start||0):whisperCaptions(result,duration,range?.start||0);
      // 시각이 전부 버려져도 인식 원문은 남아 있는 경우가 많습니다. 그냥 실패로 끝내면
      // 사용자는 "인식을 못 했다" 고 오해하지만, 실제로는 받아쓴 글이 멀쩡히 있습니다.
      if(!normalized.captions.length){
        const recognized=String(normalized.text||'').trim();
        if(!recognized)throw new Error('말소리를 인식하지 못했습니다. 소리가 분명한 구간으로 다시 시도해 주세요.');
        throw new Error('인식은 됐지만 자막에 넣을 시각을 찾지 못했습니다. 아래 원문을 참고해 직접 입력해 주세요.\n\n'+recognized);
      }
      Object.assign(s,normalized);s.gaps=findUncaptioned(buffer,s.captions.map(c=>({...c,start:c.start-(range?.start||0),end:c.end-(range?.start||0)})));
      this.setBody('<div class="smart-success">'+s.captions.length+'개 자막을 만들었어요.</div><p class="inspector-note">'+(server?'온라인에서 처리한 자막':pc?'이 PC에서 처리한 자막':'브라우저에서 처리한 자막')+'</p><p class="note">틀린 문구는 여기서 고친 뒤 적용하세요. 기존 자막은 지우지 않습니다.</p><p class="note warning">숫자·이름은 틀릴 수 있습니다.'+(s.segmentFallback?' 일부 문장은 문장 단위의 실제 시각으로 보존했습니다.':'')+(s.skipped?' 시각이 불확실한 '+s.skipped+'개 항목은 제외했습니다.':'')+(s.stretched?' 시각이 비정상으로 늘어난 '+s.stretched+'개 자막의 시작점을 당겼습니다. 타임라인에서 확인해 주세요.':'')+(s.gaps.length?' 소리는 있으나 자막이 없는 '+s.gaps.length+'개 구간도 확인해 주세요.':'')+'</p><div class="smart-caption-review">'+s.captions.map((c,i)=>'<label><span>'+c.start.toFixed(2)+' → '+c.end.toFixed(2)+'초</span><textarea data-caption-index="'+i+'" maxlength="3000" aria-label="자막 '+(i+1)+' 내용">'+esc(c.text)+'</textarea></label>').join('')+'</div><details class="smart-details"><summary>전체 인식 원문</summary><p>'+esc(s.text)+'</p></details>'+progressMarkup+button('apply-captions','자동자막 트랙에 추가',false,true));
    });}finally{if(pc)this.refreshPcAsr().catch(()=>{});}
  }
  applyCaptions(){
    const s=this.state;if(s?.kind!=='captions'||!s.captions)return;
    if(JSON.stringify(captureDocument())!==JSON.stringify(s.before))throw new Error('인식 중 편집 내용이 바뀌었습니다. 적용하지 않고 현재 편집을 유지합니다.');
    const captions=s.captions.filter(c=>c.text.trim());if(!captions.length)throw new Error('추가할 자막 내용이 없습니다.');
    if(project.captions.length+captions.length>5000)throw new Error('자막은 최대 5,000개입니다. 구간을 나눠 작업해 주세요.');
    const track=ensureAutoCaptionTrack();
    for(const c of captions)c.trackId=track.id;
    project.captions.push(...captions);this.hooks.commit(s.before,'자동 자막 추가');
    this.hooks.select('caption',captions[0].id);this.hooks.timeline.reveal({...captions[0],type:'caption'});
    this.close(false);this.hooks.toast(captions.length+'개 자막을 '+trackLabel(track.id)+'에 추가했어요. 기존 자막은 그대로입니다.');
  }
}
