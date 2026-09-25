// 편집 레시피 템플릿 회귀 검사.
import test from 'node:test';
import assert from 'node:assert/strict';
import {project,newClipDefaults,migrateTimeline} from '../public/js/state.js';
import {captureTemplate,planTemplate,normalizeTemplate,listTemplates,saveTemplate,deleteTemplate,renameTemplate,
  TEMPLATE_STORAGE_KEY,MAX_TEMPLATES,MAX_SLOTS} from '../public/js/edit-templates.js';

const defaults=structuredClone(project);
const reset=()=>Object.assign(project,structuredClone(defaults));
const video=(id,trimEnd,speed=1,transition='cut',transitionDuration=0)=>({
  ...newClipDefaults('video'),id,type:'video',name:id+'.mp4',
  srcDuration:trimEnd,trimStart:0,trimEnd,speed,transitionOut:{type:transition,duration:transitionDuration},
});
const fakeStorage=()=>{const map=new Map();return {
  getItem:k=>map.has(k)?map.get(k):null, setItem:(k,v)=>map.set(k,String(v)), removeItem:k=>map.delete(k), _map:map };};
const tpl=(...slots)=>({id:'t1',name:'테스트',slots});

test('지금 타임라인에서 컷 리듬만 떠내고 영상 파일은 담지 않는다',()=>{
  reset();
  project.clips=[video('a',4),video('b',6,2,'dissolve',.4),video('c',3)];
  migrateTimeline();
  const t=captureTemplate('반둥 워크');
  assert.equal(t.name,'반둥 워크');
  assert.equal(t.slots.length,3);
  assert.deepEqual(t.slots.map(s=>s.duration),[4,3,3],'2배속 클립은 타임라인 길이 3초로 기록된다');
  assert.deepEqual(t.slots.map(s=>s.speed),[1,2,1]);
  assert.equal(t.slots[1].transition,'dissolve');
  assert.equal(t.slots[1].transitionDuration,.4);
  const json=JSON.stringify(t);
  assert.ok(!/\.mp4|file|url|assetId/.test(json),'소재를 가리키는 값이 들어가면 안 된다: '+json);
});

test('타임라인이 비어 있으면 템플릿을 만들지 않는다',()=>{
  reset();migrateTimeline();
  assert.throws(()=>captureTemplate('빈 것'),/영상이나 이미지를 먼저/);
});

test('이름이 없으면 저장하지 않는다',()=>{
  reset();project.clips=[video('a',4)];migrateTimeline();
  for(const bad of ['','   ','\u0000\u0001']) assert.throws(()=>captureTemplate(bad),/이름을 입력/);
});

test('슬롯마다 소재의 가운데를 쓴다',()=>{
  const plan=planTemplate(tpl({duration:2}),[{assetId:'a',duration:10}]);
  assert.equal(plan.ok,true);
  assert.deepEqual([plan.slots[0].trimStart,plan.slots[0].trimEnd],[4,6],'10초 소재의 가운데 2초');
});

test('소재가 슬롯보다 적으면 앞에서부터 다시 쓴다',()=>{
  const plan=planTemplate(tpl({duration:1},{duration:1},{duration:1},{duration:1}),
    [{assetId:'a',duration:10},{assetId:'b',duration:10}]);
  assert.deepEqual(plan.slots.map(s=>s.assetId),['a','b','a','b']);
  assert.equal(plan.reused,2,'모자란 슬롯 수를 알려 준다');
  assert.deepEqual(plan.slots.map(s=>s.start),[0,1,2,3],'컷은 순서대로 이어 붙는다');
  assert.equal(plan.total,4);
});

test('소재가 짧으면 배속을 올려 리듬을 지킨다',()=>{
  // 2초 슬롯에 1초짜리 소재 -> 0.5배속으로 늘려서 2초를 채운다
  const slow=planTemplate(tpl({duration:2}),[{assetId:'a',duration:1}]);
  assert.equal(slow.slots[0].speed,.5);
  assert.equal(slow.slots[0].duration,2,'리듬은 지켜진다');
  assert.equal(slow.slots[0].shortened,false);
  assert.deepEqual([slow.slots[0].trimStart,slow.slots[0].trimEnd],[0,1],'소재 전체를 쓴다');
});

test('배속을 최대로 올려도 모자라면 그 컷만 짧게 두고 알려 준다',()=>{
  // 0.25배속이 한계이므로 10초 슬롯에 1초 소재는 4초까지만 채울 수 있다
  const plan=planTemplate(tpl({duration:10}),[{assetId:'a',duration:1}]);
  const slot=plan.slots[0];
  assert.equal(slot.speed,.25);
  assert.ok(slot.duration<10,'없는 화면을 만들어 내지 않는다');
  assert.equal(slot.duration,4);
  assert.equal(slot.shortened,true);
  assert.equal(plan.shortened,1);
});

