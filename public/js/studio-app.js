// UI는 편집 명령을 호출하고, 상태·자원·시간표·렌더러는 각각의 모듈이 담당합니다.
import {project,FONTS,clipAt,clipDuration,buildLayout,totalDuration,newOverlay,anchorItem,syncAnchoredItems} from './state.js';
import {Player} from './player.js';
import {loadFonts} from './render.js';
import {detectEngine,exportVideo} from './exporter.js';
import {mixTimeline,findUncaptioned} from './audio.js';
import {parseSrt,buildSrt} from './srt.js';
import {uid,clamp,download} from './util.js';
import {assets,addAsset,makeClip,makeAudio,captureDocument,restoreDocument,History,setDocumentName,documentName,packProject,unpackProject,saveDraft,loadDraft,demoSound,onAssetReady} from './project-store.js';
import {Timeline} from './timeline.js';
import {GRAPHICS,CAPTIONS,TRANSITIONS} from './presets.js';
import {encodeWav,transcriptionCaptions,apiError} from './ai-client.js';

const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=t=>`${Math.floor(t/60).toString().padStart(2,'0')}:${Math.floor(t%60).toString().padStart(2,'0')}`;
let selection=null,view='media',mediaFilter='all',search='',isDemo=false,engine=null,exportCtrl=null,aiCtrl=null,importing=false,captionScope='selected',activeTransition='dissolve',draftTimer,toastTimer,dirty=false;
let aiStatus={configured:false,provider:'openai'};
const voice={text:'익숙한 도시를 새롭게 보는 시간. 오늘의 순간을, 나만의 이야기로 남겨보세요.',voice:'marin',tone:'natural',speed:1};
const tones={natural:'자연스러운 한국어로, 과장 없이 따뜻하고 편안하게 읽어주세요.',energetic:'밝고 생동감 있는 한국어로 읽어주세요. 또렷하게 말하되 소리를 지르거나 과장하지 마세요.',narration:'차분한 다큐멘터리 내레이션처럼 자연스러운 한국어로 읽어주세요. 문장 사이에 짧게 쉬어주세요.',product:'신뢰감 있는 한국어 제품 소개처럼 읽어주세요. 숫자와 제품명을 또렷하게 발음하고 광고조는 절제하세요.'};
const player=new Player($('preview'),{onTick:tick});
const history=new History(()=>{selection=validSelection();refresh();scheduleDraft();});
const timeline=new Timeline({
  select:(type,id)=>select(type,id,{timeline:false}),pause:()=>player.pause(),seek:t=>player.seek(t),preview:()=>player.invalidate(),
  commit:(before,label)=>commit(before,label),transition:id=>{select('clip',id);setView('transitions');},
  drop:async(kind,id,t,lane)=>{try{if(kind==='asset')await placeAsset(id,t,lane);else{const [type,key]=id.split(':');if(type==='g')addGraphic(key,t);if(type==='c')applyCaptionPreset(key);if(type==='t')applyTransition(key);}}catch(e){toast(e.message);}},
});
onAssetReady(()=>player.invalidate());

function toast(message){clearTimeout(toastTimer);$('toast').textContent=message;$('toast').hidden=false;toastTimer=setTimeout(()=>$('toast').hidden=true,4200);}
function tick(t){
  const f=Math.floor((t%1)*project.fps);
  $('timecode').innerHTML=`00:${fmt(t)}<span>:${String(f).padStart(2,'0')}</span>`;
  $('play').textContent=player.playing?'Ⅱ':'▶';$('play').setAttribute('aria-label',player.playing?'일시정지':'재생');
  timeline?.tick(t);
}
function collection(type){return type==='clip'?project.clips:type==='caption'?project.captions:type==='graphic'?project.overlays:type==='audio'?project.audio.tracks:[];}
function selected(){return selection?.type==='asset'?assets.get(selection.id):collection(selection?.type).find(i=>i.id===selection?.id);}
function validSelection(){if(selected())return selection;return project.clips[0]?{type:'clip',id:project.clips[0].id}:null;}
function select(type,id,options={}){
  selection={type,id};if(options.timeline!==false)timeline.select(type,id);
  renderInspector();if(view==='media')renderAssets();if(view==='captions')renderCaptionList();
  if(window.innerWidth<651)$('workbench').classList.remove('show-library');
}
function refresh(){
  syncAnchoredItems();selection=validSelection();
  $('projectName').value=documentName;$('emptyPreview').hidden=!!project.clips.length;$('preview').hidden=!project.clips.length;
  $('previewLabel').hidden=!isDemo;$('play').disabled=!project.clips.length;$('openExport').disabled=!project.clips.length||!engine?.ok;
  $('undo').disabled=!history.past.length;$('redo').disabled=!history.future.length;
  $('splitClip').disabled=!project.clips.length;$('duplicateClip').disabled=!selected()||selection?.type==='asset';$('deleteClip').disabled=!selected()||selection?.type==='asset';
  $('preview').width=project.width;$('preview').height=project.height;
  $('previewResolution').textContent=`${project.width} × ${project.height}`;
  renderLibrary();renderInspector();timeline.render();if(selection)timeline.select(selection.type,selection.id);
  player.seek(Math.min(player.time,Math.max(0,totalDuration()-.001)));
}
function commit(before,label){syncAnchoredItems();if(history.push(before,label)){dirty=true;isDemo=isDemo&&assets.size<=4;scheduleDraft();}refresh();}
function edit(label,mutate){if(exportCtrl||importing)return;player.pause();const before=captureDocument();mutate();commit(before,label);}
function scheduleDraft(){
  clearTimeout(draftTimer);$('saveStatus').textContent='저장 중…';
  draftTimer=setTimeout(async()=>{try{await saveDraft();$('saveStatus').textContent='이 브라우저에 저장됨';dirty=false;}catch{$('saveStatus').textContent='파일로 저장 필요';}},650);
}
function setView(next){
  view=next;renderLibrary();
  document.querySelectorAll('.rail-item[data-view]').forEach(b=>{b.classList.toggle('active',b.dataset.view===view);b.setAttribute('aria-pressed',b.dataset.view===view);});
  if(window.innerWidth<=650){$('workbench').classList.add('show-library');$('workbench').classList.remove('show-inspector');}
}

