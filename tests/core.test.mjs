// npm 설치 없이 실행하는 계산·저장·렌더러 회귀 검사입니다.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {project,newClipDefaults,buildLayout,layersAt,clipAt,anchorItem,syncAnchoredItems,clipFadeGain,clipDuration,clipStartTime,pinClipPositions,transitionPairs,totalDuration,timelineTracks,trackIdFor,trackLabel,trackItems,migrateTimeline,addTimelineTrack,removeTimelineTrack,TRACK_ROLES} from '../public/js/state.js';
import {assets,addAsset,makeClip,makeAudio,captureDocument,restoreDocument,History,packProject,unpackProject,validateDocument,clearAssets,waveformOf,demoSound} from '../public/js/project-store.js';
import {encodeWav,transcriptionCaptions} from '../public/js/ai-client.js';
import {renderFrame,measureVisual,loadFonts} from '../public/js/render.js';
import {Player} from '../public/js/player.js';
import {GRAPHICS,CAPTIONS} from '../public/js/presets.js';
import {frameTime,itemRange,splitAvailability,splitTimelineItem,setItemRange,planVideoPlacement,placeVideoClip,setTransition,planClipTrim,applyClipTrim,deleteTimelineItem,planPlacement,placeTimelineItem,trackGaps,currentGap,closeTimelineGap,planItemTrim,applyItemTrim,planSilenceCuts,applySilenceCuts} from '../public/js/timeline-edits.js';
import {Timeline} from '../public/js/timeline.js';
import {transformOf,visualCorners,alignVisual,withVisualTransform,croppedBounds,transformPoint,inverseTransformPoint,hitVisual,cropFromDrag,resizeFromDrag,snapVisualCenter} from '../public/js/visual-transform.js';
import {SAFE_AREAS,safeAreaConfig,safeAreaRect} from '../public/js/safe-areas.js';
import {FONTS,ensureFont} from '../public/js/font-catalog.js';
import {SOUND_EFFECTS,synthesizeEffect,createSoundEffect} from '../public/js/sound-effects.js';
import {applyFade,mixTimeline,extractClipAudio} from '../public/js/audio.js';
import {Input,InputAudioTrack,AudioBufferSink} from '../public/vendor/mediabunny.min.js';
import {exportVideo} from '../public/js/exporter.js';
import {analyzeSilence,monoPcm} from '../public/js/silence.js';
import {normalizedRect,mosaicAt,validMosaics,unresolvedMosaics,mergeTrackingKeys,redactSource,trackingTemplate,trackRectangle} from '../public/js/mosaic.js';
import {chunkSpeechText,whisperCaptions,runLocalAI,installedVoices,speakInstalled,TTS_MODEL} from '../public/js/local-ai.js';
import {cachedModel} from '../public/js/model-download.js';
import {StudioTools} from '../public/js/studio-tools.js';
import {selectionRefs,resolveSelection,combineSelection,marqueeHits,captureItemSettings,planPasteSettings,applySettingsPlan,applySharedProperty,deleteSelectedItems,planBatchMove,applyBatchMove,planBatchSplit,applyBatchSplit,duplicateSelectedItems} from '../public/js/batch-edits.js';
import {MonitorEditor} from '../public/js/monitor-editor.js';
import {isPcVoiceOrigin,pcVoiceStatus,saveVoiceReference,generatePcVoice,referenceFromPcm,decodeVoiceReference,recordVoiceReference} from '../public/js/pc-voice.js';
import {isPcAsrOrigin,pcAsrStatus,pcAsrWav,pcAsrCaptions,pcAsrDeviceLabel,transcribePcAudio} from '../public/js/pc-asr.js';

const require=createRequire(import.meta.url);
let canvasModule;
try {canvasModule=require(process.env.STUDIO_CANVAS_MODULE || '@napi-rs/canvas');} catch {}
const fakeMedia=()=>({src:'',currentTime:0,paused:true,readyState:2,addEventListener(){},pause(){this.paused=true;},play(){this.paused=false;return Promise.resolve();}});
globalThis.document={addEventListener(){},createElement(tag){return tag==='canvas'&&canvasModule?canvasModule.createCanvas(1,1):fakeMedia();}};
const defaults=structuredClone(project);
const reset=()=>{clearAssets();Object.assign(project,structuredClone(defaults));};
const clip=(id,duration,transition=0)=>({...newClipDefaults('image'),id,imgDuration:duration,transitionOut:{type:transition?'dissolve':'cut',duration:transition}});
const buffer=channels=>({numberOfChannels:channels.length,length:channels[0].length,sampleRate:48000,getChannelData:c=>Float32Array.from(channels[c])});

test('dissolve: 4s + 3s with 1s overlap is 6s; weights sum to one',()=>{
  reset();project.clips=[clip('a',4,1),clip('b',3)];
  const layout=buildLayout();assert.equal(layout.total,6);assert.equal(layout.entries[1].start,3);
  assert.deepEqual(layersAt(3.5).map(l=>l.weight),[.5,.5]);assert.equal(clipAt(3.5).clip.id,'b');
  assert.deepEqual(layersAt(6).map(l=>l.clip.id),['b']);
});

test('short clips never produce three active media or gain over one within a track',()=>{
  reset();project.clips=[clip('a',.4,2),clip('b',.2,2),clip('c',.4,2)];
  const layout=buildLayout();assert.equal(layout.entries[0].overlapOut,.1);assert.equal(layout.entries[1].overlapOut,.1);
  project.clips.push({...clip('upper',1),start:0,trackId:'v2'});
  for(let t=0;t<layout.total;t+=.001)for(const track of timelineTracks().filter(t=>t.kind==='visual')){const ls=layersAt(t).filter(l=>l.trackId===track.id);assert.ok(ls.length<=2);if(ls.length)near(ls.reduce((s,l)=>s+l.weight,0),1);}
});

test('legacy anchors detach without moving captions or graphics during video edits',()=>{
  reset();const a={...clip('a',4),type:'video',trimStart:10,trimEnd:14,srcDuration:18,start:0};const b={...clip('b',3),start:6};project.clips=[a,b];
  const cap={id:'cap',text:'caption',start:1,end:2,anchor:{clipId:'a',sourceStart:11,sourceEnd:12}};
  const graphic={id:'g',text:'graphic',start:.5,end:3,anchor:{clipId:'a',sourceStart:10.5,sourceEnd:13}};
  project.captions=[cap];project.overlays=[graphic];migrateTimeline();
  const before=captureDocument();
  placeVideoClip(a,planPlacement(12,4,'v1','a'));applyClipTrim(planClipTrim('a','start',13));deleteTimelineItem({type:'clip',id:'a'},true);
  assert.deepEqual(captureDocument().captions,before.captions);assert.deepEqual(captureDocument().overlays,before.overlays);
  assert.equal(cap.anchor,undefined);assert.equal(graphic.anchor,undefined);
});

test('fade gain is clamped to half-duration and remains finite',()=>{
  assert.equal(clipFadeGain({fadeIn:20,fadeOut:20},1,4),.5);
  assert.equal(clipFadeGain({fadeIn:20,fadeOut:20},2,4),1);
  assert.equal(clipFadeGain({fadeIn:20,fadeOut:20},3,4),.5);
});

test('undo/redo restores serializable edits while preserving image resources',async()=>{
  reset();const bitmap={marker:'shared-image'};
  assets.set('asset',{id:'asset',kind:'image',file:new File(['photo'],'photo.jpg',{type:'image/jpeg'}),base:{...clip('base',4),bitmap,natW:100,natH:100},duration:4});
  project.clips=[await makeClip('asset',{id:'instance'})];const h=new History(),before=captureDocument();
  project.clips[0].scale=1.7;assert.equal(h.push(before,'scale'),true);
  assert.equal(h.undo(),'scale');assert.equal(project.clips[0].scale,1);assert.equal(project.clips[0].bitmap,bitmap);
  assert.equal(h.redo(),'scale');assert.equal(project.clips[0].scale,1.7);
  assert.ok(!JSON.stringify(captureDocument()).includes('shared-image'));
  const bad={...captureDocument(),clips:[{...captureDocument().clips[0],id:'missing'}]};
  assert.throws(()=>restoreDocument(bad));assert.equal(project.clips[0].id,'instance');
});

test('portable project includes unplaced library assets and rejects truncation',async()=>{
  reset();const file=new File(['unused binary payload'],'unused.png',{type:'image/png'});
  assets.set('unused',{id:'unused',kind:'image',file});const packed=packProject();
  const head=await packed.slice(0,12).arrayBuffer();assert.equal(new TextDecoder().decode(head.slice(0,8)),'SSLAB01\n');
  const len=new DataView(head).getUint32(8,true),meta=JSON.parse(await packed.slice(12,12+len).text());
  assert.equal(meta.assets[0].name,'unused.png');assert.equal(await packed.slice(12+len).text(),'unused binary payload');
  await assert.rejects(()=>unpackProject(packed.slice(0,-1)),/손상/);
});

test('failed project decoding preserves prior assets, timeline, and undo resources',async()=>{
  reset();const bitmap={close(){}};const file=new File(['original'],'original.jpg',{type:'image/jpeg'});
  assets.set('original',{id:'original',kind:'image',file,base:{...clip('base',4),bitmap,natW:10,natH:10}});
  project.clips=[await makeClip('original',{id:'old-instance'})];const before=captureDocument();
  const badDoc=structuredClone(before);badDoc.clips[0].assetId='bad';
  const meta=new TextEncoder().encode(JSON.stringify({document:badDoc,assets:[{id:'bad',name:'broken.xyz',type:'application/octet-stream',size:3}]}));
  const n=new Uint8Array(4);new DataView(n.buffer).setUint32(0,meta.length,true);
  await assert.rejects(()=>unpackProject(new Blob(['SSLAB01\n',n,meta,'bad'])),/영상이나 이미지/);
  assert.deepEqual(captureDocument(),before);assert.equal(assets.size,1);assert.ok(assets.has('original'));assert.equal(project.clips[0].bitmap,bitmap);
});

test('portable image project round-trip replaces old assets and retains edits', {skip:!canvasModule},async()=>{
  reset();globalThis.createImageBitmap=async blob=>canvasModule.loadImage(Buffer.from(await blob.arrayBuffer()));
  const canvas=canvasModule.createCanvas(16,16),ctx=canvas.getContext('2d');ctx.fillStyle='#2244aa';ctx.fillRect(0,0,16,16);
  const photo=new File([canvas.toBuffer('image/png')],'roundtrip.png',{type:'image/png'});
  const a=await addAsset(photo,{id:'saved-image'});project.clips=[await makeClip(a.id,{id:'saved-clip',start:2,imgDuration:5,scale:1.2,ken:'in',fadeIn:1})];
  await splitTimelineItem({type:'clip',id:'saved-clip'},4);
  project.clips.push(await makeClip(a.id,{id:'after-gap',start:10,imgDuration:2}));
  project.captions=[{id:'saved-caption',text:'Round trip',start:1,end:2,trackId:'v2',transform:{rotation:12,offsetX:.1},crop:{left:.1}}];
  migrateTimeline();addTimelineTrack('visual');addTimelineTrack('audio');
  project.clips[0].transform={scaleX:.8,scaleY:1.1,opacity:.7,flipX:true};project.clips[0].crop={top:.12,bottom:.2};
  const expected=captureDocument(),packed=packProject();await addAsset(photo,{id:'unrelated-old-project'});
  project.clips[0].scale=2;
  await unpackProject(packed);assert.deepEqual(captureDocument(),expected);assert.deepEqual([...assets.keys()],['saved-image']);
  assert.equal(project.clips[0].bitmap.width,16);assert.equal(project.clips[0].bitmap.height,16);
});

test('project validation blocks injected identifiers, invalid trim, and duplicate records',()=>{
  reset();const doc=captureDocument();assert.doesNotThrow(()=>validateDocument(doc,[]));
  assert.throws(()=>validateDocument(doc,[{id:'" onmouseover="bad'}]));
  assert.throws(()=>validateDocument(doc,[{id:'same'},{id:'same'}]));
  doc.tracks=[{id:'audio',assetId:'sound',start:0,trimStart:3,trimEnd:1,lane:'music'}];assert.throws(()=>validateDocument(doc,[{id:'sound'}]));
});

test('PCM conversion and waveform include right-channel-only audio',async()=>{
  const b=buffer([[0,0,0,0],[1,-1,.5,0]]);const wav=await encodeWav(b).arrayBuffer();const view=new DataView(wav);
  assert.equal(view.getUint16(22,true),1);assert.equal(view.getUint32(24,true),48000);
  assert.equal(view.getInt16(44,true),16383);assert.equal(view.getInt16(46,true),-16384);
  const wave=waveformOf(b,4);assert.equal(wave[0],1);assert.equal(wave[3],0);
});

test('automatic captions use returned timestamps and split speech gaps',()=>{
  const caps=transcriptionCaptions({words:[{word:'hello',start:1.2,end:1.5},{word:'world.',start:1.6,end:2.1},{word:'next',start:3.4,end:3.9}]});
  assert.deepEqual(caps.map(c=>[c.start,c.end,c.text]),[[1.2,2.1,'hello world.'],[3.4,3.9,'next']]);
  assert.deepEqual(transcriptionCaptions({segments:[{text:'real segment',start:9,end:10}]}).map(c=>[c.start,c.end]),[[9,10]]);
});

test('sample audio is a real PCM WAV with the advertised duration',async()=>{
  const file=demoSound(2);const v=new DataView(await file.arrayBuffer());assert.equal(v.getUint32(24,true),24000);assert.equal(v.getUint32(40,true),2*24000*2);
});

test('decoder request survives cloned clip data during undo',async()=>{
  reset();const player=new Player({getContext:()=>({})});player.draw=()=>{};
  const calls=[],resolvers=[];const sink={getCanvas(t){calls.push(t);return new Promise(r=>resolvers.push(r));}};
  const c={sink};player._requestSinkFrame(c,1);const restored={...c};player._requestSinkFrame(restored,2);
  resolvers.shift()({timestamp:1,canvas:{width:1,height:1}});await new Promise(r=>setImmediate(r));
  assert.deepEqual(calls,[1,2]);resolvers.shift()({timestamp:2,canvas:{width:1,height:1}});await new Promise(r=>setImmediate(r));
  assert.equal(player._sinkState(restored).pending,false);assert.equal(player._sinkState(restored).frame.t,2);
});

test('independent audio starts at its offset, honors trim and fades, and stops after end',()=>{
  reset();const el=fakeMedia();project.clips=[clip('a',10)];
  project.audio.tracks=[{id:'sound',el,start:2,trimStart:1,trimEnd:5,volume:.8,fadeIn:1,fadeOut:1,muted:false}];
  const player=new Player({getContext:()=>({})});player.playing=true;player.time=1;player._syncTracks();assert.equal(el.paused,true);
  player.time=2.5;player._syncTracks();assert.equal(el.currentTime,1.5);assert.equal(el.volume,.4);assert.equal(el.paused,false);
  player.time=6;player._syncTracks();assert.equal(el.paused,true);
});

test('shared renderer produces an opaque red/blue midpoint and real fade/flash', {skip:!canvasModule},()=>{
  reset();project.clips=[clip('red',4,1),clip('blue',3)];
  const {createCanvas}=canvasModule,out=createCanvas(90,160),ctx=out.getContext('2d');
  const solid=color=>{const c=createCanvas(90,160),g=c.getContext('2d');g.fillStyle=color;g.fillRect(0,0,90,160);return c;};
  const sources={red:solid('#ff0000'),blue:solid('#0000ff')};const opts={source:c=>({img:sources[c.id],w:90,h:160})};
  renderFrame(ctx,3.5,opts);const pixel=ctx.getImageData(45,80,1,1).data;
  assert.ok(Math.abs(pixel[0]-128)<=1);assert.equal(pixel[1],0);assert.ok(Math.abs(pixel[2]-128)<=1);assert.equal(pixel[3],255);
  project.clips[0].transitionOut.type='fade';renderFrame(ctx,3.5,opts);assert.deepEqual([...ctx.getImageData(45,80,1,1).data],[0,0,0,255]);
  project.clips[0].transitionOut.type='flash';renderFrame(ctx,3.5,opts);assert.deepEqual([...ctx.getImageData(45,80,1,1).data],[255,255,255,255]);
});

test('all graphics and caption presets render with the shared canvas path', {skip:!canvasModule},()=>{
  reset();project.clips=[clip('image',4)];const {createCanvas}=canvasModule,canvas=createCanvas(180,320),ctx=canvas.getContext('2d');
  renderFrame(ctx,1);const empty=Buffer.from(ctx.getImageData(0,0,180,320).data);
  for(const preset of GRAPHICS){
    project.overlays=[{...preset,graphic:preset.id,id:'graphic',start:0,end:3}];
    renderFrame(ctx,1);assert.notDeepEqual(Buffer.from(ctx.getImageData(0,0,180,320).data),empty,preset.id);
  }
  project.overlays=[];
  for(const preset of CAPTIONS){
    project.captions=[{id:'caption',text:'Caption test',start:0,end:3,style:preset.style}];
    renderFrame(ctx,1);assert.notDeepEqual(Buffer.from(ctx.getImageData(0,0,180,320).data),empty,preset.id);
  }
});


// 시간표 편집 회귀: 원본 미디어 대신 작은 메모리 자원을 사용합니다.
async function fixtureClip(id,duration=4,type='image',overrides={}){
  const assetId='asset-'+id,base={...clip('base-'+id,duration),type,trimEnd:type==='video'?duration:0,srcDuration:type==='video'?duration:0,natW:90,natH:160,bitmap:type==='image'?{close(){}}:null};
  assets.set(assetId,{id:assetId,kind:type,file:new File(['fixture'],id+(type==='image'?'.png':'.mp4'),{type:type==='image'?'image/png':'video/mp4'}),duration:type==='image'?3:duration,base});
  return makeClip(assetId,{id,...overrides});
}
function fixtureAudio(id,duration=6,overrides={}){
  const assetId='asset-'+id,pcm={...buffer([[0,0],[0,0]]),duration};
  assets.set(assetId,{id:assetId,kind:'audio',file:new File(['audio'],id+'.wav',{type:'audio/wav'}),buffer:pcm,url:'blob:fixture',duration});
  return makeAudio(assetId,{id,...overrides});
}
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-7,actual+' != '+expected);
function assertValidLayout(){
  const entries=buildLayout().entries;
  for(const track of timelineTracks()){
    const row=entries.filter(e=>e.trackId===track.id);
    for(let i=0;i<row.length;i++){
      const e=row[i];assert.ok(Number.isFinite(e.start)&&e.start>=0);assert.ok(e.duration>=1/project.fps-1e-7);
      if(row[i+1]&&e.end>row[i+1].start+1e-6)assert.ok(e.overlapOut>0&&e.nextId===row[i+1].id);
    }
  }
}

test('explicit video gaps remain black and sequence duration includes every track',()=>{
  reset();project.clips=[{...clip('later',2),start:7},{...clip('earlier',3),start:1}];
  project.overlays=[{id:'g',text:'tail',start:10,end:12}];
  project.captions=[{id:'c',text:'later caption',start:14,end:15}];
  project.audio.tracks=[{id:'a',start:16,trimStart:1,trimEnd:5}];
  const layout=buildLayout();assert.deepEqual(layout.entries.map(e=>[e.clip.id,e.start]),[['earlier',1],['later',7]]);
  assert.equal(clipStartTime(0),7);assert.equal(clipStartTime(1),1);assert.equal(layout.total,20);assert.equal(layout.videoEnd,9);
  for(const t of [0,4,5,6.9,10,19,20,21])assert.deepEqual(layersAt(t),[],String(t));
  assert.equal(layersAt(7.5)[0].clip.id,'later');
});

test('manual caption and graphic movement detaches anchors without clipping at video boundaries',()=>{
  reset();project.clips=[clip('a',4)];
  for(const list of [project.captions,project.overlays]){
    const item={id:list===project.captions?'c':'g',text:'independent',start:1,end:3};list.push(item);anchorItem(item,'a');
    setItemRange(item,8,10);syncAnchoredItems();assert.deepEqual([item.start,item.end,item.anchor],[8,10,undefined]);
    project.clips[0].imgDuration=1;syncAnchoredItems();assert.deepEqual([item.start,item.end],[8,10]);
  }
  assert.equal(totalDuration(),10);
});

test('save/undo preserves explicit starts and migrates old contiguous projects to version 4',async()=>{
  reset();project.clips=[await fixtureClip('a'),await fixtureClip('b',3)];
  project.clips[0].transitionOut={type:'dissolve',duration:1};
  const legacy=captureDocument();legacy.version=1;delete legacy.timelineTracks;for(const c of legacy.clips){delete c.start;delete c.trackId;delete c.transitionOut.toId;}
  restoreDocument(legacy);
  const before=captureDocument();assert.equal(before.version,4);assert.deepEqual(before.clips.map(c=>c.start),[0,3]);assert.equal(before.clips[0].transitionOut.toId,'b');
  assert.equal(new History().push(before,'no change'),false);
  const history=new History();placeVideoClip(project.clips[1],planVideoPlacement(9,3,'b'));history.push(before,'move');
  assert.deepEqual(captureDocument().clips.map(c=>c.start),[0,9]);history.undo();assert.deepEqual(captureDocument(),before);
  history.redo();assert.deepEqual(captureDocument().clips.map(c=>c.start),[0,9]);
});

