// UI는 편집 명령을 호출하고, 상태·자원·시간표·렌더러는 각각의 모듈이 담당합니다.
import {project,FONTS,clipAt,clipDuration,buildLayout,totalDuration,newOverlay,syncAnchoredItems,pinClipPositions,transitionPairs,timelineTracks,trackIdFor,trackLabel,trackKind,trackItems,migrateTimeline,addTimelineTrack,removeTimelineTrack} from './state.js';
import {Player} from './player.js';
import {loadFonts,measureVisual} from './render.js';
import {detectEngine,exportVideo} from './exporter.js';
import {mixTimeline,findUncaptioned} from './audio.js';
import {parseSrt,buildSrt} from './srt.js';
import {uid,clamp,download} from './util.js';
import {assets,addAsset,makeClip,makeAudio,captureDocument,restoreDocument,History,setDocumentName,documentName,packProject,unpackProject,saveDraft,loadDraft,demoSound,onAssetReady} from './project-store.js';
import {Timeline} from './timeline.js';
import {frameTime,timelineCollection,itemRange,splitAvailability,splitTimelineItem,planVideoPlacement,placeVideoClip,planClipTrim,applyClipTrim,setItemRange,setTransition,deleteTimelineItem,planPlacement,placeTimelineItem,currentGap,planItemTrim,applyItemTrim} from './timeline-edits.js';
import {GRAPHICS,CAPTIONS,TRANSITIONS} from './presets.js';
import {transformOf,alignVisual,visualCorners} from './visual-transform.js';
import {SAFE_AREAS,safeAreaConfig} from './safe-areas.js';
import {SOUND_EFFECTS,createSoundEffect} from './sound-effects.js';
import {ensureFont} from './font-catalog.js';
import {encodeWav,transcriptionCaptions,apiError} from './ai-client.js';

const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=t=>`${Math.floor(t/60).toString().padStart(2,'0')}:${Math.floor(t%60).toString().padStart(2,'0')}`;
let selection=null,view='media',mediaFilter='all',search='',isDemo=false,engine=null,exportCtrl=null,aiCtrl=null,importing=false,captionScope='selected',activeTransition='dissolve',draftTimer,toastTimer,dirty=false;
let aiStatus={configured:false,provider:'openai'};
const voice={text:'익숙한 도시를 새롭게 보는 시간. 오늘의 순간을, 나만의 이야기로 남겨보세요.',voice:'marin',tone:'natural',speed:1};
const tones={natural:'자연스러운 한국어로, 과장 없이 따뜻하고 편안하게 읽어주세요.',energetic:'밝고 생동감 있는 한국어로 읽어주세요. 또렷하게 말하되 소리를 지르거나 과장하지 마세요.',narration:'차분한 다큐멘터리 내레이션처럼 자연스러운 한국어로 읽어주세요. 문장 사이에 짧게 쉬어주세요.',product:'신뢰감 있는 한국어 제품 소개처럼 읽어주세요. 숫자와 제품명을 또렷하게 발음하고 광고조는 절제하세요.'};
let safeConfig=safeAreaConfig('shorts'),safeEnabled=false,soundPreview=null,soundPreviewUrl=null;
const player=new Player($('preview'),{onTick:tick});
const history=new History(()=>{selection=validSelection();refresh();scheduleDraft();});
const timeline=new Timeline({
  select:(type,id)=>select(type,id,{timeline:false}),gap:gap=>select('gap',gap.id,{gap,timeline:false}),
  removeTrack:id=>{try{edit('빈 트랙 삭제',()=>removeTimelineTrack(id));}catch(error){toast(error.message);}},
  sound:id=>SOUND_EFFECTS.find(s=>s.id===id),graphic:id=>GRAPHICS.find(g=>g.id===id),pause:()=>player.pause(),seek:t=>player.seek(t,{allowBeyond:true}),preview:()=>player.invalidate(),
  busy:()=>!!(exportCtrl||importing),error:message=>toast(message),
  commit:(before,label)=>commit(before,label),transition:(id,rightId)=>selectTransition(id,rightId),
  drop:async(kind,id,t,lane,plan)=>{
    if(kind==='asset')return placeAsset(id,t,lane,plan);
    const [type,key]=id.split(':');
    if(type==='g')return addGraphic(key,t,plan);
    if(type==='c')return addCaption(t,key,plan);
    if(type==='t')return applyTransition(key,false,plan);
    if(type==='sfx')return addSound(key,t,lane,plan);
  },
});

onAssetReady(()=>player.invalidate());

function toast(message){clearTimeout(toastTimer);$('toast').textContent=message;$('toast').hidden=false;toastTimer=setTimeout(()=>$('toast').hidden=true,4200);}
function tick(t){
  const f=Math.floor((t%1)*project.fps);
  $('timecode').innerHTML=`00:${fmt(t)}<span>:${String(f).padStart(2,'0')}</span>`;
  $('play').classList.toggle('is-playing',player.playing);$('play').setAttribute('aria-label',player.playing?'일시정지':'재생');
  timeline?.tick(t);updateToolbar();
}
const collection=type=>timelineCollection(type);
function currentTransition(target=selection){
  if(!target)return null;
  const leftId=target.leftId||target.id;
  return transitionPairs().find(pair=>pair.left.clip.id===leftId&&(!target.rightId||pair.right.clip.id===target.rightId))||null;
}
function selected(){return selection?.type==='asset'?assets.get(selection.id):selection?.type==='transition'?currentTransition():selection?.type==='gap'?currentGap(selection):collection(selection?.type).find(i=>i.id===selection?.id);}
function validSelection(){return selected()?selection:null;}
function updateToolbar(){
  const gap=currentGap(selection),split=gap?{ok:true}:splitAvailability(selection,frameTime(player.time));
  const editable=!!selected()&&!['asset','transition','gap'].includes(selection?.type);
  $('splitClip').disabled=!split.ok;$('splitClip').title=gap?'선택한 빈 공간 닫기 · S':split.ok?'선택한 클립만 분할 · S':split.reason;
  $('splitClip').querySelector('span').textContent=gap?'공백 닫기':'분할';
  $('duplicateClip').disabled=!editable;$('deleteClip').disabled=!selected()||selection?.type==='asset';
  $('rippleDeleteClip').disabled=!(editable||gap);
}
function select(type,id,options={}){
  selection={type,id,...(options.gap||{})};player.selection=selection;if(options.timeline!==false)timeline.select(type,id);
  player.invalidate();
  renderInspector();if(view==='media')document.querySelectorAll('[data-asset]').forEach(n=>n.classList.toggle('selected',type==='asset'&&n.dataset.asset===id));if(view==='captions')renderCaptionList();if(view==='transitions')renderLibrary();
  updateToolbar();if(window.innerWidth<651)$('workbench').classList.remove('show-library');
}
function selectTransition(id,rightId){
  const pair=currentTransition({id,rightId});if(!pair)return;
  player.pause();selection={type:'transition',id,rightId};activeTransition=pair.type;
  timeline.select('transition',id,rightId);player.seek(pair.center,{allowBeyond:true});setView('transitions');renderInspector();updateToolbar();
}

