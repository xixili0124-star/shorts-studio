// 음악에서 컷 자리를 찾는 계산 회귀 검사.
// 실제 음원 대신 정확한 간격의 타격음을 만들어 씁니다. 답을 아는 신호라야 검사가 됩니다.
import test from 'node:test';
import assert from 'node:assert/strict';
import {onsetEnvelope,pickOnsets,estimateTempo,beatOffset,beatGrid,slotsFromCuts,rhythmFromSamples,
  ANALYSIS_RATE,DEFAULT_HOP} from '../public/js/beat-detect.js';

// 재현 가능한 잡음. Math.random 을 쓰면 검사가 실행마다 달라집니다.
const noise=seed=>{let x=seed;return()=>{x=(x*1103515245+12345)&0x7fffffff;return x/0x7fffffff*2-1;};};
/** bpm 간격으로 타격이 들어간 신호를 만듭니다. offset 은 첫 타격 위치(초). */
const clicks=(bpm,seconds,{seed=7,offset=0,rate=ANALYSIS_RATE}={})=>{
  const rnd=noise(seed),n=Math.round(rate*seconds),s=new Float32Array(n),period=60/bpm;
  for(let t=offset;t<seconds;t+=period){
    const start=Math.round(t*rate);
    for(let i=0;i<Math.round(rate*0.05)&&start+i<n;i++)s[start+i]+=rnd()*Math.exp(-i/(rate*0.008));
  }
  for(let i=0;i<n;i++)s[i]+=rnd()*0.01;
  return s;
};

test('세기 곡선은 커지는 변화만 남기고 길이가 맞는다',()=>{
  const samples=clicks(120,4);
  const {flux,hopSeconds}=onsetEnvelope(samples,ANALYSIS_RATE);
  assert.equal(flux.length,Math.floor(samples.length/DEFAULT_HOP));
  assert.ok(Math.abs(hopSeconds-DEFAULT_HOP/ANALYSIS_RATE)<1e-9);
  assert.ok([...flux].every(v=>v>=0),'작아지는 변화는 0 으로 둔다');
  assert.ok([...flux].some(v=>v>0),'타격이 있으면 0 만 나오지 않는다');
});

test('소리를 읽지 못하면 알려 준다',()=>{
  assert.throws(()=>onsetEnvelope(new Float32Array(0),ANALYSIS_RATE),/읽지 못했/);
  assert.throws(()=>onsetEnvelope(clicks(120,1),0),/읽지 못했/);
});

test('타격 자리를 찾아낸다',()=>{
  const {flux,hopSeconds}=onsetEnvelope(clicks(120,8),ANALYSIS_RATE);
  const onsets=pickOnsets(flux,hopSeconds);
  assert.ok(onsets.length>=12,'8초에 0.5초 간격이면 최소 12개는 나와야 한다: '+onsets.length);
  // 찾은 자리마다 0.5 초 격자에 가까운지
  for(const t of onsets){
    const nearest=Math.round(t/0.5)*0.5;
    assert.ok(Math.abs(t-nearest)<0.08,t+' 가 격자에서 너무 멀다');
  }
});

test('너무 가까운 자리는 하나로 본다',()=>{
  const {flux,hopSeconds}=onsetEnvelope(clicks(120,6),ANALYSIS_RATE);
  const onsets=pickOnsets(flux,hopSeconds,{minGap:0.4});
  for(let i=1;i<onsets.length;i++)assert.ok(onsets[i]-onsets[i-1]>=0.4-1e-6,'간격 위반');
});

test('템포를 5% 안으로 맞춘다',()=>{
  for(const bpm of [90,100,120,128,135,150]){
    const {flux,hopSeconds}=onsetEnvelope(clicks(bpm,14,{seed:bpm}),ANALYSIS_RATE);
    const {bpm:found,strength}=estimateTempo(flux,hopSeconds);
    assert.ok(Math.abs(found-bpm)/bpm<0.05,bpm+' 을 '+found+' 로 봤다');
    assert.ok(strength>1,'반복이 뚜렷하면 강도가 1 보다 커야 한다: '+strength);
  }
});