test('S splits only the selected video while caption, graphic and audio timing stays intact',async()=>{
  reset();project.clips=[await fixtureClip('video',6,'video',{start:2})];
  project.captions=[{id:'caption',text:'whole caption',start:2,end:8}];project.overlays=[{id:'graphic',text:'whole graphic',start:2,end:8}];
  project.audio.tracks=[fixtureAudio('music',10,{start:0})];
  const before=captureDocument(),history=new History();
  const result=await splitTimelineItem({type:'clip',id:'video'},4);syncAnchoredItems();
  const after=captureDocument();assert.equal(result.type,'clip');assert.deepEqual(after.clips.map(c=>[c.start,c.trimStart,c.trimEnd]),[[2,0,2],[4,2,6]]);
  assert.deepEqual(after.captions,before.captions);assert.deepEqual(after.overlays,before.overlays);assert.deepEqual(after.tracks,before.tracks);
  assertValidLayout();history.push(before,'split');history.undo();assert.deepEqual(captureDocument(),before);history.redo();assert.deepEqual(captureDocument(),after);
});

test('S targets caption, graphic and audio independently and never falls back to a video',async()=>{
  for(const type of ['caption','graphic','audio']){
    reset();project.clips=[await fixtureClip('video',8)];
    project.captions=[{id:'caption',text:'caption',start:2,end:6}];project.overlays=[{id:'graphic',text:'graphic',start:2,end:6}];
    project.audio.tracks=[fixtureAudio('audio',8,{start:2,trimStart:1,trimEnd:5,fadeIn:0,fadeOut:0})];
    const before=captureDocument();const result=await splitTimelineItem({type,id:type},4);
    const after=captureDocument();assert.equal(result.type,type);assert.deepEqual(after.clips,before.clips);
    if(type!=='caption')assert.deepEqual(after.captions,before.captions);
    if(type!=='graphic')assert.deepEqual(after.overlays,before.overlays);
    if(type!=='audio')assert.deepEqual(after.tracks,before.tracks);
    const ranges=(type==='caption'?after.captions:type==='graphic'?after.overlays:after.tracks).map(item=>[item.start,type==='audio'?item.start+item.trimEnd-item.trimStart:item.end]);
    assert.deepEqual(ranges,[[2,4],[4,6]]);
    if(type==='audio')assert.deepEqual(after.tracks.map(t=>[t.trimStart,t.trimEnd]),[[1,3],[3,5]]);
  }
  const before=captureDocument();
  for(const selection of [null,{type:'asset',id:'asset-video'},{type:'transition',id:'video'},{type:'caption',id:'missing'}])assert.equal(splitAvailability(selection,3).ok,false);
  assert.equal(splitAvailability({type:'clip',id:'video'},NaN).ok,false);
  await assert.rejects(()=>splitTimelineItem({type:'clip',id:'video'},20));
  assert.deepEqual(captureDocument(),before);
});

test('one-frame image and video splits keep their true length at 24/30/60 fps',async()=>{
  for(const fps of [24,30,60])for(const type of ['image','video']){
    reset();project.fps=fps;project.clips=[await fixtureClip('tiny',1,type,{start:0})];
    await splitTimelineItem({type:'clip',id:'tiny'},1/fps);
    const entries=buildLayout().entries;near(entries[0].duration,1/fps);near(entries[1].start,1/fps);near(entries[1].end,1);assertValidLayout();
    assert.doesNotThrow(()=>validateDocument(captureDocument(),[...assets.keys()].map(id=>({id}))));
  }
});

test('splitting retains image motion and video/audio fade envelopes including undo',async()=>{
  reset();project.clips=[await fixtureClip('image',4,'image',{start:0,ken:'in',fadeIn:2,fadeOut:1})];
  project.audio.tracks=[fixtureAudio('audio',4,{start:0,fadeIn:2,fadeOut:1})];
  const before=captureDocument(),original=project.clips[0],samples=[.25,.75,1.5,2.5,3.75].map(t=>clipFadeGain(original,t,4));
  await splitTimelineItem({type:'clip',id:'image'},1);await splitTimelineItem({type:'audio',id:'audio'},1);
  for(const [i,t] of [.25,.75,1.5,2.5,3.75].entries()){
    const at=layersAt(t)[0];near(clipFadeGain(at.clip,at.local,at.duration),samples[i]);
    near(((at.clip.motionOffset||0)+at.local)/at.clip.motionDuration,t/4);
    const audio=project.audio.tracks.find(a=>t>=a.start&&t<a.start+a.trimEnd-a.trimStart);near(clipFadeGain(audio,t-audio.start,audio.trimEnd-audio.trimStart),samples[i]);
  }
  const after=captureDocument(),history=new History();history.push(before,'split');history.undo();assert.deepEqual(captureDocument(),before);history.redo();assert.deepEqual(captureDocument(),after);
  const right=project.clips[1];applyClipTrim(planClipTrim(right.id,'start',2));assert.equal(right.motionOffset,2);assert.equal(right.fadeEnvelope.offset,2);
  assert.doesNotThrow(()=>validateDocument(captureDocument(),[...assets.keys()].map(id=>({id}))));
});

test('offline fade scheduling matches the split preview envelope',()=>{
  const events=[],param={setValueAtTime:(value,time)=>events.push([value,time]),linearRampToValueAtTime:(value,time)=>events.push([value,time])};
  const envelope={offset:1,duration:4,fadeIn:2,fadeOut:1};applyFade(param,.8,5,3,0,1,envelope);
  assert.deepEqual(events,[[.4,5],[.8,6],[.8,7],[0,8]]);
});

test('video placement preserves empty space and inserts at occupied boundaries without overwriting',()=>{
  reset();project.clips=[{...clip('a',3),start:0},{...clip('b',3),start:3},{...clip('c',3),start:6}];pinClipPositions();
  const move=planVideoPlacement(12,3,'c');assert.deepEqual([move.start,move.end,move.shifts.length],[12,15,0]);
  placeVideoClip(project.clips[2],move);assert.deepEqual(buildLayout().entries.map(e=>e.start),[0,3,12]);
  const inGap=planVideoPlacement(7,3);placeVideoClip(clip('gap',3),inGap);assert.deepEqual([inGap.start,inGap.end,inGap.shifts.length],[7,10,0]);
  const inserted=planVideoPlacement(4,2);assert.equal(inserted.start,3);assert.equal(inserted.shift,2);
  const result=placeVideoClip(clip('new',2),inserted);assert.deepEqual([result.start,result.end],[inserted.start,inserted.end]);assert.equal(result.shifted,3);
  assertValidLayout();assert.deepEqual(buildLayout().entries.map(e=>[e.clip.id,e.start]),[['a',0],['new',3],['b',5],['gap',9],['c',14]]);
});

test('inserting inside a dissolve removes only that connection and keeps original clip lengths',()=>{
  reset();project.clips=[clip('a',4,1),clip('b',4,.5),clip('c',4)];pinClipPositions();
  const before=buildLayout().entries.map(e=>e.duration),plan=planVideoPlacement(3.5,3);
  const placed=placeVideoClip(clip('inserted',3),plan);assert.deepEqual([placed.start,placed.end],[4,7]);
  const entries=buildLayout().entries;assert.deepEqual(entries.filter(e=>e.clip.id!=='inserted').map(e=>e.duration),before);
  assert.equal(entries[0].overlapOut,0);assert.equal(entries.find(e=>e.clip.id==='b').overlapOut,.5);assertValidLayout();
});

test('transitions belong to adjacent pairs and update the right side only, including explicit zero',()=>{
  reset();project.clips=[{...clip('a',4),start:0},{...clip('b',4),start:4},{...clip('c',2),start:10}];
  project.captions=[{id:'c1',text:'independent',start:3,end:12}];
  assert.deepEqual(transitionPairs().map(p=>[p.left.clip.id,p.right.clip.id]),[['a','b']]);
  const pair=setTransition('a','b','dissolve',1);assert.deepEqual([pair.start,pair.end,pair.center],[3,4,3.5]);
  assert.deepEqual(project.clips.map(c=>c.start),[0,3,9]);assert.deepEqual(project.captions[0],{id:'c1',text:'independent',start:3,end:12,trackId:'v3'});
  assert.throws(()=>setTransition('b','c','dissolve',.5),/맞닿은/);
  setTransition('a','b','flash',.5);assert.deepEqual(project.clips.map(c=>c.start),[0,3.5,9.5]);
  setTransition('a','b','dissolve',0);assert.equal(transitionPairs()[0].type,'cut');assert.deepEqual(project.clips.map(c=>c.start),[0,4,10]);
});

test('Delete leaves a gap; ripple delete closes time on just the selected numbered track',()=>{
  for(const ripple of [false,true]){
    reset();project.clips=[{...clip('a',3),start:0},{...clip('b',3),start:3},{...clip('c',3),start:6}];
    project.captions=[{id:'cap',text:'keep',start:4,end:8}];project.audio.tracks=[{id:'audio',lane:'music',start:1,trimStart:0,trimEnd:8}];
    migrateTimeline();const others=JSON.stringify([project.captions,project.audio.tracks]);deleteTimelineItem({type:'clip',id:'b'},ripple);
    assert.deepEqual(buildLayout().entries.map(e=>e.start),[0,ripple?3:6]);assert.equal(JSON.stringify([project.captions,project.audio.tracks]),others);assertValidLayout();
  }
  reset();project.audio.tracks=[{id:'a',lane:'music',start:0,trimStart:1,trimEnd:3},{id:'b',lane:'music',start:4,trimStart:0,trimEnd:2},{id:'voice',lane:'voice',start:4,trimStart:0,trimEnd:2}];
  deleteTimelineItem({type:'audio',id:'a'},true);assert.deepEqual(project.audio.tracks.map(t=>[t.id,t.start]),[['b',2],['voice',4]]);
  project.captions=[{id:'cap1',text:'one',start:0,end:2},{id:'cap2',text:'two',start:3,end:4}];
  deleteTimelineItem({type:'caption',id:'cap1'},true);assert.deepEqual([project.captions[0].start,project.captions[0].end],[1,2]);
});

test('deleting a video between two dissolves keeps a valid gap or closes the effective span',()=>{
  for(const ripple of [false,true]){
    reset();project.clips=[clip('a',4,1),clip('b',4,1),clip('c',4)];pinClipPositions();
    project.overlays=[{id:'g',text:'keep',start:4,end:7}];
    deleteTimelineItem({type:'clip',id:'b'},ripple);
    assert.deepEqual(buildLayout().entries.map(e=>e.start),[0,ripple?4:6]);assertValidLayout();
    assert.deepEqual(project.overlays[0],{id:'g',text:'keep',start:4,end:7,trackId:'v2'});
  }
});

test('trimming fixes the opposite edge, honors media bounds, and leaves neighbors unmoved',()=>{
  reset();project.clips=[{...clip('video',4),type:'video',start:5,trimStart:2,trimEnd:6,srcDuration:10},{...clip('next',3),start:11}];
  const left=planClipTrim('video','start',6);applyClipTrim(left);
  assert.deepEqual([project.clips[0].start,project.clips[0].trimStart,project.clips[0].trimEnd],[6,3,6]);
  assert.equal(buildLayout().entries[0].end,9);assert.equal(project.clips[1].start,11);
  const right=planClipTrim('video','end',20);applyClipTrim(right);
  assert.equal(buildLayout().entries[0].end,11);assert.equal(project.clips[0].trimEnd,8);assertValidLayout();
  const extendLeft=planClipTrim('video','start',0);applyClipTrim(extendLeft);assert.equal(project.clips[0].start,3);assert.equal(project.clips[0].trimStart,0);
});

test('drag metadata keeps the compatible destination track and exact full-duration ghost',async()=>{
  reset();project.clips=[await fixtureClip('a',4,'image',{start:0}),await fixtureClip('b',4,'image',{start:4})];
  await fixtureClip('source-video',7.25,'video');await fixtureClip('source-image',9);fixtureAudio('sfx',.65);
  const timeline=Object.create(Timeline.prototype);Object.assign(timeline,{zoom:100,time:0,snapping:false,callbacks:{graphic:id=>GRAPHICS.find(g=>g.id===id),sound:id=>SOUND_EFFECTS.find(s=>s.id===id)},canvas:{getBoundingClientRect:()=>({left:0})}});
  timeline.external={kind:'asset',id:'asset-source-image'};const imagePlan=timeline.externalPlan(900,'v1');assert.deepEqual([imagePlan.start,imagePlan.end],[9,12]);
  timeline.external={kind:'asset',id:'asset-source-video'};assert.equal(timeline.externalPlan(400,'a1'),null);
  const videoPlan=timeline.externalPlan(400,'v2');assert.equal(videoPlan.trackId,'v2');near(videoPlan.end-videoPlan.start,7.25);
  const inserted=await makeClip('asset-source-video');const actual=placeVideoClip(inserted,videoPlan.placement);
  assert.deepEqual([actual.trackId,actual.start,actual.end],[videoPlan.trackId,videoPlan.start,videoPlan.end]);assert.deepEqual(project.clips.slice(0,2).map(c=>c.start),[0,4]);
  timeline.external={kind:'preset',id:'g:burst'};const graphic=timeline.externalPlan(1800,'v3');near(graphic.end,19);assert.equal(timeline.externalPlan(1800,'a2'),null);
  timeline.external={kind:'preset',id:'c:pill'};assert.equal(timeline.externalPlan(1800,'v1').lane,'v1');
  timeline.external={kind:'preset',id:'sfx:whoosh'};const sound=timeline.externalPlan(1800,'a2');near(sound.end,18.65);assert.equal(timeline.externalPlan(1800,'v1'),null);
  timeline.external={kind:'preset',id:'t:dissolve'};assert.equal(timeline.externalPlan(1800,'v1'),null);
  assertValidLayout();
});

test('preview can seek beyond the last video and stops video audio in gaps',()=>{
  reset();const video={...clip('video',2),type:'video',start:2,trimStart:0,trimEnd:2,srcDuration:2,el:fakeMedia(),volume:1};
  project.clips=[video];project.captions=[{id:'tail',text:'end',start:6,end:8}];
  const player=new Player({getContext:()=>({})});player.draw=()=>{};player.playing=true;player.time=2.5;player._syncVideos(false);assert.equal(video.el.paused,false);
  player.time=4.5;player._syncVideos(false);assert.equal(video.el.paused,true);player.pause();player.seek(12,{allowBeyond:true});assert.equal(player.time,12);
  player.step(1);near(player.time,12+1/30);assert.equal(player.duration,8);
});

test('offline mixer schedules audio after video end and allocates the full sequence',async()=>{
  reset();project.clips=[clip('image',2)];project.audio.tracks=[fixtureAudio('tail',5,{start:7,fadeIn:0,fadeOut:0})];
  const previous=globalThis.OfflineAudioContext,starts=[];let length;
  globalThis.OfflineAudioContext=class{
    constructor(_channels,n){length=n;this.destination={};}
    createGain(){return {gain:{value:1,setValueAtTime(){},linearRampToValueAtTime(){}},connect(target){return target;}};}
    createBufferSource(){return {connect(target){return target;},start(...args){starts.push(args);}};}
    startRendering(){return Promise.resolve({length});}
  };
  try{await mixTimeline();assert.equal(length,12*48000);assert.deepEqual(starts,[[7,0,5]]);}finally{globalThis.OfflineAudioContext=previous;}
});

test('shared renderer leaves video gaps black and renders captions beyond the video', {skip:!canvasModule},()=>{
  reset();const {createCanvas}=canvasModule,out=createCanvas(180,320),ctx=out.getContext('2d'),source=createCanvas(180,320),g=source.getContext('2d');
  g.fillStyle='#ff0000';g.fillRect(0,0,180,320);project.clips=[{...clip('image',2),start:0}];
  project.captions=[{id:'caption',text:'AFTER VIDEO',start:4,end:7,style:CAPTIONS[0].style}];
  const opts={source:()=>({img:source,w:180,h:320})};renderFrame(ctx,3,opts);const black=Buffer.from(ctx.getImageData(0,0,180,320).data);
  assert.deepEqual([...ctx.getImageData(90,160,1,1).data],[0,0,0,255]);renderFrame(ctx,5,opts);assert.notDeepEqual(Buffer.from(ctx.getImageData(0,0,180,320).data),black);
});

test('project validation rejects unapproved overlaps and malformed timing metadata',async()=>{
  reset();project.clips=[await fixtureClip('a',3,'image',{start:0}),await fixtureClip('b',3,'image',{start:2})];
  const records=[...assets.keys()].map(id=>({id}));assert.throws(()=>validateDocument(captureDocument(),records),/겹쳐/);
  project.clips[1].start=3;const valid=captureDocument();assert.doesNotThrow(()=>validateDocument(valid,records));
  for(const change of [{start:NaN},{motionOffset:-2},{fadeEnvelope:{offset:0,duration:4,fadeIn:NaN,fadeOut:0}}]){
    const doc=structuredClone(valid);Object.assign(doc.clips[0],change);assert.throws(()=>validateDocument(doc,records));
  }
});

test('deterministic mixed edits never create an unapproved video overlap',()=>{
  reset();let seed=504;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
  project.clips=[{...clip('initial',4),start:0}];
  for(let i=0;i<800;i++){
    const list=buildLayout().entries,selected=list[Math.floor(random()*list.length)],operation=Math.floor(random()*6);
    if(!selected||operation===0){const duration=1+random()*5;placeVideoClip(clip('added-'+i,duration),planVideoPlacement(frameTime(random()*30),duration));}
    else if(operation===1)placeVideoClip(selected.clip,planVideoPlacement(frameTime(random()*30),selected.duration,selected.clip.id));
    else if(operation===2)applyClipTrim(planClipTrim(selected.clip.id,'end',frameTime(selected.end+(random()-.5)*2)));
    else if(operation===3&&list.length>2)deleteTimelineItem({type:'clip',id:selected.clip.id},random()>.5);
    else{const pairs=transitionPairs();if(pairs.length){const pair=pairs[Math.floor(random()*pairs.length)];setTransition(pair.left.clip.id,pair.right.clip.id,random()>.5?'dissolve':'cut',random());}}
    assertValidLayout();
  }
});

test('named role tracks expand without coupling clip kind or narration role',()=>{
  reset();project.clips=[{...clip('media',3),start:0}];
  project.overlays=[{id:'g',text:'G',start:1,end:2}];project.captions=[{id:'c',text:'C',start:1,end:2}];
  project.audio.tracks=[fixtureAudio('voice',4,{lane:'voice'}),fixtureAudio('music',4)];
  migrateTimeline();
  assert.deepEqual([project.clips[0].trackId,project.overlays[0].trackId,project.captions[0].trackId],['v1','v2','v3']);
  assert.deepEqual(project.audio.tracks.map(t=>[t.trackId,t.role]),[['a2','voice'],['a1','music']]);
  const visual=addTimelineTrack('visual'),audio=addTimelineTrack('audio');
  assert.equal(trackLabel(visual.id),'영상 2');assert.equal(trackLabel(audio.id),'오디오 2');
  assert.throws(()=>removeTimelineTrack('v1'),/빈 트랙/);assert.equal(removeTimelineTrack(visual.id),true);
  assert.equal(project.clips[0].trackId,'v1');
});

test('mixed visual insertion and cross-track movement shift only destination-track items',()=>{
  reset();project.clips=[{...clip('a',4),start:0,trackId:'v1'},{...clip('b',3),start:4,trackId:'v1'}];
  project.captions=[{id:'c',text:'same track',start:8,end:9,trackId:'v1'},{id:'other',text:'other track',start:8,end:9,trackId:'v3'}];
  const graphic={id:'g',text:'insert',start:0,end:2,trackId:'v2'};
  const plan=planPlacement(2,2,'v1');assert.equal(plan.start,4);
  assert.deepEqual(plan.shifts.map(s=>[s.type,s.id,s.start]),[['clip','b',6],['caption','c',10]]);
  placeTimelineItem('graphic',graphic,plan);
  assert.deepEqual([graphic.trackId,graphic.start,graphic.end],['v1',4,6]);
  assert.deepEqual(project.captions.map(c=>c.start),[10,8]);
  const before=captureDocument();placeTimelineItem('graphic',graphic,planPlacement(1,2,'v2','g'));
  assert.deepEqual(captureDocument().clips,before.clips);assert.deepEqual(captureDocument().captions,before.captions);
  assert.deepEqual([graphic.trackId,graphic.start,graphic.end],['v2',1,3]);assertValidLayout();
});

test('simultaneous transitions on separate tracks retain all four media instances',()=>{
  reset();project.clips=[
    {...clip('a',4,1),start:0,trackId:'v1'},{...clip('b',4),start:3,trackId:'v1'},
    {...clip('c',4,1),start:0,trackId:'v2'},{...clip('d',4),start:3,trackId:'v2'},
  ];
  migrateTimeline();assert.equal(transitionPairs().length,2);
  const active=layersAt(3.5);assert.equal(active.length,4);
  for(const id of ['v1','v2'])near(active.filter(e=>e.trackId===id).reduce((n,e)=>n+e.weight,0),1);
  setTransition('a','b','cut',0);assert.equal(project.clips.find(c=>c.id==='b').start,4);
  assert.equal(project.clips.find(c=>c.id==='d').start,3);assert.equal(transitionPairs().find(p=>p.trackId==='v2').duration,1);
  placeVideoClip(project.clips[0],planPlacement(10,4,'v3','a'));
  assert.equal(transitionPairs().find(p=>p.trackId==='v2').duration,1);assertValidLayout();
});

