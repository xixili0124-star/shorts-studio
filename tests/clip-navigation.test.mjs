// 컷 경계로 건너뛰는 이동 회귀 검사.
import test from 'node:test';
import assert from 'node:assert/strict';
import {project,newClipDefaults,migrateTimeline,addTimelineTrack} from '../public/js/state.js';
import {clipBoundaries,boundaryFrom} from '../public/js/timeline-edits.js';

const defaults=structuredClone(project);
const reset=()=>Object.assign(project,structuredClone(defaults));
const video=(id,seconds,speed=1)=>({...newClipDefaults('video'),id,type:'video',name:id+'.mp4',
  srcDuration:seconds,trimStart:0,trimEnd:seconds,speed});

test('경계는 0과 각 컷의 시작·끝이고 맞닿은 자리는 한 번만 센다',()=>{
  reset();
  project.clips=[video('a',4),video('b',3),video('c',2)];
  migrateTimeline();
  assert.deepEqual(clipBoundaries(),[0,4,7,9]);
});

test('배속을 준 컷도 실제 타임라인 길이로 경계가 잡힌다',()=>{
  reset();
  project.clips=[video('a',4,2),video('b',4)];   // 2초 + 4초
  migrateTimeline();
  assert.deepEqual(clipBoundaries(),[0,2,6]);
});

test('타임라인이 비어 있으면 0 하나만 남는다',()=>{
  reset();migrateTimeline();
  assert.deepEqual(clipBoundaries(),[0]);
});

test('앞뒤로 한 칸씩 움직인다',()=>{
  const marks=[0,4,7,9];
  assert.equal(boundaryFrom(marks,0,1),4);
  assert.equal(boundaryFrom(marks,4,1),7);
  assert.equal(boundaryFrom(marks,5,1),7);
  assert.equal(boundaryFrom(marks,5,-1),4);
  assert.equal(boundaryFrom(marks,4,-1),0);
  assert.equal(boundaryFrom(marks,9,-1),7);
});

test('경계 위에 딱 서 있어도 제자리에 머물지 않는다',()=>{
  const marks=[0,4,7];
  assert.equal(boundaryFrom(marks,4,1),7,'앞으로');
  assert.equal(boundaryFrom(marks,4,-1),0,'뒤로');
  assert.equal(boundaryFrom(marks,4.00001,1),7,'아주 조금 지난 자리도 같다');
});

test('더 갈 곳이 없으면 아무것도 돌려주지 않는다',()=>{
  const marks=[0,4,7];
  assert.equal(boundaryFrom(marks,0,-1),null,'맨 앞에서 뒤로');
  assert.equal(boundaryFrom(marks,7,1),null,'맨 끝에서 앞으로');
  assert.equal(boundaryFrom(marks,99,1),null);
  assert.equal(boundaryFrom([],0,1),null);
  assert.equal(boundaryFrom(null,0,1),null);
});

test('이상한 값이 섞여 있어도 건너뛴다',()=>{
  const marks=[0,NaN,4,Infinity,7,undefined];
  assert.equal(boundaryFrom(marks,0,1),4);
  assert.equal(boundaryFrom(marks,5,-1),4);
});

test('영상 트랙이 여러 겹이면 모든 트랙의 경계를 함께 본다',()=>{
  reset();
  project.clips=[video('a',6)];
  migrateTimeline();
  const extra=addTimelineTrack('visual',{role:'video'});
  // 위 트랙에 3초 지점에서 시작하는 2초짜리 화면을 겹쳐 놓는다
  project.clips.push({...video('b',2),start:3,trackId:extra});
  const marks=clipBoundaries();
  assert.ok(marks.includes(3),'겹친 화면의 시작도 경계다: '+marks.join(','));
  assert.ok(marks.includes(5),'겹친 화면의 끝도 경계다: '+marks.join(','));
  assert.equal(boundaryFrom(marks,0,1),3);
});