function renderLibrary(){
  const titles={media:'소재 라이브러리',captions:'자막 스튜디오',graphics:'모션 그래픽',transitions:'장면 전환',voice:'AI 보이스'};
  $('libraryTitle').textContent=titles[view];$('libraryCount').textContent=view==='media'?String(assets.size).padStart(2,'0'):view==='graphics'?'06':view==='captions'?'08':view==='transitions'?'04':'AI';
  const host=$('libraryContent');
  if(view==='media'){
    host.innerHTML=`<button class="import-zone" data-action="import"><span class="import-plus">＋</span><strong>파일 가져오기</strong><span>영상 · 이미지 · 오디오를 한곳에</span><small>또는 여기에 파일을 놓아주세요</small></button><div class="filter-tabs" aria-label="소재 종류">${[['all','전체'],['video','영상'],['image','이미지'],['audio','오디오']].map(([key,label])=>`<button data-filter="${key}" class="${mediaFilter===key?'active':''}">${label}</button>`).join('')}</div><label class="search-box"><span>⌕</span><input id="mediaSearch" type="search" placeholder="소재 검색" aria-label="소재 검색" value="${esc(search)}"><kbd>/</kbd></label><div id="assetGrid" class="asset-grid"></div><p class="library-hint">더블클릭하면 추가됩니다.<br>원하는 위치로 끌어 넣어도 좋아요.</p>`;
    renderAssets();
  }else if(view==='graphics'){
    host.innerHTML=`<p class="preset-intro">움직임 하나로 장면에 포인트를.<br>클릭하면 현재 위치에 추가돼요.</p><div class="preset-grid">${GRAPHICS.map(g=>`<button class="preset-card" draggable="true" data-preset="g:${g.id}" aria-label="${g.name} 추가"><div class="preset-art ${g.art}"><span>${g.label}</span><small>MOTION GRAPHIC</small></div><strong>${g.name}</strong><small>${g.hint}</small></button>`).join('')}</div><p class="library-hint">문구·색상·크기·표시 시간은<br>오른쪽 속성에서 자유롭게 바꿔보세요.</p>`;
  }else if(view==='captions'){
    host.innerHTML=`<div class="segmented"><button data-scope="selected" class="${captionScope==='selected'?'active':''}">선택 자막에 적용</button><button data-scope="all" class="${captionScope==='all'?'active':''}">전체 자막에 적용</button></div><div class="section-label">자막 스타일 <span>8 STYLES</span></div><div class="preset-grid">${CAPTIONS.map(c=>`<button class="preset-card" data-preset="c:${c.id}" aria-label="${c.name} 자막 스타일"><div class="preset-art caption-preview ${c.art}"><span>${c.label}</span></div><strong>${c.name}</strong></button>`).join('')}</div><div class="section-label">자막 편집 <span>${project.captions.length}개</span></div><button class="button primary wide" data-action="add-caption">＋ 현재 위치에 자막</button><div class="field-grid"><button class="button subtle" data-action="import-srt">SRT 가져오기</button><button class="button subtle" data-action="export-srt">SRT 저장</button></div><button class="button secondary wide" data-action="auto-caption" ${!aiStatus.configured?'disabled':''}>${aiCtrl?'처리 취소':'자동 자막 만들기'}</button><p class="inspector-note">${aiStatus.configured?'실행 전 확인 후 오디오를 OpenAI로 전송합니다. 배경음악은 제외합니다.':'자동 자막은 AI 연결 후 사용할 수 있어요. 실험판은 원본 자막 서버를 호출하지 않습니다.'}</p><div id="captionList" class="caption-list"></div>`;
    renderCaptionList();
  }else if(view==='transitions'){
    host.innerHTML=`<p class="preset-intro">선택한 클립과 다음 장면 사이에 적용됩니다. 전환 구간은 서로 겹쳐 재생돼요.</p><div class="preset-grid">${TRANSITIONS.map(t=>`<button class="preset-card" draggable="true" data-preset="t:${t.id}" aria-label="${t.name} 적용"><div class="preset-art ${t.id==='cut'?'none':''}">${t.id==='cut'?'<span>│</span>':`<div class="transition-demo ${t.id}"></div>`}</div><strong>${t.name}</strong><small>${t.hint}</small></button>`).join('')}</div><div class="transition-options"><label class="field-label">전환 길이 <select id="transitionDuration"><option value=".3">0.3초 · 빠르게</option><option value=".5" selected>0.5초 · 자연스럽게</option><option value="1">1.0초 · 여유롭게</option><option value="1.5">1.5초 · 천천히</option></select></label><button class="button secondary wide" data-action="all-transitions">모든 연결에 ${TRANSITIONS.find(t=>t.id===activeTransition)?.name||'디졸브'} 적용</button><p class="inspector-note">짧은 클립에서는 전환 길이가 자동으로 줄어들어요. 겹치는 만큼 전체 길이도 짧아집니다.</p></div>`;
  }else{
    host.innerHTML=`<p class="preset-intro">문장을 쓰고, 이야기의 목소리를 고르세요.</p><div class="voice-card"><div class="voice-avatar">≋</div><div><strong>OpenAI Voice</strong><p>gpt-4o-mini-tts · 한국어 지원</p></div></div><label class="field-label">보이스<select id="ttsVoice">${['marin','cedar','coral','onyx','nova','sage','shimmer','alloy','ash','ballad','echo','fable','verse'].map(v=>`<option value="${v}" ${v===voice.voice?'selected':''}>${v[0].toUpperCase()+v.slice(1)}</option>`).join('')}</select></label><label class="field-label">말하기 스타일<select id="ttsTone">${[['natural','자연스럽게'],['energetic','밝고 생동감 있게'],['narration','차분한 내레이션'],['product','또렷한 제품 소개']].map(([v,n])=>`<option value="${v}" ${v===voice.tone?'selected':''}>${n}</option>`).join('')}</select></label><label class="property-row"><span>속도</span><input id="ttsSpeed" type="range" min=".75" max="1.25" step=".05" value="${voice.speed}" aria-label="TTS 말하기 속도"><output id="ttsSpeedOut">${voice.speed.toFixed(2)}×</output></label><label class="field-label">원고<textarea id="ttsText" class="tts-text" maxlength="2000" placeholder="들려주고 싶은 이야기를 적어보세요.">${esc(voice.text)}</textarea></label><p class="inspector-note" id="ttsCount">${voice.text.length} / 2,000자</p><button class="button primary wide" data-action="generate-voice" ${!aiStatus.configured?'disabled':''}>${aiCtrl?'생성 취소':'음성 생성 후 타임라인에 추가'}</button><div class="voice-status">${aiStatus.configured?'설정됨 · 실제 연결/한국어 음질 미검증<br>생성 전 확인 후 API 이용료가 발생할 수 있어요.':'연결 필요<br>API 키는 화면에 입력하지 않습니다. 로컬 서버에 키를 설정한 뒤 사용할 수 있어요.'}</div><p class="library-hint">AI 생성 음성입니다. 원고는 음성 생성 시 OpenAI로 전송됩니다. 생성한 음성은 소재함과 보이스 트랙에 추가돼요.</p><button class="button subtle wide" data-action="refresh-ai">연결 상태 다시 확인</button>`;
  }
}

