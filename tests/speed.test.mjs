// 배속·저속 회귀 검사. 원본 구간은 그대로 두고 타임라인 길이만 달라지는지 확인합니다.
import test from 'node:test';
import assert from 'node:assert/strict';
import {project,newClipDefaults,clipSpeed,clipDuration,audioDuration,sourceTime,localTime,buildLayout,totalDuration,migrateTimeline,trackItems,trackIdFor,MIN_SPEED,MAX_SPEED} from '../public/js/state.js';
import {itemRange,applyItemSpeed} from '../public/js/timeline-edits.js';

const defaults=structuredClone(project);
const reset=()=>Object.assign(project,structuredClone(defaults));
const video=(id,trimStart,trimEnd,speed=1,start=undefined)=>({
  ...newClipDefaults('video'),id,type:'video',name:id+'.mp4',
  srcDuration:trimEnd,trimStart,trimEnd,speed,...(start!==undefined?{start}:{}),
});
const audio=(id,start,trimStart,trimEnd,speed=1)=>({
  id,assetId:id,name:id+'.wav',start,trimStart,trimEnd,speed,volume:1,fadeIn:0,fadeOut:0,lane:'music',role:'music',
});

test('배속 값은 범위를 벗어나면 잘리고, 없거나 이상하면 1배로 본다',()=>{
  for(const [given,expected] of [[undefined,1],[null,1],[0,1],[-2,1],[NaN,1],['이상',1],
    [1,1],[2,2],[0.5,.5],[99,MAX_SPEED],[0.01,MIN_SPEED],['2',2]]){
    assert.equal(clipSpeed({speed:given}),expected,String(given));
  }
});

test('타임라인 길이는 원본 구간을 배속으로 나눈 값이다',()=>{
  assert.equal(clipDuration(video('a',0,10,1)),10);
  assert.equal(clipDuration(video('a',0,10,2)),5);
  assert.equal(clipDuration(video('a',0,10,.5)),20);
  assert.equal(clipDuration(video('a',2,6,4)),1);          // 원본 4초 구간을 4배속
  assert.equal(audioDuration(audio('m',0,0,8,2)),4);
  assert.equal(audioDuration(audio('m',0,1,9,.5)),16);
});

test('원본 시각과 클립 내부 시각은 배속을 사이에 두고 서로 뒤집힌다',()=>{
  const clip=video('a',3,13,2);
  assert.equal(sourceTime(clip,0),3);                      // 클립 시작은 항상 trimStart
  assert.equal(sourceTime(clip,1),5);                      // 2배속이면 1초에 원본 2초가 흐른다
  assert.equal(sourceTime(clip,clipDuration(clip)),13);    // 클립 끝은 항상 trimEnd
  for(const local of [0,.4,1,2.5,5]) assert.ok(Math.abs(localTime(clip,sourceTime(clip,local))-local)<1e-9,String(local));
  const slow=video('b',0,4,.5);
  assert.equal(sourceTime(slow,4),2);                      // 절반 속도면 4초에 원본 2초
  assert.equal(localTime(slow,2),4);
});

test('이미지 클립은 배속을 무시한다',()=>{
  const image={...newClipDefaults('image'),id:'i',type:'image',imgDuration:3,speed:4};
  assert.equal(clipDuration(image),3);
  assert.equal(sourceTime(image,1),0);
});

test('배속을 바꾸면 같은 트랙의 뒤 클립만 길이 변화만큼 따라 움직인다',()=>{
  reset();
  project.clips=[video('a',0,4),video('b',0,4),video('c',0,4)];
  migrateTimeline();
  const before=buildLayout().entries.map(e=>[e.id,e.start,e.duration]);
  assert.deepEqual(before,[['a',0,4],['b',4,4],['c',8,4]]);

  assert.equal(applyItemSpeed('clip','a',2),true);
  const after=buildLayout().entries.map(e=>[e.id,e.start,+e.duration.toFixed(6)]);
  assert.deepEqual(after,[['a',0,2],['b',2,4],['c',6,4]],'앞 클립이 절반이 되면 뒤가 2초씩 당겨진다');
  // 원본에서 쓰는 구간 자체는 그대로여야 한다
  const a=project.clips.find(c=>c.id==='a');
  assert.equal(a.trimStart,0);
  assert.equal(a.trimEnd,4);
  assert.equal(totalDuration(),10);

  assert.equal(applyItemSpeed('clip','a',.5),true);
  assert.deepEqual(buildLayout().entries.map(e=>[e.id,e.start,+e.duration.toFixed(6)]),
    [['a',0,8],['b',8,4],['c',12,4]],'느리게 하면 뒤가 밀린다');
});

test('같은 배속을 다시 주면 아무것도 움직이지 않는다',()=>{
  reset();
  project.clips=[video('a',0,4),video('b',0,4)];
  migrateTimeline();
  assert.equal(applyItemSpeed('clip','a',1),false);
  assert.deepEqual(buildLayout().entries.map(e=>[e.id,e.start]),[['a',0],['b',4]]);
});

test('영상 배속은 다른 트랙의 오디오를 건드리지 않는다',()=>{
  reset();
  project.clips=[video('a',0,4),video('b',0,4)];
  project.audio.tracks=[audio('m',0,0,8)];
  migrateTimeline();
  applyItemSpeed('clip','a',2);
  const music=project.audio.tracks[0];
  assert.equal(music.start,0,'오디오 트랙은 제자리');
  assert.equal(clipSpeed(music),1,'오디오 배속도 그대로');
  assert.equal(audioDuration(music),8);
});

test('오디오 클립도 같은 규칙으로 배속이 걸린다',()=>{
  reset();
  project.clips=[video('a',0,10)];
  project.audio.tracks=[audio('m',0,0,4),audio('n',4,0,4)];
  migrateTimeline();
  const trackId=trackIdFor('audio',project.audio.tracks[0]);
  assert.equal(applyItemSpeed('audio','m',2),true);
  const positions=trackItems(trackId).map(e=>[e.id,e.start,+e.duration.toFixed(6)]);
  assert.deepEqual(positions,[['m',0,2],['n',2,4]],'앞 오디오가 짧아진 만큼 뒤가 당겨진다');
  assert.equal(project.audio.tracks[0].trimEnd,4,'원본 구간은 그대로');
});

test('영상이 아닌 클립에는 배속을 주지 않는다',()=>{
  reset();
  project.clips=[{...newClipDefaults('image'),id:'i',type:'image',imgDuration:3}];
  migrateTimeline();
  assert.throws(()=>applyItemSpeed('clip','i',2),/영상 클립에만/);
  assert.throws(()=>applyItemSpeed('caption','x',2),/영상 또는 오디오/);
});

test('배속을 줘도 클립 시작과 끝의 원본 시각은 경계를 넘지 않는다',()=>{
  const fast=video('a',1,3,4);
  const frames=[];
  for(let local=0;local<=clipDuration(fast)+1e-9;local+=1/30)frames.push(sourceTime(fast,Math.min(local,clipDuration(fast))));
  assert.ok(frames.every(t=>t>=1-1e-9&&t<=3+1e-9),'원본 1~3초 밖을 요청하지 않는다');
  assert.ok(Math.abs(frames[frames.length-1]-3)<1e-6,'마지막은 trimEnd 에 닿는다');
});