test('gap closure handles mixed content, leading gaps and stale selections without touching other tracks',()=>{
  reset();project.clips=[{...clip('v',2),start:0,trackId:'v1'},{...clip('other',2),start:4,trackId:'v2'}];
  project.captions=[{id:'c',text:'caption',start:5,end:6,trackId:'v1'}];
  project.overlays=[{id:'g',text:'graphic',start:8,end:9,trackId:'v1'}];
  project.audio.tracks=[fixtureAudio('audio',3,{start:7,trackId:'a1'})];migrateTimeline();
  const gap=trackGaps('v1')[0];assert.deepEqual([gap.start,gap.end],[2,5]);
  const others=captureDocument().tracks;assert.equal(closeTimelineGap(gap),true);
  assert.deepEqual([project.captions[0].start,project.overlays[0].start],[2,5]);assert.equal(project.clips[1].start,4);
  assert.deepEqual(captureDocument().tracks,others);assert.equal(currentGap(gap),null);assert.equal(closeTimelineGap(gap),false);
  const leading=trackGaps('v2')[0];assert.deepEqual([leading.start,leading.end],[0,4]);closeTimelineGap(leading);
  assert.equal(project.clips[1].start,0);assert.equal(project.overlays[0].start,5);
  deleteTimelineItem(trackGaps('a1')[0]);assert.equal(project.audio.tracks[0].start,0);
});

test('gap detection uses occupied unions and exposes no unbounded trailing gap',()=>{
  reset();project.overlays=[{id:'a',text:'A',start:1,end:4,trackId:'v2'},{id:'b',text:'B',start:3,end:7,trackId:'v2'},{id:'c',text:'C',start:9,end:10,trackId:'v2'}];
  assert.deepEqual(trackGaps('v2').map(g=>[g.start,g.end]),[[0,1],[7,9]]);
  assert.deepEqual(trackGaps('v1'),[]);
});

test('ripple deletion shifts other visual kinds on the same track but leaves matching kinds elsewhere',()=>{
  reset();project.clips=[{...clip('v',2),start:0,trackId:'v1'}];
  project.captions=[{id:'c',text:'C',start:3,end:4,trackId:'v1'},{id:'other',text:'O',start:3,end:4,trackId:'v3'}];
  project.overlays=[{id:'g',text:'G',start:5,end:6,trackId:'v1'}];
  deleteTimelineItem({type:'clip',id:'v'},true);
  assert.deepEqual(project.captions.map(c=>c.start),[1,3]);assert.equal(project.overlays[0].start,3);
});

test('audio and text trim share neighbor limits and keep the opposite timeline edge fixed',()=>{
  reset();project.audio.tracks=[fixtureAudio('a',8,{start:2,trimStart:1,trimEnd:3,trackId:'a1'}),fixtureAudio('b',3,{start:5,trackId:'a1'})];
  applyItemTrim(planItemTrim('audio','a','end',10));
  assert.deepEqual([project.audio.tracks[0].start,project.audio.tracks[0].trimStart,project.audio.tracks[0].trimEnd],[2,1,4]);
  applyItemTrim(planItemTrim('audio','a','start',3));
  assert.deepEqual([project.audio.tracks[0].start,project.audio.tracks[0].trimStart,project.audio.tracks[0].trimEnd],[3,2,4]);
  near(itemRange('audio','a').end,5);assert.equal(project.audio.tracks[1].start,5);
  project.captions=[{id:'c',text:'C',start:0,end:2,trackId:'v1'}];project.overlays=[{id:'g',text:'G',start:3,end:5,trackId:'v1'}];
  applyItemTrim(planItemTrim('caption','c','end',8));assert.equal(project.captions[0].end,3);
});

test('v2 explicit timing and legacy anchors restore into v3 without a position jump',async()=>{
  reset();project.clips=[await fixtureClip('a',4,'image',{start:6})];
  project.captions=[{id:'c',text:'keep',start:7,end:9}];
  const legacy=captureDocument();legacy.version=2;delete legacy.timelineTracks;
  for(const item of [...legacy.clips,...legacy.captions])delete item.trackId;
  legacy.captions[0].anchor={clipId:'a',sourceStart:1,sourceEnd:3};
  restoreDocument(legacy);assert.deepEqual([project.clips[0].start,project.captions[0].start,project.captions[0].end],[6,7,9]);
  placeVideoClip(project.clips[0],planPlacement(0,4,'v2','a'));
  assert.deepEqual([project.captions[0].start,project.captions[0].end,project.captions[0].anchor],[7,9,undefined]);
  const saved=captureDocument();assert.equal(saved.version,4);assert.equal(saved.clips[0].trackId,'v2');
});

test('v3 validates track compatibility and finite transform/crop ranges while accepting cross-track overlap',async()=>{
  reset();project.clips=[await fixtureClip('a',3,'image',{start:0,trackId:'v1'}),await fixtureClip('b',3,'image',{start:0,trackId:'v2'})];
  const valid=captureDocument(),records=[...assets.keys()].map(id=>({id}));assert.doesNotThrow(()=>validateDocument(valid,records));
  for(const change of [{trackId:'missing'},{trackId:'a1'},{transform:{rotation:NaN}},{transform:{scaleX:0}},{crop:{left:.6,right:.6}}]){
    const doc=structuredClone(valid);Object.assign(doc.clips[0],change);assert.throws(()=>validateDocument(doc,records));
  }
  const duplicated=structuredClone(valid);duplicated.timelineTracks.push({...duplicated.timelineTracks[0]});assert.throws(()=>validateDocument(duplicated,records));
});

test('centering uses the visible crop and preserves rotation, flips and independent scales',()=>{
  const item={transform:{scaleX:1.3,scaleY:.7,rotation:37,flipX:true,offsetX:.4,offsetY:-.2},crop:{left:.3,top:.1,right:.05,bottom:.2}};
  const bounds={x:100,y:300,w:600,h:900},original={...item.transform};
  alignVisual(item,bounds,1080,1920,'x');alignVisual(item,bounds,1080,1920,'y');
  const corners=visualCorners(bounds,item,1080,1920);
  near(corners.reduce((n,p)=>n+p.x,0)/4,540);near(corners.reduce((n,p)=>n+p.y,0)/4,960);
  assert.equal(item.transform.rotation,original.rotation);assert.equal(item.transform.flipX,true);assert.equal(item.transform.scaleY,.7);
});

test('three visual tracks composite in stable order and preserve uncovered lower pixels',{skip:!canvasModule},()=>{
  reset();const {createCanvas}=canvasModule,W=90,H=160,out=createCanvas(W,H),ctx=out.getContext('2d');
  const sources={};for(const [id,color] of [['red','#ff0000'],['blue','#0000ff'],['green','#00ff00']]){
    const canvas=createCanvas(W,H),g=canvas.getContext('2d');g.fillStyle=color;g.fillRect(0,0,W,H);sources[id]=canvas;
  }
  project.clips=[
    {...clip('red',4),start:0,trackId:'v1',natW:W,natH:H},
    {...clip('blue',4),start:0,trackId:'v2',natW:W,natH:H,bg:'transparent',crop:{right:.5}},
    {...clip('green',4),start:0,trackId:'v3',natW:W,natH:H,bg:'transparent',crop:{right:.5,bottom:.5}},
  ];
  const opts={source:c=>({img:sources[c.id],w:W,h:H})};renderFrame(ctx,1,opts);
  assert.deepEqual([...ctx.getImageData(20,30,1,1).data],[0,255,0,255]);
  assert.deepEqual([...ctx.getImageData(20,120,1,1).data],[0,0,255,255]);
  assert.deepEqual([...ctx.getImageData(70,30,1,1).data],[255,0,0,255]);
  migrateTimeline();project.timelineTracks=[...project.timelineTracks.filter(t=>t.kind==='visual').reverse(),...project.timelineTracks.filter(t=>t.kind==='audio')];
  renderFrame(ctx,1,opts);assert.deepEqual([...ctx.getImageData(20,30,1,1).data],[255,0,0,255]);
});

test('transparent dissolve weights do not double-attenuate the lower track',{skip:!canvasModule},()=>{
  reset();const {createCanvas}=canvasModule,W=90,H=160,out=createCanvas(W,H),ctx=out.getContext('2d'),sources={};
  for(const [id,color] of [['base','#00ff00'],['a','#ff0000'],['b','#0000ff']]){
    const c=createCanvas(W,H),g=c.getContext('2d');g.fillStyle=color;g.fillRect(0,0,W,H);sources[id]=c;
  }
  project.clips=[
    {...clip('base',4),start:0,trackId:'v1',natW:W,natH:H},
    {...clip('a',2,.5),start:0,trackId:'v2',natW:W,natH:H,bg:'transparent',crop:{right:.5}},
    {...clip('b',2),start:1.5,trackId:'v2',natW:W,natH:H,bg:'transparent',crop:{left:.5}},
  ];
  renderFrame(ctx,1.75,{source:c=>({img:sources[c.id],w:W,h:H})});
  const left=[...ctx.getImageData(20,80,1,1).data],right=[...ctx.getImageData(70,80,1,1).data];
  assert.ok(Math.abs(left[0]-128)<=1&&Math.abs(left[1]-128)<=1);assert.equal(left[2],0);
  assert.ok(Math.abs(right[1]-128)<=1&&Math.abs(right[2]-128)<=1);assert.equal(right[0],0);
});

test('clip opacity applies once to the completed source and backdrop group',{skip:!canvasModule},()=>{
  reset();const {createCanvas}=canvasModule,W=90,H=160,out=createCanvas(W,H),ctx=out.getContext('2d');
  const base=createCanvas(W,H),top=createCanvas(90,90);base.getContext('2d').fillStyle='#ff0000';base.getContext('2d').fillRect(0,0,W,H);
  top.getContext('2d').fillStyle='#0000ff';top.getContext('2d').fillRect(0,0,90,90);
  project.clips=[{...clip('base',4),start:0,trackId:'v1',natW:W,natH:H},{...clip('top',4),start:0,trackId:'v2',fit:'contain',bg:'black',natW:90,natH:90,transform:{opacity:.5}}];
  renderFrame(ctx,1,{source:c=>({img:c.id==='base'?base:top,w:90,h:c.id==='base'?H:90})});
  const center=[...ctx.getImageData(45,80,1,1).data],bar=[...ctx.getImageData(45,5,1,1).data];
  assert.ok(Math.abs(center[0]-128)<=1&&Math.abs(center[2]-128)<=1);assert.equal(center[1],0);
  assert.ok(Math.abs(bar[0]-128)<=1);assert.deepEqual(bar.slice(1),[0,0,255]);
});

test('multiple captions render simultaneously and transform/crop leave time ranges unchanged',{skip:!canvasModule},()=>{
  reset();const {createCanvas}=canvasModule,canvas=createCanvas(270,480),ctx=canvas.getContext('2d');
  project.captions=[{id:'a',text:'UPPER',start:0,end:3,trackId:'v1',style:{...CAPTIONS[0].style,bottom:.7}},
    {id:'b',text:'LOWER',start:0,end:3,trackId:'v2',style:{...CAPTIONS[0].style,bottom:.2}}];
  renderFrame(ctx,1);const both=Buffer.from(ctx.getImageData(0,0,270,480).data);
  const top=project.captions.shift();renderFrame(ctx,1);const lower=Buffer.from(ctx.getImageData(0,0,270,480).data);assert.notDeepEqual(both,lower);
  project.captions=[top];renderFrame(ctx,1);assert.notDeepEqual(both,Buffer.from(ctx.getImageData(0,0,270,480).data));
  top.transform={rotation:25,scaleX:.8,scaleY:.8,flipX:true,opacity:.6};top.crop={left:.1};
  renderFrame(ctx,1);assert.deepEqual([top.start,top.end],[0,3]);assert.notDeepEqual(both,Buffer.from(ctx.getImageData(0,0,270,480).data));
});

test('rendered visual fade survives a split inside its envelope',{skip:!canvasModule},async()=>{
  reset();const {createCanvas}=canvasModule,W=90,H=160,bitmap=createCanvas(W,H),out=createCanvas(W,H),ctx=out.getContext('2d');
  bitmap.getContext('2d').fillStyle='#0000ff';bitmap.getContext('2d').fillRect(0,0,W,H);
  assets.set('image',{id:'image',kind:'image',file:new File(['fixture'],'image.png',{type:'image/png'}),duration:4,base:{...clip('base',4),bitmap,natW:W,natH:H}});
  project.clips=[await makeClip('image',{id:'split',start:0,fadeIn:1})];
  const opts={source:()=>({img:bitmap,w:W,h:H})};renderFrame(ctx,.75,opts);const before=[...ctx.getImageData(45,80,1,1).data];
  await splitTimelineItem({type:'clip',id:'split'},.5);renderFrame(ctx,.75,opts);assert.deepEqual([...ctx.getImageData(45,80,1,1).data],before);
});

test('voice transcription follows purpose after movement between numbered audio tracks',async()=>{
  reset();project.audio.tracks=[fixtureAudio('voice',2,{start:1,role:'voice',trackId:'a1',fadeIn:0,fadeOut:0}),fixtureAudio('music',3,{start:1,role:'music',trackId:'a2'})];
  placeTimelineItem('audio',project.audio.tracks[0],planPlacement(6,2,'a2','voice'));
  const previous=globalThis.OfflineAudioContext,starts=[];
  globalThis.OfflineAudioContext=class{
    constructor(){this.destination={};}
    createGain(){return {gain:{value:1,setValueAtTime(){},linearRampToValueAtTime(){}},connect(target){return target;}};}
    createBufferSource(){return {connect(target){return target;},start(...args){starts.push(args);}};}
    startRendering(){return Promise.resolve({});}
  };
  try{await mixTimeline({includeBgm:false,includeVoice:true});assert.deepEqual(starts,[[6,0,2]]);}
  finally{globalThis.OfflineAudioContext=previous;}
});

test('built-in sound effects are deterministic, distinct, bounded non-silent WAV files',async()=>{
  const signatures=new Set();
  for(const effect of SOUND_EFFECTS){
    const samples=synthesizeEffect(effect.id,8000),again=synthesizeEffect(effect.id,8000);
    assert.equal(samples.length,Math.round(effect.duration*8000));assert.deepEqual(samples,again);
    let peak=0,power=0;for(const value of samples){assert.ok(Number.isFinite(value));peak=Math.max(peak,Math.abs(value));power+=value*value;}
    assert.ok(peak>.7&&peak<.83);assert.ok(power>1);near(samples[0],0);
    signatures.add(Buffer.from(samples.buffer).toString('base64'));
    const wav=new DataView(await createSoundEffect(effect.id).arrayBuffer());assert.equal(wav.getUint32(24,true),48000);
    assert.equal(wav.getUint32(40,true),Math.round(effect.duration*48000)*2);
  }
  assert.equal(signatures.size,SOUND_EFFECTS.length);assert.throws(()=>synthesizeEffect('missing'));
});

test('platform guides form bounded editable rectangles and never affect default export frames',{skip:!canvasModule},()=>{
  reset();for(const preset of SAFE_AREAS){
    const r=safeAreaRect(preset,1080,1920);assert.ok(r.x>=0&&r.y>=0&&r.w>0&&r.h>0&&r.x+r.w<=1080&&r.y+r.h<=1920);
  }
  const cfg=safeAreaConfig('shorts');cfg.margins.top=.3;assert.equal(SAFE_AREAS[0].margins.top,.1);
  const {createCanvas}=canvasModule,canvas=createCanvas(90,160),ctx=canvas.getContext('2d');
  renderFrame(ctx,0);const exported=Buffer.from(ctx.getImageData(0,0,90,160).data);
  renderFrame(ctx,0,{safeArea:cfg});assert.notDeepEqual(Buffer.from(ctx.getImageData(0,0,90,160).data),exported);
  renderFrame(ctx,0);assert.deepEqual(Buffer.from(ctx.getImageData(0,0,90,160).data),exported);
});

test('font preparation loads actual generated text and weights without requesting the whole catalog',async()=>{
  reset();const previous=globalThis.document,requests=[],loads=[];
  globalThis.document={fonts:{load(descriptor,text){loads.push({descriptor,text});return Promise.resolve([{}]);}},
    createElement(){return {remove(){}};},head:{append(link){requests.push(link.href);queueMicrotask(()=>link.onload());}}};
  try{
    await loadFonts();assert.equal(requests.length,0);
    project.overlays=[
      {...GRAPHICS.find(g=>g.id==='chapter'),graphic:'chapter',start:0,end:2,subtitle:'MY PRIVATE CHAPTER'},
      {...GRAPHICS.find(g=>g.id==='count'),graphic:'count',start:0,end:2},
      {...GRAPHICS.find(g=>g.id==='typewriter'),graphic:'typewriter',start:0,end:2},
    ];
    project.template.mode='band';project.template.credit.on=true;project.template.credit.text='Credit';
    await loadFonts();
    assert.ok(loads.some(l=>l.text.includes('MY PRIVATE CHAPTER')));
    assert.ok(loads.some(l=>l.text.includes('0123456789')));assert.ok(loads.some(l=>l.text.includes('▌')));
    assert.ok(loads.some(l=>l.descriptor.startsWith('400 ')&&l.text.includes(project.template.comment.text)));
    assert.ok(loads.some(l=>l.descriptor.startsWith('700 ')&&l.text.includes('Credit')));
    assert.ok(requests.length<FONTS.length);assert.ok(requests.every(url=>!url.includes('PRIVATE')&&!url.includes('text=')));
  }finally{globalThis.document=previous;}
});

test('font binary failure and cancellation reject export preparation instead of silently falling back',async()=>{
  reset();const previous=globalThis.document;
  globalThis.document={fonts:{load(){return Promise.reject(new Error('font binary failed'));}},
    createElement(){return {remove(){}};},head:{append(link){queueMicrotask(()=>link.onload());}}};
  try{
    project.captions=[{id:'c',text:'caption',start:0,end:2,style:{font:'"Orbit"'}}];
    await assert.rejects(()=>loadFonts(),/font binary failed/);
    document.fonts.load=()=>new Promise(()=>{});
    const controller=new AbortController(),pending=loadFonts({signal:controller.signal});
    queueMicrotask(()=>controller.abort());await assert.rejects(()=>pending,error=>error.name==='AbortError');
  }finally{globalThis.document=previous;}
});

// 자동 편집은 브라우저 UI 대신 순수 PCM·프레임·편집 명령으로 검증합니다.
const pcmFixture=(channels,rate=16000)=>({numberOfChannels:channels.length,sampleRate:rate,length:channels[0].length,duration:channels[0].length/rate,getChannelData:i=>channels[i]});
const maskFixture=(overrides={})=>({id:'mask',enabled:true,mode:'static',rect:{x:.2,y:.2,w:.3,h:.3},strength:100,padding:.12,keyframes:[],...overrides});
const keyFixture=(time,overrides={})=>({x:.2,y:.2,w:.3,h:.3,time,duration:1/30,confidence:1,lost:false,...overrides});

test('silence candidates retain speech padding and examine every channel',()=>{
  const samples=new Float32Array(16000*4);samples.fill(.2,8000,24000);samples.fill(.2,40000,56000);
  const result=analyzeSilence(pcmFixture([new Float32Array(samples.length),samples]),{thresholdDb:-38,minSilence:.4,padding:.1,fps:30});
  assert.deepEqual(result.removed, [{start:0,end:.4},{start:1.6,end:2.4},{start:3.6,end:4}]);
  assert.equal(result.allSilent,false);near(result.removedDuration,1.6);
  assert.deepEqual(result.kept,[{start:.4,end:1.6},{start:2.4,end:3.6}]);
  const right=Float32Array.from({length:16000},(_,i)=>[0,.5,0,-.5][i%4]);
  assert.equal(analyzeSilence(pcmFixture([new Float32Array(16000),right])).removed.length,0);
  assert.deepEqual(monoPcm(pcmFixture([new Float32Array(16000),right])),right);
});

test('silence handles all-silent, all-loud, bounded duration and corrupt PCM safely',()=>{
  const quiet=analyzeSilence(pcmFixture([new Float32Array(16000)]));assert.equal(quiet.allSilent,true);assert.deepEqual(quiet.removed,[{start:0,end:1}]);
  const loud=new Float32Array(16000).fill(.1);assert.deepEqual(analyzeSilence(pcmFixture([loud])).removed,[]);
  const tail=new Float32Array(500);tail.fill(.2,405);
  const bounded=analyzeSilence(pcmFixture([tail],1000),{duration:.405,minSilence:.1,padding:0});
  assert.equal(bounded.peak,0);assert.equal(bounded.allSilent,true);assert.deepEqual(bounded.kept,[]);
  assert.throws(()=>analyzeSilence(null));assert.throws(()=>analyzeSilence(pcmFixture([loud]),{thresholdDb:NaN}));
  assert.throws(()=>analyzeSilence(pcmFixture([Float32Array.of(0,NaN)])),/손상/);
  assert.throws(()=>monoPcm(pcmFixture([loud]),0));assert.throws(()=>monoPcm(pcmFixture([Float32Array.of(NaN)])),/손상/);
});