function renderAssets(){
  const grid=$('assetGrid');if(!grid)return;
  const list=[...assets.values()].filter(a=>(mediaFilter==='all'||a.kind===mediaFilter)&&a.file.name.toLowerCase().includes(search.toLowerCase()));
  grid.innerHTML=list.map(a=>{
    const picture=a.kind==='audio'?`<div class="audio-thumb">${(a.waveform||[]).filter((_,i)=>i%5===0).map(v=>`<i style="height:${Math.max(2,v*43)}px"></i>`).join('')}</div>`:`<img src="${a.thumb||''}" alt="${esc(a.file.name)}" draggable="false">`;
    return `<article class="asset-card ${selection?.type==='asset'&&selection.id===a.id?'selected':''}" data-asset="${a.id}" draggable="true" tabindex="0" role="button" aria-label="${esc(a.file.name)}"><div class="asset-image">${picture}<span class="asset-kind">${a.kind==='audio'?'♫':a.kind==='video'?'▶':'▧'}</span><span class="asset-duration">${a.kind==='image'?'IMAGE':fmt(a.duration)}</span><button class="asset-add" data-add-asset="${a.id}" aria-label="${esc(a.file.name)} 타임라인에 추가">＋</button></div><h3>${esc(a.file.name)}</h3><p>${a.kind==='video'?'영상':a.kind==='audio'?(a.aiGenerated?'AI 음성':'오디오'):'이미지'} · ${a.kind==='audio'?`${a.duration.toFixed(1)}초`:`${a.base.natW} × ${a.base.natH}`}</p></article>`;
  }).join('')||'<p class="note" style="grid-column:1/-1;padding:20px 0">아직 소재가 없어요.<br>파일을 가져오면 여기에서 찾을 수 있어요.</p>';
}
function renderCaptionList(){const list=$('captionList');if(!list)return;list.innerHTML=project.captions.map(c=>`<button data-select-caption="${c.id}" class="${selection?.id===c.id?'selected':''}"><small>${c.start.toFixed(2)} → ${c.end.toFixed(2)}${c.anchor?' · 연결됨':''}</small>${esc(c.text)}</button>`).join('');}

const range=(label,prop,value,min,max,step=1,suffix='')=>`<label class="property-row"><span>${label}</span><input type="range" data-prop="${prop}" min="${min}" max="${max}" step="${step}" value="${esc(value)}" aria-label="${label}"><output>${Number(value).toFixed(step<1?1:0)}${suffix}</output></label>`;
const number=(label,prop,value,min=0,max=86400,step=.1)=>`<label class="property-row"><span>${label}</span><input type="number" data-prop="${prop}" value="${Number(value||0).toFixed(2)}" min="${min}" max="${max}" step="${step}"><span>초</span></label>`;
const selectField=(label,prop,value,options)=>`<label class="property-row"><span>${label}</span><select data-prop="${prop}">${options.map(([v,n])=>`<option value="${esc(v)}" ${v===value?'selected':''}>${n}</option>`).join('')}</select></label>`;
const section=(title,body,sub='')=>`<section class="property-section"><h3>${title}<span>${sub}</span></h3>${body}</section>`;
function renderInspector(){
  const host=$('inspectorContent'),item=selected(),type=selection?.type;
  if(!item){$('selectionBadge').textContent='프로젝트';host.innerHTML='<div class="inspector-empty">이야기의 시작은 소재 하나.<br>파일을 불러오거나 타임라인에서<br>편집할 항목을 선택해 주세요.</div><button class="button secondary wide" data-action="import">＋ 파일 가져오기</button>';return;}
  if(type==='asset'){
    $('selectionBadge').textContent='소재';host.innerHTML=`<div class="selected-item"><div class="item-icon">${item.kind==='audio'?'♫':'▧'}</div><div><strong>${esc(item.file.name)}</strong><small>${(item.file.size/1048576).toFixed(1)} MB · ${item.kind==='image'?'이미지':`${item.duration.toFixed(2)}초`}</small></div></div>${section('소재 정보',`<p class="note">원본 파일은 수정하지 않습니다.<br>같은 소재를 여러 번 추가해서 각각 다르게 편집할 수 있어요.</p>`)}<button class="button primary wide" data-add-asset="${item.id}">＋ 타임라인에 추가</button>`;return;
  }
  $('selectionBadge').textContent={clip:'클립',graphic:'그래픽',caption:'자막',audio:'오디오'}[type];
  const name=item.name||item.text;
  let html=`<div class="selected-item">${item.thumb?`<img src="${item.thumb}" alt="">`:`<div class="item-icon">${type==='audio'?'♫':type==='caption'?'T':'✧'}</div>`}<div><strong>${esc(name)}</strong><small>${type==='clip'?`${item.type==='image'?'이미지':'영상'} 클립 · ${clipDuration(item).toFixed(2)}초`:type==='audio'?(item.aiGenerated?'AI 생성 음성':'독립 오디오 클립'):`${item.start.toFixed(2)} → ${item.end.toFixed(2)}초`}</small></div></div>`;
  if(type==='clip'){
    html+=section('변형',selectField('맞춤','fit',item.fit,[['cover','꽉 채우기'],['contain','전체 보이기']])+range('확대','scale',item.scale*100,30,300,1,'%')+range('가로','offX',item.offX*100,-50,50,1,'%')+range('세로','offY',item.offY*100,-50,50,1,'%')+selectField('여백','bg',item.bg,[['blur','흐린 원본'],['black','검정'],['white','흰색']])+'<button class="button subtle wide" data-action="reset-transform">위치·확대 초기화</button>','TRANSFORM');
    html+=section('클립 구간',item.type==='image'?number('길이','imgDuration',item.imgDuration,.2,600):number('시작','trimStart',item.trimStart,0,item.trimEnd-.03)+number('끝','trimEnd',item.trimEnd,item.trimStart+.03,item.srcDuration),item.type==='video'?'원본 기준':'DURATION');
    if(item.type==='image')html+=section('이미지 모션',selectField('움직임','ken',item.ken,[['none','없음'],['in','천천히 확대'],['out','천천히 축소'],['left','왼쪽으로 팬'],['right','오른쪽으로 팬']]));
    if(item.type==='video')html+=section('원본 오디오',range('볼륨','volume',(item.volume??1)*100,0,100,1,'%')+`<label class="property-row"><input type="checkbox" data-prop="muted" ${item.muted?'checked':''}>음소거</label>${item.decoderOnly?'<p class="note warning">디코더 모드: 미리보기 소리는 지원하지 않으며 내보내기에만 포함됩니다.</p>':''}`);
    const entry=buildLayout().entries.find(e=>e.clip.id===item.id);
    html+=section('다음 장면과 전환',selectField('효과','transitionType',item.transitionOut?.type||'cut',TRANSITIONS.map(t=>[t.id,t.name]))+number('길이','transitionDuration',item.transitionOut?.duration||.5,0,2,.1)+`<p class="inspector-note">${entry.index===project.clips.length-1?'마지막 클립입니다. 다음 장면을 추가하면 전환이 적용돼요.':`실제 겹침: ${entry.overlapOut.toFixed(2)}초 · 짧은 클립에 맞춰 자동 제한`}</p>`);
    html+=section('클립 페이드',number('인','fadeIn',item.fadeIn,0,2)+number('아웃','fadeOut',item.fadeOut,0,2));
  }else if(type==='audio'){
    html+=section('트랙 위치',selectField('트랙','lane',item.lane,[['music','A1 · 오디오'],['voice','A2 · 보이스']])+number('위치','start',item.start)+number('시작','trimStart',item.trimStart,0,item.trimEnd-.03)+number('끝','trimEnd',item.trimEnd,item.trimStart+.03,assets.get(item.assetId)?.duration||86400));
    html+=section('오디오',range('볼륨','volume',(item.volume??1)*100,0,100,1,'%')+number('페이드 인','fadeIn',item.fadeIn,0,10)+number('페이드 아웃','fadeOut',item.fadeOut,0,10)+`<label class="property-row"><input type="checkbox" data-prop="muted" ${item.muted?'checked':''}>음소거</label><p class="inspector-note">영상이 끝난 뒤의 오디오는 내보내기에 포함되지 않습니다.${item.aiGenerated?' 게시할 때 AI 생성 음성임을 알려주세요.':''}</p>`);
  }else{
    html+=section('내용',`<textarea data-prop="text" rows="3" maxlength="3000" aria-label="${type==='caption'?'자막':'그래픽'} 내용">${esc(item.text)}</textarea>${item.graphic==='lower'?`<label class="field-label">보조 문구<input type="text" data-prop="subtitle" value="${esc(item.subtitle)}" maxlength="150"></label>`:''}`);
    html+=section('표시 구간',number('시작','start',item.start)+number('끝','end',item.end)+`<label class="property-row"><input type="checkbox" data-prop="linked" ${item.anchor?'checked':''}>영상 클립과 함께 이동</label><p class="inspector-note">${item.anchor?'연결된 클립을 이동·트림하면 이 항목도 따라갑니다.':'시퀀스 기준 시각입니다. 클립을 재편집한 뒤 싱크를 확인하세요.'}</p>`);
    const s=type==='caption'?{...project.captionStyle,...item.style}:item,prefix=type==='caption'?'style.':'';
    html+=section('글자 스타일',selectField('폰트',prefix+'font',s.font,FONTS.map(f=>[f.css,f.label]))+range('크기',prefix+'size',s.size,24,160,1)+`<label class="property-row"><span>글자색</span><input type="color" data-prop="${prefix}color" value="${esc(s.color==='#fff'?'#ffffff':s.color)}" aria-label="글자색"></label>`);
    if(type==='caption')html+=section('배치',range('아래 여백','style.bottom',s.bottom*100,5,60,1,'%')+selectField('등장','style.anim',s.anim||'none',[['none','없음'],['fade','페이드'],['pop','팝업']]));
    else html+=section('배치',range('가로','x',item.x*100,5,95,1,'%')+range('세로','y',item.y*100,5,95,1,'%'));
  }
  html+='<button class="button subtle wide delete-action" data-action="delete">선택 항목 삭제</button>';host.innerHTML=html;
}