test('반복이 없으면 템포를 주장하지 않는다',()=>{
  const rnd=noise(3),n=ANALYSIS_RATE*6,s=new Float32Array(n);
  for(let i=0;i<n;i++)s[i]=rnd()*0.2;           // 그냥 잡음
  const {flux,hopSeconds}=onsetEnvelope(s,ANALYSIS_RATE);
  assert.ok(estimateTempo(flux,hopSeconds).strength<1.6,'잡음에서 강한 템포가 나오면 안 된다');
  assert.deepEqual(estimateTempo(new Float32Array(0),0.01),{bpm:0,strength:0});
});

test('격자의 시작점을 첫 타격에 맞춘다',()=>{
  const {flux,hopSeconds}=onsetEnvelope(clicks(120,12,{offset:0.25}),ANALYSIS_RATE);
  const offset=beatOffset(flux,hopSeconds,120);
  const period=0.5;
  const distance=Math.min(Math.abs(offset-0.25),Math.abs(offset-0.25+period),Math.abs(offset-0.25-period));
  assert.ok(distance<0.06,'0.25 초에서 시작하는 격자를 찾아야 한다: '+offset);
});

test('격자는 박자 간격으로 펼쳐진다',()=>{
  const grid=beatGrid(120,0,5);
  assert.deepEqual(grid,[0,0.5,1,1.5,2,2.5,3,3.5,4,4.5]);
  assert.deepEqual(beatGrid(0,0,5),[]);
  assert.deepEqual(beatGrid(120,0,0),[]);
});

test('첫 컷 앞의 자투리는 슬롯으로 만들지 않는다',()=>{
  const slots=slotsFromCuts([0.3,1.3,2.3],3.3);
  assert.deepEqual(slots.map(s=>s.duration),[1,1,1],'0~0.3 구간은 버린다');
});

test('끝자락이 너무 짧으면 앞 컷에 붙인다',()=>{
  const slots=slotsFromCuts([0,1,2],2.1);
  assert.deepEqual(slots.map(s=>s.duration),[1,1.1],'0.1 초짜리 토막을 남기지 않는다');
});

test('슬롯 길이는 범위 안으로 당긴다',()=>{
  const slots=slotsFromCuts([0,0.01,20],40,{minSlot:0.2,maxSlot:8});
  assert.ok(slots.every(s=>s.duration>=0.2&&s.duration<=8),JSON.stringify(slots));
});

test('컷 자리가 없으면 슬롯도 없다',()=>{
  assert.deepEqual(slotsFromCuts([],10),[]);
  assert.deepEqual(slotsFromCuts([5,6],0),[]);
  assert.deepEqual(slotsFromCuts([11,12],10),[],'길이를 넘어선 자리만 있으면 만들지 않는다');
});

test('음악 한 곡에서 바로 컷 리듬이 나온다',()=>{
  const result=rhythmFromSamples(clicks(120,16,{seed:11}),ANALYSIS_RATE,{every:2});
  assert.ok(Math.abs(result.bpm-120)/120<0.05,'BPM '+result.bpm);
  assert.ok(result.slots.length>=6,'슬롯 수 '+result.slots.length);
  // 2박마다 자르면 120BPM 에서 1초 간격이어야 한다
  for(const slot of result.slots.slice(0,-1)){
    assert.ok(Math.abs(slot.duration-1)<0.12,'슬롯이 1초 근처여야 한다: '+slot.duration);
  }
  assert.ok(result.slots.every(s=>s.speed===1&&s.transition==='cut'));
});

test('every 를 0 으로 주면 격자 대신 찾아낸 자리를 그대로 쓴다',()=>{
  const result=rhythmFromSamples(clicks(120,10,{seed:5}),ANALYSIS_RATE,{every:0});
  assert.deepEqual(result.cuts,result.onsets);
  assert.ok(result.slots.length>0);
});

test('4박마다 자르면 컷이 절반으로 줄어든다',()=>{
  const two=rhythmFromSamples(clicks(120,20,{seed:9}),ANALYSIS_RATE,{every:2});
  const four=rhythmFromSamples(clicks(120,20,{seed:9}),ANALYSIS_RATE,{every:4});
  assert.ok(four.slots.length<two.slots.length,two.slots.length+' vs '+four.slots.length);
  for(const slot of four.slots.slice(0,-1))assert.ok(Math.abs(slot.duration-2)<0.2,slot.duration);
});
