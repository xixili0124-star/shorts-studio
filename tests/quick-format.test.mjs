import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  QUICK_FORMAT_PRESETS,
  quickFormatState,
  applyQuickFormatPreset,
  setQuickFormatMargins,
  setQuickFormatEnabled,
  setQuickFormatText,
  setQuickFormatTextStyle,
} from '../public/js/quick-format.js';
import {
  SAVED_QUICK_FORMATS_KEY, MAX_SAVED_QUICK_FORMATS,
  listSavedQuickFormats, saveQuickFormat, deleteSavedQuickFormat, applySavedQuickFormat,
} from '../public/js/saved-quick-formats.js';
import { captureDocument, restoreDocument, History, validateDocument } from '../public/js/project-store.js';
import { project, newClipDefaults } from '../public/js/state.js';
import { renderFrame } from '../public/js/render.js';

const require=createRequire(import.meta.url);
let canvasModule;
try{canvasModule=require(process.env.STUDIO_CANVAS_MODULE||'@napi-rs/canvas');}catch{}

const defaults = structuredClone(project);
const reset = () => Object.assign(project, structuredClone(defaults));
const closeTo = (actual, expected, message) => assert.ok(
  Math.abs(actual - expected) < 1e-9,
  `${message || 'value'}: expected ${expected}, received ${actual}`,
);

function quickFormatStorage(initial = null) {
  const values = new Map(initial === null ? [] : [[SAVED_QUICK_FORMATS_KEY, initial]]);
  return {
    getItem:key => values.get(key) ?? null,
    setItem:(key, value) => values.set(key, String(value)),
  };
}

test('saved quick formats restore every editable value without changing unrelated project data', () => {
  const storage=quickFormatStorage(), template=structuredClone(defaults.template);
  applyQuickFormatPreset(template,'top-focus');
  setQuickFormatMargins(template,.31,.16);
  setQuickFormatText(template,'top','첫 줄 *강조*\n둘째 줄');
  setQuickFormatText(template,'bottom','아래 *포인트*');
  for(const [side,style] of [
    ['top',{position:.24,font:'"Hahmlet"',size:137,color:'#112233',accent:'#ffee33',background:'#340011'}],
    ['bottom',{position:.77,font:'"Jua"',size:69,color:'#ddeeff',accent:'#66ccdd',background:'#113344'}],
  ])for(const [key,value] of Object.entries(style))setQuickFormatTextStyle(template,side,key,value);
  const before=structuredClone(template), item=saveQuickFormat(template,'  이야기 포맷  ',{storage});
  assert.deepEqual(template,before,'saving does not change the current project');
  assert.equal(item.name,'이야기 포맷');
  const target=structuredClone(defaults.template);
  target.customMetadata={keep:true};target.hook.customMetadata='유지';target.comment.name='보존';
  const applied=applySavedQuickFormat(target,item.id,storage);
  assert.deepEqual(applied,quickFormatState(template));
  assert.deepEqual(target.customMetadata,{keep:true});
  assert.equal(target.hook.customMetadata,'유지');assert.equal(target.comment.name,'보존');
  item.settings.topText='외부 수정';
  assert.equal(listSavedQuickFormats(storage)[0].settings.topText,'첫 줄 *강조*\n둘째 줄','returned values are detached from stored data');
});

test('saving a disabled quick format preserves its copy and restores its disabled state', () => {
  const storage=quickFormatStorage(), template=structuredClone(defaults.template);
  applyQuickFormatPreset(template,'bottom-focus');setQuickFormatText(template,'top','켜면 다시 보여요');
  setQuickFormatEnabled(template,false);
  const item=saveQuickFormat(template,'숨긴 포맷',{storage}), target={};
  assert.deepEqual(applySavedQuickFormat(target,item.id,storage),quickFormatState(template));
  assert.equal(target.mode,'none');
  assert.equal(setQuickFormatEnabled(target,true).topText,'켜면 다시 보여요');
});