async function importFiles(files){
  if(aiCtrl)return toast('AI 처리를 마치거나 취소한 뒤 파일을 가져와 주세요.');
  if(importing||exportCtrl)return;importing=true;player.pause();const before=captureDocument();const errors=[];let added=0;
  $('workbench').inert=true;document.querySelector('.appbar').inert=true;toast('소재를 불러오고 있어요…');
  try{for(const file of files){
    try{if(/\.(srt|vtt)$/i.test(file.name)){const caps=parseSrt(await file.text());if(!caps.length)throw new Error('자막 구간을 읽지 못했습니다.');project.captions.push(...caps);selection={type:'caption',id:caps[0].id};view='captions';}
    else{const asset=await addAsset(file);selection={type:'asset',id:asset.id};view='media';}added++;}
    catch(e){errors.push(`${file.name}: ${e.message}`);}
  }}finally{importing=false;$('workbench').inert=false;document.querySelector('.appbar').inert=false;}
  isDemo=false;commit(before,'소재 가져오기');if(added){dirty=true;scheduleDraft();}
  toast(errors.length?`${added}개 추가 · ${errors[0]}`:`${added}개 소재를 가져왔어요. 더블클릭하거나 타임라인으로 끌어 넣으세요.`);
}
async function mediaEdit(command){
  if(exportCtrl||importing)return;
  importing=true;$('workbench').inert=true;document.querySelector('.appbar').inert=true;
  try{return await command();}
  finally{importing=false;$('workbench').inert=false;document.querySelector('.appbar').inert=false;}
}
const placeAsset=(...args)=>mediaEdit(()=>placeAssetImpl(...args));
const duplicateSelection=()=>mediaEdit(duplicateSelectionImpl);
const splitSelected=()=>mediaEdit(splitSelectedImpl);

