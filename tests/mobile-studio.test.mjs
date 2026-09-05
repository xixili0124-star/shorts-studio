import test from 'node:test';
import assert from 'node:assert/strict';
import {mobileLayout,mobileDockView,mobileActions,mobileInspectorMatches} from '../public/js/mobile-studio.js';

test('휴대폰 세로와 터치 가로 화면을 같은 모바일 편집기로 연결한다',()=>{
  assert.deepEqual(mobileLayout({width:390,height:844}),{active:true,landscape:false});
  assert.deepEqual(mobileLayout({width:844,height:390,coarse:true}),{active:true,landscape:true});
  assert.deepEqual(mobileLayout({width:1024,height:768,coarse:true}),{active:true,landscape:true});
});
test('넓은 마우스 화면과 큰 터치 PC는 기존 PC 레이아웃을 유지한다',()=>{
  assert.equal(mobileLayout({width:1024,height:768}).active,false);
  assert.equal(mobileLayout({width:1440,height:900,coarse:true}).active,false);
});
test('검수용 화면 전환은 브라우저 크기보다 우선하고 미지정 값은 자동 판단한다',()=>{
  assert.deepEqual(mobileLayout({width:1440,height:900,override:'mobile'}),{active:true,landscape:true});
  assert.deepEqual(mobileLayout({width:390,height:844,coarse:true,override:'desktop'}),{active:false,landscape:false});
  assert.equal(mobileLayout({width:390,height:844,override:'invalid'}).active,true);
});
test('세부 효과 화면에서도 현재 하단 도구 묶음을 찾을 수 있다',()=>{
  for(const view of ['media','captions','voice'])assert.equal(mobileDockView(view),view);
  for(const view of ['quick-format','graphics','transitions','mosaic','silence','sounds'])assert.equal(mobileDockView(view),'effects');
});
test('선택 전에는 추가 도구만, 선택 후에는 해당 클립 편집 도구만 제시한다',()=>{
  assert.deepEqual(mobileActions().map(item=>item[1]),['추가','자막','소리','그래픽','퀵포맷']);
  const video=mobileActions({type:'clip',count:1}).map(item=>item[0]);
  assert.ok(video.includes('splitClip'));assert.ok(!video.includes('view:media'));
  const caption=mobileActions({type:'caption',count:1}).map(item=>item[0]);
  assert.ok(caption.includes('inspector:text'));assert.ok(!caption.includes('inspector:crop'));
  const audio=mobileActions({type:'audio',count:1}).map(item=>item[0]);
  assert.ok(audio.includes('inspector:volume'));assert.ok(!audio.includes('menu:screen'));
  const graphic=mobileActions({type:'graphic',count:1}).map(item=>item[0]);
  assert.ok(graphic.includes('inspector:motion'));assert.ok(!graphic.includes('inspector:effects'));
});
test('여러 클립과 공백에는 개별 클립 전용 설정을 노출하지 않는다',()=>{
  assert.ok(mobileActions({type:'clip',count:2}).some(item=>item[0]==='inspector:all'));
  assert.ok(!mobileActions({type:'caption',count:2}).some(item=>item[0]==='inspector:text'));
  assert.equal(mobileActions({type:'gap'})[0][1],'공백 닫기');
});
test('한 작업 패널에서는 해당 속성만 보이고 전체 속성은 별도로 제공한다',()=>{
  assert.equal(mobileInspectorMatches('font','글자 스타일'),true);
  assert.equal(mobileInspectorMatches('font','텍스트 박스'),false);
  assert.equal(mobileInspectorMatches('text','내용'),true);
  assert.equal(mobileInspectorMatches('text','키프레임'),false);
  assert.equal(mobileInspectorMatches('motion','키프레임'),true);
  assert.equal(mobileInspectorMatches('motion','변형'),false);
  assert.equal(mobileInspectorMatches('all','트랙'),true);
});