test('PCM conversion preserves antiphase speech and alternating active channels',()=>{
  const left=new Float32Array(32000),right=new Float32Array(32000);left.fill(.25,0,16000);right.fill(.4,16000);
  const alternating=monoPcm(pcmFixture([left,right]));near(alternating[100],.25);assert.ok(alternating[20000]>.39);
  const anti=monoPcm(pcmFixture([new Float32Array(48000).fill(.25),new Float32Array(48000).fill(-.25)],48000));
  assert.equal(anti.length,16000);assert.ok(anti.every(x=>x===.25));
});

test('automatic cuts move only their track, retain source masks and round-trip undo',async()=>{
  reset();const selected=await fixtureClip('talk',20,'video',{start:2,trimStart:5,trimEnd:15,trackId:'v1',fadeIn:2,fadeOut:2,mosaics:[maskFixture()]});
  project.clips=[selected,await fixtureClip('other',4,'video',{start:3,trackId:'v2'})];
  project.overlays=[{id:'following',text:'same track',trackId:'v1',start:14,end:16}];
  project.captions=[{id:'independent',text:'stay here',trackId:'v2',start:4,end:5}];
  project.audio.tracks=[fixtureAudio('music',8,{start:2,trackId:'a1'})];
  const before=captureDocument(),plan=planSilenceCuts({type:'clip',id:'talk'},[{start:2,end:3},{start:6,end:9}]);
  assert.deepEqual(captureDocument(),before);
  const result=await applySilenceCuts(plan),parts=project.clips.filter(c=>c.trackId==='v1');
  assert.equal(result.count,3);assert.equal(result.removedDuration,4);
  assert.deepEqual(parts.map(c=>[c.start,c.trimStart,c.trimEnd]),[[2,5,7],[4,8,11],[7,14,15]]);
  assert.deepEqual(parts.map(c=>c.fadeEnvelope.offset),[0,3,9]);
  assert.notEqual(parts[0].mosaics,parts[1].mosaics);assert.deepEqual(parts[0].mosaics,parts[1].mosaics);
  assert.equal(project.overlays[0].start,10);assert.equal(project.overlays[0].end,12);
  const after=captureDocument();assert.deepEqual(after.clips.find(c=>c.id==='other'),before.clips.find(c=>c.id==='other'));
  assert.deepEqual(after.captions,before.captions);assert.deepEqual(after.tracks,before.tracks);
  validateDocument(after,[...assets.values()]);
  const history=new History();history.push(before,'cuts');history.undo();assert.deepEqual(captureDocument(),before);history.redo();assert.deepEqual(captureDocument(),after);
});

test('automatic audio cuts respect trim offset and leave the second audio track alone',async()=>{
  reset();project.audio.tracks=[fixtureAudio('speech',10,{start:3,trimStart:2,trimEnd:8,trackId:'a1'}),fixtureAudio('next',2,{start:10,trackId:'a1'}),fixtureAudio('other',4,{start:5,trackId:'a2'})];
  const before=captureDocument();await applySilenceCuts(planSilenceCuts({type:'audio',id:'speech'},[{start:1,end:3}]));
  assert.deepEqual(project.audio.tracks.filter(c=>c.trackId==='a1').map(c=>[c.start,c.trimStart,c.trimEnd]),[[3,2,3],[4,5,8],[8,0,2]]);
  assert.deepEqual(captureDocument().tracks.find(c=>c.id==='other'),before.tracks.find(c=>c.id==='other'));
});

test('automatic cuts reject transitions, overlaps, invalid intervals and collection overflow',async()=>{
  reset();project.clips=[await fixtureClip('video',4,'video'),await fixtureClip('next',4,'video',{start:4})];migrateTimeline();
  setTransition('video','next','dissolve',.5);assert.throws(()=>planSilenceCuts({type:'clip',id:'video'},[{start:1,end:2}]),/전환/);
  setTransition('video','next','cut',0);project.overlays=[{id:'overlap',text:'x',start:1,end:2,trackId:'v1'}];
  assert.throws(()=>planSilenceCuts({type:'clip',id:'video'},[{start:1,end:2}]),/겹친/);project.overlays=[];
  for(const cuts of [[{start:0,end:4}],[{start:1,end:5}],[{start:1,end:2},{start:1.5,end:3}],[]])assert.throws(()=>planSilenceCuts({type:'clip',id:'video'},cuts));
  reset();const first=fixtureAudio('speech',4,{start:0,trackId:'a1'});
  project.audio.tracks=[first,...Array.from({length:999},(_,i)=>makeAudio(first.assetId,{id:'extra-'+i,start:5+i,trimEnd:1,trackId:'a1'}))];
  const before=captureDocument();assert.throws(()=>planSilenceCuts({type:'audio',id:'speech'},[{start:1,end:2}]),/1,000/);assert.deepEqual(captureDocument(),before);
});

test('automatic cuts abort staging without changing a newer edit or leaking video elements',async()=>{
  reset();project.clips=[await fixtureClip('video',8,'video')];
  const plan=planSilenceCuts({type:'clip',id:'video'},[{start:1,end:2},{start:4,end:5}]),before=captureDocument();
  const originalDocument=globalThis.document,created=[],controller=new AbortController();
  globalThis.document={...originalDocument,createElement(){const el=fakeMedia();created.push(el);queueMicrotask(()=>controller.abort());return el;}};
  try{await assert.rejects(()=>applySilenceCuts(plan,{signal:controller.signal}),e=>e.name==='AbortError');assert.deepEqual(captureDocument(),before);assert.ok(created.every(el=>el.src===''));}
  finally{globalThis.document=originalDocument;}
  project.clips[0].volume=.4;const changed=captureDocument();await assert.rejects(()=>applySilenceCuts(plan),/바뀌/);assert.deepEqual(captureDocument(),changed);
});

test('tracking keys use actual frame coverage at 24fps, 15fps and VFR',()=>{
  for(const duration of [1/24,1/15,.27]){
    const effect=maskFixture({mode:'tracked',range:[0,1],keyframes:[keyFixture(0),keyFixture(1-duration,{duration})]});
    assert.equal(validMosaics([effect]),true);assert.deepEqual(unresolvedMosaics({trimStart:0,trimEnd:1,mosaics:[effect]}),[]);
    assert.equal(mosaicAt(effect,.9999).full,false);assert.equal(mosaicAt(effect,1.01).full,true);
  }
  const failed=maskFixture({mode:'tracked',range:[0,2],keyframes:[keyFixture(0),keyFixture(.1,{lost:true}),keyFixture(2)]});
  assert.equal(mosaicAt(failed,.05).full,true);assert.equal(unresolvedMosaics({trimStart:.02,trimEnd:.08,mosaics:[failed]}).length,1);
  assert.equal(mosaicAt(failed,NaN).full,true);assert.equal(mosaicAt({...failed,enabled:false},.1),null);
});

test('tracking repair cannot interpolate across two unverified paths or tiny shifted masks',()=>{
  const previous=[keyFixture(0),keyFixture(.1),keyFixture(.2,{lost:true}),keyFixture(1,{lost:true})];
  const next=[keyFixture(0,{lost:true}),keyFixture(.1,{lost:true}),keyFixture(.2),keyFixture(.3),keyFixture(1)];
  const merged=maskFixture({mode:'tracked',keyframes:mergeTrackingKeys(previous,next)});
  assert.equal(mosaicAt(merged,.05).full,false);assert.equal(mosaicAt(merged,.15).full,true);assert.equal(mosaicAt(merged,.5).full,false);
  const small=[0,.5,1].map(t=>keyFixture(t,{x:.1,w:.005})),shifted=[keyFixture(0,{x:.107,w:.005,lost:true}),keyFixture(.5,{x:.107,w:.005}),keyFixture(1,{x:.107,w:.005,lost:true})];
  const safe=maskFixture({mode:'tracked',keyframes:mergeTrackingKeys(small,shifted)});
  assert.equal(mosaicAt(safe,.25).full,true);assert.equal(mosaicAt(safe,.5).full,true);
});

test('mosaic validation rejects unsafe keys and version 4 persists independent masks',async()=>{
  reset();const effect=maskFixture({mode:'tracked',range:[0,4],keyframes:[keyFixture(0),keyFixture(4-1/30)]});
  project.clips=[await fixtureClip('video',4,'video',{mosaics:[effect]})];const before=captureDocument();assert.equal(before.version,4);
  validateDocument(before,[...assets.values()]);
  for(const bad of [maskFixture({strength:NaN}),maskFixture({padding:2}),{...effect,keyframes:[keyFixture(0,{duration:0})]},{...effect,keyframes:[keyFixture(1),keyFixture(0)]}])assert.equal(validMosaics([bad]),false);
  assert.equal(validMosaics([effect,effect]),false);
  await splitTimelineItem({type:'clip',id:'video'},2);assert.notEqual(project.clips[0].mosaics,project.clips[1].mosaics);
  assert.deepEqual(project.clips[0].mosaics,project.clips[1].mosaics);const after=captureDocument();
  const history=new History();history.push(before,'split masked clip');history.undo();assert.deepEqual(captureDocument(),before);history.redo();assert.deepEqual(captureDocument(),after);
  const cleared=captureDocument();delete cleared.clips[0].mosaics;restoreDocument(cleared);assert.equal(project.clips[0].mosaics,undefined);
  assert.equal(unresolvedMosaics({...project.clips[1],trimEnd:5}).length,1);
});

function texturedFrame(W,H,x,y,size=26,frequency=1){
  const gray=new Float32Array(W*H).fill(.08);
  for(let j=0;j<size;j++)for(let i=0;i<size;i++)gray[(y+j)*W+x+i]=.5+.2*Math.sin(i*.61*frequency)+.18*Math.cos(j*.83*frequency);
  return gray;
}
test('tracking follows textured translation but fails on occlusion and ambiguous jumps',()=>{
  const W=128,H=128,rect={x:28/W,y:32/H,w:26/W,h:26/H};
  for(const frequency of [1,2]){
    const template=trackingTemplate(texturedFrame(W,H,28,32,26,frequency),W,H,rect);let previous=rect;
    for(let i=1;i<=6;i++){const next=trackRectangle(texturedFrame(W,H,28+i*2,32+i,26,frequency),W,H,template,previous);assert.equal(next.lost,false);assert.ok(Math.abs(next.x*W-(28+i*2))<1);assert.ok(Math.abs(next.y*H-(32+i))<1);previous=next;}
    assert.equal(trackRectangle(new Float32Array(W*H).fill(.08),W,H,template,previous).lost,true);
  }
  assert.throws(()=>trackingTemplate(new Float32Array(W*H),W,H,rect),/특징/);
  const template=trackingTemplate(texturedFrame(W,H,28,32),W,H,rect);
  assert.equal(trackRectangle(texturedFrame(W,H,46,32),W,H,template,rect).lost,true);
});

test('mosaic replaces transparent details and fully covers unresolved sources',{skip:!canvasModule},()=>{
  const {createCanvas}=canvasModule,source=createCanvas(40,40),g=source.getContext('2d'),out=createCanvas(40,40),ctx=out.getContext('2d');
  for(let x=0;x<40;x++){g.fillStyle=x%2?'rgba(255,0,0,.5)':'rgba(0,0,255,.5)';g.fillRect(x,0,1,40);}
  const clip={mosaics:[maskFixture({rect:{x:0,y:0,w:1,h:1},padding:0})]};
  let redacted=redactSource(ctx,{img:source,w:40,h:40,sourceTime:0},clip,0);const r=redacted.img.getContext('2d');
  assert.deepEqual([...r.getImageData(5,5,1,1).data],[...r.getImageData(6,5,1,1).data]);assert.equal(r.getImageData(5,5,1,1).data[3],255);
  clip.mosaics=[maskFixture({mode:'tracked',range:[0,1],keyframes:[keyFixture(0,{lost:true})]})];
  redacted=redactSource(ctx,{img:source,w:40,h:40,sourceTime:.1},clip,.1);
  assert.deepEqual([...redacted.img.getContext('2d').getImageData(5,5,1,1).data],[21,21,21,255]);
});

test('shared renderer keeps a masked source unchanged through split and transformed blur backdrop',{skip:!canvasModule},async()=>{
  reset();const {createCanvas}=canvasModule,source=createCanvas(90,160),out=createCanvas(90,160),g=source.getContext('2d');
  for(let x=0;x<90;x++){g.fillStyle=x%2?'#f00':'#00f';g.fillRect(x,0,1,160);}
  const effect=maskFixture({mode:'tracked',range:[0,4],keyframes:[keyFixture(0),keyFixture(4-1/30)]});
  project.clips=[await fixtureClip('video',4,'video',{mosaics:[effect],fit:'contain',bg:'blur',transform:{scaleX:.8,rotation:10},crop:{left:.1}})];
  const provider=(clip,local)=>({img:source,w:90,h:160,sourceTime:clip.trimStart+local});
  renderFrame(out.getContext('2d'),2.5,{source:provider});const before=Buffer.from(out.getContext('2d').getImageData(0,0,90,160).data);
  await splitTimelineItem({type:'clip',id:'video'},2);renderFrame(out.getContext('2d'),2.5,{source:provider});
  assert.deepEqual(Buffer.from(out.getContext('2d').getImageData(0,0,90,160).data),before);
});

test('tracking preview holds pixels with their presentation timestamp',{skip:!canvasModule},async()=>{
  reset();const {createCanvas}=canvasModule,frame=createCanvas(30,30),player=new Player(createCanvas(30,30)),el={...fakeMedia(),videoWidth:30,videoHeight:30};
  const c={...clip('video',2),type:'video',el,mosaics:[maskFixture({mode:'tracked'})]};project.clips=[c];
  assert.equal(player.source(c,0).timeReliable,false);
  frame.getContext('2d').fillStyle='red';frame.getContext('2d').fillRect(0,0,30,30);player.rememberPresentedFrame(el,frame,.1);
  frame.getContext('2d').fillStyle='blue';frame.getContext('2d').fillRect(0,0,30,30);el.currentTime=.8;
  const src=player.source(c,.8);assert.equal(src.sourceTime,.1);assert.deepEqual([...src.img.getContext('2d').getImageData(0,0,1,1).data],[255,0,0,255]);
  let reads=0;const decoder={...c,id:'decoder',decoderOnly:true,trimStart:0,sink:{getCanvas:async()=>{reads++;return{timestamp:.1,duration:.3,canvas:frame};}}};
  project.clips=[decoder];player.draw=()=>{};assert.equal(player.source(decoder,.1),null);await new Promise(resolve=>setImmediate(resolve));
  frame.getContext('2d').fillStyle='red';frame.getContext('2d').fillRect(0,0,30,30);
  const held=player.source(decoder,.1);assert.equal(held.timeReliable,true);assert.equal(held.sourceTime,.1);assert.deepEqual([...held.img.getContext('2d').getImageData(0,0,1,1).data],[0,0,255,255]);
  player.source(decoder,.39);assert.equal(reads,1);
});

test('local speech chunks are bounded and do not break Unicode pairs',()=>{
  const chunks=chunkSpeechText('첫 번째 문장입니다. '+('한국어 원고 😀 '.repeat(20)),70);
  assert.ok(chunks.length>1&&chunks.every(c=>c.length<=70&&c.length>0));assert.ok(chunks.every(c=>!/[\uD800-\uDBFF]$/.test(c)&&! /^[\uDC00-\uDFFF]/.test(c)));
  assert.throws(()=>chunkSpeechText(''));assert.throws(()=>chunkSpeechText('가'.repeat(2001)));assert.throws(()=>chunkSpeechText('😀',1));
});

test('Whisper captions retain valid times, offset trimmed clips and never invent missing timestamps',()=>{
  const result=whisperCaptions({text:'안녕하세요. 다음 문장',chunks:[{text:' 안녕하세요.',timestamp:[.2,1.2]},{text:'다음',timestamp:[2,3]},{text:'문장',timestamp:[3,7]},{text:'bad',timestamp:[4,null]},{text:'bad',timestamp:[5,4]},{text:'outside',timestamp:[8,9]}]},5,10);
  assert.deepEqual(result.captions.map(c=>[c.start,c.end,c.text]),[[10.2,11.2,'안녕하세요.'],[12,15,'다음 문장']]);assert.equal(result.skipped,3);
  assert.ok(result.captions.every(c=>c.generated==='local-whisper'));assert.deepEqual(whisperCaptions({text:'missing times'},3).captions,[]);
  assert.throws(()=>whisperCaptions({},NaN));
});

test('AI workers terminate on success, cancellation, startup error and transfer error',async()=>{
  const old=globalThis.Worker,workers=[];
  globalThis.Worker=class{constructor(url,options){this.url=url;this.options=options;this.terminated=false;workers.push(this);}postMessage(payload,transfer){this.payload=payload;this.transfer=transfer;}terminate(){this.terminated=true;}};
  try{
    const events=[],pcm=Float32Array.of(.1,.2),pending=runLocalAI('asr',{audio:pcm},{onProgress:(p,m)=>events.push([p,m])}),worker=workers.at(-1);
    assert.equal(worker.options.type,'module');assert.equal(worker.transfer[0],pcm.buffer);
    worker.onmessage({data:{type:'progress',progress:.5,message:'working'}});worker.onmessage({data:{type:'result',result:{text:'완료'}}});
    assert.deepEqual(await pending,{text:'완료'});assert.equal(worker.terminated,true);assert.deepEqual(events,[[.5,'working']]);
    const ctrl=new AbortController(),cancelled=runLocalAI('tts',{text:'한국어'},{signal:ctrl.signal});ctrl.abort();await assert.rejects(()=>cancelled,e=>e.name==='AbortError');assert.equal(workers.at(-1).terminated,true);
    const failed=runLocalAI('tts',{});workers.at(-1).onerror();await assert.rejects(()=>failed,/엔진/);assert.equal(workers.at(-1).terminated,true);
    globalThis.Worker.prototype.postMessage=function(){throw new Error('transfer failed');};await assert.rejects(()=>runLocalAI('asr',{}),/transfer failed/);assert.equal(workers.at(-1).terminated,true);
    const n=workers.length;await assert.rejects(()=>runLocalAI('tts',{}, {signal:AbortSignal.abort()}),e=>e.name==='AbortError');assert.equal(workers.length,n);
  }finally{globalThis.Worker=old;}
});

test('installed speech excludes remote voices and cancels without producing an audio asset',async()=>{
  reset();const old=globalThis.speechSynthesis,oldU=globalThis.SpeechSynthesisUtterance,spoken=[];
  const local={name:'한국어',lang:'ko-KR',voiceURI:'local-ko',localService:true};let cancelled=0;
  globalThis.speechSynthesis={getVoices:()=>[{name:'Remote',lang:'ko-KR',voiceURI:'cloud',localService:false},local],cancel(){cancelled++;},speak(u){spoken.push(u);}};
  globalThis.SpeechSynthesisUtterance=class{constructor(text){this.text=text;}};
  try{
    assert.deepEqual(installedVoices(),[local]);const before=captureDocument(),controller=new AbortController(),pending=speakInstalled('안녕하세요','local-ko',{signal:controller.signal});
    assert.equal(spoken[0].voice,local);controller.abort();await assert.rejects(()=>pending,e=>e.name==='AbortError');assert.ok(cancelled>=1);assert.equal(assets.size,0);assert.deepEqual(captureDocument(),before);
    await assert.rejects(()=>speakInstalled('안녕하세요','cloud'),/설치된/);
  }finally{globalThis.speechSynthesis=old;globalThis.SpeechSynthesisUtterance=oldU;}
});

test('model downloads use public immutable GETs, detect truncation and tolerate disabled caches',async()=>{
  const oldFetch=globalThis.fetch,oldCaches=globalThis.caches,requests=[];let response=Uint8Array.of(1,2,3,4);
  globalThis.caches={open:async()=>{throw new Error('storage disabled');}};
  globalThis.fetch=async(url,options)=>{requests.push({url,options});return new Response(response);};
  try{
    assert.deepEqual(await cachedModel(TTS_MODEL.base+'onnx/test.onnx',4),response);assert.equal(requests[0].options.credentials,'omit');assert.equal(requests[0].options.body,undefined);
    response=Uint8Array.of(1,2);await assert.rejects(()=>cachedModel(TTS_MODEL.base+'onnx/test.onnx',4),/끊겼/);
    const count=requests.length;await assert.rejects(()=>cachedModel('https://unapproved.example/model',4),/허용/);assert.equal(requests.length,count);
  }finally{globalThis.fetch=oldFetch;globalThis.caches=oldCaches;}
});

test('automatic caption application preserves old captions, uses a new track and rejects stale results',()=>{
  reset();project.captions=[{id:'existing',text:'유지',start:0,end:1,trackId:'v3'}];migrateTimeline();const before=captureDocument(),calls=[];
  const owner={state:{kind:'captions',before,captions:[{id:'new',text:'새 자막',start:1,end:2,generated:'local-whisper'}]},close(){},hooks:{commit:(doc,label)=>calls.push(label),select(){},timeline:{reveal(){}},toast(){}}};
  StudioTools.prototype.applyCaptions.call(owner);assert.equal(calls.length,1);assert.equal(project.captions[0].text,'유지');assert.notEqual(project.captions[1].trackId,'v3');assert.equal(project.captions[1].text,'새 자막');
  const after=captureDocument();assert.throws(()=>StudioTools.prototype.applyCaptions.call(owner),/바뀌/);assert.deepEqual(captureDocument(),after);
});