test('saved formats can be replaced and deleted without affecting other entries', () => {
  const storage=quickFormatStorage(), template={};applyQuickFormatPreset(template,'balanced');
  const first=saveQuickFormat(template,'처음',{storage}), second=saveQuickFormat(template,'둘째',{storage});
  setQuickFormatText(template,'bottom','새 문구');
  const updated=saveQuickFormat(template,'이름 수정',{storage,id:first.id});
  assert.equal(updated.id,first.id);assert.equal(listSavedQuickFormats(storage).length,2);
  assert.equal(listSavedQuickFormats(storage)[0].settings.bottomText,'새 문구');
  assert.equal(deleteSavedQuickFormat(first.id,storage),true);
  assert.deepEqual(listSavedQuickFormats(storage).map(item=>item.id),[second.id]);
  assert.equal(deleteSavedQuickFormat(first.id,storage),false);
  const before=structuredClone(template);
  assert.throws(()=>applySavedQuickFormat(template,first.id,storage),/찾을 수 없습니다/);
  assert.deepEqual(template,before,'missing records must not partially change the template');
  assert.throws(()=>saveQuickFormat(template,'없음',{storage,id:first.id}),/찾을 수 없습니다/);
});

test('saved formats reject excess entries, allow updating at the limit, and bound names and text', () => {
  const storage=quickFormatStorage(), template={};applyQuickFormatPreset(template,'balanced');
  template.hook.text='가'.repeat(1000);
  for(let index=0;index<MAX_SAVED_QUICK_FORMATS;index++)saveQuickFormat(template,`포맷 ${index}`,{storage});
  const before=storage.getItem(SAVED_QUICK_FORMATS_KEY), first=listSavedQuickFormats(storage)[0];
  assert.equal(first.settings.topText.length,240);
  assert.throws(()=>saveQuickFormat(template,'추가',{storage}),/20개까지/);
  assert.equal(storage.getItem(SAVED_QUICK_FORMATS_KEY),before);
  assert.equal(saveQuickFormat(template,'가'.repeat(100),{storage,id:first.id}).name.length,40);
  assert.throws(()=>saveQuickFormat(template,'\u0000\n ',{storage,id:first.id}),/이름/);
});

test('malformed individual saved formats are discarded and unsupported values cannot overwrite prototypes', () => {
  const storage=quickFormatStorage(), template={};applyQuickFormatPreset(template,'wide');
  const saved=saveQuickFormat(template,'정상',{storage});
  const hostile=JSON.parse(JSON.stringify(saved));hostile.id='hostile';hostile.settings.top=99;
  hostile.settings.topText='가'.repeat(1000);hostile.settings.topStyle.size=999;
  hostile.settings.topStyle.font='x'.repeat(101);hostile.settings.topStyle.color='invalid';
  hostile.settings.topStyle.__proto__={polluted:'not copied'};
  Object.defineProperty(hostile.settings,'__proto__',{value:{polluted:true},enumerable:true});
  const bad={...saved,id:'bad',settings:{...saved.settings,topStyle:null}};
  storage.setItem(SAVED_QUICK_FORMATS_KEY,JSON.stringify({version:1,items:[null,bad,saved,{...saved},hostile,{...saved,id:'bad-name',name:'\u0000'}]}));
  const items=listSavedQuickFormats(storage);
  assert.deepEqual(items.map(item=>item.id),[saved.id,'hostile']);
  const target={};applySavedQuickFormat(target,'hostile',storage);
  assert.equal(target.videoTop,.45);assert.equal(target.hook.size,200);
  assert.equal(target.hook.text.length,240);assert.equal(target.hook.color,'#ffffff');
  assert.equal(target.hook.font,'"Black Han Sans"');
  assert.equal(target.polluted,undefined);assert.equal({}.polluted,undefined);
});

test('broken or unsupported saved-format data is reported without overwriting it', () => {
  for(const raw of ['{broken',JSON.stringify({version:2,items:[]}),JSON.stringify({version:1,items:{}})]){
    const storage=quickFormatStorage(raw);
    assert.throws(()=>listSavedQuickFormats(storage),/기존 저장값은 변경하지 않았습니다/);
    assert.throws(()=>saveQuickFormat({},'새 포맷',{storage}),/읽을 수 없습니다/);
    assert.equal(storage.getItem(SAVED_QUICK_FORMATS_KEY),raw);
  }
});