test('템플릿이 배속을 담고 있으면 원본을 그만큼 더 가져간다',()=>{
  const plan=planTemplate(tpl({duration:2,speed:2}),[{assetId:'a',duration:20}]);
  assert.equal(plan.slots[0].speed,2);
  assert.equal(plan.slots[0].trimEnd-plan.slots[0].trimStart,4,'2초 x 2배속 = 원본 4초');
  assert.equal(plan.slots[0].duration,2);
});

test('컷 전환은 길이를 0으로 둔다',()=>{
  const plan=planTemplate(tpl({duration:1,transition:'cut',transitionDuration:.5},
    {duration:1,transition:'dissolve',transitionDuration:.5}),[{assetId:'a',duration:10}]);
  assert.equal(plan.slots[0].transitionDuration,0);
  assert.equal(plan.slots[1].transitionDuration,.5);
});

test('소재가 없으면 계획을 세우지 않는다',()=>{
  assert.equal(planTemplate(tpl({duration:1}),[]).ok,false);
  assert.equal(planTemplate(tpl({duration:1}),[{assetId:'a',duration:0}]).ok,false);
  assert.match(planTemplate(tpl({duration:1}),[]).reason,/라이브러리에 올려/);
});

test('망가진 템플릿은 읽지 않는다',()=>{
  for(const bad of [null,undefined,{},{id:'x'},{id:'x',name:'이름'},{id:'x',name:'이름',slots:[]},
    {id:'!!',name:'이름',slots:[{duration:1}]},{id:'x',name:'',slots:[{duration:1}]}]){
    assert.equal(normalizeTemplate(bad),null,JSON.stringify(bad));
  }
  const fixed=normalizeTemplate({id:'x',name:'이름',slots:[{duration:'2',speed:99,transition:'없는효과',transitionDuration:9},{duration:-1},'쓰레기']});
  assert.equal(fixed.slots.length,1,'읽을 수 없는 슬롯은 버린다');
  assert.equal(fixed.slots[0].speed,4,'배속은 범위로 자른다');
  assert.equal(fixed.slots[0].transition,'cut','모르는 전환은 컷으로');
  assert.equal(fixed.slots[0].transitionDuration,2,'전환 길이도 자른다');
});

test('슬롯 개수는 상한이 있다',()=>{
  const many=Array.from({length:MAX_SLOTS+30},()=>({duration:1}));
  assert.equal(normalizeTemplate({id:'x',name:'이름',slots:many}).slots.length,MAX_SLOTS);
});

test('저장하고 목록에서 찾고 이름을 바꾸고 지운다',()=>{
  reset();project.clips=[video('a',4),video('b',4)];migrateTimeline();
  const storage=fakeStorage();
  const saved=saveTemplate('첫 템플릿',{storage});
  assert.equal(listTemplates(storage).length,1);
  assert.equal(listTemplates(storage)[0].name,'첫 템플릿');
  assert.equal(renameTemplate(saved.id,'이름 바꿈',storage),true);
  assert.equal(listTemplates(storage)[0].name,'이름 바꿈');
  assert.equal(deleteTemplate(saved.id,storage),true);
  assert.deepEqual(listTemplates(storage),[]);
  assert.equal(deleteTemplate('없는-id',storage),false);
  assert.equal(renameTemplate('없는-id','x',storage),false);
});

test('같은 이름으로 다시 저장하면 예전 것을 밀어낸다',()=>{
  reset();project.clips=[video('a',4)];migrateTimeline();
  const storage=fakeStorage();
  saveTemplate('같은 이름',{storage});
  project.clips=[video('a',4),video('b',4)];
  saveTemplate('같은 이름',{storage});
  const list=listTemplates(storage);
  assert.equal(list.length,1);
  assert.equal(list[0].slots.length,2,'새로 저장한 것이 남는다');
});

test('저장소가 망가져 있어도 빈 목록으로 버틴다',()=>{
  const storage=fakeStorage();
  for(const junk of ['','{','null','{"templates":"배열아님"}','{"templates":[1,2,3]}']){
    storage.setItem(TEMPLATE_STORAGE_KEY,junk);
    assert.deepEqual(listTemplates(storage),[],junk);
  }
});

test('저장소를 쓸 수 없으면 알아들을 수 있게 알려 준다',()=>{
  reset();project.clips=[video('a',4)];migrateTimeline();
  assert.throws(()=>saveTemplate('x',{storage:{}}),/사이트 저장소를 허용/);
  const full={getItem:()=>null,setItem(){throw new Error('quota');}};
  assert.throws(()=>saveTemplate('x',{storage:full}),/저장 공간을 확인/);
});

test('템플릿 개수에는 상한이 있다',()=>{
  reset();project.clips=[video('a',4)];migrateTimeline();
  const storage=fakeStorage();
  for(let i=0;i<MAX_TEMPLATES;i++)saveTemplate('템플릿 '+i,{storage});
  assert.equal(listTemplates(storage).length,MAX_TEMPLATES);
  assert.throws(()=>saveTemplate('하나 더',{storage}),/개까지 저장할 수 있습니다/);
});
