// 실제 소리나 브라우저 없이 오디오 노드의 자동화와 키프레임 입력 수명주기를 검사합니다.
import test from 'node:test';
import assert from 'node:assert/strict';
import {automateVolume,volumeAt,hasAudibleVolume,PreviewAudioGain} from '../public/js/audio-gain.js';
import {sliceKeyframes} from '../public/js/keyframes.js';
import {KeyframeEditor} from '../public/js/keyframe-editor.js';
import {typographyControls,textAppearanceControls} from '../public/js/inspector-controls.js';
import {mixTimeline} from '../public/js/audio.js';
import {Player} from '../public/js/player.js';
import {project,newClipDefaults,setLegacyEditorMode} from '../public/js/state.js';

const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-8,actual+' != '+expected);
const defaults=structuredClone({...project,clips:[],captions:[],overlays:[],timelineTracks:undefined,
  audio:{originalVolume:1,bgm:null,narration:null,tracks:[]}});
function reset(){Object.assign(project,structuredClone(defaults));setLegacyEditorMode(false);}
class Param {
  constructor(){this.value=1;this.events=[];}
  setValueAtTime(value,time){this.events.push(['set',value,time]);}
  linearRampToValueAtTime(value,time){this.events.push(['linear',value,time]);}
}
class AudioNode {
  constructor(){this.gain=new Param();this.connections=[];this.disconnected=0;}
  connect(target){this.connections.push(target);return target;}
  disconnect(){this.connections=[];this.disconnected++;}
}
class AudioContextFake {
  constructor(){this.state='suspended';this.destination={};this.gains=[];this.sources=[];this.elements=[];}
  resume(){this.state='running';return Promise.resolve();}
  createGain(){const node=new AudioNode();this.gains.push(node);return node;}
  createMediaElementSource(element){const node=new AudioNode();this.elements.push({element,node});return node;}
  createBufferSource(){const node=new AudioNode();node.starts=[];node.start=(...args)=>node.starts.push(args);this.sources.push(node);return node;}
  startRendering(){return Promise.resolve(this);}
}
const media=()=>({volume:1,currentTime:0,paused:true,muted:false,addEventListener(){},pause(){this.paused=true;},play(){this.paused=false;return Promise.resolve();}});
const keyed=keys=>({volume:0,keyframes:{version:1,tracks:{volume:keys}}});

test('inspector numeric controls reject saved attribute text and render finite bounded values',()=>{
  const marker='58" data-review-marker="accepted';
  const typography=typographyControls({size:marker,font:'"Noto Sans KR"'});
  const appearance=textAppearanceControls({size:marker,strokeW:marker,boxOpacity:Infinity,
    boxPaddingX:1000,boxPaddingY:-1,shadowOpacity:NaN,shadowBlur:marker,shadowX:-Infinity,shadowY:marker});
  const html=typography+appearance;
  assert.doesNotMatch(html,/data-review-marker|NaN|Infinity/);
  assert.match(typography,/<input[^>]*data-prop="size"[^>]*value="24"/);
  for(const [tag] of html.matchAll(/<input\b[^>]*type="range"[^>]*>/g)){
    const read=name=>Number(tag.match(new RegExp(name+'="([^"]+)"'))?.[1]);
    const value=read('value');
    assert.ok(Number.isFinite(value)&&value>=read('min')&&value<=read('max'),tag);
  }
});

function emit(target,type,fields={}){
  const event=new Event(type,{cancelable:true});
  for(const [key,value] of Object.entries(fields))Object.defineProperty(event,key,{value,configurable:true});
  target.dispatchEvent(event);return event;
}
class Control extends EventTarget {
  constructor(dataset={}){
    super();this.dataset=dataset;this.style={};this.value='';this.captures=new Set();
    this.classList={toggle(){}};
  }
  matches(selector){
    const match=selector.match(/^\[data-([a-z-]+)(?:="([^"]+)")?\]$/);if(!match)return false;
    const key=match[1].replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase());
    return this.dataset[key]!==undefined&&(match[2]===undefined||this.dataset[key]===match[2]);
  }
  closest(selector){return this.matches(selector)?this:this.parentElement?.closest(selector)||null;}
  setPointerCapture(id){this.captures.add(id);}
  hasPointerCapture(id){return this.captures.has(id);}
  releasePointerCapture(id){this.captures.delete(id);emit(this,'lostpointercapture',{pointerId:id});}
}