async function placeAssetImpl(id,time=null,lane=null){
  const asset=assets.get(id);if(!asset)return;
  const before=captureDocument();player.pause();
  if(asset.kind==='audio'){
    const at=time??player.time;
    const track=makeAudio(id,{start:Math.max(0,at),lane:lane==='voice'?'voice':lane==='audio'?'music':asset.aiGenerated?'voice':'music'});
    project.audio.tracks.push(track);selection={type:'audio',id:track.id};
  }else{
    const clip=await makeClip(id);let index=project.clips.length;
    if(time!==null){const entries=buildLayout().entries;index=entries.findIndex(e=>time<(e.start+e.end)/2);if(index<0)index=entries.length;}
    project.clips.splice(index,0,clip);selection={type:'clip',id:clip.id};
  }
  commit(before,'타임라인에 추가');if(selection.type==='clip')player.seek(buildLayout().entries.find(e=>e.clip.id===selection.id)?.start||0);
  toast('타임라인에 추가했어요.');
}
function addGraphic(id,time=player.time){
  if(!project.clips.length)return toast('먼저 영상이나 이미지를 타임라인에 추가해 주세요.');
  const preset=GRAPHICS.find(g=>g.id===id);if(!preset)return;
  edit('그래픽 추가',()=>{
    const at=clipAt(time);const end=Math.min(totalDuration(),time+3);
    const graphic={...newOverlay(time),...preset,id:uid(),graphic:id,start:time,end:Math.max(time+.1,end),anim:'none'};
    delete graphic.art;delete graphic.label;delete graphic.hint;delete graphic.name;
    if(at&&graphic.end<=at.end+.001)anchorItem(graphic,at.clip.id);
    project.overlays.push(graphic);selection={type:'graphic',id:graphic.id};
  });player.seek(Math.min(totalDuration()-.001,time+.45));toast('모션 그래픽을 추가했어요. 오른쪽에서 문구를 바꿔보세요.');
}
function addCaption(){
  if(!project.clips.length)return toast('먼저 영상이나 이미지를 타임라인에 추가해 주세요.');
  edit('자막 추가',()=>{const t=player.time,at=clipAt(t);const cap={id:uid(),start:t,end:Math.min(totalDuration(),t+2.5),text:'여기에 자막을 입력하세요'};if(at&&cap.end<=at.end+.001)anchorItem(cap,at.clip.id);project.captions.push(cap);selection={type:'caption',id:cap.id};});
}
function applyCaptionPreset(id){const p=CAPTIONS.find(c=>c.id===id);if(!p)return;
if(captionScope==='selected'&&project.captions.length&&selection?.type!=='caption')return toast('바꿀 자막을 먼저 선택하거나, 전체 자막에 적용을 선택해 주세요.');
edit('자막 스타일 변경',()=>{
  if(captionScope==='selected'&&selection?.type==='caption'&&selected())selected().style={...p.style};
  else{project.captionStyle={...project.captionStyle,...p.style};for(const cap of project.captions)cap.style={...p.style};}
});toast(captionScope==='selected'&&selection?.type==='caption'?'선택 자막의 스타일을 바꿨어요.':'전체 자막과 새 자막의 스타일을 바꿨어요.');}
function applyTransition(id,all=false){
  const preset=TRANSITIONS.find(t=>t.id===id);if(!preset)return;
  const requested=Number($('transitionDuration')?.value)||preset.duration;
  let clip=selection?.type==='clip'?selected():clipAt(player.time)?.clip;
  if(!clip||project.clips.length<2)return toast('전환하려면 영상 또는 이미지 클립이 두 개 이상 필요해요.');
  if(!all&&project.clips.indexOf(clip)===project.clips.length-1)return toast('선택한 클립 뒤에 장면을 추가하거나 앞 클립을 선택해 주세요.');
  activeTransition=id;edit('장면 전환 변경',()=>{for(const c of all?project.clips.slice(0,-1):[clip])c.transitionOut={type:id,duration:id==='cut'?0:requested};});
  const entry=buildLayout().entries.find(e=>e.clip.id===clip.id);if(entry?.overlapOut)player.seek(entry.end-entry.overlapOut/2);
  toast(`${all?'모든 연결에 ':''}${preset.name}를 적용했어요.`);
}
function deleteSelection(){if(!selection||selection.type==='asset')return;edit('항목 삭제',()=>{const list=collection(selection.type),index=list.findIndex(i=>i.id===selection.id);if(index>=0){list.splice(index,1);selection=null;}});}
async function duplicateSelectionImpl(){
  const item=selected(),type=selection?.type;if(!item||type==='asset')return;
  const before=captureDocument();player.pause();
  if(type==='clip'){const index=project.clips.indexOf(item),dup=await makeClip(item.assetId,{...captureDocument().clips[index],id:uid()});project.clips.splice(index+1,0,dup);selection={type,id:dup.id};}
  else if(type==='audio'){const dup=makeAudio(item.assetId,{...captureDocument().tracks.find(t=>t.id===item.id),id:uid(),start:item.start+item.trimEnd-item.trimStart});project.audio.tracks.push(dup);selection={type,id:dup.id};}
  else{const dup=JSON.parse(JSON.stringify(item));dup.id=uid();dup.start=item.end;dup.end=item.end+(item.end-item.start);delete dup.anchor;collection(type).push(dup);selection={type,id:dup.id};}
  commit(before,'항목 복제');
}
async function splitSelectedImpl(){
  const at=selection?.type==='clip'?buildLayout().entries.find(e=>e.clip.id===selection.id):clipAt(player.time);
  if(!at)return toast('분할할 클립을 선택해 주세요.');
  const local=player.time-at.start,clip=at.clip,dur=clipDuration(clip),min=1/project.fps;
  if(local<min||dur-local<min)return toast('클립 안쪽으로 재생 막대를 옮겨 주세요.');
  if(local<2*at.overlapIn||dur-local<2*at.overlapOut)return toast('전환 길이를 유지할 수 없는 위치예요. 전환을 줄이거나 다른 위치에서 분할해 주세요.');
  const before=captureDocument();player.pause();
  const src=clip.type==='video'?clip.trimStart+local:local;
  const right=await makeClip(clip.assetId,{...captureDocument().clips[at.index],id:uid(),fadeIn:0});
  if(clip.type==='video'){right.trimStart=src;clip.trimEnd=src;}else{right.imgDuration=dur-local;clip.imgDuration=local;}
  clip.transitionOut={type:'cut',duration:0};clip.fadeOut=0;
  project.clips.splice(at.index+1,0,right);
  for(const list of [project.captions,project.overlays])for(const item of [...list]){
    if(item.anchor?.clipId!==clip.id)continue;
    const a=item.anchor;
    if(a.sourceStart>=src){a.clipId=right.id;if(clip.type==='image'){a.sourceStart-=src;a.sourceEnd-=src;}}
    else if(a.sourceEnd>src){const dup=JSON.parse(JSON.stringify(item));dup.id=uid();dup.anchor={clipId:right.id,sourceStart:clip.type==='image'?0:src,sourceEnd:clip.type==='image'?a.sourceEnd-src:a.sourceEnd};a.sourceEnd=src;list.push(dup);}
  }
  selection={type:'clip',id:right.id};commit(before,'클립 분할');toast('클립을 분할했어요. 연결된 자막과 그래픽도 함께 나뉩니다.');
}

const controlBefore=new WeakMap();
function applyProperty(input){
  const item=selected();if(!item||selection.type==='asset')return;
  const prop=input.dataset.prop;let value=input.type==='checkbox'?input.checked:input.type==='range'||input.type==='number'?Number(input.value):input.value;
  if(typeof value==='number'&&!Number.isFinite(value))return;
  if(input.type==='range'||input.type==='number'){const min=Number(input.min),max=Number(input.max);if(input.min!=='')value=Math.max(min,value);if(input.max!=='')value=Math.min(max,value);}
  if(['scale','offX','offY','x','y','volume','style.bottom'].includes(prop))value/=100;
  if(prop==='linked'){if(value){const at=clipAt(item.start);if(at)anchorItem(item,at.clip.id);}else delete item.anchor;}
  else if(prop==='transitionType')item.transitionOut={type:value,duration:item.transitionOut?.duration||.5};
  else if(prop==='transitionDuration')item.transitionOut={type:item.transitionOut?.type||'dissolve',duration:value};
  else if(prop.startsWith('style.')){item.style={...project.captionStyle,...item.style,[prop.slice(6)]:value};}
  else item[prop]=value;
  if(['start','end'].includes(prop)&&selection.type!=='audio'){
    item.end=Math.max(item.start+1/project.fps,item.end);
    if(item.anchor)anchorItem(item,item.anchor.clipId);
  }
  if(item.trimEnd!==undefined)item.trimEnd=Math.max(item.trimStart+1/project.fps,item.trimEnd);
  const output=input.parentElement.querySelector('output');if(output)output.textContent=`${Number(input.value).toFixed(Number(input.step)<1?1:0)}${['scale','offX','offY','x','y','volume','style.bottom'].includes(prop)?'%':''}`;
  syncAnchoredItems();player.invalidate();
}

