// 실제 키 보간·좌표 계산과 합성 프레임 추적을 검사합니다. 외부 모델이나 미디어는 쓰지 않습니다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { KEYFRAME_CHANNELS, keyframeValue, evaluateItem, setKeyframe, removeKeyframe, moveKeyframe, setValueAt, sliceKeyframes, splitKeyframes, validateKeyframes } from '../public/js/keyframes.js';
import { cropTrackingAt, cropTrackingGeometry, validCropTracking, cropTrackingWarnings, sliceCropTracking, splitCropTracking, smoothCropKeys, trackCrop } from '../public/js/crop-tracking.js';
import { trackingTemplate, trackRectangle } from '../public/js/mosaic.js';
import { transformOf, transformPoint, inverseTransformPoint, visualCorners, withVisualTransform, alignVisual } from '../public/js/visual-transform.js';
import { MonitorEditor } from '../public/js/monitor-editor.js';
import { StudioTools } from '../public/js/studio-tools.js';
import { project, newClipDefaults } from '../public/js/state.js';
import { captureDocument } from '../public/js/project-store.js';
import { renderFrame } from '../public/js/render.js';

const require=createRequire(import.meta.url);
let canvasModule;try{canvasModule=require(process.env.STUDIO_CANVAS_MODULE||'@napi-rs/canvas');}catch{}

const near = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const keyed = () => {
  const item = { transform: { offsetX: .25, opacity: .8 }, volume: 1 };
  setKeyframe(item, 'offsetX', 0, -.2);setKeyframe(item, 'offsetX', 4, .6);
  setKeyframe(item, 'opacity', 0, .2);setKeyframe(item, 'opacity', 4, 1);
  setKeyframe(item, 'volume', 0, .5);setKeyframe(item, 'volume', 4, 2.5);
  return item;
};

test('keyframes interpolate clip-local transform and volume without mutating the source', () => {
  const item = keyed(), before = structuredClone(item), evaluated = evaluateItem(item, 2);
  near(evaluated.transform.offsetX, .2);near(evaluated.transform.opacity, .6);near(evaluated.volume, 1.5);
  assert.equal(evaluated.keyframes, undefined);assert.deepEqual(item, before);
  evaluated.transform.offsetX = 2;assert.deepEqual(item, before);
  near(keyframeValue(item, 'offsetX', -5), -.2);near(keyframeValue(item, 'offsetX', 30), .6);
  near(keyframeValue({}, 'scaleX', 2), 1);
});

test('hold interpolation switches at the exact next key and key movement replaces collisions', () => {
  const item = {};setKeyframe(item, 'opacity', 0, .1, { easing: 'hold' });setKeyframe(item, 'opacity', 2, .8);
  near(keyframeValue(item, 'opacity', 1.999), .1);near(keyframeValue(item, 'opacity', 2), .8);
  assert.equal(moveKeyframe(item, 'opacity', 2, 3), true);near(keyframeValue(item, 'opacity', 2), .1);
  assert.equal(moveKeyframe(item, 'opacity', 3, 0), true);assert.equal(item.keyframes.tracks.opacity.length, 1);
  near(keyframeValue(item, 'opacity', 0), .8);assert.equal(removeKeyframe(item, 'opacity', 0), true);
  assert.equal(item.keyframes, undefined);assert.equal(removeKeyframe(item, 'opacity', 0), false);
});

test('animated property edits change the current key while static edits stay static', () => {
  const item = keyed(), before = structuredClone(item);
  setValueAt(item, 'offsetX', 2, .3);setValueAt(item, 'scaleY', 2, 1.5);
  near(keyframeValue(item, 'offsetX', 2), .3);near(item.transform.offsetX, before.transform.offsetX);
  assert.equal(item.keyframes.tracks.scaleY, undefined);assert.equal(item.transform.scaleY, 1.5);
  setValueAt(item, 'scaleX', 2, 1.7, { autoKey: true });near(keyframeValue(item, 'scaleX', 2), 1.7);
  assert.throws(() => setKeyframe(item, 'volume', 1, 3.01));assert.throws(() => setKeyframe(item, 'rotation', NaN, 0));
});

