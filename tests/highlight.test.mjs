// 소재에서 쓸 만한 구간을 고르는 채점 회귀 검사.
import test from 'node:test';
import assert from 'node:assert/strict';
import {frameStats,frameMotion,windowScores,bestWindowStart,nextWindowStart} from '../public/js/highlight.js';
import {planTemplate} from '../public/js/edit-templates.js';

/** time 초마다 한 장씩, 주어진 값으로 채운 표본을 만듭니다. */
const samples=(list)=>list.map(([time,detail,motion,mean=128])=>({time,detail,motion,mean}));

test('한 장에서 평균 밝기와 결의 세기를 낸다',()=>{
  assert.deepEqual(frameStats(new Float32Array([100,100,100,100])),{mean:100,detail:0});
  const flat=frameStats(new Float32Array([0,200,0,200]));
  assert.equal(flat.mean,100);
  assert.equal(flat.detail,100,'값이 갈릴수록 결이 세다');
  assert.deepEqual(frameStats(null),{mean:0,detail:0});
  assert.deepEqual(frameStats(new Float32Array(0)),{mean:0,detail:0});
});

test('두 장 사이의 움직임은 평균 절대 차이다',()=>{
  const a=new Float32Array([10,20,30]),b=new Float32Array([10,20,30]);
  assert.equal(frameMotion(a,b),0,'같은 화면은 0');
  assert.equal(frameMotion(a,new Float32Array([20,30,40])),10);
  assert.equal(frameMotion(a,new Float32Array([1,2])),0,'길이가 다르면 0');
  assert.equal(frameMotion(null,a),0);
});

test('결과 움직임이 살아 있는 구간을 고른다',()=>{
  // 0~2초는 밋밋하고 3~5초가 볼 만하다. 정확히 어느 자리인지보다 밋밋한 앞을
  // 피하는지가 핵심이다. 구간 안 프레임의 평균으로 재므로 더 좋은 쪽이 뒤일 수 있다.
  const list=samples([[0,1,1],[1,1,1],[2,1,1],[3,90,80],[4,95,85],[5,92,82]]);
  const start=bestWindowStart(list,2,7);
  assert.ok(start>=3,'밋밋한 앞부분을 골랐다: '+start);
  assert.ok(start+2<=7,'소재 밖으로 나가지 않는다: '+start);
});

test('너무 어둡거나 하얗게 날아간 구간은 감점한다',()=>{
  // 결과 움직임은 같지만 앞 구간이 새까맣다
  const list=samples([[0,90,80,4],[1,90,80,4],[2,90,80,4],[3,90,80,128],[4,90,80,128],[5,90,80,128]]);
  assert.equal(bestWindowStart(list,2,7),3,'검은 화면을 피한다');
  const blown=samples([[0,90,80,128],[1,90,80,128],[2,90,80,250],[3,90,80,250]]);
  assert.equal(bestWindowStart(blown,1,5),0,'날아간 화면도 피한다');
});

test('고를 자리가 없으면 아무것도 돌려주지 않는다',()=>{
  assert.equal(bestWindowStart([],2,10),null);
  assert.equal(bestWindowStart(samples([[0,1,1]]),2,1),null,'구간이 소재보다 길다');
  assert.equal(bestWindowStart(samples([[0,1,1]]),0,10),null);
  assert.equal(bestWindowStart(samples([[9,1,1]]),2,10),null,'끝을 넘는 후보뿐이면 없다');
});

test('고른 자리는 소재 밖으로 나가지 않는다',()=>{
  const list=samples([[0,1,1],[4,99,99]]);
  const start=bestWindowStart(list,2,5);
  assert.ok(start>=0&&start+2<=5,'start='+start);
});

test('점수가 같으면 앞쪽을 골라 결과가 흔들리지 않는다',()=>{
  const list=samples([[0,50,50],[1,50,50],[2,50,50],[3,50,50]]);
  const first=bestWindowStart(list,1,4);
  for(let i=0;i<5;i++)assert.equal(bestWindowStart(list,1,4),first);
  assert.equal(first,0);
});

test('이미 쓴 구간과 겹치지 않는 자리를 고른다',()=>{
  const list=samples([[0,90,80],[1,88,78],[2,86,76],[3,84,74],[4,82,72]]);
  const first=nextWindowStart(list,1,5,[]);
  const second=nextWindowStart(list,1,5,[first]);
  assert.notEqual(second,first,'같은 구간을 또 주면 똑같은 화면이 된다');
  assert.ok(Math.abs(second-first)>=1-1e-6,'겹치지 않아야 한다');
});

test('남은 자리가 없으면 겹침을 허용하고 제일 좋은 데를 쓴다',()=>{
  const list=samples([[0,90,80],[1,10,10]]);
  const taken=[0,1];
  const picked=nextWindowStart(list,1,2,taken);
  assert.ok(picked!==null,'포기하지 않는다');
  assert.equal(picked,0,'겹치더라도 제일 좋은 자리');
});

test('windowScores 는 후보마다 점수와 표본 수를 함께 준다',()=>{
  const list=samples([[0,10,10],[1,90,90],[2,90,90]]);
  const scores=windowScores(list,2,4);
  assert.ok(scores.length>=1);
  for(const entry of scores){
    assert.ok(Number.isFinite(entry.score));
    assert.ok(entry.frames>=1);
    assert.ok(entry.start+2<=4+1e-6);
  }
});

test('템플릿이 구간 선택을 맡기면 그 자리를 쓴다',()=>{
  const calls=[];
  const plan=planTemplate({id:'t',name:'x',slots:[{duration:2},{duration:2}]},
    [{assetId:'a',duration:20}],
    {pickStart:(source,span,taken)=>{calls.push({assetId:source.assetId,span,taken:[...taken]});return taken.length?12:3;}});
  assert.deepEqual(plan.slots.map(s=>s.trimStart),[3,12]);
  assert.deepEqual(plan.slots.map(s=>s.trimEnd),[5,14]);
  assert.equal(calls.length,2);
  assert.deepEqual(calls[0].taken,[],'처음에는 쓴 자리가 없다');
  assert.deepEqual(calls[1].taken,[3],'두 번째에는 앞서 쓴 자리를 알려 준다');
  assert.equal(calls[0].span,2);
});

test('맡긴 쪽이 이상한 값을 주면 소재 안으로 당기거나 가운데로 되돌린다',()=>{
  const far=planTemplate({id:'t',name:'x',slots:[{duration:2}]},[{assetId:'a',duration:10}],
    {pickStart:()=>999});
  assert.equal(far.slots[0].trimStart,8,'끝을 넘으면 마지막 자리로 당긴다');
  const negative=planTemplate({id:'t',name:'x',slots:[{duration:2}]},[{assetId:'a',duration:10}],
    {pickStart:()=>-5});
  assert.equal(negative.slots[0].trimStart,0);
  const none=planTemplate({id:'t',name:'x',slots:[{duration:2}]},[{assetId:'a',duration:10}],
    {pickStart:()=>null});
  assert.equal(none.slots[0].trimStart,4,'고르지 못하면 가운데');
});

test('구간 선택을 맡기지 않으면 예전처럼 가운데를 쓴다',()=>{
  const plan=planTemplate({id:'t',name:'x',slots:[{duration:2}]},[{assetId:'a',duration:10}]);
  assert.equal(plan.slots[0].trimStart,4);
});