function refresh(){
  migrateTimeline();selection=validSelection();player.selection=selection;
  const hasContent=totalDuration()>0;
  $('projectName').value=documentName;$('emptyPreview').hidden=hasContent;$('preview').hidden=!hasContent;
  $('previewLabel').hidden=!isDemo;$('play').disabled=!hasContent;$('openExport').disabled=!hasContent||!engine?.ok;
  $('undo').disabled=!history.past.length;$('redo').disabled=!history.future.length;
  updateToolbar();
  $('preview').width=project.width;$('preview').height=project.height;
  $('previewResolution').textContent=`${project.width} × ${project.height}`;
  renderLibrary();renderInspector();timeline.render();timeline.select(selection?.type,selection?.id,selection?.rightId);
  prepareFonts();
  player.seek(player.time,{allowBeyond:true});
}
function commit(before,label){syncAnchoredItems();if(history.push(before,label)){dirty=true;isDemo=isDemo&&assets.size<=4;scheduleDraft();}refresh();}
function edit(label,mutate){if(exportCtrl||importing)return;player.pause();const before=captureDocument();mutate();commit(before,label);}
function scheduleDraft(){
  clearTimeout(draftTimer);$('saveStatus').textContent='저장 중…';
  draftTimer=setTimeout(async()=>{try{await saveDraft();$('saveStatus').textContent='이 브라우저에 저장됨';dirty=false;}catch{$('saveStatus').textContent='파일로 저장 필요';}},650);
}
function setView(next){
  if(next!=='sounds')stopSoundPreview();
  view=next;renderLibrary();
  document.querySelectorAll('.rail-item[data-view]').forEach(b=>{b.classList.toggle('active',b.dataset.view===view);b.setAttribute('aria-pressed',b.dataset.view===view);});
  if(window.innerWidth<=650){$('workbench').classList.add('show-library');$('workbench').classList.remove('show-inspector');}
}