test('split and trim preserve sampled channel values and hold boundaries', () => {
  const item = keyed();setKeyframe(item, 'scaleX', 0, 1, { easing: 'hold' });setKeyframe(item, 'scaleX', 2, 2);
  const before = structuredClone(item), pieces = splitKeyframes(item, 1.3, 4), trimmed = sliceKeyframes(item, .7, 3.7);
  for (const t of [0, .2, 1.3, 1.8, 2, 3.4, 4]) {
    const keyframes = t < 1.3 ? pieces.left : pieces.right, local = t < 1.3 ? t : t - 1.3;
    for (const channel of KEYFRAME_CHANNELS) near(keyframeValue({ ...item, keyframes }, channel, local), keyframeValue(item, channel, t));
  }
  for (const t of [0, .4, 1.3, 2.7, 3]) for (const channel of KEYFRAME_CHANNELS) near(keyframeValue({ ...item, keyframes: trimmed }, channel, t), keyframeValue(item, channel, t + .7));
  assert.equal(validateKeyframes(pieces.left, 1.3), true);assert.equal(validateKeyframes(pieces.right, 2.7), true);
  assert.deepEqual(item, before);assert.deepEqual(splitKeyframes({}, 1, 2), { left: undefined, right: undefined });
});

test('range extension holds the first or last value and malformed key data is rejected', () => {
  const item = keyed(), extended = { ...item, keyframes: sliceKeyframes(item, -1, 5) };
  near(keyframeValue(extended, 'offsetX', 0), -.2);near(keyframeValue(extended, 'offsetX', 6), .6);
  for (const change of [data => data.tracks.offsetX.push({ time: 4, value: 0 }), data => data.tracks.opacity[0].value = Infinity,
    data => data.tracks.offsetX[0].time = -1, data => data.tracks.volume[0].value = 3.1, data => data.tracks.unknown = [{ time: 0 }] ]) {
    const data = structuredClone(item.keyframes);change(data);assert.equal(validateKeyframes(data), false);
  }
});

test('time-aware visual geometry and inverse coordinates agree at an interpolated key', () => {
  const item = keyed(), bounds = { x: 100, y: 80, w: 400, h: 300 }, W = 1080, H = 1920;
  setKeyframe(item, 'rotation', 0, 0);setKeyframe(item, 'rotation', 4, 90);
  setKeyframe(item, 'scaleX', 0, 1);setKeyframe(item, 'scaleX', 4, 2);
  const point = { x: 130, y: 140 }, screen = transformPoint(point, bounds, item, W, H, 2);
  const back = inverseTransformPoint(screen, bounds, item, W, H, 2);
  near(back.x, point.x);near(back.y, point.y);
  assert.deepEqual(visualCorners(bounds, item, W, H, 2), visualCorners(bounds, evaluateItem(item, 2), W, H));
  near(transformOf(item, 2).rotation, 45);
});

test('shared visual paint applies timed opacity once and alignment edits the current key', () => {
  const item = keyed(), bounds = { x: 100, y: 80, w: 400, h: 300 }, W = 1080, H = 1920;
  const ctx = { globalAlpha: .5, save() {}, restore() {}, translate() {}, rotate() {}, scale() {} };
  let painted;withVisualTransform(ctx, bounds, item, W, H, () => { painted = ctx.globalAlpha; }, 2);
  near(painted, .3);alignVisual(item, bounds, W, H, 'x', 2);
  const corners = visualCorners(bounds, item, W, H, 2);near(corners.reduce((sum, point) => sum + point.x, 0) / 4, W / 2);
  near(keyframeValue(item, 'offsetX', 0), -.2);near(keyframeValue(item, 'offsetX', 4), .6);
});

const cropKey = (time, x, lost = false) => ({ time, x, y: .25, w: .2, h: .3, confidence: lost ? .2 : .95, lost });
const tracked = keys => ({ cropTracking: { version: 1, enabled: true, zoom: 1.15, anchorX: .5, anchorY: .5, keys } });