function editorHarness(){
  const previous=globalThis.window;globalThis.window=new EventTarget();
  const host=new Control(),ruler=new Control(),point=new Control({keyframeTime:'0'});
  ruler.getBoundingClientRect=()=>({left:100,width:400});point.parentElement=ruler;point.style.left='0%';
  const controls=new Map([
    ['.keyframe-section',new Control()],['.keyframe-time',new Control()],['.keyframe-playhead',new Control()],
    ['[data-keyframe-command="toggle"]',new Control({keyframeCommand:'toggle'})],
    ['[data-keyframe-command="previous"]',new Control({keyframeCommand:'previous'})],
    ['[data-keyframe-command="next"]',new Control({keyframeCommand:'next'})],
    ['[data-keyframe-easing]',new Control({keyframeEasing:''})],
  ]);
  host.querySelector=selector=>controls.get(selector)||null;
  host.querySelectorAll=selector=>selector==='[data-keyframe-time]'?[point]:[];
  const state={time:10,busy:false,range:{type:'clip',id:'item',start:10,end:14,duration:4,item:{id:'item',type:'image',
    keyframes:{version:1,tracks:{offsetX:[{time:0,value:.1},{time:2,value:.5},{time:4,value:.9}]}}}}};
  const calls={edits:[],seeks:[],errors:[],pauses:0};
  const editor=new KeyframeEditor({host,range:()=>state.range,time:()=>state.time,fps:()=>30,busy:()=>state.busy,
    pause:()=>calls.pauses++,seek:time=>{state.time=time;calls.seeks.push(time);},
    render(){},edit:(label,run)=>{calls.edits.push(label);return run();},error:message=>calls.errors.push(message)});
  const begin=(extra={})=>emit(host,'pointerdown',{target:point,pointerId:7,button:0,isPrimary:true,clientX:100,...extra});
  const move=()=>emit(point,'pointermove',{pointerId:7,clientX:200});
  return {editor,host,point,state,calls,controls,begin,move,
    restore(){emit(point,'pointercancel',{pointerId:7});clearTimeout(editor.suppressTimer);globalThis.window=previous;}};
}

test('volume automation preserves 300 percent, hold jumps and a clipped linear ending',()=>{
  const item=keyed([{time:0,value:.5,easing:'hold'},{time:2,value:3,easing:'linear'},{time:4,value:1}]),param=new Param();
  assert.equal(Boolean(hasAudibleVolume(item)),true);assert.equal(Boolean(hasAudibleVolume({volume:0})),false);
  near(volumeAt(item,1),.5);near(volumeAt(item,2),3);near(volumeAt(item,3),2);
  automateVolume(param,item,5,3,.8);
  assert.deepEqual(param.events,[['set',.4,5],['set',.4,7],['set',3*.8,7],['linear',1.6,8]]);
  const constant=new Param();automateVolume(constant,{volume:3},9,2);
  assert.deepEqual(constant.events,[['set',3,9]]);
});

test('trimmed automation starts at the sliced value and adds only the timeline offset',()=>{
  const original=keyed([{time:0,value:0},{time:6,value:3}]);
  const item={...original,keyframes:sliceKeyframes(original,2,5)},param=new Param();
  automateVolume(param,item,8,3);
  assert.deepEqual(param.events,[['set',1,8],['linear',2.5,11]]);
  const held=keyed([{time:0,value:2.5,easing:'hold'},{time:4,value:0}]),partial=new Param();
  automateVolume(partial,held,3,2);assert.deepEqual(partial.events,[['set',2.5,3],['set',2.5,5]]);
});