function renderLibrary(){
  const titles={media:'소재 라이브러리',captions:'자막 스튜디오',graphics:'모션 그래픽',transitions:'장면 전환',voice:'AI 보이스',sounds:'효과음 라이브러리'};
  $('libraryTitle').textContent=titles[view];$('libraryCount').textContent=view==='media'?String(assets.size).padStart(2,'0'):view==='graphics'?String(GRAPHICS.length):view==='captions'?String(CAPTIONS.length):view==='transitions'?'04':view==='sounds'?String(SOUND_EFFECTS.length):'AI';
  const host=$('libraryContent');
  if(view==='media'){
    host.innerHTML=`<button class="import-zone" data-action="import"><span class="import-plus">＋</span><strong>파일 가져오기</strong><span>영상 · 이미지 · 오디오를 한곳에</span><small>또는 여기에 파일을 놓아주세요</small></button><div class="filter-tabs" aria-label="소재 종류">${[['all','전체'],['video','영상'],['image','이미지'],['audio','오디오']].map(([key,label])=>`<button data-filter="${key}" class="${mediaFilter===key?'active':''}">${label}</button>`).join('')}</div><label class="search-box"><span>⌕</span><input id="mediaSearch" type="search" placeholder="소재 검색" aria-label="소재 검색" value="${esc(search)}"><kbd>/</kbd></label><div id="assetGrid" class="asset-grid"></div><p class="library-hint">더블클릭·＋는 재생 막대 위치에 추가합니다.<br>끌어 넣을 때 초록색 범위가 실제 배치 위치예요.<br>이미지 기본 3초 · 영상은 원본 길이</p>`;
    renderAssets();
  }else if(view==='graphics'){
    host.innerHTML=`<p class="preset-intro">움직임 하나로 장면에 포인트를.<br>클릭하면 선택한 영상 트랙에 추가돼요.</p><div class="preset-grid">${GRAPHICS.map(g=>`<button class="preset-card" draggable="true" data-preset="g:${g.id}" aria-label="${g.name} 추가"><div class="preset-art ${g.art}"><span>${g.label}</span><small>MOTION GRAPHIC</small></div><strong>${g.name}</strong><small>${g.hint}</small></button>`).join('')}</div><p class="library-hint">문구·색상·크기·표시 시간은<br>오른쪽 속성에서 자유롭게 바꿔보세요.</p>`;
  }else if(view==='captions'){
    host.innerHTML=`<div class="segmented"><button data-scope="selected" class="${captionScope==='selected'?'active':''}">선택 자막에 적용</button><button data-scope="all" class="${captionScope==='all'?'active':''}">전체 자막에 적용</button></div><div class="section-label">자막 스타일 <span>${CAPTIONS.length} STYLES</span></div><div class="preset-grid">${CAPTIONS.map(c=>`<button class="preset-card" draggable="true" data-preset="c:${c.id}" aria-label="${c.name} 자막 스타일"><div class="preset-art caption-preview ${c.art}"><span>${c.label}</span></div><strong>${c.name}</strong></button>`).join('')}</div><div class="section-label">자막 편집 <span>${project.captions.length}개</span></div><button class="button primary wide" data-action="add-caption">＋ 현재 위치에 자막</button><div class="field-grid"><button class="button subtle" data-action="import-srt">SRT 가져오기</button><button class="button subtle" data-action="export-srt">SRT 저장</button></div><button class="button secondary wide" data-action="auto-caption" ${!aiStatus.configured?'disabled':''}>${aiCtrl?'처리 취소':'자동 자막 만들기'}</button><p class="inspector-note">${aiStatus.configured?'실행 전 확인 후 오디오를 OpenAI로 전송합니다. 배경음악은 제외합니다.':'자동 자막은 AI 연결 후 사용할 수 있어요. 실험판은 원본 자막 서버를 호출하지 않습니다.'}</p><div id="captionList" class="caption-list"></div>`;
    renderCaptionList();
  }else if(view==='transitions'){
    const pair=currentTransition(),effect=pair?.type||activeTransition;
    const context=pair?esc(pair.left.clip.name||'앞 클립')+' ↔ '+esc(pair.right.clip.name||'뒤 클립'):'타임라인에서 두 장면 사이의 ＋ 또는 전환 아이콘을 선택하세요.';
    host.innerHTML='<p class="preset-intro transition-context">'+context+'</p><div class="preset-grid">'+TRANSITIONS.map(t=>'<button class="preset-card '+(t.id===effect?'active':'')+'" draggable="true" data-preset="t:'+t.id+'" aria-pressed="'+(t.id===effect)+'" aria-label="'+t.name+' 적용"><div class="preset-art '+(t.id==='cut'?'none':'')+'">'+(t.id==='cut'?'<span>│</span>':'<div class="transition-demo '+t.id+'"></div>')+'</div><strong>'+t.name+'</strong><small>'+t.hint+'</small></button>').join('')+'</div><div class="transition-options"><label class="field-label">전환 길이 (초)<input type="number" id="transitionDuration" min="0" max="2" step=".1" value="'+(pair?.duration||.5).toFixed(2)+'"></label><button class="button secondary wide" data-action="all-transitions">모든 연결에 '+(TRANSITIONS.find(t=>t.id===activeTransition)?.name||'디졸브')+' 적용</button><p class="inspector-note">맞닿은 두 영상 사이에만 적용합니다. 실제 겹침 구간의 가운데에 아이콘이 표시돼요. 길이를 바꾸면 같은 트랙의 뒤 클립만 그 차이만큼 이동합니다.</p></div>';

  }else if(view==='sounds'){
    host.innerHTML='<p class="preset-intro">컷 사이에 리듬을 더하세요.<br>미리 듣고, ＋ 또는 드래그로 넣을 수 있어요.</p>'+
      ['전환','클릭','알림','강조'].map(category=>'<div class="section-label">'+category+'</div><div class="sound-list">'+SOUND_EFFECTS.filter(s=>s.category===category).map(s=>'<article class="sound-card" draggable="true" data-preset="sfx:'+s.id+'"><button class="sound-play" data-preview-sound="'+s.id+'" aria-label="'+s.name+' 미리 듣기"><span class="play-symbol" aria-hidden="true"></span></button><div><strong>'+s.name+'</strong><small>'+s.duration.toFixed(2)+'초 · 합성 효과음</small></div><button class="sound-add" data-add-sound="'+s.id+'" aria-label="'+s.name+' 추가">＋</button></article>').join('')+'</div>').join('')+
      '<p class="library-hint">이 실험판이 직접 합성한 20종입니다.<br>외부 음원 샘플 없이 생성하며 영상에 사용할 수 있어요.</p><div class="external-sounds"><strong>더 많은 소리를 찾고 있다면</strong><a class="button secondary wide" href="https://www.myinstants.com/ko/instant/app/" target="_blank" rel="noopener noreferrer">Myinstants에서 찾기 ↗</a><p class="inspector-note">외부 사이트입니다. 자동 다운로드·음원 수집은 하지 않습니다. 다운로드 가능 여부와 상업적 재사용 권한은 다르므로, 권리를 확인한 파일만 소재함에 가져오세요.</p></div>';
  }else{
    host.innerHTML=`<p class="preset-intro">문장을 쓰고, 이야기의 목소리를 고르세요.</p><div class="voice-card"><div class="voice-avatar">≋</div><div><strong>OpenAI Voice</strong><p>gpt-4o-mini-tts · 한국어 지원</p></div></div><label class="field-label">보이스<select id="ttsVoice">${['marin','cedar','coral','onyx','nova','sage','shimmer','alloy','ash','ballad','echo','fable','verse'].map(v=>`<option value="${v}" ${v===voice.voice?'selected':''}>${v[0].toUpperCase()+v.slice(1)}</option>`).join('')}</select></label><label class="field-label">말하기 스타일<select id="ttsTone">${[['natural','자연스럽게'],['energetic','밝고 생동감 있게'],['narration','차분한 내레이션'],['product','또렷한 제품 소개']].map(([v,n])=>`<option value="${v}" ${v===voice.tone?'selected':''}>${n}</option>`).join('')}</select></label><label class="property-row"><span>속도</span><input id="ttsSpeed" type="range" min=".75" max="1.25" step=".05" value="${voice.speed}" aria-label="TTS 말하기 속도"><output id="ttsSpeedOut">${voice.speed.toFixed(2)}×</output></label><label class="field-label">원고<textarea id="ttsText" class="tts-text" maxlength="2000" placeholder="들려주고 싶은 이야기를 적어보세요.">${esc(voice.text)}</textarea></label><p class="inspector-note" id="ttsCount">${voice.text.length} / 2,000자</p><button class="button primary wide" data-action="generate-voice" ${!aiStatus.configured?'disabled':''}>${aiCtrl?'생성 취소':'음성 생성 후 타임라인에 추가'}</button><div class="voice-status">${aiStatus.configured?'설정됨 · 실제 연결/한국어 음질 미검증<br>생성 전 확인 후 API 이용료가 발생할 수 있어요.':'연결 필요<br>API 키는 화면에 입력하지 않습니다. 로컬 서버에 키를 설정한 뒤 사용할 수 있어요.'}</div><p class="library-hint">AI 생성 음성입니다. 원고는 음성 생성 시 OpenAI로 전송됩니다. 생성한 음성은 소재함과 선택한 오디오 트랙에 추가돼요.</p><button class="button subtle wide" data-action="refresh-ai">연결 상태 다시 확인</button>`;
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
function renderCaptionList(){const list=$('captionList');if(!list)return;list.innerHTML=project.captions.map(c=>`<button data-select-caption="${c.id}" class="${selection?.id===c.id?'selected':''}"><small>${c.start.toFixed(2)} → ${c.end.toFixed(2)} · ${trackLabel(trackIdFor('caption',c))}</small>${esc(c.text)}</button>`).join('');}

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
  if(type==='transition'){
    $('selectionBadge').textContent='전환';
    host.innerHTML='<div class="selected-item"><div class="item-icon">◩</div><div><strong>'+esc(item.left.clip.name||'앞 클립')+' ↔ '+esc(item.right.clip.name||'뒤 클립')+'</strong><small>두 장면 사이 · '+item.center.toFixed(2)+'초</small></div></div>'+section('장면 전환',selectField('효과','transitionType',item.type,TRANSITIONS.map(t=>[t.id,t.name]))+number('길이','transitionDuration',item.duration,0,2,.1)+'<p class="inspector-note">전환을 지우면 두 장면이 바로 이어집니다. 뒤쪽 영상은 겹침 길이만큼 이동합니다.</p>')+'<button class="button subtle wide delete-action" data-action="delete">전환 제거 · Delete</button>';
    return;
  }
  if(type==='gap'){
    $('selectionBadge').textContent='빈 공간';
    host.innerHTML='<div class="selected-item"><div class="item-icon">⇤</div><div><strong>'+trackLabel(item.trackId)+' · 빈 공간</strong><small>'+item.start.toFixed(2)+' → '+item.end.toFixed(2)+'초</small></div></div>'+section('잔물결 삭제','<p class="note">'+item.duration.toFixed(2)+'초 공백을 닫고 이 트랙의 오른쪽 클립만 당깁니다. 다른 트랙은 그대로입니다.</p><button class="button primary wide" data-action="close-gap">공백 닫기 · S / Delete</button>');
    return;
  }
  $('selectionBadge').textContent={clip:'클립',graphic:'그래픽',caption:'자막',audio:'오디오'}[type];
  const name=item.name||item.text;
  let html=`<div class="selected-item">${item.thumb?`<img src="${item.thumb}" alt="">`:`<div class="item-icon">${type==='audio'?'♫':type==='caption'?'T':'✧'}</div>`}<div><strong>${esc(name)}</strong><small>${type==='clip'?`${item.type==='image'?'이미지':'영상'} 클립 · ${clipDuration(item).toFixed(2)}초`:type==='audio'?(item.aiGenerated?'AI 생성 음성':'독립 오디오 클립'):`${item.start.toFixed(2)} → ${item.end.toFixed(2)}초`}</small></div></div>`;
  html+=section('트랙',selectField('배치 트랙','trackId',trackIdFor(type,item),timelineTracks().filter(t=>t.kind===trackKind(type)).map(t=>[t.id,trackLabel(t.id)]))+'<p class="inspector-note">트랙 사이로 직접 끌어 옮길 수도 있어요. 다른 트랙은 따라오지 않습니다.</p>');
  if(type==='clip'){
    html+=section('원본 맞춤',selectField('맞춤','fit',item.fit,[['cover','꽉 채우기'],['contain','전체 보이기']])+selectField('여백','bg',item.bg,[['transparent','투명 · 아래 트랙 보이기'],['blur','흐린 원본'],['black','검정'],['white','흰색']]));
    const clipRange=itemRange('clip',item.id);
    html+=section('타임라인 위치',number('위치','start',clipRange.start)+'<p class="inspector-note">빈 구간에 놓을 수 있습니다. 다른 영상 위에 놓으면 경계에 삽입하고 뒤 영상을 밀어냅니다.</p>');
    html+=section('클립 구간',item.type==='image'?number('길이','imgDuration',item.imgDuration,1/project.fps,600,1/project.fps):number('원본 시작','trimStart',item.trimStart,0,item.trimEnd-1/project.fps)+number('원본 끝','trimEnd',item.trimEnd,item.trimStart+1/project.fps,item.srcDuration),item.type==='video'?'원본 기준':'DURATION');
    if(item.type==='image')html+=section('이미지 모션',selectField('움직임','ken',item.ken,[['none','없음'],['in','천천히 확대'],['out','천천히 축소'],['left','왼쪽으로 팬'],['right','오른쪽으로 팬']]));
    if(item.type==='video')html+=section('원본 오디오',range('볼륨','volume',(item.volume??1)*100,0,100,1,'%')+`<label class="property-row"><input type="checkbox" data-prop="muted" ${item.muted?'checked':''}>음소거</label>${item.decoderOnly?'<p class="note warning">디코더 모드: 미리보기 소리는 지원하지 않으며 내보내기에만 포함됩니다.</p>':''}`);
    const pair=currentTransition({id:item.id});
    html+=section('다음 장면과 전환',pair?selectField('효과','transitionType',pair.type,TRANSITIONS.map(t=>[t.id,t.name]))+number('길이','transitionDuration',pair.duration||.5,0,2,.1)+'<p class="inspector-note">두 클립 사이의 아이콘을 누르면 전환을 선택할 수 있어요.</p>':'<p class="inspector-note">다음 영상과 맞닿아야 전환을 넣을 수 있어요.</p>');

    html+=section('클립 페이드',number('인','fadeIn',item.fadeIn,0,2)+number('아웃','fadeOut',item.fadeOut,0,2));
  }else if(type==='audio'){
    html+=section('트랙 위치',selectField('용도','role',item.role||item.lane,[['music','배경음악'],['voice','말소리 · 자막 인식 대상'],['effect','효과음']])+number('위치','start',item.start)+number('시작','trimStart',item.trimStart,0,item.trimEnd-.03)+number('끝','trimEnd',item.trimEnd,item.trimStart+.03,assets.get(item.assetId)?.duration||86400));
    html+=section('오디오',range('볼륨','volume',(item.volume??1)*100,0,100,1,'%')+number('페이드 인','fadeIn',item.fadeIn,0,10)+number('페이드 아웃','fadeOut',item.fadeOut,0,10)+`<label class="property-row"><input type="checkbox" data-prop="muted" ${item.muted?'checked':''}>음소거</label><p class="inspector-note">영상 뒤에 있는 오디오도 끝까지 내보냅니다. 영상이 없는 구간은 검은 화면입니다.${item.aiGenerated?' 게시할 때 AI 생성 음성임을 알려주세요.':''}</p>`);
  }else{
    html+=section('내용',`<textarea data-prop="text" rows="3" maxlength="3000" aria-label="${type==='caption'?'자막':'그래픽'} 내용">${esc(item.text)}</textarea>${item.graphic==='lower'?`<label class="field-label">보조 문구<input type="text" data-prop="subtitle" value="${esc(item.subtitle)}" maxlength="150"></label>`:''}`);
    html+=section('표시 구간',number('시작','start',item.start)+number('끝','end',item.end)+'<p class="inspector-note">영상과 독립적으로 이동하고 길이를 유지합니다.</p>');
    const s=type==='caption'?{...project.captionStyle,...item.style}:item,prefix=type==='caption'?'style.':'';
    html+=section('글자 스타일',selectField('폰트',prefix+'font',s.font,FONTS.map(f=>[f.css,f.group+' · '+f.label]))+range('크기',prefix+'size',s.size,24,160,1)+`<label class="property-row"><span>글자색</span><input type="color" data-prop="${prefix}color" value="${esc(s.color==='#fff'?'#ffffff':s.color)}" aria-label="글자색"></label>`);
    if(type==='caption')html+=section('배치',range('아래 여백','style.bottom',s.bottom*100,0,95,1,'%')+selectField('등장','style.anim',s.anim||'none',[['none','없음'],['fade','페이드'],['pop','팝업']]));
    else html+=section('배치',range('가로','x',item.x*100,5,95,1,'%')+range('세로','y',item.y*100,5,95,1,'%'));
  }
  if(type!=='audio'){
    const tr=transformOf(item),crop=item.crop||{};
    html+=section('변형',range('가로 이동','transform.offsetX',tr.offsetX*100,-150,150,1,'%')+range('세로 이동','transform.offsetY',tr.offsetY*100,-150,150,1,'%')+
      '<div class="field-grid"><button class="button subtle" data-action="align-x">가로 중앙</button><button class="button subtle" data-action="align-y">세로 중앙</button></div>'+
      range('가로 크기','transform.scaleX',tr.scaleX*100,5,400,1,'%')+range('세로 크기','transform.scaleY',tr.scaleY*100,5,400,1,'%')+
      range('회전','transform.rotation',tr.rotation,-180,180,1,'°')+range('불투명도','transform.opacity',tr.opacity*100,0,100,1,'%')+
      '<div class="field-grid"><label class="check-label"><input type="checkbox" data-prop="transform.flipX" '+(tr.flipX?'checked':'')+'>좌우 반전</label><label class="check-label"><input type="checkbox" data-prop="transform.flipY" '+(tr.flipY?'checked':'')+'>상하 반전</label></div><button class="button subtle wide" data-action="reset-transform">변형 초기화</button><p class="inspector-note">모니터에서 선택 요소를 끌면 이동하고, 모서리를 끌면 비율을 유지하며 확대합니다.</p>','TRANSFORM');
    html+=section('화면 자르기',range('왼쪽','crop.left',(crop.left||0)*100,0,95,1,'%')+range('오른쪽','crop.right',(crop.right||0)*100,0,95,1,'%')+
      range('위쪽','crop.top',(crop.top||0)*100,0,95,1,'%')+range('아래쪽','crop.bottom',(crop.bottom||0)*100,0,95,1,'%')+
      '<button class="button subtle wide" data-action="reset-crop">자르기 초기화</button><p class="inspector-note">화면의 일부를 숨깁니다. 원본 파일과 재생 길이는 바뀌지 않습니다.</p>','CROP');
    if(type==='caption'||type==='graphic'){
      const font=FONTS.find(f=>f.css===(type==='caption'?(item.style?.font||project.captionStyle.font):item.font));
      html+='<p class="font-license">한국어 폰트 30종 · 상업 영상 사용 가능<br><a href="'+(font?.licenseUrl||'https://openfontlicense.org/ofl-faq/')+'" target="_blank" rel="noopener noreferrer">'+esc(font?.label||'글꼴')+' · SIL OFL 사용 조건 ↗</a><br>선택한 글꼴은 Google Fonts에서 불러옵니다.</p>';
    }
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
const splitSelected=async()=>selection?.type==='gap'?deleteSelection(true):mediaEdit(splitSelectedImpl);

async function placeAssetImpl(id,time=null,lane=null,dropPlan=null){
  const asset=assets.get(id);if(!asset)return;
  const before=captureDocument();player.pause();const at=frameTime(time??player.time);let result;
  const kind=asset.kind==='audio'?'audio':'visual';
  const target=timelineTracks().find(t=>t.id===lane&&t.kind===kind)?.id||timeline.preferredTrack(kind);
  if(asset.kind==='audio'){
    const track=makeAudio(id,{start:at,role:asset.aiGenerated?'voice':id.startsWith('builtin-sfx-')?'effect':'music',
      ...(id.startsWith('builtin-sfx-')?{fadeIn:0,fadeOut:0,volume:.65}:{})});
    result=placeTimelineItem('audio',track,dropPlan?.placement||planPlacement(at,track.trimEnd-track.trimStart,target));
  }else{
    const clip=await makeClip(id,{...(asset.kind==='image'?{imgDuration:3}:{trimStart:0,trimEnd:asset.duration}),
      bg:target===timelineTracks().find(t=>t.kind==='visual')?.id?'blur':'transparent'});
    result=placeVideoClip(clip,dropPlan?.placement||planPlacement(at,clipDuration(clip),target));
  }
  selection={type:result.type,id:result.id};commit(before,'타임라인에 추가');player.seek(result.start,{allowBeyond:true});timeline.reveal(result);
  toast(result.start.toFixed(2)+'초부터 '+(result.end-result.start).toFixed(2)+'초 추가'+(result.shifted?' · 같은 트랙 뒤 클립 '+result.shifted+'개 이동':''));
  return result;
}
function addGraphic(id,time=player.time,dropPlan=null){
  if(exportCtrl||importing)return;
  const preset=GRAPHICS.find(g=>g.id===id);if(!preset)return;
  const at=dropPlan?.start??frameTime(time),before=captureDocument();player.pause();
  const graphic={...newOverlay(at),...preset,id:uid(),graphic:id,start:at,end:at+(preset.duration||3),anim:'none'};
  delete graphic.art;delete graphic.label;delete graphic.hint;delete graphic.name;
  const result=placeTimelineItem('graphic',graphic,dropPlan?.placement||planPlacement(at,preset.duration||3,timeline.preferredTrack('visual')));
  selection={type:'graphic',id:graphic.id};commit(before,'그래픽 추가');player.seek(result.start,{allowBeyond:true});
  timeline.reveal(result);toast(at.toFixed(2)+'초에 그래픽을 추가했어요.');return result;
}
function addCaption(time=player.time,presetId=null,dropPlan=null){
  if(exportCtrl||importing)return;
  const before=captureDocument(),at=dropPlan?.start??frameTime(time),style=CAPTIONS.find(p=>p.id===presetId)?.style;
  const cap={id:uid(),start:at,end:at+2.5,text:'여기에 자막을 입력하세요',...(style?{style:{...style}}:{})};
  player.pause();const result=placeTimelineItem('caption',cap,dropPlan?.placement||planPlacement(at,2.5,timeline.preferredTrack('visual')));
  selection={type:'caption',id:cap.id};commit(before,'자막 추가');player.seek(result.start,{allowBeyond:true});
  timeline.reveal(result);return result;
}

function applyCaptionPreset(id){const p=CAPTIONS.find(c=>c.id===id);if(!p)return;
if(captionScope==='selected'&&project.captions.length&&selection?.type!=='caption')return toast('바꿀 자막을 먼저 선택하거나, 전체 자막에 적용을 선택해 주세요.');
edit('자막 스타일 변경',()=>{
  if(captionScope==='selected'&&selection?.type==='caption'&&selected())selected().style={...p.style};
  else{project.captionStyle={...project.captionStyle,...p.style};for(const cap of project.captions)cap.style={...p.style};}
});toast(captionScope==='selected'&&selection?.type==='caption'?'선택 자막의 스타일을 바꿨어요.':'전체 자막과 새 자막의 스타일을 바꿨어요.');}
function applyTransition(id,all=false,target=null){
  if(exportCtrl||importing)return;
  const preset=TRANSITIONS.find(t=>t.id===id);if(!preset)return;
  const requested=Number($('transitionDuration')?.value??preset.duration);
  const pairs=all?transitionPairs():[currentTransition(target||selection)].filter(Boolean);
  if(!pairs.length){toast('맞닿은 영상 클립 사이의 연결 아이콘을 선택해 주세요.');return;}
  player.pause();const before=captureDocument();activeTransition=id;
  for(const pair of pairs)setTransition(pair.left.clip.id,pair.right.clip.id,id,requested);
  const first=pairs[0],pair=currentTransition({id:first.left.clip.id,rightId:first.right.clip.id});
  selection={type:'transition',id:first.left.clip.id,rightId:first.right.clip.id};
  commit(before,'장면 전환 변경');setView('transitions');player.seek(pair.center,{allowBeyond:true});
  const result={...selection,start:pair.center,end:pair.center};timeline.reveal(result);
  toast((all?'모든 연결에 ':'선택한 연결에 ')+preset.name+'를 적용했어요.');return result;
}
function deleteSelection(ripple=false){
  if(exportCtrl||importing||!selection||selection.type==='asset')return;
  const before=captureDocument(),wasTransition=selection.type==='transition',wasGap=selection.type==='gap';player.pause();
  if(!deleteTimelineItem(selection,ripple))return;
  selection=null;commit(before,wasTransition?'전환 제거':wasGap?'빈 공간 닫기':ripple?'선택 트랙 당겨 삭제':'빈 공간 유지 삭제');
  toast(wasTransition?'전환을 제거하고 두 영상을 연결했어요.':wasGap?'빈 공간을 닫았어요. 다른 트랙은 그대로입니다.':ripple?'선택한 트랙에서만 뒤 클립을 당겼어요.':'선택 항목을 삭제했어요. 빈 공간은 유지합니다.');
}
async function duplicateSelectionImpl(){
  const item=selected(),type=selection?.type;if(!item||['asset','transition','gap'].includes(type))return;
  const before=captureDocument();player.pause();let result;
  if(type==='clip'){
    const range=itemRange(type,item.id),saved=before.clips.find(c=>c.id===item.id);
    const dup=await makeClip(item.assetId,{...saved,id:uid(),transitionOut:{type:'cut',duration:0}});
    result=placeVideoClip(dup,planPlacement(range.end,range.duration,range.trackId));
  }else if(type==='audio'){
    const start=item.start+item.trimEnd-item.trimStart,dup=makeAudio(item.assetId,{...before.tracks.find(t=>t.id===item.id),id:uid(),start});
    result=placeTimelineItem(type,dup,planPlacement(start,dup.trimEnd-dup.trimStart,trackIdFor(type,item)));
  }else{
    const dup=JSON.parse(JSON.stringify(item));dup.id=uid();setItemRange(dup,item.end,item.end+item.end-item.start);
    result=placeTimelineItem(type,dup,planPlacement(dup.start,dup.end-dup.start,trackIdFor(type,item)));
  }
  selection={type,id:result.id};commit(before,'항목 복제');timeline.reveal(result);
}
async function splitSelectedImpl(){
  const time=frameTime(player.time),check=splitAvailability(selection,time);
  if(!check.ok)return toast(check.reason);
  const before=captureDocument();player.pause();
  const result=await splitTimelineItem(selection,time);selection={type:result.type,id:result.id};
  commit(before,'선택 클립 분할');timeline.reveal(result);toast('선택한 클립만 분할했어요. 다른 트랙은 그대로입니다.');
}

const controlBefore=new WeakMap();
// 위치 변경·트림은 입력 완료 시 한 번만 적용합니다. 입력 중 뒤 클립을 여러 번 밀지 않습니다.
const stagedProperties=new Set(['start','end','imgDuration','trimStart','trimEnd','transitionType','transitionDuration','trackId','role']);
function applyProperty(input){
  const item=selected(),type=selection?.type;if(!item||type==='asset'||type==='gap')return;
  const prop=input.dataset.prop;let value=input.type==='checkbox'?input.checked:input.type==='range'||input.type==='number'?Number(input.value):input.value;
  if(typeof value==='number'&&!Number.isFinite(value))return;
  if(input.type==='range'||input.type==='number'){if(input.min!=='')value=Math.max(Number(input.min),value);if(input.max!=='')value=Math.min(Number(input.max),value);}
  if(['scale','offX','offY','x','y','volume','style.bottom'].includes(prop))value/=100;
  if(prop==='trackId'||prop==='start'){
    const r=itemRange(type,item.id);if(!r)return;
    const target=prop==='trackId'?value:r.trackId,start=prop==='start'?frameTime(value):r.start;
    if(target!==r.trackId||Math.abs(start-r.start)>1e-6)placeTimelineItem(type,item,planPlacement(start,r.duration,target,item.id));
  }else if(prop.startsWith('transform.')){
    const key=prop.slice(10);
    if(['offsetX','offsetY','scaleX','scaleY','opacity'].includes(key))value/=100;
    item.transform={...transformOf(item),[key]:value};
  }else if(prop.startsWith('crop.')){
    const key=prop.slice(5),other={left:'right',right:'left',top:'bottom',bottom:'top'}[key];
    item.crop={...item.crop,[key]:Math.max(0,Math.min(value/100,.98-(item.crop?.[other]||0)))};
  }else if(prop==='transitionType'||prop==='transitionDuration'){
    const pair=currentTransition();if(!pair)return;
    const effect=prop==='transitionType'?value:pair.type==='cut'&&value>0?'dissolve':pair.type;
    setTransition(pair.left.clip.id,pair.right.clip.id,effect,prop==='transitionDuration'?value:pair.duration||.5);activeTransition=effect;
  }else if(type==='clip'&&['imgDuration','trimStart','trimEnd'].includes(prop)){
    const range=itemRange(type,item.id);
    const edge=prop==='trimStart'?'start':'end',time=prop==='imgDuration'?range.start+value:prop==='trimStart'?range.start+value-item.trimStart:range.end+value-item.trimEnd;
    applyClipTrim(planClipTrim(item.id,edge,frameTime(time)));
  }else if(['caption','graphic'].includes(type)&&prop==='end'){
    applyItemTrim(planItemTrim(type,item.id,'end',frameTime(value)));
  }else if(type==='audio'&&['trimStart','trimEnd'].includes(prop)){
    const r=itemRange(type,item.id),edge=prop==='trimStart'?'start':'end';
    applyItemTrim(planItemTrim(type,item.id,edge,frameTime(prop==='trimStart'?r.start+value-item.trimStart:r.end+value-item.trimEnd)));
  }else if(prop.startsWith('style.'))item.style={...project.captionStyle,...item.style,[prop.slice(6)]:value};
  else{
    if(['fadeIn','fadeOut'].includes(prop))delete item.fadeEnvelope;
    if(prop==='ken'){delete item.motionDuration;delete item.motionOffset;}
    if(type==='audio'&&prop==='trimStart'&&item.fadeEnvelope)item.fadeEnvelope={...item.fadeEnvelope,offset:item.fadeEnvelope.offset+value-item.trimStart};
    item[prop]=value;
  }
  if(item.trimEnd!==undefined)item.trimEnd=Math.max(item.trimStart+1/project.fps,item.trimEnd);
  const output=input.parentElement.querySelector('output');if(output)output.textContent=Number(input.value).toFixed(Number(input.step)<1?1:0)+(['scale','offX','offY','x','y','volume','style.bottom'].includes(prop)?'%':'');
  syncAnchoredItems();timeline.render();player.invalidate();updateToolbar();
  if(prop==='font'||prop==='style.font'||prop==='text')prepareFonts();
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
    if(before===JSON.stringify(captureDocument())&&!importing&&!exportCtrl){await placeAsset(asset.id,start,timeline.preferredTrack('audio'));toast('AI 음성을 만들고 오디오 트랙에 추가했어요.');}
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
  if(exportCtrl||importing||!engine?.ok||totalDuration()<=0)return;
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
function openExport(){if(totalDuration()<=0)return toast('타임라인에 소재 또는 자막을 추가해 주세요.');player.pause();$('exportProjectName').textContent=documentName;$('exportSummary').textContent=`${project.clips.length} 클립 · ${totalDuration().toFixed(2)}초 · 9:16 · ${engine?.label||'확인 중'}`;$('exportDialog').showModal();}
function saveProjectFile(){download(packProject(),`${documentName.replace(/[<>:"/\\|?*]/g,'_')}.shorts`);$('saveStatus').textContent='프로젝트 파일 저장';dirty=false;toast('편집 정보와 소재가 포함된 .shorts 프로젝트를 저장했어요.');}
async function openProjectFile(file){if(!file||importing||exportCtrl)return;if(aiCtrl)return toast('AI 처리를 마치거나 취소한 뒤 프로젝트를 열어 주세요.');player.pause();importing=true;clearTimeout(draftTimer);$('workbench').inert=true;document.querySelector('.appbar').inert=true;try{await unpackProject(file);history.clear();isDemo=false;selection=null;refresh();scheduleDraft();toast('프로젝트를 열었어요.');}catch(e){toast(e.message);}finally{importing=false;$('workbench').inert=false;document.querySelector('.appbar').inert=false;refresh();}}

async function loadDemo(){
  if(aiCtrl||importing||exportCtrl)return toast('진행 중인 작업을 마치거나 취소한 뒤 샘플을 열어 주세요.');
  return mediaEdit(async()=>{
  const before=captureDocument();clearTimeout(draftTimer);
  try {
  player.pause();project.clips=[];project.overlays=[];project.captions=[];project.audio.tracks=[];project.audio.bgm=null;project.timelineTracks=undefined;project.template.mode='none';
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
  pinClipPositions();
  isDemo=true;selection={type:'clip',id:project.clips[0].id};history.clear();refresh();player.seek(1.15);$('saveStatus').textContent='샘플 프로젝트';
  } catch(error){restoreDocument(before);refresh();throw error;}
  });
}

let fontRequest=0,fontFailure='';
async function prepareFonts(){
  const request=++fontRequest;
  try{await loadFonts();if(request===fontRequest){fontFailure='';player.invalidate();}}
  catch(error){if(request===fontRequest&&fontFailure!==error.message){fontFailure=error.message;toast(error.message+' 미리보기에는 임시 대체 글꼴이 보일 수 있습니다.');}}
}
function updateSafeArea(){
  player.safeArea=safeEnabled?{...safeConfig,margins:{...safeConfig.margins}}:false;
  $('safeArea').classList.toggle('active',safeEnabled);$('safeArea').setAttribute('aria-pressed',String(safeEnabled));player.invalidate();
}
function renderSafePanel(){
  $('safePlatform').value=safeConfig.id;$('safeEnabled').checked=safeEnabled;
  for(const side of ['top','right','bottom','left']){
    const input=$('safe-'+side);input.value=safeConfig.margins[side]*100;input.nextElementSibling.textContent=(safeConfig.margins[side]*100).toFixed(1)+'%';
  }
  $('safeAreaNote').textContent=safeConfig.note;$('safeAreaSource').href=safeConfig.source;
}
function stopSoundPreview(){
  soundPreview?.pause();soundPreview=null;
  if(soundPreviewUrl)URL.revokeObjectURL(soundPreviewUrl);soundPreviewUrl=null;
  document.querySelectorAll('[data-preview-sound]').forEach(b=>b.classList.remove('is-playing'));
}
async function previewSound(id){
  if(soundPreview?.dataset.id===id){stopSoundPreview();return;}
  stopSoundPreview();player.pause();soundPreviewUrl=URL.createObjectURL(createSoundEffect(id));
  const audio=new Audio(soundPreviewUrl);audio.dataset.id=id;audio.volume=.5;soundPreview=audio;
  audio.onended=()=>{if(soundPreview===audio)stopSoundPreview();};
  try{await audio.play();if(soundPreview===audio)document.querySelector('[data-preview-sound="'+id+'"]')?.classList.add('is-playing');}
  catch(error){if(soundPreview!==audio)return;stopSoundPreview();if(error.name!=='AbortError')throw error;}
}
async function addSound(id,time=player.time,lane=timeline.preferredTrack('audio'),plan=null){
  if(importing||exportCtrl)return;
  stopSoundPreview();
  return mediaEdit(async()=>{
    const asset=await addAsset(createSoundEffect(id),{id:'builtin-sfx-'+id});
    return placeAssetImpl(asset.id,time,lane,plan);
  });
}

function pickMedia(){ $('fileInput').accept='video/*,image/*,audio/*,.mkv,.ts,.srt,.vtt';$('fileInput').click(); }
function routeAction(action){
  if(action==='import')pickMedia();
  if(action==='add-caption')addCaption();
  if(action==='import-srt'){$('fileInput').accept='.srt,.vtt';$('fileInput').click();}
  if(action==='export-srt'){if(!project.captions.length)return toast('저장할 자막이 없습니다.');download(new Blob([buildSrt(project.captions)],{type:'text/plain;charset=utf-8'}),`${documentName}.srt`);}
  if(action==='delete')deleteSelection();
  if(action==='close-gap')deleteSelection(true);
  if(action==='reset-transform')edit('변형 초기화',()=>{const item=selected();item.transform={};if(selection.type==='clip')Object.assign(item,{scale:1,offX:0,offY:0});});
  if(action==='reset-crop')edit('화면 자르기 초기화',()=>{delete selected().crop;});
  if(action==='align-x'||action==='align-y')edit('중앙 정렬',()=>{
    const item=selected(),canvas=$('preview');
    alignVisual(item,measureVisual(player.ctx,selection.type,item,canvas.width,canvas.height,player.time),canvas.width,canvas.height,action==='align-x'?'x':'y');
  });
  if(action==='all-transitions')applyTransition(activeTransition,true);
  if(action==='generate-voice')generateVoice();
  if(action==='auto-caption')autoCaption();
  if(action==='refresh-ai')checkAI().then(()=>toast(aiStatus.configured?'설정을 확인했어요. 실제 생성은 버튼을 누른 뒤 진행됩니다.':'아직 AI 연결이 설정되지 않았어요.'));
}

function wire(){
  document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{if(view===b.dataset.view&&window.innerWidth<=650)$('workbench').classList.toggle('show-library');else setView(b.dataset.view);});
  $('play').onclick=()=>player.toggle();$('prevFrame').onclick=()=>player.step(-1);$('nextFrame').onclick=()=>player.step(1);
  $('safeArea').onclick=()=>{const panel=$('safeAreaPanel');panel.hidden=!panel.hidden;$('safeArea').setAttribute('aria-expanded',String(!panel.hidden));if(!panel.hidden)renderSafePanel();};
  $('closeSafeArea').onclick=()=>{$('safeAreaPanel').hidden=true;$('safeArea').setAttribute('aria-expanded','false');};
  $('safePlatform').onchange=e=>{safeConfig=safeAreaConfig(e.target.value);safeEnabled=true;renderSafePanel();updateSafeArea();};
  $('safeEnabled').onchange=e=>{safeEnabled=e.target.checked;updateSafeArea();};
  $('resetSafeArea').onclick=()=>{safeConfig=safeAreaConfig(safeConfig.id);renderSafePanel();updateSafeArea();};
  for(const side of ['top','right','bottom','left'])$('safe-'+side).oninput=e=>{
    const other={top:'bottom',bottom:'top',left:'right',right:'left'}[side];
    safeConfig.margins[side]=clamp(Number(e.target.value)/100,0,Math.min(.6,.9-safeConfig.margins[other]));
    e.target.value=safeConfig.margins[side]*100;
    e.target.nextElementSibling.textContent=(safeConfig.margins[side]*100).toFixed(1)+'%';updateSafeArea();
  };
  $('addVisualTrack').onclick=()=>{try{let track;edit('영상 트랙 추가',()=>{track=addTimelineTrack('visual');});timeline.activateTrack(track.id);}catch(e){toast(e.message);}};
  $('addAudioTrack').onclick=()=>{try{let track;edit('오디오 트랙 추가',()=>{track=addTimelineTrack('audio');});timeline.activateTrack(track.id);}catch(e){toast(e.message);}};
  $('loop').onclick=()=>{player.loop=!player.loop;$('loop').setAttribute('aria-pressed',player.loop);};
  $('undo').onclick=()=>{player.pause();const name=history.undo();if(name)toast(`${name} 실행 취소`);};$('redo').onclick=()=>{player.pause();const name=history.redo();if(name)toast(`${name} 다시 실행`);};
  $('splitClip').onclick=()=>splitSelected().catch(e=>toast(e.message));$('duplicateClip').onclick=()=>duplicateSelection().catch(e=>toast(e.message));$('deleteClip').onclick=()=>deleteSelection();$('rippleDeleteClip').onclick=()=>deleteSelection(true);
  $('saveProject').onclick=saveProjectFile;$('openProject').onclick=()=>$('projectInput').click();$('projectInput').onchange=e=>{openProjectFile(e.target.files[0]);e.target.value='';};
  $('projectName').onchange=e=>edit('프로젝트 이름 변경',()=>setDocumentName(e.target.value));
  $('openExport').onclick=openExport;$('startExport').onclick=startExport;$('cancelExport').onclick=()=>exportCtrl?.abort();
  $('exportDialog').addEventListener('cancel',e=>{if(exportCtrl)e.preventDefault();});
  $('helpButton').onclick=()=>$('helpDialog').showModal();$('toggleInspector').onclick=()=>{$('workbench').classList.toggle('show-inspector');$('workbench').classList.remove('show-library');};
  $('emptyImport').onclick=pickMedia;$('loadDemo').onclick=()=>loadDemo().then(scheduleDraft).catch(e=>toast(e.message));
  $('resetDemo').onclick=()=>{if(totalDuration()>0&&!confirm('현재 편집을 샘플 프로젝트로 바꿀까요? 필요한 작업은 먼저 저장해 주세요.'))return;$('helpDialog').close();loadDemo().then(scheduleDraft).catch(e=>toast(e.message));};
  $('newProject').onclick=()=>{if(totalDuration()>0&&!confirm('편집 타임라인을 비울까요? 현재 소재함은 유지합니다.'))return;edit('빈 프로젝트 시작',()=>{project.clips=[];project.overlays=[];project.captions=[];project.audio.tracks=[];project.timelineTracks=undefined;project.template.mode='none';selection=null;setDocumentName('새 프로젝트');isDemo=false;});$('helpDialog').close();};
  $('fileInput').onchange=e=>{importFiles([...e.target.files]);e.target.value='';e.target.accept='video/*,image/*,audio/*,.mkv,.ts,.srt,.vtt';};
  for(const host of [$('libraryContent'),$('inspectorContent')])host.addEventListener('click',e=>{
    const sound=e.target.closest('[data-add-sound]');if(sound){addSound(sound.dataset.addSound).catch(e=>toast(e.message));return;}
    const listen=e.target.closest('[data-preview-sound]');if(listen){previewSound(listen.dataset.previewSound).catch(e=>toast(e.message));return;}
    const add=e.target.closest('[data-add-asset]');if(add){e.stopPropagation();placeAsset(add.dataset.addAsset).catch(e=>toast(e.message));return;}
    const action=e.target.closest('[data-action]');if(action){routeAction(action.dataset.action);return;}
    const filter=e.target.closest('[data-filter]');if(filter){mediaFilter=filter.dataset.filter;renderLibrary();return;}
    const scope=e.target.closest('[data-scope]');if(scope){captionScope=scope.dataset.scope;renderLibrary();return;}
    const preset=e.target.closest('[data-preset]');if(preset){const [type,key]=preset.dataset.preset.split(':');if(type==='g')addGraphic(key);else if(type==='c')applyCaptionPreset(key);else if(type==='sfx')addSound(key).catch(e=>toast(e.message));else applyTransition(key);return;}
    const cap=e.target.closest('[data-select-caption]');if(cap){select('caption',cap.dataset.selectCaption);player.seek(selected().start);return;}
    const asset=e.target.closest('[data-asset]');if(asset)select('asset',asset.dataset.asset);
  });
  $('libraryContent').addEventListener('dblclick',e=>{const card=e.target.closest('[data-asset]');if(card&&!e.target.closest('[data-add-asset]'))placeAsset(card.dataset.asset).catch(e=>toast(e.message));});
  $('libraryContent').addEventListener('keydown',e=>{const card=e.target.closest('[data-asset]');if(card&&e.key==='Enter'){e.preventDefault();placeAsset(card.dataset.asset).catch(e=>toast(e.message));}});
  $('libraryContent').addEventListener('dragstart',e=>{if(exportCtrl||importing){e.preventDefault();return;}const a=e.target.closest('[data-asset]'),p=e.target.closest('[data-preset]');if(a){e.dataTransfer.setData('application/x-shorts-asset',a.dataset.asset);timeline.beginExternalDrag('asset',a.dataset.asset);}else if(p){e.dataTransfer.setData('application/x-shorts-preset',p.dataset.preset);timeline.beginExternalDrag('preset',p.dataset.preset);}e.dataTransfer.effectAllowed='copy';});
  $('libraryContent').addEventListener('change',e=>{if(e.target.id==='transitionDuration'){const pair=currentTransition();if(pair&&pair.type!=='cut')applyTransition(pair.type);}});
  $('libraryContent').addEventListener('input',e=>{if(e.target.id==='mediaSearch'){search=e.target.value;renderAssets();}if(e.target.id==='ttsText'){voice.text=e.target.value;$('ttsCount').textContent=`${voice.text.length} / 2,000자`;}if(e.target.id==='ttsVoice')voice.voice=e.target.value;if(e.target.id==='ttsTone')voice.tone=e.target.value;if(e.target.id==='ttsSpeed'){voice.speed=Number(e.target.value);$('ttsSpeedOut').textContent=voice.speed.toFixed(2)+'×';}});
  $('inspectorContent').addEventListener('focusin',e=>{if(e.target.dataset.prop)controlBefore.set(e.target,captureDocument());});
  $('inspectorContent').addEventListener('pointerdown',e=>{if(e.target.dataset.prop&&!controlBefore.has(e.target))controlBefore.set(e.target,captureDocument());});
  $('inspectorContent').addEventListener('input',e=>{if(e.target.dataset.prop&&!stagedProperties.has(e.target.dataset.prop)){if(!controlBefore.has(e.target))controlBefore.set(e.target,captureDocument());applyProperty(e.target);}});
  $('inspectorContent').addEventListener('change',e=>{if(e.target.dataset.prop){const before=controlBefore.get(e.target)||captureDocument();try{applyProperty(e.target);commit(before,'속성 변경');}catch(error){restoreDocument(before);refresh();toast(error.message);}}});
  document.addEventListener('keydown',e=>{
    if(e.defaultPrevented||exportCtrl||importing||timeline.dragging)return;const typing=/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName),mod=e.ctrlKey||e.metaKey;
    if(mod&&e.key.toLowerCase()==='s'){e.preventDefault();saveProjectFile();return;}
    if(typing||document.querySelector('dialog[open]'))return;
    if(mod&&e.key.toLowerCase()==='z'){e.preventDefault();player.pause();e.shiftKey?history.redo():history.undo();}
    else if(mod&&e.key.toLowerCase()==='d'){e.preventDefault();duplicateSelection().catch(e=>toast(e.message));}
    else if(e.code==='Space'){if(document.activeElement?.tagName==='BUTTON')return;e.preventDefault();player.toggle();}
    else if(e.code==='ArrowLeft'){e.preventDefault();player.step(e.shiftKey?-10:-1);}
    else if(e.code==='ArrowRight'){e.preventDefault();player.step(e.shiftKey?10:1);}
    else if(e.key.toLowerCase()==='s')splitSelected().catch(e=>toast(e.message));
    else if(e.key.toLowerCase()==='n')timeline.toggleSnap();
    else if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();deleteSelection(e.shiftKey);}
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
  const point=e=>{const r=$('preview').getBoundingClientRect();return {x:(e.clientX-r.left)/r.width*$('preview').width,y:(e.clientY-r.top)/r.height*$('preview').height};};
  $('preview').addEventListener('pointerdown',e=>{
    if(e.button!==0||exportCtrl||importing)return;
    let item=selected(),type=selection?.type;
    const active=itemRange(type,item?.id);
    if(!['clip','caption','graphic'].includes(type)||!active||player.time<active.start||player.time>=active.end)return;
    const canvas=$('preview'),bounds=measureVisual(player.ctx,type,item,canvas.width,canvas.height,player.time),corners=visualCorners(bounds,item,canvas.width,canvas.height),p=point(e);
    const hit=18*canvas.width/canvas.getBoundingClientRect().width;
    const corner=corners.findIndex(c=>Math.hypot(c.x-p.x,c.y-p.y)<hit);
    const center={x:corners.reduce((s,c)=>s+c.x,0)/4,y:corners.reduce((s,c)=>s+c.y,0)/4};
    player.pause();e.preventDefault();
    canvasDrag={x:e.clientX,y:e.clientY,p,center,corner,tr:transformOf(item),item,before:captureDocument()};
    canvas.setPointerCapture(e.pointerId);canvas.classList.add('dragging');
  });
  $('preview').addEventListener('pointermove',e=>{
    if(!canvasDrag)return;const r=$('preview').getBoundingClientRect(),d=canvasDrag;
    if(d.corner>=0){
      const p=point(e),ratio=Math.hypot(p.x-d.center.x,p.y-d.center.y)/Math.max(1,Math.hypot(d.p.x-d.center.x,d.p.y-d.center.y));
      const factor=clamp(ratio,Math.max(.05/d.tr.scaleX,.05/d.tr.scaleY),Math.min(10/d.tr.scaleX,10/d.tr.scaleY));
      d.item.transform={...d.tr,scaleX:d.tr.scaleX*factor,scaleY:d.tr.scaleY*factor};
    }else d.item.transform={...d.tr,offsetX:clamp(d.tr.offsetX+(e.clientX-d.x)/r.width,-3,3),offsetY:clamp(d.tr.offsetY+(e.clientY-d.y)/r.height,-3,3)};
    player.invalidate();
  });
  $('preview').addEventListener('pointerup',()=>{if(!canvasDrag)return;const b=canvasDrag.before;canvasDrag=null;$('preview').classList.remove('dragging');commit(b,'화면 변형');});
  $('preview').addEventListener('pointercancel',()=>{if(canvasDrag)restoreDocument(canvasDrag.before);canvasDrag=null;$('preview').classList.remove('dragging');refresh();});
  window.addEventListener('resize',()=>timeline.render());
}

async function init(){
  wire();checkAI();
  engine=await detectEngine();$('engineLabel').textContent=engine.label;
  try{if(new URLSearchParams(location.search).has('empty')){setDocumentName('새 프로젝트');refresh();}else if(await loadDraft()){selection=null;refresh();$('saveStatus').textContent='저장된 작업 복구';}else await loadDemo();}
  catch(e){console.warn('초기 프로젝트 로딩 실패',e);try{await loadDemo();}catch{refresh();toast('샘플을 불러오지 못했어요. 파일 가져오기로 시작해 주세요.');}}
  await prepareFonts();player.invalidate();
  document.documentElement.dataset.studioReady='true';
}
init().catch(e=>{console.error(e);toast('편집기를 시작하지 못했습니다. 새로고침해 주세요.');});