test('crop framing centers a selected subject and clamps panning to avoid new empty edges', () => {
  const clip = tracked([cropKey(0, .4), cropKey(2, .6)]), geometry = { dx: -1100, dy: 0, dw: 3280, dh: 1920 };
  const middle = cropTrackingAt(clip, 1), output = cropTrackingGeometry(clip, 1, geometry, 1080, 1920);
  near(output.dx + (middle.x + middle.w / 2) * output.dw, 540);
  const edge = tracked([cropKey(0, 0), cropKey(2, 0)]), shifted = cropTrackingGeometry(edge, 0, geometry, 1080, 1920);
  assert.ok(shifted.dx <= 0 && shifted.dx + shifted.dw >= 1080);
  assert.ok(shifted.dy <= 0 && shifted.dy + shifted.dh >= 1920);
  clip.cropTracking.enabled = false;assert.equal(cropTrackingGeometry(clip, 1, geometry, 1080, 1920), geometry);
});

test('lost tracking freezes its last location and does not interpolate across an occlusion', () => {
  const clip = tracked([cropKey(0, .1), cropKey(1, .3), cropKey(1.1, .3, true), cropKey(2, .3, true), cropKey(3, .7)]);
  near(cropTrackingAt(clip, 1.7).x, .3);near(cropTrackingAt(clip, 2.9).x, .3);
  assert.equal(cropTrackingAt(clip, 1.7).lost, true);assert.equal(cropTrackingAt(clip, 3).lost, false);
  assert.equal(cropTrackingAt(clip, 5).lost, true);assert.ok(cropTrackingWarnings(clip).length);
  const smoothed = smoothCropKeys(clip.cropTracking.keys, .5);near(smoothed[2].x, .3);near(smoothed[3].x, .3);
  const jitter=[cropKey(0,.1),cropKey(.1,.3),cropKey(.2,.1)];assert.ok(smoothCropKeys(jitter,.15)[1].x<.3);
});

test('crop split and trim preserve the camera path including a lost segment', () => {
  const clip = tracked([cropKey(0, .1), cropKey(1, .3), cropKey(2, .3, true), cropKey(3, .3, true), cropKey(4, .6)]);
  const before = structuredClone(clip), split = splitCropTracking(clip, 1.5, 4), cropTracking = sliceCropTracking(clip, 2.1, 3.9);
  for (const time of [0, .3, 1, 1.5, 1.8, 2.5, 3.5, 4]) {
    const part = { cropTracking: time < 1.5 ? split.left : split.right }, local = time < 1.5 ? time : time - 1.5;
    const expected = cropTrackingAt(clip, time), actual = cropTrackingAt(part, local);
    near(actual.x, expected.x);assert.equal(actual.lost, expected.lost);
  }
  near(cropTrackingAt({ cropTracking }, .8).x, cropTrackingAt(clip, 2.9).x);
  assert.equal(validCropTracking(split.left, 1.5), true);assert.equal(validCropTracking(split.right, 2.5), true);
  clip.cropTracking.enabled = false;assert.equal(sliceCropTracking(clip, 1, 2).enabled, false);
  clip.cropTracking.enabled = true;assert.deepEqual(clip, before);
});

test('crop path validation rejects nonfinite coordinates, duplicate times and invalid zoom', () => {
  const clip = tracked([cropKey(0, .2), cropKey(1, .3)]);assert.equal(validCropTracking(clip.cropTracking, 1), true);
  for (const change of [data => data.keys[0].x = NaN, data => data.keys[1].time = 0, data => data.keys[0].w = 2, data => data.zoom = 8]) {
    const data = structuredClone(clip.cropTracking);change(data);assert.equal(validCropTracking(data), false);
  }
});

// 원본 무늬를 유지한 채 작은 사각형만 이동시키는 합성 프레임입니다.
function movingFrame(left, top, visible = true) {
  const W = 160, H = 100, width = 40, height = 32, pixels = new Float32Array(W * H).fill(.12);
  if (visible) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const noise = ((x * 37 + y * 71 + x * y * 13) % 97) / 97;
    pixels[(top + y) * W + left + x] = .2 + .75 * noise;
  }
  return { gray: pixels, width: W, height: H, rect: { x: left / W, y: top / H, w: width / W, h: height / H } };
}