async function checkAI(){try{const r=await fetch('/api/ai/status');aiStatus=r.ok?await r.json():{configured:false};}catch{aiStatus={configured:false};}if(view==='voice'||view==='captions')renderLibrary();}
async function generateVoice(){
  if(aiCtrl){aiCtrl.abort();return;}if(!aiStatus.configured)return toast('로컬 서버에 AI 연결이 필요합니다.');
  if(!voice.text.trim())return toast('읽을 원고를 입력해 주세요.');
  if(!confirm('입력한 원고를 OpenAI로 보내 음성을 생성합니다. 별도 API 이용료가 발생할 수 있습니다. 생성할까요?'))return;
  aiCtrl=new AbortController();renderLibrary();const start=player.time,before=JSON.stringify(captureDocument());
  try{
    const r=await fetch('/api/tts',{method:'POST',headers:{'Content-Type':'application/json','X-Studio-Consent':'text-to-openai'},body:JSON.stringify({text:voice.text,voice:voice.voice,instructions:tones[voice.tone],speed:voice.speed}),signal:aiCtrl.signal});
    if(!r.ok)throw await apiError(r);
    const blob=await r.blob();if(blob.size<44)throw new Error('생성된 음성 파일이 비어 있습니다.');
    const asset=await addAsset(new File([blob],`AI 보이스 ${voice.voice} ${new Date().toTimeString().slice(0,8).replace(/:/g,'-')}.wav`,{type:'audio/wav'}),{aiGenerated:true});
    if(before===JSON.stringify(captureDocument())&&!importing&&!exportCtrl){await placeAsset(asset.id,start,'voice');toast('AI 음성을 만들고 보이스 트랙에 추가했어요.');}
    else{dirty=true;scheduleDraft();refresh();toast('편집 내용이 바뀌어 AI 음성은 소재함에만 추가했어요. 원하는 곳으로 끌어 넣으세요.');}
  }catch(e){toast(e.name==='AbortError'?'음성 생성을 취소했어요. 서버에서 이미 처리한 요청은 과금될 수 있습니다.':e.message);}finally{aiCtrl=null;renderLibrary();}
}
async function autoCaption(){
  if(aiCtrl){aiCtrl.abort();return;}if(!aiStatus.configured)return toast('자동 자막은 AI 연결 후 사용할 수 있어요.');
  if(!project.clips.length)return toast('먼저 영상 클립을 추가해 주세요.');
  if(!confirm('영상의 오디오와 보이스 트랙을 OpenAI로 전송합니다. 배경음악은 제외합니다. 기존 자막을 교체하며 API 이용료가 발생할 수 있습니다. 계속할까요?'))return;
  const before=captureDocument();aiCtrl=new AbortController();player.pause();renderLibrary();
  try{
    toast('자막용 오디오를 준비하고 있어요…');
    const buffer=await mixTimeline({includeBgm:false,includeVoice:true,signal:aiCtrl.signal});
    if(!buffer)throw new Error('인식할 영상 오디오 또는 보이스 트랙이 없습니다.');
    const wav=encodeWav(buffer);if(wav.size>22*1024*1024)throw new Error('자동 자막은 오디오 22MB까지 처리합니다. 짧게 나눠 주세요.');
    const response=await fetch('/api/transcribe',{method:'POST',headers:{'Content-Type':'audio/wav','X-Studio-Consent':'audio-to-openai'},body:wav,signal:aiCtrl.signal});
    if(!response.ok)throw await apiError(response);
    const caps=transcriptionCaptions(await response.json());if(!caps.length)throw new Error('인식한 말소리가 없습니다. 기존 자막은 유지합니다.');
    if(JSON.stringify(before)!==JSON.stringify(captureDocument())||importing||exportCtrl)throw new Error('처리 중 편집 내용이 바뀌어 자막을 적용하지 않았어요. 현재 편집을 유지합니다.');
    project.captions=caps;selection={type:'caption',id:caps[0].id};
    const gaps=findUncaptioned(buffer,caps);commit(before,'자동 자막 생성');toast(`${caps.length}개 자막 생성${gaps.length?` · 누락 의심 ${gaps.length}구간, 재생하며 확인해 주세요.`:''}`);
  }catch(e){toast(e.name==='AbortError'?'자동 자막 처리를 취소했어요.':e.message);}finally{aiCtrl=null;renderLibrary();}
}

async function startExport(){
  if(aiCtrl)return toast('AI 처리를 마치거나 취소한 뒤 내보내 주세요.');
  if(exportCtrl||importing||!engine?.ok||!project.clips.length)return;
  if(engine.mode==='recorder')return toast('이 실험판의 정확한 프레임 내보내기는 WebCodecs 지원 Chrome 또는 Edge가 필요합니다.');
  exportCtrl=new AbortController();player.pause();
  const [width,height]=$('exportResolution').value.split('x').map(Number);Object.assign(project,{width,height,fps:Number($('exportFps').value),quality:$('exportQuality').value});
  $('startExport').disabled=true;$('exportDialog').querySelector('form button').disabled=true;$('workbench').inert=true;document.querySelector('.appbar').inert=true;
  $('exportProgress').hidden=false;$('cancelExport').hidden=false;$('downloadVideo').hidden=true;$('exportPreview').hidden=true;
  for(const id of ['exportResolution','exportFps','exportQuality'])$(id).disabled=true;
  try{
    const blob=await exportVideo({engine,player,signal:exportCtrl.signal,onProgress:(p,m)=>{$('exportBar').value=p;$('exportMessage').textContent=m;}});
    if($('downloadVideo').dataset.url)URL.revokeObjectURL($('downloadVideo').dataset.url);
    const url=URL.createObjectURL(blob);$('downloadVideo').href=url;$('downloadVideo').dataset.url=url;$('downloadVideo').download=`${documentName.replace(/[<>:"/\\|?*]/g,'_')}.${engine.ext}`;
    $('downloadVideo').hidden=false;$('exportPreview').src=url;$('exportPreview').hidden=false;$('exportBar').value=1;$('exportMessage').textContent=`완성 · ${(blob.size/1048576).toFixed(1)} MB · ${totalDuration().toFixed(2)}초`;
  }catch(e){$('exportMessage').textContent=e.name==='AbortError'?'내보내기를 취소했습니다.':e.message;}
  finally{exportCtrl=null;$('startExport').disabled=false;$('exportDialog').querySelector('form button').disabled=false;$('workbench').inert=false;document.querySelector('.appbar').inert=false;$('cancelExport').hidden=true;for(const id of ['exportResolution','exportFps','exportQuality'])$(id).disabled=false;refresh();}
}
function openExport(){if(!project.clips.length)return toast('타임라인에 영상 또는 이미지를 추가해 주세요.');player.pause();$('exportProjectName').textContent=documentName;$('exportSummary').textContent=`${project.clips.length} 클립 · ${totalDuration().toFixed(2)}초 · 9:16 · ${engine?.label||'확인 중'}`;$('exportDialog').showModal();}
function saveProjectFile(){download(packProject(),`${documentName.replace(/[<>:"/\\|?*]/g,'_')}.shorts`);$('saveStatus').textContent='프로젝트 파일 저장';dirty=false;toast('편집 정보와 소재가 포함된 .shorts 프로젝트를 저장했어요.');}
async function openProjectFile(file){if(!file||importing||exportCtrl)return;if(aiCtrl)return toast('AI 처리를 마치거나 취소한 뒤 프로젝트를 열어 주세요.');player.pause();importing=true;clearTimeout(draftTimer);$('workbench').inert=true;document.querySelector('.appbar').inert=true;try{await unpackProject(file);history.clear();isDemo=false;selection=null;refresh();scheduleDraft();toast('프로젝트를 열었어요.');}catch(e){toast(e.message);}finally{importing=false;$('workbench').inert=false;document.querySelector('.appbar').inert=false;refresh();}}