test('preview routes amplification through GainNode and reuses the element route after disconnect',async()=>{
  const previous=globalThis.AudioContext;globalThis.AudioContext=AudioContextFake;
  try{
    const gain=new PreviewAudioGain(),element=media();await gain.resume();
    gain.set(element,3);assert.equal(element.volume,1);assert.equal(gain.context.gains[0].gain.value,3);
    gain.set(element,1.5);assert.equal(gain.context.elements.length,1);near(gain.context.gains[0].gain.value,1.5);
    gain.disconnect(element);assert.equal(gain.context.gains[0].connections.length,0);
    gain.set(element,0);assert.equal(gain.context.elements.length,1);assert.equal(gain.context.gains[0].gain.value,0);
    assert.equal(gain.context.gains[0].connections.length,1);
  }finally{globalThis.AudioContext=previous;}
});

test('offline and preview audio use clip-local automation with a nonzero source trim and timeline start',async()=>{
  reset();const previous={document:globalThis.document,AudioContext:globalThis.AudioContext,OfflineAudioContext:globalThis.OfflineAudioContext};
  globalThis.AudioContext=AudioContextFake;globalThis.OfflineAudioContext=AudioContextFake;
  globalThis.document={addEventListener(){}};
  const track={id:'voice',role:'voice',lane:'voice',start:5,trimStart:2,trimEnd:5,fadeIn:0,fadeOut:0,
    buffer:{duration:10},el:media(),...keyed([{time:0,value:1},{time:3,value:3}])};
  project.audio.tracks=[track];
  try{
    const rendered=await mixTimeline({includeBgm:false,includeVoice:true});
    const source=rendered.sources[0],volume=source.connections[0],fade=volume.connections[0];
    assert.deepEqual(source.starts,[[5,2,3]]);
    assert.deepEqual(volume.gain.events,[['set',1,5],['linear',3,8]]);
    assert.deepEqual(fade.gain.events,[['set',1,5]]);
    const player=new Player({getContext:()=>({})});await player.previewGain.resume();
    player.time=6.5;player._syncTracks();
    near(player.previewGain.context.gains[0].gain.value,2);near(track.el.currentTime,3.5);
    assert.equal(track.el.volume,1);
    player.previewMuted=true;player._syncTracks();assert.equal(track.el.muted,true);
    project.audio.tracks=[];player._syncTracks();assert.equal(player.previewGain.context.gains[0].connections.length,0);
  }finally{Object.assign(globalThis,previous);reset();}
});

test('video preview applies animated gain above one with original volume and fades exactly once',async()=>{
  reset();const previous={document:globalThis.document,AudioContext:globalThis.AudioContext};
  globalThis.AudioContext=AudioContextFake;globalThis.document={addEventListener(){}};
  const video={...newClipDefaults('video'),id:'video',start:5,trimStart:2,trimEnd:6,srcDuration:8,
    el:media(),fadeIn:2,fadeOut:0,...keyed([{time:0,value:3},{time:4,value:3}])};
  project.clips=[video];project.audio.originalVolume=.8;
  try{
    const player=new Player({getContext:()=>({})});await player.previewGain.resume();
    player.time=6;player._syncVideos(true);
    near(player.previewGain.context.gains[0].gain.value,1.2);near(video.el.currentTime,3);
    assert.equal(video.el.volume,1);assert.equal(video.el.muted,false);
    player.time=8;player._syncVideos(true);near(player.previewGain.context.gains[0].gain.value,2.4);
    player.previewMuted=true;player._syncVideos(true);assert.equal(video.el.muted,true);
  }finally{Object.assign(globalThis,previous);reset();}
});

for(const reason of ['pointercancel','lostpointercapture','window-capture-loss','blur','Escape']){
  test('keyframe drag cancels and releases every lock on '+reason,()=>{
    const h=editorHarness();try{
      const before=structuredClone(h.state.range.item);h.begin();h.move();
      if(reason==='Escape')emit(window,'keydown',{key:'Escape'});
      else if(reason==='blur')emit(window,'blur');
      else if(reason==='window-capture-loss')emit(window,'lostpointercapture',{pointerId:7});
      else emit(h.point,reason,{pointerId:7});
      assert.equal(h.editor.dragging,false);assert.equal(h.point.hasPointerCapture(7),false);
      assert.equal(h.point.style.left,'0%');assert.deepEqual(h.state.range.item,before);
      emit(h.point,'pointerup',{pointerId:7});assert.deepEqual(h.calls.edits,[]);assert.deepEqual(h.calls.seeks,[]);
    }finally{h.restore();}
  });
}