test('cancelling generated voice insertion retains the WAV in saved library without timeline mutation',async()=>{
  reset();const old=globalThis.window,controller=new AbortController(),before=captureDocument(),calls=[];
  globalThis.window={AudioContext:class{async decodeAudioData(){controller.abort();return pcmFixture([new Float32Array(1600).fill(.1)]);}close(){}}};
  const owner={state:{file:new File(['wave'],'voice.wav',{type:'audio/wav'}),before},run:async(kind,work)=>work(controller.signal),close:()=>calls.push('close'),hooks:{saveDraft:()=>calls.push('save'),refresh:()=>calls.push('refresh'),toast(){},commit:()=>calls.push('commit')}};
  try{await StudioTools.prototype.applyVoice.call(owner);assert.equal(assets.size,1);assert.deepEqual(captureDocument(),before);assert.deepEqual(calls,['save','refresh','close']);}
  finally{globalThis.window=old;reset();}
});

test('strict audio analysis distinguishes real boundary silence, missing decoding, channel loss and cancellation',async()=>{
  const oldTrack=Input.prototype.getPrimaryAudioTrack,oldBuffers=AudioBufferSink.prototype.buffers,oldAudioBuffer=globalThis.AudioBuffer;
  const track=Object.assign(Object.create(InputAudioTrack.prototype),{canDecode:async()=>true,getFirstTimestamp:async()=>.1,computeDuration:async()=>.9});
  let sourceTrack=track,rows=[{timestamp:.1,buffer:pcmFixture([new Float32Array(800).fill(.25)],1000)}];
  Input.prototype.getPrimaryAudioTrack=async()=>sourceTrack;
  AudioBufferSink.prototype.buffers=async function*(){for(const row of rows)yield row;};
  globalThis.AudioBuffer=class{constructor({length,numberOfChannels,sampleRate}){Object.assign(this,{length,numberOfChannels,sampleRate,duration:length/sampleRate});this.channels=Array.from({length:numberOfChannels},()=>new Float32Array(length));}getChannelData(c){return this.channels[c];}copyToChannel(pcm,c,offset){this.channels[c].set(pcm,offset);}};
  const clip={type:'video',file:new File(['sample'],'audio.mp4'),trimStart:0,trimEnd:1,muted:true};
  try{
    await assert.rejects(()=>extractClipAudio(clip,null,{strict:true,ignoreMute:true}),/읽지 못한/);
    const result=await extractClipAudio(clip,null,{strict:true,ignoreMute:true,allowBoundaryGaps:true});
    assert.equal(result.length,1000);assert.equal(result.getChannelData(0)[0],0);assert.equal(result.getChannelData(0)[150],.25);assert.equal(result.getChannelData(0)[999],0);assert.equal(clip.muted,true);
    sourceTrack=null;await assert.rejects(()=>extractClipAudio(clip,null,{strict:true,ignoreMute:true}),/오디오 트랙/);
    assert.equal(await extractClipAudio(clip,null,{strict:true,ignoreMute:true,allowMissingTrack:true}),null);
    sourceTrack=track;track.canDecode=async()=>false;await assert.rejects(()=>extractClipAudio(clip,null,{strict:true,ignoreMute:true}),/코덱/);track.canDecode=async()=>true;
    track.getFirstTimestamp=async()=>0;track.computeDuration=async()=>1;
    rows=[{timestamp:0,buffer:pcmFixture([new Float32Array(400)],1000)},{timestamp:.5,buffer:pcmFixture([new Float32Array(500)],1000)}];
    await assert.rejects(()=>extractClipAudio(clip,null,{strict:true,ignoreMute:true,allowBoundaryGaps:true}),/읽지 못한/);
    rows=[{timestamp:0,buffer:pcmFixture([new Float32Array(1000),new Float32Array(1000),new Float32Array(1000).fill(.5)],1000)}];
    const all=await extractClipAudio(clip,null,{strict:true,ignoreMute:true,allChannels:true});assert.equal(all.numberOfChannels,3);assert.equal(all.getChannelData(2)[600],.5);
    const controller=new AbortController();AudioBufferSink.prototype.buffers=async function*(){controller.abort();yield rows[0];};
    await assert.rejects(()=>extractClipAudio(clip,controller.signal,{strict:true,ignoreMute:true}),e=>e.name==='AbortError');
    assert.equal(await extractClipAudio({...clip,trimStart:2,trimEnd:3},null,{strict:true,ignoreMute:true,allowBoundaryGaps:true,allowMissingTrack:true}),null);
  }finally{Input.prototype.getPrimaryAudioTrack=oldTrack;AudioBufferSink.prototype.buffers=oldBuffers;globalThis.AudioBuffer=oldAudioBuffer;}
});

test('export refuses unresolved tracking before running the media encoder',async()=>{
  reset();project.clips=[await fixtureClip('video',2,'video',{mosaics:[maskFixture({mode:'tracked',range:[0,2],keyframes:[keyFixture(0),keyFixture(1,{lost:true})]})]})];
  await assert.rejects(()=>exportVideo({}),/모자이크|추적/);
});

test('voice capacity failure saves the generated asset without changing the timeline',async()=>{
  reset();const previous=globalThis.window,calls=[],samples=new Float32Array(16000).fill(.1);
  globalThis.window={AudioContext:class{async decodeAudioData(){return {length:samples.length,sampleRate:16000,numberOfChannels:1,duration:1,getChannelData:()=>samples};}close(){}}};
  project.timelineTracks=[{id:'v1',kind:'visual',role:'video'},...Array.from({length:24},(_,i)=>({id:'a'+(i+1),kind:'audio',role:'audio'}))];
  migrateTimeline();const before=captureDocument();
  const owner={state:{file:new File(['wav'],'generated.wav',{type:'audio/wav'}),before,start:0},run:async(kind,work)=>work(new AbortController().signal),
    hooks:{saveDraft:()=>calls.push('save'),refresh:()=>calls.push('refresh')}};
  try{await assert.rejects(()=>StudioTools.prototype.applyVoice.call(owner),/보이스 트랙/);assert.equal(assets.size,1);assert.deepEqual(calls,['save','refresh']);assert.deepEqual(captureDocument(),before);}
  finally{globalThis.window=previous;reset();}
});

// 다중 선택과 직접 조작의 계산·저장 회귀입니다. 브라우저를 제어하지 않습니다.
test('legacy role migration preserves ids, stack order, mixed tracks and version 4',()=>{
  reset();project.timelineTracks=[{id:'v3',kind:'visual'},{id:'v1',kind:'visual'},{id:'v2',kind:'visual'},{id:'a2',kind:'audio'},{id:'a1',kind:'audio'}];
  project.captions=[{id:'mixed',text:'그대로',trackId:'v1',start:2,end:5}];
  const rawRows=structuredClone(project.timelineTracks),before=captureDocument(),rows=timelineTracks();
  assert.deepEqual(rows.map(row=>row.role),['caption','video','graphic','voice','audio']);
  assert.deepEqual(project.timelineTracks,rawRows);
  migrateTimeline();assert.deepEqual(project.timelineTracks.map(row=>row.id),before.timelineTracks.map(row=>row.id));
  assert.deepEqual(project.captions,before.captions);assert.equal(captureDocument().version,4);
  assert.equal(trackIdFor('caption',project.captions[0]),'v1');
  const explicit={...captureDocument(),timelineTracks:[{id:'v1',kind:'visual',role:'caption'},{id:'a1',kind:'audio',role:'voice'}]};
  validateDocument(explicit,[]);restoreDocument(explicit);
  assert.equal(trackIdFor('caption',{}),'v1');assert.equal(trackLabel('a1'),'보이스');
});

test('per-row addition is visually adjacent and protects the last row of every role',()=>{
  reset();migrateTimeline();
  for(const role of TRACK_ROLES){
    const original=timelineTracks().find(row=>row.role===role.id),added=addTimelineTrack(role.kind,{afterId:original.id});
    const display=timelineTracks().filter(row=>row.kind===role.kind);if(role.kind==='visual')display.reverse();
    const index=display.findIndex(row=>row.id===original.id);
    assert.equal(display[index+(role.kind==='visual'?-1:1)].id,added.id);assert.equal(added.role,role.id);
    assert.equal(removeTimelineTrack(added.id),true);assert.equal(removeTimelineTrack(original.id),false);
  }
  const before=captureDocument();
  assert.throws(()=>addTimelineTrack('audio',{role:'caption'}));assert.deepEqual(captureDocument(),before);
  const bad=structuredClone(before);bad.timelineTracks[0].role='voice';assert.throws(()=>validateDocument(bad,[]),/트랙/);
});

test('marquee intersects across rows in both directions and modifiers preserve unique live ids',()=>{
  reset();project.captions=[{id:'a',start:0,end:2,text:'A'},{id:'b',start:3,end:4,text:'B'}];
  const a={type:'caption',id:'a'},b={type:'caption',id:'b'},boxes=[{...a,left:10,right:40,top:30,bottom:60},{...b,left:60,right:90,top:70,bottom:100}];
  const expected=[a,b];assert.deepEqual(marqueeHits({x:5,y:28},{x:80,y:95},boxes),expected);
  assert.deepEqual(marqueeHits({x:80,y:95},{x:5,y:28},boxes),expected);
  assert.deepEqual(marqueeHits({x:0,y:0},{x:10,y:30},boxes),[]);
  assert.deepEqual(combineSelection([a],[a,b],'add'),[a,b]);assert.deepEqual(combineSelection([a],[a,b],'toggle'),[b]);
  assert.deepEqual(selectionRefs([a,a,{type:'caption',id:'gone'},b]),expected);
});

test('settings paste changes compatible appearance while preserving content, timing, source and masks',async()=>{
  reset();project.clips=[await fixtureClip('source',8,'video',{start:0,trackId:'v1',volume:.25,fadeIn:.4,transform:{offsetX:.2,rotation:24},crop:{left:.1},mosaics:[maskFixture()]}),
    await fixtureClip('destination',6,'video',{start:10,trackId:'v1',trimStart:1,trimEnd:5,mosaics:[maskFixture({id:'own-mask',strength:70})]})];
  project.captions=[{id:'cap',trackId:'v3',start:4,end:6,text:'문구 유지',style:{size:76}}];
  project.audio.tracks=[fixtureAudio('voice',7,{start:12,role:'voice',trackId:'a2',aiGenerated:true})];
  const refs=[{type:'clip',id:'destination'},{type:'caption',id:'cap'},{type:'audio',id:'voice'}],before=captureDocument();
  const payload=captureItemSettings({type:'clip',id:'source'}),result=applySettingsPlan(planPasteSettings(refs,payload));
  assert.equal(result.applied,3);assert.equal(project.clips[1].assetId,before.clips[1].assetId);
  assert.deepEqual(project.clips[1].mosaics,before.clips[1].mosaics);assert.equal(project.clips[1].trimStart,1);assert.equal(project.clips[1].start,10);
  assert.equal(project.captions[0].text,'문구 유지');assert.equal(project.captions[0].start,4);assert.equal(project.captions[0].style.size,76);
  assert.equal(project.audio.tracks[0].role,'voice');assert.equal(project.audio.tracks[0].aiGenerated,true);assert.equal(project.audio.tracks[0].volume,.25);
  assert.notEqual(project.clips[1].transform,project.captions[0].transform);project.clips[1].transform.offsetX=.8;assert.equal(project.captions[0].transform.offsetX,.2);
  const typography=captureItemSettings({type:'caption',id:'cap'});assert.equal(planPasteSettings([{type:'audio',id:'voice'}],typography).skipped.length,1);
});

test('shared properties apply only to eligible kinds and reject stale paste plans',async()=>{
  reset();project.clips=[await fixtureClip('video',4,'video'),await fixtureClip('image',4,'image',{trackId:'v2'})];
  project.captions=[{id:'cap',start:0,end:4,text:'자막',style:{size:64}}];project.overlays=[{id:'graphic',start:0,end:4,text:'그래픽',size:100,trackId:'v2'}];
  project.audio.tracks=[fixtureAudio('audio',4)];const refs=selectionRefs(buildLayout().items),before=captureDocument();
  assert.equal(applySharedProperty(refs,'textStyle.size',88),2);assert.equal(project.captions[0].style.size,88);assert.equal(project.overlays[0].size,88);
  assert.equal(applySharedProperty(refs,'volume',.3),2);assert.equal(project.clips[1].volume,before.clips[1].volume);
  assert.equal(applySharedProperty(refs,'bg','white'),2);assert.equal(applySharedProperty(refs,'transform.offsetX',.2),4);
  assert.equal(applySharedProperty(refs,'text','잘못된 일괄 내용'),0);assert.equal(project.captions[0].text,'자막');
  assert.deepEqual(project.audio.tracks[0].transform,undefined);
  const plan=planPasteSettings(refs,captureItemSettings({type:'clip',id:'video'}));project.captions[0].text='새 편집';
  const changed=captureDocument();assert.throws(()=>applySettingsPlan(plan),/변경/);assert.deepEqual(captureDocument(),changed);
});

test('group movement preserves relative timing and rejects collisions and stale plans',()=>{
  reset();project.captions=[{id:'a',text:'A',start:1,end:3,trackId:'v3'},{id:'b',text:'B',start:2,end:4,trackId:'v2'},{id:'obstacle',text:'O',start:7,end:9,trackId:'v3'}];
  const refs=[{type:'caption',id:'a'},{type:'caption',id:'b'}],before=captureDocument();
  assert.equal(planBatchMove(refs,5).ok,false);assert.deepEqual(captureDocument(),before);
  const left=planBatchMove(refs,-50);assert.equal(left.delta,-1);applyBatchMove(left);
  assert.deepEqual(project.captions.map(item=>item.start),[0,1,7]);assert.deepEqual(project.captions.map(item=>item.trackId),['v3','v2','v3']);
  const stale=planBatchMove(refs,1);project.captions[2].text='new';assert.throws(()=>applyBatchMove(stale),/변경/);
});

test('group movement retains internal dissolves but detaches external connections',async()=>{
  reset();project.clips=[await fixtureClip('a',4,'image',{start:0,transitionOut:{type:'dissolve',duration:1,toId:'b'}}),
    await fixtureClip('b',4,'image',{start:3,transitionOut:{type:'dissolve',duration:1,toId:'c'}}),await fixtureClip('c',4,'image',{start:6})];migrateTimeline();
  applyBatchMove(planBatchMove([{type:'clip',id:'a'},{type:'clip',id:'b'}],12));
  assert.equal(project.clips[0].transitionOut.toId,'b');assert.equal(project.clips[1].transitionOut.type,'cut');assert.equal(project.clips[2].start,6);assertValidLayout();
});

test('batch ripple deletion recalculates chained dissolve spans and is one undo',async()=>{
  reset();project.clips=await Promise.all(['a','b','c','d'].map((id,i)=>fixtureClip(id,4,'image',{start:i*3,transitionOut:{type:i<3?'dissolve':'cut',duration:i<3?1:0,...(i<3?{toId:['b','c','d'][i]}:{})}})));
  project.captions=[{id:'keep',text:'유지',start:2,end:9,trackId:'v3'}];migrateTimeline();const before=captureDocument(),history=new History();
  assert.equal(deleteSelectedItems([{type:'clip',id:'b'},{type:'clip',id:'c'}],true),2);
  assert.deepEqual(project.clips.map(item=>[item.id,item.start]),[['a',0],['d',4]]);assert.deepEqual(project.captions,before.captions);
  history.push(before,'batch delete');history.undo();assert.deepEqual(captureDocument(),before);
});

test('batch splitting includes only selected eligible items and retains masks and envelopes',async()=>{
  reset();project.clips=[await fixtureClip('video',12,'video',{start:0,trimStart:2,trimEnd:10,fadeIn:2,fadeOut:2,mosaics:[maskFixture()]})];
  project.audio.tracks=[fixtureAudio('voice',12,{trimStart:2,trimEnd:10,start:0,role:'voice',fadeIn:2,fadeOut:2})];
  project.captions=[{id:'cap',text:'분할',trackId:'v3',start:0,end:8},{id:'later',text:'그대로',trackId:'v3',start:10,end:12}];
  project.overlays=[{id:'unselected',text:'유지',trackId:'v2',start:0,end:8}];
  const refs=[{type:'clip',id:'video'},{type:'audio',id:'voice'},{type:'caption',id:'cap'},{type:'caption',id:'later'}],before=captureDocument();
  const plan=planBatchSplit(refs,4),result=await applyBatchSplit(plan);assert.equal(result.items.length,3);assert.equal(result.skipped,1);
  assert.deepEqual(project.overlays,before.overlays);assert.equal(project.captions.find(item=>item.id==='later').start,10);
  for(const ref of result.items){const range=itemRange(ref.type,ref.id);assert.equal(range.start,4);assert.equal(range.end,8);}
  const right=project.clips.find(item=>item.id!=='video');assert.equal(right.trimStart,6);assert.deepEqual(right.mosaics,before.clips[0].mosaics);assert.notEqual(right.mosaics,project.clips[0].mosaics);
  for(const time of [0,.5,3.5,4,5,7.5]){const part=time<4?project.clips[0]:right;near(clipFadeGain(part,time<4?time:time-4,4),clipFadeGain(before.clips[0],time,8));}
  const h=new History();h.push(before,'batch split');h.undo();assert.deepEqual(captureDocument(),before);
});

for(const command of ['split','duplicate'])for(const mode of ['cancel','stale','second-failure'])test('batch '+command+' stages resources atomically on '+mode,async()=>{
  reset();project.clips=[await fixtureClip('first',8,'video',{start:0,trackId:'v1'}),await fixtureClip('second',8,'video',{start:0,trackId:'v2'})];
  const refs=selectionRefs(buildLayout().items),before=captureDocument(),plan=planBatchSplit(refs,4),old=document.createElement,controller=new AbortController(),staged=[];let made=0;
  document.createElement=tag=>{
    if(++made===2&&mode==='second-failure')throw new Error('fixture decode failure');
    if(made===1&&mode==='cancel')queueMicrotask(()=>controller.abort());
    if(made===1&&mode==='stale')queueMicrotask(()=>{project.clips[0].name='newer edit';});
    const element=old(tag);staged.push(element);return element;
  };
  try{
    await assert.rejects(command==='split'?applyBatchSplit(plan,{signal:controller.signal}):duplicateSelectedItems(refs,{signal:controller.signal}));
    const expected=structuredClone(before);if(mode==='stale')expected.clips[0].name='newer edit';
    assert.deepEqual(captureDocument(),expected);assert.ok(staged.every(element=>element.src===''));
  }finally{document.createElement=old;}
});

test('cross-track duplication preserves offsets when one row pushes the insertion later',async()=>{
  reset();project.captions=[{id:'a',text:'A',trackId:'v3',start:0,end:2},{id:'b',text:'B',trackId:'v2',start:1,end:3},{id:'obstacle',text:'O',trackId:'v3',start:2.5,end:6}];
  const original=captureDocument(),copies=await duplicateSelectedItems([{type:'caption',id:'a'},{type:'caption',id:'b'}]);
  assert.equal(copies.length,2);const a=itemRange('caption',copies[0].id),b=itemRange('caption',copies[1].id);near(b.start-a.start,1);
  assert.ok(a.start>=6);assert.deepEqual(project.captions.slice(0,3),original.captions);
  validateDocument(captureDocument(),[]);
});

test('duplication rejects clone and downstream overflow but normalizes fractional final frame',async()=>{
  reset();project.captions=[{id:'a',text:'A',trackId:'v3',start:86399.6,end:86399.8}];
  const copy=(await duplicateSelectedItems([{type:'caption',id:'a'}]))[0];assert.equal(project.captions.find(item=>item.id===copy.id).end,86400);validateDocument(captureDocument(),[]);
  const before=captureDocument();await assert.rejects(()=>duplicateSelectedItems([{type:'caption',id:copy.id}]),/최대/);assert.deepEqual(captureDocument(),before);
  reset();project.captions=[{id:'a',text:'A',trackId:'v3',start:0,end:2},{id:'tail',text:'T',trackId:'v3',start:2,end:86400}];
  const full=captureDocument();await assert.rejects(()=>duplicateSelectedItems([{type:'caption',id:'a'}]),/최대/);assert.deepEqual(captureDocument(),full);
});

test('inverse pointer geometry respects rotation, nonuniform scaling, flips and crop hit areas',()=>{
  const bounds={x:130,y:240,w:430,h:720},W=1080,H=1920;
  for(const rotation of [-130,0,33,170])for(const flipX of [false,true])for(const flipY of [false,true]){
    const item={transform:{rotation,flipX,flipY,scaleX:1.7,scaleY:.6,offsetX:.13,offsetY:-.2},crop:{left:.2,right:.1,top:.1,bottom:.3}};
    const point={x:bounds.x+bounds.w*.4,y:bounds.y+bounds.h*.5},screen=transformPoint(point,bounds,item,W,H),back=inverseTransformPoint(screen,bounds,item,W,H);
    near(back.x,point.x);near(back.y,point.y);assert.equal(hitVisual(screen,bounds,item,W,H),true);
    assert.equal(hitVisual(transformPoint({x:bounds.x,y:bounds.y},bounds,item,W,H),bounds,item,W,H),false);
  }
});