test('real template tracker follows synthetic moving frames and drives the crop path', async () => {
  const frames = Array.from({ length: 5 }, (_, index) => movingFrame(30 + index * 3, 28 + index));
  const first = frames[0], template = trackingTemplate(first.gray, first.width, first.height, first.rect);
  let previous = first.rect;
  const keys = [{ ...first.rect, time: 12, duration: .1, confidence: 1, lost: false }];
  for (let index = 1; index < frames.length; index++) {
    const frame = frames[index], result = trackRectangle(frame.gray, frame.width, frame.height, template, previous);
    assert.equal(result.lost, false, 'moving frame ' + index);
    near(result.x, frame.rect.x, 3 / frame.width);near(result.y, frame.rect.y, 3 / frame.height);
    keys.push({ ...result, time: 12 + index / 10, duration: .1 });previous = result;
  }
  const clip = { type: 'video', trimStart: 12, trimEnd: 12.5 };
  let sourceSeed;
  const result = await trackCrop(clip, first.rect, .2, { smoothing: 0, analyze: async (item, effect, seed) => { sourceSeed = seed;return { keyframes: keys }; } });
  near(sourceSeed, 12.2);assert.equal(result.warnings.length, 0);
  assert.equal(validCropTracking(result.tracking, .5), true);assert.equal(result.tracking.keys[0].time, 0);
  near(result.tracking.keys.at(-1).time, .5);assert.ok(result.tracking.keys.at(-1).x > result.tracking.keys[0].x);
});

test('template tracking rejects blank targets and records occlusion without fabricating movement', async () => {
  const seed = movingFrame(30, 28), blank = movingFrame(30, 28, false);
  assert.throws(() => trackingTemplate(blank.gray, blank.width, blank.height, blank.rect));
  const template = trackingTemplate(seed.gray, seed.width, seed.height, seed.rect);
  const lost = trackRectangle(blank.gray, blank.width, blank.height, template, seed.rect);
  assert.equal(lost.lost, true);near(lost.x, seed.rect.x);near(lost.y, seed.rect.y);
  const result = await trackCrop({ type: 'video', trimStart: 4, trimEnd: 4.3 }, seed.rect, 0,
    { analyze: async () => ({ keyframes: [{ ...seed.rect, time: 4, duration: .1, confidence: 1, lost: false }, { ...lost, time: 4.1, duration: .1 }, { ...lost, time: 4.3, duration: .1 }] }) });
  assert.ok(result.warnings.length);near(cropTrackingAt({ cropTracking: result.tracking }, .2).x, seed.rect.x);
});

test('crop analysis supports cancellation before and after the asynchronous tracker', async () => {
  const clip = { type: 'video', trimStart: 0, trimEnd: 1 }, rect = movingFrame(30, 28).rect;
  const first = new AbortController();first.abort();let called = false;
  await assert.rejects(trackCrop(clip, rect, 0, { signal: first.signal, analyze: async () => { called = true; } }), { name: 'AbortError' });
  assert.equal(called, false);
  const second = new AbortController();
  await assert.rejects(trackCrop(clip, rect, 0, { signal: second.signal, analyze: async () => { second.abort();return { keyframes: [] }; } }), { name: 'AbortError' });
  await assert.rejects(trackCrop({ ...clip, trimEnd: 181 }, rect, 0), /3분/);
});

test('monitor transform editing updates local keys and leaves other channels and base values intact', () => {
  const item = keyed(), original = structuredClone(item), time = 2;
  const target = { item, localTime: time, entry: { start: 10, end: 14 }, autoKey: false,
    original: { transform: structuredClone(item.transform), keyframes: structuredClone(item.keyframes) }, initial: { transform: transformOf(item, time) } };
  const editor = Object.create(MonitorEditor.prototype);editor.player = { time: 12 };
  near(editor.localTime(target.entry), 2);
  editor.applyTransform(target, { ...target.initial.transform, offsetX: .35, scaleX: 1.4 });
  near(keyframeValue(item, 'offsetX', 2), .35);near(item.transform.offsetX, original.transform.offsetX);
  assert.equal(item.transform.scaleX, 1.4);assert.equal(item.keyframes.tracks.scaleX, undefined);
  assert.deepEqual(item.keyframes.tracks.volume, original.keyframes.tracks.volume);
  editor.applyTransform(target, target.initial.transform);
  assert.deepEqual(item, original);
});

