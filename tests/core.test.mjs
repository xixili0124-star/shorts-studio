// npm 설치 없이 실행하는 계산·저장·렌더러 회귀 검사입니다.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {project,newClipDefaults,buildLayout,layersAt,clipAt,anchorItem,syncAnchoredItems,clipFadeGain,clipDuration,clipStartTime,pinClipPositions,transitionPairs,totalDuration} from '../public/js/state.js';
import {assets,addAsset,makeClip,makeAudio,captureDocument,restoreDocument,History,packProject,unpackProject,validateDocument,clearAssets,waveformOf,demoSound} from '../public/js/project-store.js';
import {encodeWav,transcriptionCaptions} from '../public/js/ai-client.js';
import {renderFrame} from '../public/js/render.js';
import {Player} from '../public/js/player.js';
import {GRAPHICS,CAPTIONS} from '../public/js/presets.js';
import {frameTime,itemRange,splitAvailability,splitTimelineItem,setItemRange,planVideoPlacement,placeVideoClip,setTransition,planClipTrim,applyClipTrim,deleteTimelineItem} from '../public/js/timeline-edits.js';
import {Timeline} from '../public/js/timeline.js';
import {applyFade,mixTimeline} from '../public/js/audio.js';

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

test('short clips never produce three active layers or audio gain over one',()=>{
  reset();project.clips=[clip('a',.4,2),clip('b',.2,2),clip('c',.4,2)];
  const layout=buildLayout();assert.equal(layout.entries[0].overlapOut,.1);assert.equal(layout.entries[1].overlapOut,.1);
  for(let t=0;t<layout.total;t+=.001){const ls=layersAt(t);assert.ok(ls.length<=2);assert.ok(Math.abs(ls.reduce((s,l)=>s+l.weight,0)-1)<1e-8);}
});

test('optional anchors preserve duration during reorder/trim and detach when their video is deleted',()=>{
  reset();const a={...clip('a',4),type:'video',trimStart:10,trimEnd:14};const b=clip('b',3);project.clips=[a,b];
  const cap={id:'cap',text:'caption',start:1,end:2};project.captions=[cap];anchorItem(cap,'a');
  project.clips=[b,a];syncAnchoredItems();assert.deepEqual([cap.start,cap.end],[4,5]);
  a.trimStart=11.5;syncAnchoredItems();assert.deepEqual([cap.start,cap.end],[2.5,3.5]);
  project.clips=[b];syncAnchoredItems();assert.deepEqual([cap.start,cap.end],[2.5,3.5]);assert.equal(cap.anchor,undefined);
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
  project.captions=[{id:'saved-caption',text:'Round trip',start:1,end:2}];
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

test('all six graphics and eight caption presets render with the shared canvas path', {skip:!canvasModule},()=>{
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
  for(let i=0;i<entries.length;i++){
    const e=entries[i];assert.ok(Number.isFinite(e.start)&&e.start>=0);assert.ok(e.duration>=1/project.fps-1e-7);
    if(entries[i+1]&&e.end>entries[i+1].start+1e-6)assert.ok(e.overlapOut>0);
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

test('save/undo preserves explicit starts and migrates old contiguous projects to version 2',async()=>{
  reset();project.clips=[await fixtureClip('a'),await fixtureClip('b',3)];
  project.clips[0].transitionOut={type:'dissolve',duration:1};
  const legacy=captureDocument();legacy.version=1;for(const c of legacy.clips){delete c.start;delete c.transitionOut.toId;}
  restoreDocument(legacy);
  const before=captureDocument();assert.equal(before.version,2);assert.deepEqual(before.clips.map(c=>c.start),[0,3]);assert.equal(before.clips[0].transitionOut.toId,'b');
  assert.equal(new History().push(before,'no change'),false);
  const history=new History();placeVideoClip(project.clips[1],planVideoPlacement(9,3,'b'));history.push(before,'move');
  assert.deepEqual(captureDocument().clips.map(c=>c.start),[0,9]);history.undo();assert.deepEqual(captureDocument(),before);
  history.redo();assert.deepEqual(captureDocument().clips.map(c=>c.start),[0,9]);
});

test('S splits only the selected video while caption, graphic and audio timing stays intact',async()=>{
  reset();project.clips=[await fixtureClip('video',6,'video',{start:2})];
  project.captions=[{id:'caption',text:'whole caption',start:2,end:8}];project.overlays=[{id:'graphic',text:'whole graphic',start:2,end:8}];
  anchorItem(project.captions[0],'video');anchorItem(project.overlays[0],'video');
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
  assert.deepEqual(project.clips.map(c=>c.start),[0,3,9]);assert.deepEqual(project.captions[0],{id:'c1',text:'independent',start:3,end:12});
  assert.throws(()=>setTransition('b','c','dissolve',.5),/맞닿은/);
  setTransition('a','b','flash',.5);assert.deepEqual(project.clips.map(c=>c.start),[0,3.5,9.5]);
  setTransition('a','b','dissolve',0);assert.equal(transitionPairs()[0].type,'cut');assert.deepEqual(project.clips.map(c=>c.start),[0,4,10]);
});

test('Delete leaves a gap; ripple delete closes time on just the selected track/lane',()=>{
  for(const ripple of [false,true]){
    reset();project.clips=[{...clip('a',3),start:0},{...clip('b',3),start:3},{...clip('c',3),start:6}];
    project.captions=[{id:'cap',text:'keep',start:4,end:8}];project.audio.tracks=[{id:'audio',lane:'music',start:1,trimStart:0,trimEnd:8}];
    const others=JSON.stringify([project.captions,project.audio.tracks]);deleteTimelineItem({type:'clip',id:'b'},ripple);
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
    project.overlays=[{id:'g',text:'keep',start:4,end:7}];anchorItem(project.overlays[0],'b');
    deleteTimelineItem({type:'clip',id:'b'},ripple);
    assert.deepEqual(buildLayout().entries.map(e=>e.start),[0,ripple?4:6]);assertValidLayout();
    assert.deepEqual(project.overlays[0],{id:'g',text:'keep',start:4,end:7});
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

test('drag metadata produces a full-duration ghost with the exact committed placement',async()=>{
  reset();project.clips=[await fixtureClip('a',4,'image',{start:0}),await fixtureClip('b',4,'image',{start:4})];
  await fixtureClip('source-video',7.25,'video');await fixtureClip('source-image',9);
  const timeline=Object.create(Timeline.prototype);Object.assign(timeline,{zoom:100,time:0,snapping:false,canvas:{getBoundingClientRect:()=>({left:0})}});
  timeline.external={kind:'asset',id:'asset-source-image'};const imagePlan=timeline.externalPlan(900,'clips');assert.deepEqual([imagePlan.start,imagePlan.end],[9,12]);
  timeline.external={kind:'asset',id:'asset-source-video'};const videoPlan=timeline.externalPlan(400,'audio');
  assert.equal(videoPlan.lane,'clips');assert.equal(videoPlan.end-videoPlan.start,7.25);
  const inserted=await makeClip('asset-source-video');const actual=placeVideoClip(inserted,videoPlan.placement);assert.deepEqual([actual.start,actual.end],[videoPlan.start,videoPlan.end]);
  timeline.external={kind:'preset',id:'g:pop'};assert.equal(timeline.externalPlan(1800,'voice').end,21);
  timeline.external={kind:'preset',id:'c:pill'};assert.equal(timeline.externalPlan(1800,'clips').lane,'captions');
  timeline.external={kind:'preset',id:'t:dissolve'};assert.equal(timeline.externalPlan(1800,'clips'),null);
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