test('unavailable or full browser storage produces an actionable error and retains existing entries', () => {
  assert.throws(()=>listSavedQuickFormats({}),/사이트 저장소를 허용/);
  assert.throws(()=>listSavedQuickFormats({getItem(){throw new Error();},setItem(){}}),/사이트 저장소를 허용/);
  const storage=quickFormatStorage(), template={};applyQuickFormatPreset(template,'balanced');
  const first=saveQuickFormat(template,'유지',{storage}), before=storage.getItem(SAVED_QUICK_FORMATS_KEY);
  storage.setItem=()=>{throw new Error('QuotaExceededError');};
  assert.throws(()=>saveQuickFormat(template,'실패',{storage}),/저장 공간.*공간을 확보/);
  assert.throws(()=>deleteSavedQuickFormat(first.id,storage),/저장 공간/);
  assert.equal(storage.getItem(SAVED_QUICK_FORMATS_KEY),before);
});

test('quick-format presets expose the four supported top and bottom band layouts', () => {
  const presets = new Map(QUICK_FORMAT_PRESETS.map(item => [item.id, item]));
  assert.equal(presets.size, QUICK_FORMAT_PRESETS.length, 'preset ids are unique');
  assert.deepEqual([...presets.keys()], ['balanced', 'top-focus', 'bottom-focus', 'wide']);
  for (const [id, top, bottom] of [
    ['balanced', .20, .20],
    ['top-focus', .28, .14],
    ['bottom-focus', .14, .28],
    ['wide', .12, .12],
  ]) {
    const preset = presets.get(id);
    assert.ok(preset?.label, `${id} has a user-facing label`);
    closeTo(preset.top, top, `${id} top margin`);
    closeTo(preset.bottom, bottom, `${id} bottom margin`);
  }
});

test('quickFormatState reads the legacy template without mutating it', () => {
  reset();
  const template = structuredClone(project.template), before = structuredClone(template);
  const state = quickFormatState(template);
  assert.equal(state.enabled, false);
  closeTo(state.top, .24, 'legacy top margin');
  closeTo(state.bottom, .32, 'legacy bottom margin');
  assert.equal(state.topText, template.hook.text);
  assert.equal(state.bottomText, template.credit.text);
  assert.deepEqual(template, before);
});

test('every preset enables the band and keeps the safe text positions inside each area', () => {
  for (const preset of QUICK_FORMAT_PRESETS) {
    const template = structuredClone(defaults.template);
    applyQuickFormatPreset(template, preset.id);
    const state = quickFormatState(template);
    assert.equal(state.enabled, true, preset.id);
    closeTo(state.top, preset.top, `${preset.id} top margin`);
    closeTo(state.bottom, preset.bottom, `${preset.id} bottom margin`);
    closeTo(template.videoHeight, 1 - preset.top - preset.bottom, `${preset.id} video height`);
    closeTo(template.hook.y, preset.top / 2, `${preset.id} top text center`);
    closeTo(template.credit.y, 1 - preset.bottom + preset.bottom * .33, `${preset.id} bottom safe position`);
    closeTo(state.topStyle.position, .5, `${preset.id} top relative position`);
    closeTo(state.bottomStyle.position, .33, `${preset.id} bottom relative position`);
    assert.equal(template.mode, 'band');
    assert.equal(template.bg, '#000000');
    assert.equal(state.topStyle.background, '#000000');
    assert.equal(state.bottomStyle.background, '#000000');
    assert.equal(template.hook.on, true);
    assert.equal(template.comment.on, false);
    assert.equal(template.credit.on, true);
  }
});

test('top and bottom typography, emphasis, position, and background are independent', () => {
  const template = structuredClone(defaults.template);
  applyQuickFormatPreset(template, 'balanced');
  for(const [side,property,value] of [
    ['top','position',.22],['top','font','"Hahmlet"'],['top','size',134],
    ['top','color','#112233'],['top','accent','#ffcc00'],['top','background','#230044'],
    ['bottom','position',.71],['bottom','font','"Jua"'],['bottom','size',76],
    ['bottom','color','#ddeeaa'],['bottom','accent','#00ccff'],['bottom','background','#073329'],
  ])setQuickFormatTextStyle(template,side,property,value);
  const state=quickFormatState(template);
  assert.deepEqual(state.topStyle,{position:.22,font:'"Hahmlet"',size:134,color:'#112233',accent:'#ffcc00',background:'#230044'});
  assert.deepEqual(state.bottomStyle,{position:.71,font:'"Jua"',size:76,color:'#ddeeaa',accent:'#00ccff',background:'#073329'});
  closeTo(template.hook.y,.20*.22,'top absolute position');
  closeTo(template.credit.y,.80+.20*.71,'bottom absolute position');

  setQuickFormatMargins(template,.28,.14);
  const resized=quickFormatState(template);
  closeTo(resized.topStyle.position,.22,'top relative position survives margin edit');
  closeTo(resized.bottomStyle.position,.71,'bottom relative position survives margin edit');
  closeTo(template.hook.y,.28*.22,'top y follows resized band');
  closeTo(template.credit.y,.86+.14*.71,'bottom y follows resized band');
  assert.equal(resized.topStyle.background,'#230044');
  assert.equal(resized.bottomStyle.background,'#073329');
});