async function loadDemo(){
  if(aiCtrl||importing||exportCtrl)return toast('진행 중인 작업을 마치거나 취소한 뒤 샘플을 열어 주세요.');
  return mediaEdit(async()=>{
  const before=captureDocument();clearTimeout(draftTimer);
  try {
  player.pause();project.clips=[];project.overlays=[];project.captions=[];project.audio.tracks=[];project.audio.bgm=null;project.template.mode='none';
  setDocumentName('서울의 밤, 짧은 기록');
  for(let i=1;i<=3;i++){
    const response=await fetch(`demo/seoul-0${i}.jpg`);if(!response.ok)throw new Error('샘플 사진을 불러오지 못했습니다.');
    const asset=await addAsset(new File([await response.blob()],`서울의 밤 0${i}.jpg`,{type:'image/jpeg'}),{id:`sample-image-${i}`});
    const clip=await makeClip(asset.id,{imgDuration:4,ken:i===2?'left':'in',transitionOut:{type:i===3?'cut':'dissolve',duration:.5}});project.clips.push(clip);
  }
  const music=await addAsset(demoSound(12),{id:'sample-sound'});project.audio.tracks=[makeAudio(music.id,{volume:.55,trimEnd:11,fadeIn:.5,fadeOut:.8})];
  project.overlays=[{...newOverlay(0),id:uid(),text:'AFTER\nHOURS',font:'"Black Han Sans"',size:139,x:.5,y:.43,color:'#d1f0a0',anim:'up',end:3.4},{...newOverlay(7.4),...GRAPHICS.find(g=>g.id==='lower'),id:uid(),graphic:'lower',start:7.4,end:10.8,text:'오늘을 기록하다',subtitle:'SEOUL, THROUGH MY EYES'}];
  project.captions=[{id:uid(),start:.3,end:3.3,text:'익숙한 도시를 새롭게 보는 시간'},{id:uid(),start:4,end:6.8,text:'작은 장면을 모아, 하나의 이야기로'},{id:uid(),start:8,end:10.8,text:'당신의 다음 이야기는 무엇인가요?'}];
  project.captionStyle={...project.captionStyle,...CAPTIONS.find(c=>c.id==='pill').style};
  for(const item of [...project.overlays,...project.captions]){const at=clipAt(item.start);if(at&&item.end<=at.end)anchorItem(item,at.clip.id);}
  isDemo=true;selection={type:'clip',id:project.clips[0].id};history.clear();refresh();player.seek(1.15);$('saveStatus').textContent='샘플 프로젝트';
  } catch(error){restoreDocument(before);refresh();throw error;}
  });
}

function pickMedia(){ $('fileInput').accept='video/*,image/*,audio/*,.mkv,.ts,.srt,.vtt';$('fileInput').click(); }
function routeAction(action){
  if(action==='import')pickMedia();
  if(action==='add-caption')addCaption();
  if(action==='import-srt'){$('fileInput').accept='.srt,.vtt';$('fileInput').click();}
  if(action==='export-srt'){if(!project.captions.length)return toast('저장할 자막이 없습니다.');download(new Blob([buildSrt(project.captions)],{type:'text/plain;charset=utf-8'}),`${documentName}.srt`);}
  if(action==='delete')deleteSelection();
  if(action==='reset-transform')edit('위치 초기화',()=>Object.assign(selected(),{scale:1,offX:0,offY:0}));
  if(action==='all-transitions')applyTransition(activeTransition,true);
  if(action==='generate-voice')generateVoice();
  if(action==='auto-caption')autoCaption();
  if(action==='refresh-ai')checkAI().then(()=>toast(aiStatus.configured?'설정을 확인했어요. 실제 생성은 버튼을 누른 뒤 진행됩니다.':'아직 AI 연결이 설정되지 않았어요.'));
}