test('monitor crop is unavailable for captions, graphics and mixed selections', () => {
  const editor = Object.create(MonitorEditor.prototype);
  assert.equal(editor.canCrop([{ type: 'clip' }]), true);
  assert.equal(editor.canCrop([{ type: 'caption' }]), false);
  assert.equal(editor.canCrop([{ type: 'graphic' }]), false);
  assert.equal(editor.canCrop([{ type: 'clip' }, { type: 'caption' }]), false);
});

function cropToolsFixture(){
  const previous=structuredClone(project),clip={...newClipDefaults('video'),id:'crop-test',name:'synthetic',start:0,trimStart:2,trimEnd:6,srcDuration:6,natW:160,natH:100,fit:'contain'};
  project.clips=[clip];project.captions=[];project.overlays=[];project.audio.tracks=[];
  const before=captureDocument(),tools=Object.create(StudioTools.prototype),commits=[];
  tools.state={kind:'crop-tracking',clip,range:{duration:4},before,tracking:tracked([cropKey(0,.2),cropKey(4,.4)]).cropTracking,zoom:1.4,pending:false};
  tools.hooks={commit:(snapshot,label)=>commits.push({snapshot,label}),toast(){}};tools.close=()=>{};
  return {tools,clip,before,commits,restore:()=>Object.assign(project,previous)};
}

test('crop dialog applies only confirmed results and removal preserves independent keyframes',()=>{
  const fixture=cropToolsFixture(),{tools,clip,commits}=fixture;
  try{
    setKeyframe(clip,'offsetX',0,.1);tools.state.before=captureDocument();const keys=structuredClone(clip.keyframes);
    tools.state.pending=true;assert.throws(()=>tools.applyCropTracking(),/추적/);assert.equal(clip.cropTracking,undefined);assert.equal(commits.length,0);
    tools.state.pending=false;tools.applyCropTracking();assert.equal(commits.length,1);assert.equal(clip.fit,'cover');near(clip.cropTracking.zoom,1.4);
    assert.notEqual(clip.cropTracking,tools.state.tracking);assert.deepEqual(clip.keyframes,keys);
    tools.state.before=captureDocument();tools.applyCropTracking(true);assert.equal(clip.cropTracking,undefined);assert.deepEqual(clip.keyframes,keys);assert.equal(commits.length,2);
  }finally{fixture.restore();}
});

test('crop dialog refuses a stale project or replaced clip before changing the document',()=>{
  const fixture=cropToolsFixture(),{tools,clip,commits}=fixture;
  try{
    project.fps+=1;assert.throws(()=>tools.applyCropTracking(),/바뀌었습니다/);assert.equal(clip.cropTracking,undefined);
    project.fps-=1;project.clips=[{...clip}];assert.throws(()=>tools.applyCropTracking(),/바뀌었습니다/);assert.equal(project.clips[0].cropTracking,undefined);
    assert.equal(commits.length,0);
  }finally{fixture.restore();}
});

test('crop target drag cancellation restores the old rectangle and pointer-up commits only the draft',()=>{
  const previousWindow=globalThis.window;globalThis.window=new EventTarget();
  const captures=new Set(),canvas={getBoundingClientRect:()=>({left:0,top:0,width:100,height:100}),
    setPointerCapture:id=>captures.add(id),hasPointerCapture:id=>captures.has(id),
    releasePointerCapture(id){captures.delete(id);this.onlostpointercapture?.({pointerId:id});}};
  const tools=Object.create(StudioTools.prototype),old={rect:{x:.2,y:.2,w:.3,h:.3},selected:false,pending:false,seedTime:0};
  tools.state={kind:'crop-tracking',...structuredClone(old),raw:{},frameLocalTime:2};tools.drawCropTracking=()=>{};
  Object.defineProperty(tools,'body',{value:{querySelector:()=>canvas}});tools.bindCropSelection();
  const pointer=(x,y,id=7)=>({clientX:x,clientY:y,pointerId:id,button:0,isPrimary:true,preventDefault(){}});
  const start=()=>{canvas.onpointerdown(pointer(10,10));canvas.onpointermove(pointer(45,50));assert.equal(tools.state.pending,true);};
  const restored=()=>{for(const key of Object.keys(old))assert.deepEqual(tools.state[key],old[key]);assert.equal(tools.state.cropDrag,null);};
  try{
    for(const cancel of ['pointercancel','lostpointercapture','blur','escape']){
      start();canvas.onpointercancel(pointer(45,50,9));assert.equal(tools.state.pending,true);
      if(cancel==='blur')window.dispatchEvent(new Event('blur'));
      else if(cancel==='escape'){const event=new Event('keydown',{cancelable:true});Object.defineProperty(event,'key',{value:'Escape'});window.dispatchEvent(event);}
      else canvas['on'+cancel](pointer(45,50));
      restored();
    }
    start();canvas.onpointerup(pointer(45,50));assert.equal(tools.state.pending,true);assert.equal(tools.state.selected,true);near(tools.state.seedTime,2);
    assert.deepEqual(tools.state.rect,{x:.1,y:.1,w:.35,h:.4});assert.equal(captures.size,0);
  }finally{tools.state.cancelCropDrag();if(previousWindow===undefined)delete globalThis.window;else globalThis.window=previousWindow;}
});