test('quick-format style setters clamp risky numeric values and normalize colors', () => {
  const template=structuredClone(defaults.template);applyQuickFormatPreset(template,'balanced');
  setQuickFormatTextStyle(template,'top','position',-2);
  setQuickFormatTextStyle(template,'top','size',999);
  setQuickFormatTextStyle(template,'top','color','not-a-color');
  const state=quickFormatState(template);
  closeTo(state.topStyle.position,.10);
  assert.equal(state.topStyle.size,200);
  assert.equal(state.topStyle.color,'#ffffff');
  assert.throws(()=>setQuickFormatTextStyle(template,'middle','size',50),/상단|하단/);
  assert.throws(()=>setQuickFormatTextStyle(template,'top','unknown',50),/지원하지 않는/);
});

test('manual margins stay within 0–45% and leave at least 30% for video', () => {
  const template = structuredClone(defaults.template);
  setQuickFormatMargins(template, .45, .45, 'top');
  let state = quickFormatState(template);
  closeTo(state.top, .45, 'top remains at the dragged value');
  closeTo(state.bottom, .25, 'bottom yields to preserve the video');
  closeTo(template.videoHeight, .30, 'minimum video height');

  setQuickFormatMargins(template, .45, .45, 'bottom');
  state = quickFormatState(template);
  closeTo(state.top, .25, 'top yields to preserve the video');
  closeTo(state.bottom, .45, 'bottom remains at the dragged value');
  closeTo(template.videoHeight, .30, 'minimum video height');

  setQuickFormatMargins(template, -.2, 8, 'bottom');
  state = quickFormatState(template);
  closeTo(state.top, 0, 'negative top margin is clamped');
  closeTo(state.bottom, .45, 'oversized bottom margin is clamped');
  closeTo(template.videoHeight, .55, 'video height follows normalized margins');
});

test('top and bottom text edits preserve line breaks and do not reset layout', () => {
  const template = structuredClone(defaults.template);
  applyQuickFormatPreset(template, 'top-focus');
  setQuickFormatText(template, 'top', '첫 줄\n둘째 줄');
  setQuickFormatText(template, 'bottom', '끝까지 보면 반전');
  const state = quickFormatState(template);
  assert.equal(state.topText, '첫 줄\n둘째 줄');
  assert.equal(state.bottomText, '끝까지 보면 반전');
  closeTo(state.top, .28, 'text edit preserves top margin');
  closeTo(state.bottom, .14, 'text edit preserves bottom margin');
  assert.throws(() => setQuickFormatText(template, 'middle', '잘못된 위치'), /top|bottom|상단|하단/i);
});

test('turning quick format off and on preserves the chosen layout and copy', () => {
  const template = structuredClone(defaults.template);
  applyQuickFormatPreset(template, 'bottom-focus');
  setQuickFormatText(template, 'top', '오늘의 이슈');
  setQuickFormatText(template, 'bottom', '여러분 생각은?');
  setQuickFormatEnabled(template, false);
  assert.equal(quickFormatState(template).enabled, false);
  assert.equal(template.mode, 'none');
  setQuickFormatEnabled(template, true);
  const state = quickFormatState(template);
  assert.equal(state.enabled, true);
  closeTo(state.top, .14, 'restored top margin');
  closeTo(state.bottom, .28, 'restored bottom margin');
  assert.equal(state.topText, '오늘의 이슈');
  assert.equal(state.bottomText, '여러분 생각은?');
});