test('direct crop adjusts local edges and resize holds the opposite cropped anchor fixed',()=>{
  const bounds={x:120,y:80,w:400,h:600},W=1080,H=1920;
  for(const rotation of [-45,0,77])for(const flipX of [false,true])for(const flipY of [false,true]){
    const item={transform:{rotation,flipX,flipY,scaleX:1.8,scaleY:.7,offsetX:.1,offsetY:-.05},crop:{left:.1,right:.2,top:.15,bottom:.1}},b=croppedBounds(bounds,item.crop);
    const from=transformPoint({x:b.x,y:b.y},bounds,item,W,H),to=transformPoint({x:b.x+40,y:b.y+60},bounds,item,W,H);
    const crop=cropFromDrag(item,bounds,W,H,from,to,['left','top']);near(crop.left,.2);near(crop.top,.25);near(crop.right,.2);near(crop.bottom,.1);
    const anchor={x:b.x+b.w,y:b.y+b.h},old=transformPoint(anchor,bounds,item,W,H),next=resizeFromDrag(item,bounds,W,H,from,to,['left','top'],false),fixed=transformPoint(anchor,bounds,{...item,transform:next},W,H);
    near(fixed.x,old.x);near(fixed.y,old.y);
    const limited=cropFromDrag(item,bounds,W,H,from,transformPoint({x:10000,y:10000},bounds,item,W,H),['left','top']);
    assert.ok(limited.left+limited.right<=.98+1e-8);assert.ok(limited.top+limited.bottom<=.98+1e-8);
  }
});

test('crop window dragging preserves visible dimensions and center snapping uses visible crop',()=>{
  const bounds={x:100,y:200,w:400,h:700},item={crop:{left:.2,right:.3,top:.1,bottom:.4},transform:{rotation:33,flipX:true,scaleX:1.2,scaleY:.8}};
  const from=transformPoint({x:300,y:400},bounds,item,1080,1920),to=transformPoint({x:340,y:470},bounds,item,1080,1920);
  const crop=cropFromDrag(item,bounds,1080,1920,from,to,['move']);near(crop.left+crop.right,.5);near(crop.top+crop.bottom,.5);
  alignVisual(item,bounds,1080,1920,'x');alignVisual(item,bounds,1080,1920,'y');item.transform.offsetX+=3/1080;item.transform.offsetY-=4/1920;
  const snap=snapVisualCenter(item,bounds,1080,1920,{x:5,y:5});assert.deepEqual(snap.guides,{x:true,y:true});
  const center=visualCorners(bounds,{...item,transform:snap.transform},1080,1920).reduce((sum,p)=>({x:sum.x+p.x/4,y:sum.y+p.y/4}),{x:0,y:0});
  near(center.x,540);near(center.y,960);
});

test('monitor overlay draws selection outside exported pixels and keeps the legacy player path', {skip:!canvasModule},()=>{
  reset();const bitmap=canvasModule.createCanvas(90,160);bitmap.getContext('2d').fillStyle='red';bitmap.getContext('2d').fillRect(0,0,90,160);
  project.clips=[{...clip('image',3),bitmap,natW:90,natH:160,scale:.5}];
  const canvas=canvasModule.createCanvas(180,320),player=new Player(canvas);player.selection={type:'clip',id:'image'};player.selectionOverlay=true;let updates=0;player.onDraw=()=>updates++;
  player.draw();const withoutUI=canvas.getContext('2d').getImageData(0,0,180,320).data.slice();
  const expected=canvasModule.createCanvas(180,320);renderFrame(expected.getContext('2d'),0,{source:player.source});
  assert.deepEqual(withoutUI,expected.getContext('2d').getImageData(0,0,180,320).data);assert.equal(updates,1);
  player.selectionOverlay=false;player.draw();assert.notDeepEqual(withoutUI,canvas.getContext('2d').getImageData(0,0,180,320).data);
});

// 직접 조작의 포인터·취소·화면 좌표 회귀 검사입니다.
class MonitorClasses {
  values = new Set();
  add(...names) { names.forEach(name => this.values.add(name)); }
  remove(...names) { names.forEach(name => this.values.delete(name)); }
  contains(name) { return this.values.has(name); }
  toggle(name, force) { const yes = force ?? !this.contains(name); if (yes) this.add(name); else this.remove(name); return yes; }
}
class MonitorNode extends EventTarget {
  constructor(tagName = 'div', id = '') {
    super(); Object.assign(this, { tagName: tagName.toUpperCase(), id, dataset: {}, style: {}, classList: new MonitorClasses(), children: [], parentElement: null, hidden: false, width: 1000, height: 800, clientWidth: 600, clientHeight: 500, offsetWidth: 150, offsetHeight: 35, rect: { left: 20, top: 40, width: 600, height: 500 }, captures: new Set() });
  }
  append(node) { this.children.push(node); node.parentElement = this; }
  setAttribute(name, value) { this[name] = value; }
  getBoundingClientRect() { return { ...this.rect, right: this.rect.left + this.rect.width, bottom: this.rect.top + this.rect.height }; }
  matches(selector) {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    const names = { '[data-edges]': 'edges', '[data-monitor-mode]': 'monitorMode', '[data-monitor-align]': 'monitorAlign' };
    return names[selector] ? this.dataset[names[selector]] !== undefined : false;
  }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  setPointerCapture(id) { this.captures.add(id); }
  hasPointerCapture(id) { return this.captures.has(id); }
  releasePointerCapture(id) { this.captures.delete(id); this.dispatchEvent(monitorEvent('lostpointercapture', { pointerId: id }, this)); }
  blur() { if (document.activeElement === this) document.activeElement = null; }
}
function monitorEvent(type, fields = {}, target) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, fields);
  if (target) Object.defineProperty(event, 'target', { value: target });
  return event;
}
function monitorFixture(overrides = {}, extra = []) {
  reset();Object.assign(project, { width: 1000, height: 800 });
  const nodes = Object.fromEntries(['preview', 'viewerStage', 'monitorOverlay', 'monitorOutline', 'monitorTools', 'monitorSelectionCount'].map(id => [id, new MonitorNode(id === 'preview' ? 'canvas' : 'div', id)]));
  const canvas = nodes.preview, stage = nodes.viewerStage;
  canvas.rect = { left: 50, top: 80, width: 500, height: 400 };
  stage.append(canvas); stage.append(nodes.monitorOverlay); nodes.monitorOverlay.append(nodes.monitorOutline); stage.append(nodes.monitorTools);
  globalThis.window = new EventTarget();
  globalThis.document = { activeElement: null, body: new MonitorNode('body'), getElementById: id => nodes[id], createElement: tag => new MonitorNode(tag) };
  const first = { ...newClipDefaults('image'), id: 'first', start: 0, imgDuration: 10, natW: 1000, natH: 800, scale: .6, trackId: 'v1', ...structuredClone(overrides) };
  project.clips = [first, ...extra.map((item, i) => ({ ...newClipDefaults('image'), id: 'extra-' + i, start: 0, imgDuration: 10, natW: 1000, natH: 800, scale: .5, trackId: 'v' + (i + 2), ...structuredClone(item) }))];
  const refs = project.clips.map(item => ({ type: 'clip', id: item.id }));
  const counts = { commits: [], starts: 0, ends: 0, refreshes: 0, invalidates: 0 };
  const ctx = { save() {}, restore() {}, measureText: text => ({ width: text.length * 10 }) };
  const player = { time: 1, playing: false, ctx, pause() { this.playing = false; }, invalidate() { counts.invalidates++; this.onDraw?.(); } };
  const editor = new MonitorEditor({ player, selections: () => refs, selection: () => refs[0], busy: () => false, align() {}, gestureStart() { counts.starts++; }, gestureEnd() { counts.ends++; }, refresh() { counts.refreshes++; }, commit(before, label) { counts.commits.push({ before, label, after: captureDocument() }); } });
  editor.update();
  const logical = point => ({ clientX: canvas.rect.left + point.x / canvas.width * canvas.rect.width, clientY: canvas.rect.top + point.y / canvas.height * canvas.rect.height });
  const pointer = (type, point, opts = {}) => {
    const { target = canvas, ...fields } = opts;
    const event = monitorEvent(type, { pointerId: 77, button: 0, buttons: type === 'pointerup' ? 0 : 1, isPrimary: true, altKey: true, shiftKey: false, ...logical(point), ...fields }, target);
    stage.dispatchEvent(event); return event;
  };
  const center = () => visualCorners(editor.bounds(editor.current()), first, canvas.width, canvas.height).reduce((sum, p) => ({ x: sum.x + p.x / 4, y: sum.y + p.y / 4 }), { x: 0, y: 0 });
  return { editor, canvas, stage, nodes, player, first, refs, counts, pointer, center };
}

const monitorNearPoint = (a, b) => { near(a.x, b.x, 'x'); near(a.y, b.y, 'y'); };
const monitorGeometry = { transform: { offsetX: .13, offsetY: -.07, rotation: 33, scaleX: 1.4, scaleY: .65, flipX: true, flipY: false }, crop: { left: .17, right: .09, top: .12, bottom: .21 } };


function withFitGlobals(run) {
  const previous = { style: globalThis.getComputedStyle, observer: globalThis.ResizeObserver };
  const padding = { paddingLeft: '20px', paddingRight: '20px', paddingTop: '30px', paddingBottom: '10px' };
  const observers = [];
  globalThis.getComputedStyle = () => padding;
  globalThis.ResizeObserver = class { constructor(callback) { this.callback = callback; this.targets = []; observers.push(this); } observe(node) { this.targets.push(node); } disconnect() {} };
  try { return run(padding, observers); }
  finally {
    if (previous.style === undefined) delete globalThis.getComputedStyle; else globalThis.getComputedStyle = previous.style;
    if (previous.observer === undefined) delete globalThis.ResizeObserver; else globalThis.ResizeObserver = previous.observer;
  }
}

