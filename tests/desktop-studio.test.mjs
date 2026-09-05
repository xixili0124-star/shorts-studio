import test from 'node:test';
import assert from 'node:assert/strict';
import {desktopGroupForView,desktopInspectorGroup,desktopInspectorTabs} from '../public/js/desktop-studio.js';

test('기존 라이브러리 화면은 새 탐색 묶음으로 모두 연결되고 모르는 화면은 파일로 복귀한다',()=>{
  const destinations={files:['media'],captions:['captions'],sound:['sounds','voice'],design:['quick-format','graphics','transitions'],tools:['mosaic','silence']};
  const routes=Object.entries(destinations).flatMap(([group,views])=>views.map(view=>({view,group})));
  assert.equal(new Set(routes.map(route=>route.view)).size,9);
  for(const {view,group} of routes)assert.equal(desktopGroupForView(view),group,view);
  for(const unknown of [undefined,null,'','future-tool'])assert.equal(desktopGroupForView(unknown),'files');
});

test('영상·자막·오디오의 속성은 표시되는 탭 하나에만 속해 누락되거나 중복되지 않는다',()=>{
  const selections={
    clip:['변형','원본 맞춤','화면 자르기','키프레임','이미지 모션','원본 오디오','클립 페이드','다음 장면과 전환','트랙','타임라인 위치','클립 구간','자동 편집'],
    caption:['내용','글자 스타일','변형','배치','테두리','텍스트 박스','그림자','키프레임','효과'],
    audio:['오디오','키프레임','트랙','트랙 위치','자동 편집'],
    batch:['화면 설정 대상','변형','글자 스타일','테두리','원본 맞춤','오디오','클립 페이드'],
  };
  for(const [type,titles] of Object.entries(selections)){
    const tabs=desktopInspectorTabs(titles,type);
    const partition=tabs.flatMap(group=>titles.filter(title=>desktopInspectorGroup(title,type)===group));
    assert.deepEqual([...partition].sort(),[...titles].sort(),type+'의 모든 섹션을 한 번씩 표시해야 합니다');
    for(const tab of tabs)assert.ok(titles.some(title=>desktopInspectorGroup(title,type)===tab),type+'에 빈 탭을 만들면 안 됩니다');
  }
});

test('기본 텍스트 편집과 꾸미기·움직임을 구분하고 새로운 속성도 세부 탭에서 찾을 수 있다',()=>{
  assert.equal(desktopInspectorGroup('글자 스타일','caption'),'basic');
  assert.equal(desktopInspectorGroup('텍스트 박스','caption'),'style');
  assert.equal(desktopInspectorGroup('효과','caption'),'motion');
  assert.equal(desktopInspectorGroup('화면 자르기','clip'),'details');
  const future='새로운 색상 보정';
  assert.equal(desktopInspectorGroup(future,'clip'),'details');
  assert.deepEqual(desktopInspectorTabs([future],'clip'),['details']);
});

test('속성 재렌더 순서와 중복 섹션이 달라져도 탭 순서는 고정되고 입력을 바꾸지 않는다',()=>{
  const titles=Object.freeze(['트랙','키프레임','텍스트 박스','내용','키프레임','그림자']);
  const expected=['basic','style','motion','details'];
  assert.deepEqual(desktopInspectorTabs(titles,'caption'),expected);
  assert.deepEqual(desktopInspectorTabs([...titles].reverse(),'caption'),expected);
  assert.deepEqual(desktopInspectorTabs(['오디오','키프레임','트랙 위치'],'audio'),['basic','motion','details']);
  assert.deepEqual(desktopInspectorTabs([],'clip'),[]);
});

test('파일·공백·전환의 전용 속성 화면에는 클립용 탭을 덧씌우지 않는다',()=>{
  for(const [type,title] of [['asset','파일 정보'],['gap','잔물결 삭제'],['transition','장면 전환']]){
    assert.deepEqual(desktopInspectorTabs([title],type),[],type);
  }
});