test('keyframe drag ignores secondary pointers and commits once without a follow-up click seek',()=>{
  const h=editorHarness();try{
    h.begin();h.begin({pointerId:8,isPrimary:false,clientX:150});
    emit(h.point,'pointermove',{pointerId:8,clientX:400});emit(h.point,'pointerup',{pointerId:8});
    assert.equal(h.calls.pauses,1);assert.equal(h.editor.dragging,true);
    h.move();emit(h.point,'pointerup',{pointerId:7});emit(h.point,'pointerup',{pointerId:7});
    assert.equal(h.editor.dragging,false);assert.deepEqual(h.calls.edits,['키프레임 이동']);
    assert.deepEqual(h.state.range.item.keyframes.tracks.offsetX.map(key=>key.time),[1,2,4]);
    assert.deepEqual(h.calls.seeks,[11]);emit(h.host,'click',{target:h.point});assert.deepEqual(h.calls.seeks,[11]);
  }finally{h.restore();}
});

for(const change of ['selection','channel','keys','range','busy']){
  test('keyframe drag does not commit stale '+change+' state',()=>{
    const h=editorHarness();try{
      h.begin();h.move();
      if(change==='selection')h.state.range={...h.state.range,item:structuredClone(h.state.range.item)};
      if(change==='channel')h.editor.channel='scaleX';
      if(change==='keys')h.state.range.item.keyframes.tracks.offsetX[0].value=.2;
      if(change==='range')h.state.range={...h.state.range,start:11,end:15};
      if(change==='busy')h.state.busy=true;
      const newer=structuredClone(h.state.range.item);emit(h.point,'pointerup',{pointerId:7});
      assert.deepEqual(h.state.range.item,newer);assert.deepEqual(h.calls.edits,[]);assert.deepEqual(h.calls.seeks,[]);
      assert.equal(h.editor.dragging,false);
    }finally{h.restore();}
  });
}

test('cancelled keyframe drag does not swallow the next inspector command',()=>{
  const h=editorHarness();try{
    h.begin();h.move();emit(h.point,'pointercancel',{pointerId:7});
    emit(h.host,'click',{target:h.controls.get('[data-keyframe-command="toggle"]')});
    assert.deepEqual(h.calls.edits,['키프레임 삭제']);
  }finally{h.restore();}
});

test('keyframe property selection renders its value slider beside the key controls',()=>{
  const h=editorHarness();try{
    h.editor.channel='rotation';h.state.range.item.transform={rotation:37};
    const html=h.editor.render(h.state.range);
    assert.match(html,/data-keyframe-channel/);
    assert.match(html,/data-keyframe-value[^>]*data-prop="transform\.rotation"/);
    assert.match(html,/value="37"[^>]*aria-label="현재 위치 회전 값"/);
    assert.match(html,/위 슬라이더로 값을 정하세요/);
    h.state.range.type='audio';h.state.range.item={type:'audio',volume:2.25};
    const audio=h.editor.render(h.state.range);
    assert.match(audio,/data-prop="volume"[^>]*max="300"[^>]*value="225"/);
    h.state.range.type='clip';h.state.range.item={type:'video',audioSeparated:true,transform:{}};
    assert.doesNotMatch(h.editor.render(h.state.range),/<option value="volume"/);
  }finally{h.restore();}
});

test('adding a key seeks to the same quantized frame used by following property edits',()=>{
  const h=editorHarness();try{
    h.editor.channel='rotation';h.state.range.item={type:'image',transform:{rotation:15}};
    h.state.time=11.15;
    emit(h.host,'click',{target:h.controls.get('[data-keyframe-command="toggle"]')});
    const expected=10+35/30,keys=h.state.range.item.keyframes.tracks.rotation;
    assert.equal(keys.length,1);near(keys[0].time,35/30);assert.deepEqual(h.calls.seeks,[expected]);
    assert.equal(h.state.time,expected);
    // 같은 표시 프레임에서 다시 누르면 인접 소수 키를 추가하지 않고 현재 키를 지웁니다.
    h.state.time=11.15;emit(h.host,'click',{target:h.controls.get('[data-keyframe-command="toggle"]')});
    assert.equal(h.state.range.item.keyframes,undefined);
  }finally{h.restore();}
});