function wire(){
  document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{if(view===b.dataset.view&&window.innerWidth<=650)$('workbench').classList.toggle('show-library');else setView(b.dataset.view);});
  $('play').onclick=()=>player.toggle();$('prevFrame').onclick=()=>player.step(-1);$('nextFrame').onclick=()=>player.step(1);
  $('safeArea').onclick=()=>{player.safeArea=!player.safeArea;$('safeArea').setAttribute('aria-pressed',player.safeArea);player.invalidate();};
  $('loop').onclick=()=>{player.loop=!player.loop;$('loop').setAttribute('aria-pressed',player.loop);};
  $('undo').onclick=()=>{player.pause();const name=history.undo();if(name)toast(`${name} 실행 취소`);};$('redo').onclick=()=>{player.pause();const name=history.redo();if(name)toast(`${name} 다시 실행`);};
  $('splitClip').onclick=()=>splitSelected().catch(e=>toast(e.message));$('duplicateClip').onclick=()=>duplicateSelection().catch(e=>toast(e.message));$('deleteClip').onclick=deleteSelection;
  $('saveProject').onclick=saveProjectFile;$('openProject').onclick=()=>$('projectInput').click();$('projectInput').onchange=e=>{openProjectFile(e.target.files[0]);e.target.value='';};
  $('projectName').onchange=e=>edit('프로젝트 이름 변경',()=>setDocumentName(e.target.value));
  $('openExport').onclick=openExport;$('startExport').onclick=startExport;$('cancelExport').onclick=()=>exportCtrl?.abort();
  $('exportDialog').addEventListener('cancel',e=>{if(exportCtrl)e.preventDefault();});
  $('helpButton').onclick=()=>$('helpDialog').showModal();$('toggleInspector').onclick=()=>{$('workbench').classList.toggle('show-inspector');$('workbench').classList.remove('show-library');};
  $('emptyImport').onclick=pickMedia;$('loadDemo').onclick=()=>loadDemo().then(scheduleDraft).catch(e=>toast(e.message));
  $('resetDemo').onclick=()=>{if(project.clips.length&&!confirm('현재 편집을 샘플 프로젝트로 바꿀까요? 필요한 작업은 먼저 저장해 주세요.'))return;$('helpDialog').close();loadDemo().then(scheduleDraft).catch(e=>toast(e.message));};
  $('newProject').onclick=()=>{if(project.clips.length&&!confirm('편집 타임라인을 비울까요? 현재 소재함은 유지합니다.'))return;edit('빈 프로젝트 시작',()=>{project.clips=[];project.overlays=[];project.captions=[];project.audio.tracks=[];project.template.mode='none';selection=null;setDocumentName('새 프로젝트');isDemo=false;});$('helpDialog').close();};
  $('fileInput').onchange=e=>{importFiles([...e.target.files]);e.target.value='';e.target.accept='video/*,image/*,audio/*,.mkv,.ts,.srt,.vtt';};
  for(const host of [$('libraryContent'),$('inspectorContent')])host.addEventListener('click',e=>{
    const add=e.target.closest('[data-add-asset]');if(add){e.stopPropagation();placeAsset(add.dataset.addAsset).catch(e=>toast(e.message));return;}
    const action=e.target.closest('[data-action]');if(action){routeAction(action.dataset.action);return;}
    const filter=e.target.closest('[data-filter]');if(filter){mediaFilter=filter.dataset.filter;renderLibrary();return;}
    const scope=e.target.closest('[data-scope]');if(scope){captionScope=scope.dataset.scope;renderLibrary();return;}
    const preset=e.target.closest('[data-preset]');if(preset){const [type,key]=preset.dataset.preset.split(':');if(type==='g')addGraphic(key);else if(type==='c')applyCaptionPreset(key);else applyTransition(key);return;}
    const cap=e.target.closest('[data-select-caption]');if(cap){select('caption',cap.dataset.selectCaption);player.seek(selected().start);return;}
    const asset=e.target.closest('[data-asset]');if(asset)select('asset',asset.dataset.asset);
  });
  $('libraryContent').addEventListener('dblclick',e=>{const card=e.target.closest('[data-asset]');if(card&&!e.target.closest('[data-add-asset]'))placeAsset(card.dataset.asset).catch(e=>toast(e.message));});
  $('libraryContent').addEventListener('keydown',e=>{const card=e.target.closest('[data-asset]');if(card&&e.key==='Enter'){e.preventDefault();placeAsset(card.dataset.asset).catch(e=>toast(e.message));}});
  $('libraryContent').addEventListener('dragstart',e=>{const a=e.target.closest('[data-asset]'),p=e.target.closest('[data-preset]');if(a)e.dataTransfer.setData('application/x-shorts-asset',a.dataset.asset);else if(p)e.dataTransfer.setData('application/x-shorts-preset',p.dataset.preset);e.dataTransfer.effectAllowed='copy';});
  $('libraryContent').addEventListener('input',e=>{if(e.target.id==='mediaSearch'){search=e.target.value;renderAssets();}if(e.target.id==='ttsText'){voice.text=e.target.value;$('ttsCount').textContent=`${voice.text.length} / 2,000자`;}if(e.target.id==='ttsVoice')voice.voice=e.target.value;if(e.target.id==='ttsTone')voice.tone=e.target.value;if(e.target.id==='ttsSpeed'){voice.speed=Number(e.target.value);$('ttsSpeedOut').textContent=voice.speed.toFixed(2)+'×';}});
  $('inspectorContent').addEventListener('focusin',e=>{if(e.target.dataset.prop)controlBefore.set(e.target,captureDocument());});
  $('inspectorContent').addEventListener('pointerdown',e=>{if(e.target.dataset.prop&&!controlBefore.has(e.target))controlBefore.set(e.target,captureDocument());});
  $('inspectorContent').addEventListener('input',e=>{if(e.target.dataset.prop){if(!controlBefore.has(e.target))controlBefore.set(e.target,captureDocument());applyProperty(e.target);}});
  $('inspectorContent').addEventListener('change',e=>{if(e.target.dataset.prop){const before=controlBefore.get(e.target)||captureDocument();applyProperty(e.target);commit(before,'속성 변경');}});
  $('timelineCanvas').addEventListener('keydown',e=>{const n=e.target.closest('[data-type][data-id]');if(n&&e.key==='Enter'){e.preventDefault();select(n.dataset.type,n.dataset.id);}});
  document.addEventListener('keydown',e=>{
    if(exportCtrl||importing)return;const typing=/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName),mod=e.ctrlKey||e.metaKey;
    if(mod&&e.key.toLowerCase()==='s'){e.preventDefault();saveProjectFile();return;}
    if(typing||document.querySelector('dialog[open]'))return;
    if(mod&&e.key.toLowerCase()==='z'){e.preventDefault();player.pause();e.shiftKey?history.redo():history.undo();}
    else if(mod&&e.key.toLowerCase()==='d'){e.preventDefault();duplicateSelection().catch(e=>toast(e.message));}
    else if(e.code==='Space'){e.preventDefault();player.toggle();}
    else if(e.code==='ArrowLeft'){e.preventDefault();player.step(e.shiftKey?-10:-1);}
    else if(e.code==='ArrowRight'){e.preventDefault();player.step(e.shiftKey?10:1);}
    else if(e.key.toLowerCase()==='s')splitSelected().catch(e=>toast(e.message));
    else if(e.key.toLowerCase()==='n')timeline.toggleSnap();
    else if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();deleteSelection();}
    else if(e.key==='/'){e.preventDefault();setView('media');$('mediaSearch')?.focus();}
    else if(e.key==='Escape'){$('workbench').classList.remove('show-library','show-inspector');}
  });
  let dragDepth=0;
  document.addEventListener('dragenter',e=>{if(e.dataTransfer.types.includes('Files')){dragDepth++;$('dropOverlay').hidden=false;}});
  document.addEventListener('dragover',e=>{if(e.dataTransfer.types.includes('Files'))e.preventDefault();});
  document.addEventListener('dragleave',e=>{if(e.dataTransfer.types.includes('Files')){dragDepth--;if(dragDepth<=0)$('dropOverlay').hidden=true;}});
  document.addEventListener('drop',e=>{dragDepth=0;$('dropOverlay').hidden=true;if(e.dataTransfer.files.length){e.preventDefault();importFiles([...e.dataTransfer.files]);}});
  document.addEventListener('paste',e=>{if(/INPUT|TEXTAREA/.test(document.activeElement?.tagName))return;const files=[...(e.clipboardData?.files||[])];if(files.length){e.preventDefault();importFiles(files);}});
  window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
  let canvasDrag=null;
  $('preview').addEventListener('pointerdown',e=>{if(exportCtrl)return;let item=selected();if(selection?.type!=='clip'){const at=clipAt(player.time);if(!at)return;select('clip',at.clip.id);item=selected();}player.pause();canvasDrag={x:e.clientX,y:e.clientY,offX:item.offX,offY:item.offY,item,before:captureDocument()};$('preview').setPointerCapture(e.pointerId);$('preview').classList.add('dragging');});
  $('preview').addEventListener('pointermove',e=>{if(!canvasDrag)return;const r=$('preview').getBoundingClientRect(),d=canvasDrag;d.item.offX=clamp(d.offX+(e.clientX-d.x)/r.width,-.5,.5);d.item.offY=clamp(d.offY+(e.clientY-d.y)/r.height,-.5,.5);player.invalidate();});
  $('preview').addEventListener('pointerup',()=>{if(!canvasDrag)return;const b=canvasDrag.before;canvasDrag=null;$('preview').classList.remove('dragging');commit(b,'화면 위치 이동');});
  $('preview').addEventListener('pointercancel',()=>{if(canvasDrag)restoreDocument(canvasDrag.before);canvasDrag=null;$('preview').classList.remove('dragging');refresh();});
  window.addEventListener('resize',()=>timeline.render());
}

async function init(){
  wire();checkAI();
  engine=await detectEngine();$('engineLabel').textContent=engine.label;
  try{if(new URLSearchParams(location.search).has('empty')){setDocumentName('새 프로젝트');refresh();}else if(await loadDraft()){selection=null;refresh();$('saveStatus').textContent='저장된 작업 복구';}else await loadDemo();}
  catch(e){console.warn('초기 프로젝트 로딩 실패',e);try{await loadDemo();}catch{refresh();toast('샘플을 불러오지 못했어요. 파일 가져오기로 시작해 주세요.');}}
  await loadFonts();player.invalidate();
  document.documentElement.dataset.studioReady='true';
}
init().catch(e=>{console.error(e);toast('편집기를 시작하지 못했습니다. 새로고침해 주세요.');});
