// npm 설치 없이 실행하는 계산·저장·렌더러 회귀 검사입니다.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {project,newClipDefaults,buildLayout,layersAt,clipAt,anchorItem,syncAnchoredItems,clipFadeGain} from '../public/js/state.js';
import {assets,addAsset,makeClip,makeAudio,captureDocument,restoreDocument,History,packProject,unpackProject,validateDocument,clearAssets,waveformOf,demoSound} from '../public/js/project-store.js';
import {encodeWav,transcriptionCaptions} from '../public/js/ai-client.js';
import {renderFrame} from '../public/js/render.js';
import {Player} from '../public/js/player.js';
import {GRAPHICS,CAPTIONS} from '../public/js/presets.js';

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

test('anchored captions follow reorder, source trimming, and deletion',()=>{
  reset();const a={...clip('a',4),type:'video',trimStart:10,trimEnd:14};const b=clip('b',3);project.clips=[a,b];
  const cap={id:'cap',text:'caption',start:1,end:2};project.captions=[cap];anchorItem(cap,'a');
  project.clips=[b,a];syncAnchoredItems();assert.deepEqual([cap.start,cap.end],[4,5]);
  a.trimStart=11.5;syncAnchoredItems();assert.deepEqual([cap.start,cap.end],[3,3.5]);
  project.clips=[b];syncAnchoredItems();assert.equal(cap.start,cap.end);
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
  const a=await addAsset(photo,{id:'saved-image'});project.clips=[await makeClip(a.id,{id:'saved-clip',imgDuration:5,scale:1.2})];
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