test('quick format survives document validation, restore, undo, and redo', () => {
  reset();
  const original = captureDocument(), history = new History();
  applyQuickFormatPreset(project.template, 'wide');
  setQuickFormatText(project.template, 'top', '3초 뒤 반전');
  setQuickFormatText(project.template, 'bottom', '결말은 댓글에서');
  setQuickFormatTextStyle(project.template,'top','position',.25);
  setQuickFormatTextStyle(project.template,'top','font','"Hahmlet"');
  setQuickFormatTextStyle(project.template,'top','size',116);
  setQuickFormatTextStyle(project.template,'top','color','#ffeecc');
  setQuickFormatTextStyle(project.template,'top','background','#221133');
  setQuickFormatTextStyle(project.template,'bottom','position',.68);
  setQuickFormatTextStyle(project.template,'bottom','background','#003322');
  const edited = captureDocument();

  assert.doesNotThrow(() => validateDocument(edited, []));
  restoreDocument(edited);
  let state = quickFormatState(project.template);
  assert.equal(state.enabled, true);
  assert.equal(state.topText, '3초 뒤 반전');
  assert.equal(state.bottomText, '결말은 댓글에서');
  assert.equal(state.topStyle.font,'"Hahmlet"');
  assert.equal(state.topStyle.size,116);
  assert.equal(state.topStyle.color,'#ffeecc');
  assert.equal(state.topStyle.background,'#221133');
  assert.equal(state.bottomStyle.background,'#003322');
  closeTo(state.topStyle.position,.25);
  closeTo(state.bottomStyle.position,.68);
  closeTo(state.top, .12, 'restored top margin');
  closeTo(state.bottom, .12, 'restored bottom margin');

  assert.equal(history.push(original, '퀵포맷 적용'), true);
  assert.equal(history.undo(), '퀵포맷 적용');
  assert.deepEqual(captureDocument(), original);
  assert.equal(history.redo(), '퀵포맷 적용');
  assert.deepEqual(captureDocument(), edited);
});

test('opening a legacy document without a template does not inherit the previous project format', () => {
  reset();
  const legacy=captureDocument();delete legacy.template;
  applyQuickFormatPreset(project.template,'top-focus');setQuickFormatText(project.template,'top','이전 프로젝트 문구');
  restoreDocument(legacy);
  assert.equal(project.template.quickFormat,false);
  assert.equal(project.template.mode,'none');
  assert.notEqual(project.template.hook.text,'이전 프로젝트 문구');
});

test('the shared renderer keeps the video between the exported black bands', {skip:!canvasModule}, () => {
  reset();
  applyQuickFormatPreset(project.template, 'balanced');
  project.clips=[{...newClipDefaults('image'),id:'quick-clip',name:'test',imgDuration:2,natW:90,natH:96,start:0}];
  const canvas=canvasModule.createCanvas(90,160),source=canvasModule.createCanvas(90,96);
  const sourceContext=source.getContext('2d');sourceContext.fillStyle='#00ff00';sourceContext.fillRect(0,0,90,96);
  const context=canvas.getContext('2d');renderFrame(context,1,{source:()=>({img:source,w:90,h:96})});
  const pixel=(x,y)=>[...context.getImageData(x,y,1,1).data];
  assert.deepEqual(pixel(2,2),[0,0,0,255]);
  assert.deepEqual(pixel(45,80),[0,255,0,255]);
  assert.deepEqual(pixel(2,157),[0,0,0,255]);

  setQuickFormatTextStyle(project.template,'top','background','#ff0000');
  setQuickFormatTextStyle(project.template,'bottom','background','#0000ff');
  renderFrame(context,1,{source:()=>({img:source,w:90,h:96})});
  assert.deepEqual(pixel(2,2),[255,0,0,255]);
  assert.deepEqual(pixel(45,80),[0,255,0,255]);
  assert.deepEqual(pixel(2,157),[0,0,255,255]);

  setQuickFormatText(project.template,'top','긴 문구 '.repeat(40));
  setQuickFormatText(project.template,'bottom','아래 문구 '.repeat(40));
  renderFrame(context,1,{source:()=>({img:source,w:90,h:96})});
  let intrusions=0;
  for(let y=33;y<127;y++)for(let x=0;x<90;x++){
    const [r,g,b,a]=pixel(x,y);if(r!==0||g!==255||b!==0||a!==255)intrusions++;
  }
  assert.equal(intrusions,0,'quick-format copy is clipped to its own black band');
});