const monitorTest=(name,run)=>test('monitor: '+name,()=>{
  const saved=Object.fromEntries(['document','window','getComputedStyle','ResizeObserver'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  try{run();}finally{for(const [key,descriptor] of Object.entries(saved)){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}reset();}
});
monitorTest('ten move events produce one commit; release-generated lost capture does not undo', () => {
  const f = monitorFixture(monitorGeometry), p = f.center(), old = transformOf(f.first), before = captureDocument();
  f.pointer('pointerdown', p);
  for (let i = 1; i <= 10; i++) f.pointer('pointermove', { x: p.x + 6 * i, y: p.y + 2 * i });
  f.pointer('pointerup', { x: p.x + 60, y: p.y + 20 });
  assert.equal(f.counts.commits.length, 1); assert.deepEqual(f.counts.commits[0].before, before); near(f.first.transform.offsetX, old.offsetX + .06); near(f.first.transform.offsetY, old.offsetY + .025); assert.equal(f.editor.dragging, false); assert.equal(f.counts.ends, 1);
});

for (const cancel of ['pointercancel', 'lostpointercapture', 'blur', 'Escape']) monitorTest(cancel + ': cancels every selected target without source changes', () => {
  const f = monitorFixture(monitorGeometry, [{ transform: { rotation: -48, offsetX: -.2 }, crop: { left: .1 } }]), before = captureDocument(), p = f.center();
  f.pointer('pointerdown', p); f.pointer('pointermove', { x: p.x + 60, y: p.y + 20 });
  if (cancel === 'blur') window.dispatchEvent(new Event('blur'));
  else if (cancel === 'Escape') window.dispatchEvent(monitorEvent('keydown', { key: 'Escape' }));
  else f.pointer(cancel, p);
  assert.equal(f.editor.dragging, false); assert.equal(f.counts.commits.length, 0); assert.equal(f.counts.ends, 1); assert.deepEqual(captureDocument(), before);
});

monitorTest('other pointer cancellation must not cancel the primary gesture', () => {
  const f = monitorFixture(), p = f.center();
  f.pointer('pointerdown', p); f.pointer('pointermove', { x: p.x + 50, y: p.y }); f.pointer('pointercancel', p, { pointerId: 88 });
  assert.equal(f.editor.dragging, true, 'secondary pointercancel cancelled primary drag'); f.pointer('pointercancel', p);
});

monitorTest('crop under rotation, flip and nonuniform scale keeps opposite edge fixed', () => {
  const f = monitorFixture(monitorGeometry); f.editor.mode = 'crop';
  const b = f.editor.bounds(f.editor.current()), c = croppedBounds(b, f.first.crop), beforeTransform = structuredClone(f.first.transform), corners = visualCorners(b, f.first, 1000, 800);
  const a = { x: c.x, y: c.y + c.h / 2 }, d = { x: a.x + b.w * .1, y: a.y };
  const from = transformPoint(a, b, f.first, 1000, 800), to = transformPoint(d, b, f.first, 1000, 800);
  f.pointer('pointerdown', from, { target: f.editor.buttons[7] }); f.pointer('pointermove', to); f.pointer('pointerup', to);
  near(f.first.crop.left, .27); near(f.first.crop.right, .09); assert.deepEqual(f.first.transform, beforeTransform); const after = visualCorners(b, f.first, 1000, 800); monitorNearPoint(corners[1], after[1]); monitorNearPoint(corners[2], after[2]); assert.equal(f.counts.commits.length, 1);
});

for (const rotation of [33, 350]) monitorTest('rotate out and back is no-op, starting angle ' + rotation, () => {
  const f = monitorFixture({ ...monitorGeometry, transform: { ...monitorGeometry.transform, rotation } }), before = captureDocument(), p = f.center(), from = { x: p.x + 120, y: p.y }, angle = Math.PI / 6, to = { x: p.x + 120 * Math.cos(angle), y: p.y + 120 * Math.sin(angle) };
  f.pointer('pointerdown', from, { target: f.editor.rotate }); f.pointer('pointermove', to); f.pointer('pointermove', from); f.pointer('pointerup', from);
  assert.equal(f.counts.commits.length, 0, 'roundtrip transform: ' + JSON.stringify(f.first.transform)); assert.deepEqual(captureDocument(), before);
});

monitorTest('fitCanvas contains portrait/landscape/square canvas inside padded content box', () => withFitGlobals(() => {
  const f = monitorFixture(); f.stage.clientWidth = 640; f.stage.clientHeight = 500;
  for (const [w, h] of [[1080, 1920], [1920, 1080], [1000, 1000]]) {
    f.canvas.width = w; f.canvas.height = h; f.editor.fitCanvas();
    const width = parseFloat(f.canvas.style.width), height = parseFloat(f.canvas.style.height);
    near(width / height, w / h); assert.ok(width <= 600 + 1e-8); assert.ok(height <= 460 + 1e-8); assert.equal(f.canvas.width, w); assert.equal(f.canvas.height, h);
  }
}));
monitorTest('point maps fitted content pixels directly to intrinsic canvas coordinates', () => withFitGlobals(() => {
  const f = monitorFixture(); f.canvas.width = 1080; f.canvas.height = 1920; f.editor.fitCanvas();
  f.canvas.getBoundingClientRect = () => ({ ...f.canvas.rect, width: parseFloat(f.canvas.style.width), height: parseFloat(f.canvas.style.height) });
  const rect = f.canvas.getBoundingClientRect();
  monitorNearPoint(f.editor.point({ clientX: rect.left + rect.width * .25, clientY: rect.top + rect.height * .75 }), { x: 270, y: 1440 });
}));
monitorTest('ResizeObserver host resizing refits without changing source dimensions', () => withFitGlobals((padding, observers) => {
  const f = monitorFixture(), oldWidth = f.canvas.width, oldHeight = f.canvas.height;
  assert.equal(observers.length, 1); assert.equal(observers[0].targets[0], f.stage);
  f.stage.clientWidth = 360; f.stage.clientHeight = 900; observers[0].callback();
  near(parseFloat(f.canvas.style.width), 320); near(parseFloat(f.canvas.style.height), 256); assert.equal(f.canvas.width, oldWidth); assert.equal(f.canvas.height, oldHeight);
}));
monitorTest('padding-only ResizeObserver notification invalidates fit cache', () => withFitGlobals((padding, observers) => {
  const f = monitorFixture(); f.stage.clientWidth = 640; f.stage.clientHeight = 500; f.canvas.width = 1920; f.canvas.height = 1080; f.editor.fitCanvas();
  near(parseFloat(f.canvas.style.width), 600);
  padding.paddingLeft = '120px'; padding.paddingRight = '120px'; observers[0].callback();
  near(parseFloat(f.canvas.style.width), 400, 'available content width after padding change');
}));


// 타임라인 포인터 조작과 선택 상태 회귀 검사입니다.
function seedTimeline() {
  reset();
  project.clips=[];project.overlays=[];project.audio.tracks=[];project.fps=30;
  project.timelineTracks=[{id:'v1',kind:'visual',role:'video'},{id:'v2',kind:'visual',role:'caption'},{id:'a1',kind:'audio',role:'audio'}];
  project.captions=[{id:'a',text:'a',trackId:'v1',start:1,end:3},{id:'b',text:'b',trackId:'v2',start:2,end:4}];
}

function mockTimelineEvents() {
  const names=['document','window','requestAnimationFrame','cancelAnimationFrame'];
  const saved=new Map(names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  const rafs=new Map(),calls={commits:[],seeks:[],errors:[]};let nextRaf=0;
  const emit=(target,type,fields={})=>target.dispatchEvent(Object.assign(new Event(type,{cancelable:true}),fields));
  const node=(data={})=>Object.assign(new EventTarget(),{
    dataset:{},style:{},tagName:'DIV',captures:new Set(),children:[],offsetTop:27,offsetHeight:54,
    classList:{add(){},remove(){},toggle(){}},setAttribute(){},focus(){},remove(){},closest(){return null;},querySelectorAll(){return [];},
    append(child){this.children.push(child);},getBoundingClientRect(){return{left:0,top:0,right:500,bottom:200};},
    setPointerCapture(id){this.captures.add(id);},hasPointerCapture(id){return this.captures.has(id);},
    releasePointerCapture(id){this.captures.delete(id);emit(this,'lostpointercapture',{pointerId:id});},...data,
  });
  const rows=new Map(['v1','v2','a1'].map(id=>{const row=node({dataset:{track:id}});row.closest=s=>s==='.track'?row:null;return[id,row];}));
  const blocks=new Map(project.captions.map(item=>{
    const block=node({dataset:{type:'caption',id:item.id},getBoundingClientRect:()=>({left:item.start*100,right:item.end*100,top:item.id==='a'?81:27,bottom:item.id==='a'?125:71})});
    block.closest=s=>s.includes('.timeline-block')?block:s==='.track'?rows.get(item.trackId):null;return[item.id,block];
  }));
  const canvas=node({querySelectorAll:s=>s.includes('.timeline-block')?[...blocks.values()]:[]});
  const ruler=node();ruler.closest=s=>s.includes('#ruler')?ruler:null;
  const notice=node(),scroll={scrollLeft:0,scrollTop:0,clientWidth:500,clientHeight:200,getBoundingClientRect:()=>({left:0,right:500,top:0,bottom:200})};
  globalThis.window=new EventTarget();globalThis.document={activeElement:null,createElement:()=>node(),getElementById:id=>rows.get(id.replace('track-',''))||notice,elementFromPoint:()=>rows.get('v1')};
  globalThis.requestAnimationFrame=fn=>{rafs.set(++nextRaf,fn);return nextRaf;};globalThis.cancelAnimationFrame=id=>rafs.delete(id);
  const timeline=Object.assign(Object.create(Timeline.prototype),{canvas,scroll,zoom:100,snapping:false,time:0,dragging:false,selection:null,selections:[],
    callbacks:{pause(){},select(){},selectMany(){},seek:t=>calls.seeks.push(t),commit:(before,label)=>calls.commits.push({before,label}),error:e=>calls.errors.push(e)},
    activateTrack(){},render(){},ensureWidth(){},showPreview(){},clearPreview(){},
  });
  const pointer=(target,clientX=150,clientY=90,pointerId=7)=>({target,button:0,isPrimary:true,pointerId,clientX,clientY,preventDefault(){}});
  const refs=[...blocks.keys()].map(id=>({type:'caption',id}));
  return{timeline,canvas,ruler,blocks,refs,calls,rafs,emit,pointer,
    restore(){emit(window,'keydown',{key:'Escape'});emit(window,'blur');for(const[name,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}},
  };
}

test('batch reveal preserves the selected IDs and primary item',()=>{
  seedTimeline();const m=mockTimelineEvents();try{
    m.timeline.selectMany(m.refs,m.refs[1]);m.timeline.reveal({type:'caption',id:'a',start:1,end:3},{preserveSelection:true});
    assert.deepEqual(m.timeline.selections,m.refs);assert.equal(m.timeline.selection.id,'b');
  }finally{m.restore();}
});

test('timeline pointer lifecycle ignores foreign events and aborts without committing',()=>{
  for(const mode of ['single','group','marquee'])for(const reason of ['pointercancel','lostpointercapture','blur','Escape']){
    seedTimeline();const m=mockTimelineEvents();try{
      const t=m.timeline,owner=mode==='marquee'?m.canvas:m.blocks.get('a');t.selectMany(mode==='group'?m.refs:[m.refs[0]]);
      const initial=structuredClone(t.selections),before=captureDocument();
      if(mode==='marquee')t.startMarquee(m.pointer(owner,190,30));else t.pointerDown(m.pointer(owner));
      for(const type of ['pointermove','pointerup','pointercancel','lostpointercapture'])m.emit(owner,type,{pointerId:8,clientX:350,clientY:60});
      assert.equal(t.dragging,true,mode);assert.deepEqual(captureDocument(),before);
      m.emit(owner,'pointermove',{pointerId:7,clientX:350,clientY:60});assert.deepEqual(captureDocument(),before);
      if(reason==='Escape')m.emit(window,'keydown',{key:'Escape'});else if(reason==='blur')m.emit(window,'blur');else m.emit(owner,reason,{pointerId:7});
      m.emit(owner,'pointerup',{pointerId:7});m.emit(window,'blur');
      assert.equal(t.dragging,false,`${mode}: ${reason}`);assert.equal(owner.hasPointerCapture(7),false);assert.equal(m.rafs.size,0);
      assert.deepEqual(captureDocument(),before);assert.deepEqual(t.selections,initial);assert.equal(m.calls.commits.length,0);
    }finally{m.restore();}
  }
});

test('group pointerup commits once and retains group timing',()=>{
  seedTimeline();const m=mockTimelineEvents();try{
    const t=m.timeline,owner=m.blocks.get('a');t.selectMany(m.refs);t.pointerDown(m.pointer(owner));
    m.emit(owner,'pointermove',{pointerId:7,clientX:250,clientY:90});m.emit(owner,'pointerup',{pointerId:7});m.emit(owner,'pointerup',{pointerId:7});
    assert.deepEqual(project.captions.map(c=>c.start),[2,3]);assert.equal(m.calls.commits.length,1);assert.deepEqual(t.selections,m.refs);assert.equal(m.rafs.size,0);
  }finally{m.restore();}
});

test('single trim isolates its clip after multi-selection',()=>{
  seedTimeline();const m=mockTimelineEvents();try{
    const t=m.timeline,owner=m.blocks.get('a'),other=structuredClone(project.captions[1]);t.selectMany(m.refs);
    const grip={dataset:{edge:'end'},closest:s=>s==='[data-edge]'?grip:owner.closest(s)};t.pointerDown(m.pointer(grip,300));
    m.emit(owner,'pointermove',{pointerId:7,clientX:350,clientY:90});m.emit(owner,'pointerup',{pointerId:7});
    assert.equal(project.captions[0].end,3.5);assert.deepEqual(project.captions[1],other);assert.deepEqual(t.selections,[m.refs[0]]);assert.equal(m.calls.commits.length,1);
  }finally{m.restore();}
});

test('single drag rejects stale project data without overwriting newer edits',()=>{
  seedTimeline();const m=mockTimelineEvents();try{
    const owner=m.blocks.get('a');m.timeline.pointerDown(m.pointer(owner));m.emit(owner,'pointermove',{pointerId:7,clientX:250,clientY:90});
    project.captions[1].text='newer edit';const newer=captureDocument();m.emit(owner,'pointerup',{pointerId:7});
    assert.deepEqual(captureDocument(),newer);assert.equal(m.calls.commits.length,0);assert.equal(m.calls.errors.length,1);
  }finally{m.restore();}
});

test('ruler scrub filters pointer IDs and removes every termination listener',()=>{
  for(const reason of ['pointerup','pointercancel','blur','Escape']){
    seedTimeline();const m=mockTimelineEvents();try{
      m.timeline.pointerDown(m.pointer(m.ruler,100,10));
      for(const type of ['pointermove','pointerup','pointercancel'])m.emit(window,type,{pointerId:8,clientX:300,clientY:10});
      assert.deepEqual(m.calls.seeks,[1]);m.emit(window,'pointermove',{pointerId:7,clientX:200,clientY:10});
      if(reason==='Escape')m.emit(window,'keydown',{key:'Escape'});else m.emit(window,reason,{pointerId:7});
      m.emit(window,'pointermove',{pointerId:7,clientX:300,clientY:10});assert.deepEqual(m.calls.seeks,[1,2],reason);
    }finally{m.restore();}
  }
});

const pcLocation={protocol:'http:',hostname:'127.0.0.1'};
const referenceBuffer=(duration=4)=>{const data=Float32Array.from({length:Math.round(duration*16000)},(_,i)=>Math.sin(i*.1)*.2);return {sampleRate:16000,length:data.length,numberOfChannels:1,getChannelData:()=>data};};

test('PC voice only uses the local editor origin and never probes a public/mobile page',async()=>{
  for(const location of [undefined,{protocol:'https:',hostname:'example.com'},{protocol:'http:',hostname:'127.0.0.1.evil.test'},{protocol:'http:',hostname:'192.168.1.2'},{protocol:'file:',hostname:''}]){
    assert.equal(isPcVoiceOrigin(location),false);
    await assert.rejects(()=>pcVoiceStatus({location,fetchImpl:()=>{throw new Error('must never fetch');}}),/PC용 로컬/);
  }
  assert.ok(isPcVoiceOrigin(pcLocation));assert.ok(isPcVoiceOrigin({protocol:'http:',hostname:'localhost'}));
  let call;
  const result=await pcVoiceStatus({location:pcLocation,fetchImpl:async(url,options)=>{call={url,options};return new Response('{"localServer":true,"state":"ready","profiles":[]}',{headers:{'Content-Type':'application/json'}});}});
  assert.equal(result.state,'ready');assert.equal(call.url,'/api/voice-clone/status');assert.equal(call.options.credentials,'omit');assert.equal(call.options.redirect,'error');assert.equal(call.options.headers['X-Studio-PC-Voice'],'1');
});

test('voice reference preparation yields bounded mono WAV without adding private audio to the project',async()=>{
  reset();const before=captureDocument(),ref=referenceFromPcm(referenceBuffer());
  assert.equal(ref.duration,4);assert.equal(ref.sampleRate,32000);assert.ok(ref.wav.size<1024*1024);
  const view=new DataView(await ref.wav.arrayBuffer());assert.equal(view.getUint16(22,true),1);assert.equal(view.getUint32(24,true),32000);
  for(const duration of [2.99,10.01])assert.throws(()=>referenceFromPcm(referenceBuffer(duration)),/3~10초/);
  const silent=referenceBuffer();silent.getChannelData=()=>new Float32Array(silent.length);assert.throws(()=>referenceFromPcm(silent),/무음/);
  assert.equal(assets.size,0);assert.deepEqual(captureDocument(),before);
});

test('voice reference request carries explicit consent only to the PC adapter',async()=>{
  const reference=referenceFromPcm(referenceBuffer());let call;
  const result=await saveVoiceReference({name:'내 목소리',promptText:'참고 문장',wav:reference.wav,consent:true},{location:pcLocation,fetchImpl:async(url,options)=>{call={url,options};return new Response('{"profile":{"id":"abc"}}',{status:201,headers:{'Content-Type':'application/json'}});}});
  assert.equal(result.profile.id,'abc');assert.equal(call.url,'/api/voice-clone/references');const payload=JSON.parse(call.options.body);
  assert.equal(payload.promptText,'참고 문장');assert.equal(payload.consent,true);assert.equal(call.options.headers['X-Studio-Consent'],'voice-clone-local');
  assert.equal(Buffer.from(payload.audio,'base64').length,reference.wav.size);assert.equal(assets.size,0);
});

test('PC-generated WAV uses actual sample rate and rejects HTML, oversized and invalid responses',async()=>{
  const wav=encodeWav({...referenceBuffer(),sampleRate:48000}),bytes=await wav.arrayBuffer();
  const response=()=>new Response(bytes,{headers:{'Content-Type':'audio/wav','X-Studio-Audio-Rate':'48000','X-Studio-Audio-Duration':'1.333333'}});
  const result=await generatePcVoice({text:'한국어',profileId:'ref',consent:true},{location:pcLocation,fetchImpl:async()=>response()});
  assert.equal(result.sampleRate,48000);assert.equal(result.wav.size,wav.size);assert.ok(result.duration>1);
  const invalid=[()=>new Response('<html>old server</html>',{headers:{'Content-Type':'text/html'}}),
    ()=>new Response('bad',{headers:{'Content-Type':'audio/wav','X-Studio-Audio-Rate':'44100','X-Studio-Audio-Duration':'1'}}),
    ()=>new Response(bytes,{headers:{'Content-Type':'audio/wav','Content-Length':String(33*1024*1024)}})];
  for(const make of invalid)await assert.rejects(()=>generatePcVoice({text:'x'},{location:pcLocation,fetchImpl:async()=>make()}));
});

test('PC request cancellation discards late audio and timeout is not described as engine cancellation',async()=>{
  let release;const controller=new AbortController(),before=captureDocument();
  const pending=generatePcVoice({text:'x'},{location:pcLocation,signal:controller.signal,fetchImpl:()=>new Promise(resolve=>{release=resolve;})});
  controller.abort();release(new Response('ignored',{headers:{'Content-Type':'audio/wav'}}));await assert.rejects(()=>pending,error=>error.name==='AbortError');
  assert.deepEqual(captureDocument(),before);
  await assert.rejects(()=>generatePcVoice({text:'x'},{location:pcLocation,timeout:1,fetchImpl:async(url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError'))))}),/엔진 작업이 남아/);
});

test('decoding a reference closes its audio context on success, invalid duration and abort',async()=>{
  const original=globalThis.AudioContext;let closes=0,pcm=referenceBuffer();
  globalThis.AudioContext=class{async decodeAudioData(){return pcm;}async close(){closes++;}};
  try{
    await decodeVoiceReference(new Blob(['input']));assert.equal(closes,1);
    pcm=referenceBuffer(2);await assert.rejects(()=>decodeVoiceReference(new Blob(['input'])),/3~10초/);assert.equal(closes,2);
    const controller=new AbortController();controller.abort();await assert.rejects(()=>decodeVoiceReference(new Blob(['input']),{signal:controller.signal}),error=>error.name==='AbortError');assert.equal(closes,2);
  }finally{globalThis.AudioContext=original;}
});

test('microphone recording closes tracks and late permission after cancel never starts recording',async()=>{
  const oldNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator'),oldRecorder=globalThis.MediaRecorder;let stopped=0,started=0,permission;
  const stream={getTracks:()=>[{stop(){stopped++;}}]};
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:()=>new Promise(resolve=>{permission=resolve;})}}});
  globalThis.MediaRecorder=class{static isTypeSupported(){return true;}constructor(){this.state='inactive';this.mimeType='audio/webm';}start(){started++;this.state='recording';}stop(){this.state='inactive';this.ondataavailable?.({data:new Blob(['voice'])});this.onstop?.();}};
  try{
    const late=recordVoiceReference();late.cancel();await assert.rejects(()=>late.promise,error=>error.name==='AbortError');permission(stream);await new Promise(setImmediate);assert.equal(started,0);assert.equal(stopped,1);
    const active=recordVoiceReference();permission(stream);await new Promise(setImmediate);active.stop();assert.ok((await active.promise).size>0);assert.equal(started,1);assert.equal(stopped,2);
  }finally{globalThis.MediaRecorder=oldRecorder;if(oldNavigator)Object.defineProperty(globalThis,'navigator',oldNavigator);else delete globalThis.navigator;}
});

test('voice mode UI preserves browser voices and exposes PC setup without public-page requests',()=>{
  const oldLocation=globalThis.location;globalThis.location={protocol:'https:',hostname:'example.com'};
  const owner={voice:{engine:'local',text:'원고 유지',voice:'F1',speed:1,steps:5,systemVoice:'',accepted:false},pcVoice:{status:null,error:'',checking:false,profileId:'',accepted:false},pcVoiceMarkup:StudioTools.prototype.pcVoiceMarkup};const host={innerHTML:''};
  try{
    StudioTools.prototype.renderVoice.call(owner,host);assert.match(host.innerHTML,/Supertonic 2/);assert.match(host.innerHTML,/원고 유지/);assert.match(host.innerHTML,/value="device"/);assert.match(host.innerHTML,/value="pc"/);
    owner.voice.engine='pc';StudioTools.prototype.renderVoice.call(owner,host);assert.match(host.innerHTML,/PC 사용 안내/);assert.match(host.innerHTML,/data-smart-action="voice" disabled/);assert.match(host.innerHTML,/원고 유지/);assert.doesNotMatch(host.innerHTML,/http:\/\/127\.0\.0\.1/);
    assert.match(host.innerHTML,/내 목소리 · VoxCPM2/);
    globalThis.location={protocol:'http:',hostname:'127.0.0.1'};
    owner.pcVoice.status={state:'ready',provider:'voxcpm2',localServer:true,profiles:[{id:'ref',name:'saved voice',duration:6,audioAvailable:true}]};owner.pcVoice.profileId='ref';
    StudioTools.prototype.renderVoice.call(owner,host);assert.match(host.innerHTML,/내 목소리 · VoxCPM2/);assert.match(host.innerHTML,/48kHz/);assert.doesNotMatch(host.innerHTML,/data-smart-action="voice" disabled/);
    owner.pcVoice.status.provider='gpt-sovits';StudioTools.prototype.renderVoice.call(owner,host);assert.match(host.innerHTML,/내 목소리 · GPT-SoVITS/);assert.doesNotMatch(host.innerHTML,/48kHz/);assert.match(host.innerHTML,/saved voice/);
  }finally{globalThis.location=oldLocation;}
});

test('private reference dialog captures file drops and paste before media import handlers',async()=>{
  reset();const saved=globalThis.document,before=captureDocument(),loaded=[],errors=[];let imports=0;
  const dialog=Object.assign(new EventTarget(),{open:true,setAttribute(){}}),library=new EventTarget(),inspector=new EventTarget(),overlay={hidden:false};
  const doc=Object.assign(new EventTarget(),{createElement:()=>dialog,body:{append(){}},getElementById:id=>({libraryContent:library,inspectorContent:inspector,dropOverlay:overlay}[id])});
  globalThis.document=doc;
  try{
    const owner=new StudioTools({});owner.state={kind:'voice-reference'};owner.loadVoiceReference=async file=>loaded.push(file);owner.showError=e=>errors.push(e);
    doc.addEventListener('drop',()=>imports++);doc.addEventListener('paste',()=>imports++);
    const file=new File(['private reference'],'private.wav',{type:'audio/wav'});
    const emit=type=>{const e=Object.assign(new Event(type,{cancelable:true}),type==='drop'?{dataTransfer:{files:[file]}}:{clipboardData:{files:[file]}});doc.dispatchEvent(e);return e;};
    assert.ok(emit('drop').defaultPrevented);assert.ok(emit('paste').defaultPrevented);await new Promise(setImmediate);
    assert.deepEqual(loaded,[file,file]);assert.equal(imports,0);assert.equal(overlay.hidden,true);assert.equal(errors.length,0);
    owner.state={kind:'mosaic'};emit('drop');assert.equal(loaded.length,2);assert.equal(imports,0);
    owner.state={kind:'voice-reference'};owner.job=new AbortController();emit('drop');assert.equal(loaded.length,2);
    dialog.open=false;emit('drop');assert.equal(imports,1);
    assert.equal(assets.size,0);assert.deepEqual(captureDocument(),before);
  }finally{globalThis.document=saved;}
});

test('closing the dialog cancels microphone acquisition before the asynchronous close event',()=>{
  const order=[],owner=Object.assign(Object.create(StudioTools.prototype),{
    referenceRecording:{cancel(){order.push('microphone');}},job:{abort(){order.push('request');}},
    dialog:{open:true,close(){order.push('dialog');}},
  });
  owner.close();assert.deepEqual(order,['microphone','request','dialog']);assert.equal(owner.referenceRecording,null);
});

function referenceUiOwner(){
  const progress={setAttribute(){}},cancel={textContent:''},body={querySelectorAll:()=>[],querySelector:selector=>selector.includes('cancel')?cancel:selector==='.smart-progress'?progress:null};
  const owner=Object.create(StudioTools.prototype),messages=[];let refreshed=0;
  owner.dialog={open:true,querySelector:()=>body,querySelectorAll:()=>[],close(){this.open=false;owner.cleanup();}};
  owner.job=null;owner.pcVoice={profileId:''};owner.state={kind:'voice-reference',name:'private identity',promptText:'private reference words',consent:true,reference:referenceFromPcm(referenceBuffer())};
  owner.progress=()=>{};owner.refreshPcVoice=async()=>{refreshed++;};owner.hooks={toast:m=>messages.push(m)};
  return {owner,messages,get refreshed(){return refreshed;}};
}

test('closing reference registration does not cancel a committed write and still refreshes the list',async()=>{
  const savedFetch=globalThis.fetch,savedLocation=globalThis.location;globalThis.location=pcLocation;let release,request;
  globalThis.fetch=async(url,options)=>{request=options;return new Promise(resolve=>{release=resolve;});};
  const ui=referenceUiOwner(),before=captureDocument();
  try{
    const pending=ui.owner.saveReference();await new Promise(setImmediate);ui.owner.close();
    assert.equal(request.signal.aborted,false);release(new Response('{"profile":{"id":"saved"}}',{status:201,headers:{'Content-Type':'application/json'}}));
    await pending;assert.equal(ui.owner.pcVoice.profileId,'saved');assert.equal(ui.refreshed,1);assert.match(ui.messages[0],/창은 닫혔지만/);assert.deepEqual(captureDocument(),before);
  }finally{globalThis.fetch=savedFetch;globalThis.location=savedLocation;}
});

test('reference registration refreshes storage state even when the response is lost',async()=>{
  const savedFetch=globalThis.fetch,savedLocation=globalThis.location;globalThis.location=pcLocation;
  globalThis.fetch=async()=>{throw new TypeError('connection lost after commit');};const ui=referenceUiOwner();
  try{await assert.rejects(()=>ui.owner.saveReference(),/연결이 끊겼/);assert.equal(ui.refreshed,1);assert.equal(ui.messages.length,0);}
  finally{globalThis.fetch=savedFetch;globalThis.location=savedLocation;}
});

test('reference deletion completes and refreshes after its dialog closes',async()=>{
  const savedFetch=globalThis.fetch,savedLocation=globalThis.location,savedConfirm=globalThis.confirm;globalThis.location=pcLocation;globalThis.confirm=()=>true;
  let release,request;globalThis.fetch=async(url,options)=>{request=options;return new Promise(resolve=>{release=resolve;});};
  const ui=referenceUiOwner();ui.owner.pcVoice.profileId='to-delete';ui.owner.open=()=>{ui.owner.dialog.open=true;};
  try{const pending=ui.owner.deleteReference();await new Promise(setImmediate);ui.owner.close();assert.equal(request.signal.aborted,false);
    release(new Response('{"deleted":true}',{headers:{'Content-Type':'application/json'}}));await pending;
    assert.equal(ui.owner.pcVoice.profileId,'');assert.equal(ui.refreshed,1);assert.match(ui.messages[0],/삭제했/);
  }finally{globalThis.fetch=savedFetch;globalThis.location=savedLocation;globalThis.confirm=savedConfirm;}
});

test('PC status refresh preserves the script textarea and cannot redraw a changed voice mode',async()=>{
  const saved={document:globalThis.document,fetch:globalThis.fetch,location:globalThis.location};globalThis.location=pcLocation;
  const textarea={value:'한글 입력 중',selectionStart:4},button={disabled:false};let renders=0,release;
  const settings={contains:()=>false,set innerHTML(value){renders++;},querySelector:()=>null};
  globalThis.document={activeElement:textarea,getElementById:id=>id==='pcVoiceSettings'?settings:id==='libraryContent'?{querySelector:()=>button}:null};
  globalThis.fetch=async()=>new Promise(resolve=>{release=resolve;});
  const owner=Object.assign(Object.create(StudioTools.prototype),{voice:{engine:'pc',text:'원고'},pcVoice:{checking:false,profileId:''},pcVoiceMarkup:()=>'<p>status</p>',hooks:{view:()=>'voice',renderLibrary(){throw new Error('must not replace the textarea');}}});
  try{
    const pending=owner.refreshPcVoice();assert.equal(renders,1);owner.voice.engine='local';textarea.value='한글 입력 계속';
    release(new Response('{"state":"ready","profiles":[{"id":"ref","audioAvailable":true}]}',{headers:{'Content-Type':'application/json'}}));await pending;
    assert.equal(renders,1);assert.equal(globalThis.document.activeElement,textarea);assert.equal(textarea.value,'한글 입력 계속');assert.equal(owner.voice.engine,'local');assert.equal(owner.pcVoice.profileId,'ref');
  }finally{Object.assign(globalThis,saved);}
});

test('PC generated voice round-trips as ordinary project audio without private reference state',async()=>{
  reset();const saved=globalThis.window,pcm=referenceBuffer(4),rate=pcm.sampleRate;
  globalThis.window={AudioContext:class{async decodeAudioData(){return {...pcm,duration:pcm.length/rate};}close(){}}};
  const calls=[],owner={state:{file:new File([encodeWav(pcm)],'AI 내 목소리.wav',{type:'audio/wav'}),before:captureDocument(),start:2,voice:{engine:'pc'}},
    pcVoice:{profileId:'private-ref-id',promptText:'private reference words'},run:async(kind,work)=>work(new AbortController().signal),close(){},
    hooks:{commit:(doc,label)=>calls.push(label),select(){},timeline:{reveal(){}},toast(){}}};
  try{
    await StudioTools.prototype.applyVoice.call(owner);assert.deepEqual(calls,['PC 내 목소리 음성 추가']);assert.equal(project.audio.tracks.length,1);assert.equal(project.audio.tracks[0].start,2);
    const expected=captureDocument(),packed=packProject(),raw=new TextDecoder().decode(await packed.arrayBuffer());
    assert.doesNotMatch(raw,/private-ref-id|private reference words|engineKey/);reset();await unpackProject(packed);
    assert.deepEqual(captureDocument(),expected);assert.equal(assets.size,1);assert.equal([...assets.values()][0].buffer.sampleRate,rate);
  }finally{globalThis.window=saved;reset();}
});

const pcAsrJobId='a'.repeat(32);
const pcAsrJson=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const pcAsrReady=(overrides={})=>({localServer:true,provider:'faster-whisper',model:'large-v3-turbo',modelName:'Whisper large-v3-turbo',configured:true,available:true,device:'cuda',computeType:'float16',busy:false,setupUrl:'/pc-asr-setup.html',...overrides});
const pcAsrResult=(overrides={})=>{const words=[{word:'안녕하세요.',start:.1,end:.8,probability:.9}];return {text:'안녕하세요.',words,segments:[{text:'안녕하세요.',start:0,end:1,words,timing:'word'}],model:'large-v3-turbo',device:'cuda',computeType:'float16',...overrides};};
const pcAsrPcm=()=>new Float32Array(16000).fill(.1);

test('PC ASR blocks public origins and checks the exact local provider without sending audio',async()=>{
  for(const location of [undefined,{protocol:'https:',hostname:'example.com'},{protocol:'http:',hostname:'127.0.0.1.evil.test'},{protocol:'http:',hostname:'192.168.1.2'},{protocol:'file:',hostname:''}]){
    assert.equal(isPcAsrOrigin(location),false);
    const options={location,fetchImpl:()=>{throw new Error('must never fetch');}};
    await assert.rejects(()=>pcAsrStatus(options),/PC용 로컬/);
    await assert.rejects(()=>transcribePcAudio(pcAsrPcm(),options),/PC용 로컬/);
  }
  assert.ok(isPcAsrOrigin(pcLocation));assert.ok(isPcAsrOrigin({protocol:'http:',hostname:'localhost'}));
  let call;
  const result=await pcAsrStatus({location:pcLocation,fetchImpl:async(url,options)=>{call={url,options};return pcAsrJson(pcAsrReady({setupUrl:'https://example.com/untrusted'}));}});
  assert.equal(result.setupUrl,'/pc-asr-setup.html');assert.equal(call.url,'/api/pc-asr/status');assert.equal(call.options.method,'GET');assert.equal(call.options.body,undefined);
  assert.equal(call.options.credentials,'omit');assert.equal(call.options.redirect,'error');assert.equal(call.options.cache,'no-store');assert.equal(call.options.headers['X-Studio-PC-ASR'],'1');
  const missing=await pcAsrStatus({location:pcLocation,fetchImpl:async()=>pcAsrJson(pcAsrReady({configured:false,available:false,device:null,computeType:null,reason:'초기 설치가 필요합니다.'}))});
  assert.equal(missing.available,false);assert.equal(missing.device,null);assert.match(missing.reason,/초기 설치/);
  for(const response of [()=>pcAsrJson(pcAsrReady({provider:'other'})),()=>pcAsrJson(pcAsrReady({model:'tiny'})),()=>new Response('<html>old server</html>',{headers:{'Content-Type':'text/html'}}),()=>new Response('{}',{headers:{'Content-Type':'application/json','Content-Length':String(65537)}})]){
    await assert.rejects(()=>pcAsrStatus({location:pcLocation,fetchImpl:async()=>response()}));
  }
});

test('PC ASR sends only bounded 16k mono PCM16 WAV after execution and polls the same job',async()=>{
  const calls=[],pcm=pcAsrPcm();let polls=0;
  const result=await transcribePcAudio(pcm,{location:pcLocation,pollInterval:1,onProgress:(value,message)=>calls.push({progress:value,message}),fetchImpl:async(url,options)=>{
    calls.push({url,options});
    if(url==='/api/pc-asr/transcribe')return pcAsrJson({jobId:pcAsrJobId},202);
    assert.equal(url,'/api/pc-asr/jobs/'+pcAsrJobId);return ++polls===1?pcAsrJson({state:'running',progress:null,message:'인식 중'}):pcAsrJson({state:'done',result:pcAsrResult()});
  }});
  assert.equal(result.model,'large-v3-turbo');assert.equal(polls,2);
  const post=calls.find(call=>call.options?.method==='POST'),view=new DataView(await post.options.body.arrayBuffer());
  assert.ok(post.options.body instanceof Blob);assert.equal(post.options.body.size,44+pcm.length*2);
  assert.equal(view.getUint16(20,true),1);assert.equal(view.getUint16(22,true),1);assert.equal(view.getUint32(24,true),16000);assert.equal(view.getUint16(34,true),16);
  assert.equal(post.options.headers['Content-Type'],'audio/wav');assert.equal(post.options.headers['X-Studio-Consent'],'audio-to-local-asr');
  for(const call of calls.filter(call=>call.url)){assert.ok(call.url.startsWith('/api/pc-asr/'));assert.equal(call.options.headers['X-Studio-PC-ASR'],'1');assert.equal(call.options.credentials,'omit');assert.equal(call.options.redirect,'error');}
  assert.ok(calls.some(call=>call.progress===null&&call.message==='인식 중'));
  for(const bad of [new Float32Array(),new Float32Array([NaN]),new Float32Array([Infinity]),new Float32Array(16000*180+1),[.1,.2]])assert.throws(()=>pcAsrWav(bad),/3분/);
});

test('PC ASR cancellation releases the UI before a late create response and cancels that job',async()=>{
  const ctrl=new AbortController(),calls=[];let release;
  const pending=transcribePcAudio(pcAsrPcm(),{location:pcLocation,signal:ctrl.signal,fetchImpl:async(url,options)=>{
    calls.push({url,options});
    if(url==='/api/pc-asr/transcribe')return new Promise(resolve=>{release=resolve;});
    assert.equal(url,'/api/pc-asr/cancel');return pcAsrJson({cancelled:true});
  }});
  ctrl.abort();await assert.rejects(()=>pending,error=>error.name==='AbortError');assert.equal(calls.length,1);
  release(pcAsrJson({jobId:pcAsrJobId},202));await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(calls.length,2);const cancel=calls[1];assert.deepEqual(JSON.parse(cancel.options.body),{jobId:pcAsrJobId});assert.equal(cancel.options.signal.aborted,false);
  assert.equal(cancel.options.headers['X-Studio-Consent'],'audio-to-local-asr');assert.equal(cancel.options.headers['Content-Type'],'application/json');
});

test('PC ASR discards late poll results and sends a separate cancellation request',async()=>{
  const ctrl=new AbortController(),calls=[];let releasePoll,polled;
  const reachedPoll=new Promise(resolve=>{polled=resolve;});
  const pending=transcribePcAudio(pcAsrPcm(),{location:pcLocation,signal:ctrl.signal,fetchImpl:async(url,options)=>{
    calls.push({url,options});
    if(url==='/api/pc-asr/transcribe')return pcAsrJson({jobId:pcAsrJobId},202);
    if(url==='/api/pc-asr/cancel')return pcAsrJson({cancelled:true});
    polled();return new Promise(resolve=>{releasePoll=resolve;});
  }});
  await reachedPoll;ctrl.abort();await assert.rejects(()=>pending,error=>error.name==='AbortError');
  releasePoll(pcAsrJson({state:'done',result:pcAsrResult()}));await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(calls.filter(call=>call.url==='/api/pc-asr/cancel').length,1);assert.equal(calls.filter(call=>call.url.includes('/jobs/')).length,1);
});

test('PC ASR timeout and failed jobs do not fall back to another engine',async()=>{
  let cancelled=0;
  await assert.rejects(()=>transcribePcAudio(pcAsrPcm(),{location:pcLocation,timeout:15,requestTimeout:100,fetchImpl:async(url)=>{
    if(url==='/api/pc-asr/transcribe')return pcAsrJson({jobId:pcAsrJobId},202);
    if(url==='/api/pc-asr/cancel'){cancelled++;return pcAsrJson({cancelled:true});}
    return new Promise(()=>{});
  }}),/처리 시간이 초과/);assert.equal(cancelled,1);
  for(const job of [{state:'failed',error:{code:'engine_failed',message:'GPU 메모리를 확인해 주세요.'}},{state:'cancelled'}]){
    const urls=[];
    await assert.rejects(()=>transcribePcAudio(pcAsrPcm(),{location:pcLocation,fetchImpl:async(url)=>{urls.push(url);return url.endsWith('/transcribe')?pcAsrJson({jobId:pcAsrJobId},202):pcAsrJson(job);}}));
    assert.deepEqual(urls,['/api/pc-asr/transcribe','/api/pc-asr/jobs/'+pcAsrJobId]);
  }
  const ctrl=new AbortController();ctrl.abort();await assert.rejects(()=>transcribePcAudio(pcAsrPcm(),{location:pcLocation,signal:ctrl.signal,fetchImpl:()=>{throw new Error('must never fetch');}}),error=>error.name==='AbortError');
  const urls=[];await assert.rejects(()=>transcribePcAudio(pcAsrPcm(),{location:pcLocation,fetchImpl:async(url)=>{urls.push(url);return pcAsrJson({jobId:'../../other'});}}),/작업 번호/);assert.deepEqual(urls,['/api/pc-asr/transcribe']);
});

test('PC ASR mixed word and segment timing preserves the full text without inventing word times',()=>{
  const result=pcAsrResult({text:'앞 문장 시각만 있는 문장 끝',words:[{word:'앞',start:.2,end:.8},{word:'끝',start:4.1,end:5}],segments:[
    {text:'앞',start:0,end:1,words:[{word:'앞',start:.2,end:.8}],timing:'word'},
    {text:'문장 시각만 있는 문장',start:1.2,end:3.8,words:[],timing:'segment'},
    {text:'끝',start:4,end:5,words:[{word:'끝',start:4.1,end:5}],timing:'word'},
  ]});
  const normalized=pcAsrCaptions(result,5,10);
  assert.deepEqual(normalized.captions.map(({text,start,end})=>({text,start,end})),[{text:'앞',start:10.2,end:10.8},{text:'문장 시각만 있는 문장',start:11.2,end:13.8},{text:'끝',start:14.1,end:15}]);
  assert.equal(normalized.text,result.text);assert.equal(normalized.segmentFallback,true);assert.equal(normalized.timingMode,'mixed');assert.equal(normalized.skipped,0);assert.ok(normalized.captions.every(c=>c.generated==='pc-whisper-turbo'));
  assert.equal(pcAsrCaptions({...result,skipped:3},5).skipped,3);
  const fallback=pcAsrCaptions(pcAsrResult({words:[],segments:[{text:'보존할 문장',start:-.1,end:3,words:[{word:'보존할',start:null,end:null}],timing:'segment'},{text:'범위 밖',start:4,end:5,words:[]}]}),2,7);
  assert.deepEqual(fallback.captions.map(({text,start,end})=>({text,start,end})),[{text:'보존할 문장',start:7,end:9}]);assert.equal(fallback.skipped,2);assert.equal(fallback.timingMode,'segment');
  assert.throws(()=>pcAsrCaptions(result,NaN));assert.throws(()=>pcAsrCaptions(result,2,-1));assert.throws(()=>pcAsrCaptions({...result,model:'tiny'},5));
});

test('PC ASR keeps Korean and number fragments in complete source words with real timings',()=>{
  const timed=rows=>rows.map(([word,start,end])=>({word,start,end}));
  const dateText='오늘은 2026년 8월 28일입니다.',priceText='영상 길이는 15초이고 가격은 12,000원입니다.';
  const dateWords=timed([['오늘은',.1,.5],[' 2026',.5,1.2],['년',1.2,1.4],[' 8',1.4,1.7],['월',1.7,1.8],[' 28',1.8,2.1],['일입니다.',2.1,2.8]]);
  const priceWords=timed([[' 영상',3.5,3.9],[' 길이는',3.9,4.4],[' 15',4.4,4.8],['초이고',4.8,5.2],[' 가격은',5.2,6.5],[' 12',6.5,6.82],[',000원입니다.',6.82,7.44]]);
  const segments=[
    {text:dateText,start:.1,end:2.8,words:dateWords,timing:'word'},
    {text:priceText,start:3.5,end:7.44,words:priceWords,timing:'word'},
  ];
  const result=pcAsrResult({text:dateText+' '+priceText,words:[...dateWords,...priceWords],segments});
  const original=structuredClone(result),normalized=pcAsrCaptions(result,8,10);
  assert.deepEqual(normalized.captions.map(({text,start,end})=>({text,start,end})),[
    {text:dateText,start:10.1,end:12.8},
    {text:'영상 길이는 15초이고 가격은',start:13.5,end:16.5},
    {text:'12,000원입니다.',start:16.5,end:17.44},
  ]);
  assert.equal(normalized.text,result.text);assert.equal(normalized.skipped,0);
  assert.equal(normalized.timingMode,'word');assert.equal(normalized.segmentFallback,false);assert.deepEqual(result,original);
});

test('PC ASR source word merging preserves separators and declines mismatches or invalid timing',()=>{
  const normalize=(text,rows)=>{
    const words=rows.map(([word,start,end])=>({word,start,end}));
    return pcAsrCaptions(pcAsrResult({text,words,segments:[{text,start:0,end:3,words,timing:'word'}]}),3,4);
  };
  for(const text of ['13,000원입니다.','12 ,000원입니다.']){
    const result=normalize(text,[['12',.1,.5],[',000원입니다.',.5,1]]);
    assert.deepEqual(result.captions.map(({text,start,end})=>({text,start,end})),[{text:'12 ,000원입니다.',start:4.1,end:5}]);
    assert.equal(result.text,text);
  }
  const separators=normalize('한/영·설명—끝.',[['한/',.1,.3],['영·',.3,.5],['설명—',.5,.7],['끝.',.7,1]]);
  assert.equal(separators.captions[0].text,'한/영·설명—끝.');
  const spanning=normalize('앞 문장 가격입니다.',[['앞 문장',.1,.8],[' 가',.8,1],['격',1,1.3],['입니다.',1.3,2]]);
  assert.deepEqual(spanning.captions.map(({text,start,end})=>({text,start,end})),[{text:'앞 문장 가격입니다.',start:4.1,end:6}]);
  const invalid=normalize('123원입니다.',[['1',.1,.3],['2',null,null],['3원입니다.',.5,1]]);
  assert.deepEqual(invalid.captions.map(({text,start,end})=>({text,start,end})),[{text:'1 3원입니다.',start:4.1,end:5}]);
  assert.equal(invalid.skipped,1);
});

test('PC ASR UI exposes setup and actual device while keeping hosted Tiny usable',()=>{
  reset();const saved=globalThis.location;
  const owner=Object.assign(Object.create(StudioTools.prototype),{captionScope:'selected',captionEngine:'local',pcAsr:{status:null,error:'',checking:false},audioRange:()=>({item:{name:'선택한 말소리'},duration:1})});
  try{
    globalThis.location={protocol:'https:',hostname:'example.com'};let html=owner.captionControls();assert.match(html,/value="local" selected/);assert.match(html,/Whisper Tiny/);assert.match(html,/pc-asr-setup.html/);assert.doesNotMatch(html,/http:\/\/127\.0\.0\.1|http:\/\/localhost/);
    owner.captionEngine='pc';html=owner.captionControls();assert.match(html,/현재 주소에서는 PC 서버에 연결하지/);assert.match(html,/data-smart-action="captions" disabled/);
    globalThis.location=pcLocation;owner.pcAsr.status=pcAsrReady();html=owner.captionControls();assert.match(html,/실행 장치: GPU \(CUDA\) · float16/);assert.doesNotMatch(html,/data-smart-action="captions" disabled/);
    owner.pcAsr.status=pcAsrReady({busy:true,reason:'이 PC에서만 처리합니다.'});html=owner.captionControls();assert.match(html,/다른 PC AI 작업이 진행 중/);assert.match(html,/data-smart-action="captions" disabled/);
    owner.pcAsr.status=pcAsrReady({device:'cpu',computeType:'int8'});assert.match(owner.captionControls(),/실행 장치: CPU · int8/);
    owner.pcAsr.status=pcAsrReady({available:false,configured:false});assert.match(owner.captionControls(),/초기 설치/);assert.match(owner.captionControls(),/data-smart-action="captions" disabled/);assert.equal(owner.captionEngine,'pc');
    assert.equal(pcAsrDeviceLabel({device:'unknown'}),'실행 장치 미확인');
  }finally{globalThis.location=saved;reset();}
});

test('PC ASR status selects installed Turbo once without overwriting a later Tiny choice or caption drafts',async()=>{
  const saved={location:globalThis.location,fetch:globalThis.fetch,document:globalThis.document};globalThis.location=pcLocation;
  const textarea={value:'자막 수정 중'},engine={value:'local'},create={disabled:false},settings={contains:()=>false,innerHTML:'',querySelector:()=>null};
  globalThis.document={activeElement:textarea,getElementById:id=>id==='pcAsrSettings'?settings:id==='libraryContent'?{querySelector:selector=>selector.includes('caption-engine')?engine:create}:null};
  const owner=Object.assign(Object.create(StudioTools.prototype),{captionScope:'selected',captionEngine:'local',captionEngineChosen:false,pcAsr:{status:null,error:'',checking:false},audioRange:()=>({duration:1}),hooks:{view:()=>'captions',renderLibrary(){throw new Error('must not redraw caption drafts');}}});
  try{
    globalThis.fetch=async()=>pcAsrJson(pcAsrReady());await owner.refreshPcAsr();assert.equal(owner.captionEngine,'pc');assert.equal(engine.value,'pc');assert.equal(create.disabled,false);assert.equal(globalThis.document.activeElement,textarea);assert.equal(textarea.value,'자막 수정 중');
    let release;globalThis.fetch=async()=>new Promise(resolve=>{release=resolve;});const pending=owner.refreshPcAsr();owner.captionEngine='local';owner.captionEngineChosen=true;release(pcAsrJson(pcAsrReady()));await pending;
    assert.equal(owner.captionEngine,'local');assert.equal(engine.value,'local');assert.equal(textarea.value,'자막 수정 중');
    owner.captionEngine='pc';globalThis.fetch=async()=>pcAsrJson(pcAsrReady({available:false}));await owner.refreshPcAsr();assert.equal(owner.captionEngine,'pc');assert.equal(create.disabled,true);
    globalThis.location={protocol:'https:',hostname:'example.com'};globalThis.fetch=()=>{throw new Error('must never fetch');};await owner.refreshPcAsr();
  }finally{Object.assign(globalThis,saved);}
});

test('PC ASR review applies only on consent and preserves existing captions and trimmed timeline offset',async()=>{
  reset();project.captions=[{id:'keep-caption',text:'기존 자막',trackId:'v3',start:0,end:1}];
  const saved={location:globalThis.location,fetch:globalThis.fetch,confirm:globalThis.confirm,Worker:globalThis.Worker};globalThis.location=pcLocation;
  const before=captureDocument(),history=new History(),calls=[],pcm=referenceBuffer(2);let confirms=0;
  const owner=Object.assign(Object.create(StudioTools.prototype),{captionEngine:'pc',captionEngineChosen:false,captionScope:'selected',pcAsr:{status:pcAsrReady(),checking:false},dialog:{open:false},
    audioRange:()=>({type:'audio',id:'selected-audio',start:7,duration:1,item:{name:'말소리',buffer:pcm,trimStart:.25,trimEnd:1.25}}),
    open(){this.dialog.open=true;},setBody(html){this.review=html;},progress(){},async run(kind,work){return work(new AbortController().signal);},async refreshPcAsr(){},close(){this.dialog.open=false;},
    hooks:{commit:(document,label)=>{calls.push(label);history.push(document,label);},select(){},timeline:{reveal(){}},toast(){}}});
  try{
    globalThis.Worker=class{constructor(){throw new Error('must not fall back to Tiny');}};
    globalThis.fetch=async(url,options)=>{calls.push(url);return url.endsWith('/transcribe')?pcAsrJson({jobId:pcAsrJobId},202):pcAsrJson({state:'done',result:pcAsrResult({text:'문장 단위 보존',words:[],segments:[{text:'문장 단위 보존',start:.1,end:.8,words:[],timing:'segment'}]})});};
    globalThis.confirm=()=>{confirms++;return false;};await owner.openCaptions();assert.equal(calls.length,0);assert.deepEqual(captureDocument(),before);
    globalThis.confirm=()=>{confirms++;return true;};await owner.openCaptions();assert.equal(confirms,2);assert.equal(owner.state.engine,'pc');assert.equal(owner.state.captions[0].start,7.1);assert.equal(owner.state.captions[0].end,7.8);
    assert.match(owner.review,/실제 문장 시각으로 보존/);assert.match(owner.review,/전체 인식 원문/);assert.match(owner.review,/GPU \(CUDA\)/);assert.deepEqual(captureDocument(),before);
    owner.applyCaptions();assert.equal(project.captions.length,2);assert.equal(project.captions[0].text,'기존 자막');assert.notEqual(project.captions[0].trackId,project.captions[1].trackId);assert.equal(calls.at(-1),'PC Turbo 자동 자막 추가');assert.equal(assets.size,0);
    assert.equal(history.undo(),'PC Turbo 자동 자막 추가');assert.deepEqual(captureDocument(),before);
    owner.pcAsr.status=pcAsrReady({available:false});globalThis.confirm=()=>{throw new Error('must not run');};await assert.rejects(()=>owner.openCaptions(),/Tiny로 자동 전환하지/);assert.equal(owner.captionEngine,'pc');
  }finally{Object.assign(globalThis,saved);reset();}
});
