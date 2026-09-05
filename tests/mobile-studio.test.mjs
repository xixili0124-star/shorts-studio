import test from 'node:test';
import assert from 'node:assert/strict';
import {mobileLayout,mobileDockView} from '../public/js/mobile-studio.js';

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