test('crop dialog pixels match the shared renderer with local keys, source-time masks and grouped opacity',{skip:!canvasModule},()=>{
  const previous=structuredClone(project),previousDocument=globalThis.document;
  globalThis.document={createElement:tag=>tag==='canvas'?canvasModule.createCanvas(1,1):{}};
  try{
    const raw=canvasModule.createCanvas(160,100),paint=raw.getContext('2d');
    paint.fillStyle='#f04a30';paint.fillRect(0,0,80,100);paint.fillStyle='#2386ed';paint.fillRect(80,0,80,100);
    paint.fillStyle='white';paint.fillRect(35,25,55,35);
    const tracking=tracked([cropKey(0,.1),cropKey(4,.5)]).cropTracking;
    const clip={...newClipDefaults('video'),id:'crop-pixels',start:7,trackId:'v1',trimStart:11,trimEnd:15,srcDuration:20,natW:160,natH:100,
      fit:'cover',scale:.8,bg:'blur',fadeIn:1,fadeOut:1,cropTracking:tracking,transform:{rotation:7,scaleY:.95}};
    setKeyframe(clip,'offsetX',0,-.05);setKeyframe(clip,'offsetX',4,.1);setKeyframe(clip,'opacity',0,.3);setKeyframe(clip,'opacity',4,.7);
    const rect={x:.2,y:.2,w:.25,h:.35};
    clip.mosaics=[{id:'pixel-mask',enabled:true,mode:'tracked',rect,strength:70,padding:.1,range:[11,15],keyframes:[{...rect,time:11,duration:.1,confidence:1,lost:false},{...rect,x:.5,time:15,duration:.1,confidence:1,lost:false}]}];
    Object.assign(project,{width:180,height:320,clips:[clip],captions:[],overlays:[],template:{...project.template,mode:'none'}});
    const before=captureDocument(),tools=Object.create(StudioTools.prototype),preview=canvasModule.createCanvas(180,320),expected=canvasModule.createCanvas(180,320);
    const state={clip,range:{duration:4},tracking,zoom:tracking.zoom,raw,pending:false};
    for(const local of [.2,2,3.8]){
      state.frameLocalTime=local;state.sourceFrameTime=clip.trimStart+local;tools.drawCropPreview(preview,state);
      renderFrame(expected.getContext('2d'),clip.start+local,{source:(sourceClip,at)=>{near(at,local);return{img:raw,w:160,h:100,sourceTime:clip.trimStart+at};}});
      const a=preview.getContext('2d').getImageData(0,0,180,320).data,b=expected.getContext('2d').getImageData(0,0,180,320).data;
      let differences=0,visible=0;for(let i=0;i<a.length;i++){if(a[i]!==b[i])differences++;if(i%4!==3&&a[i]>10)visible++;}
      assert.equal(differences,0,'preview/export pixel mismatch at local '+local);assert.ok(visible>1000);
    }
    assert.deepEqual(captureDocument(),before);
  }finally{Object.assign(project,previous);if(previousDocument===undefined)delete globalThis.document;else globalThis.document=previousDocument;}
});
