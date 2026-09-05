const MAX_MARGIN = .45;
const MIN_VIDEO_HEIGHT = .30;
const MAX_BAND_TOTAL = 1 - MIN_VIDEO_HEIGHT;
const MIN_TEXT_POSITION = .10;
const MAX_TEXT_POSITION = .90;
const MIN_TEXT_SIZE = 24;
const MAX_TEXT_SIZE = 200;

export const QUICK_FORMAT_PRESETS = Object.freeze([
  Object.freeze({ id:'balanced', label:'균형형', hint:'상·하단을 같은 높이로', top:.20, bottom:.20 }),
  Object.freeze({ id:'top-focus', label:'상단 강조', hint:'첫 문장을 크게 보여주기', top:.28, bottom:.14 }),
  Object.freeze({ id:'bottom-focus', label:'하단 강조', hint:'설명·결론을 넉넉하게', top:.14, bottom:.28 }),
  Object.freeze({ id:'wide', label:'영상 넓게', hint:'화면을 더 크게 유지', top:.12, bottom:.12 }),
]);

const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round = value => Math.round(value * 10000) / 10000;
const hex = (value, fallback='#000000') => /^#[0-9a-f]{6}$/i.test(String(value||'')) ? String(value).toLowerCase() : fallback;

function bandPosition(style, start, height, fallback) {
  if(Number.isFinite(Number(style?.bandPosition)))return clamp(Number(style.bandPosition),MIN_TEXT_POSITION,MAX_TEXT_POSITION);
  if(height<=0)return fallback;
  return clamp((finite(style?.y,start+height*fallback)-start)/height,MIN_TEXT_POSITION,MAX_TEXT_POSITION);
}

function normalizedMargins(top, bottom, changed='both') {
  let nextTop=clamp(finite(top,.20),0,MAX_MARGIN);
  let nextBottom=clamp(finite(bottom,.20),0,MAX_MARGIN);
  if(nextTop+nextBottom>MAX_BAND_TOTAL){
    if(changed==='top')nextBottom=Math.max(0,MAX_BAND_TOTAL-nextTop);
    else if(changed==='bottom')nextTop=Math.max(0,MAX_BAND_TOTAL-nextBottom);
    else {
      const scale=MAX_BAND_TOTAL/(nextTop+nextBottom);
      nextTop*=scale;nextBottom*=scale;
    }
  }
  return {top:round(nextTop),bottom:round(nextBottom)};
}

function ensureTemplate(template) {
  if(!template||typeof template!=='object'||Array.isArray(template))throw new TypeError('퀵포맷 설정이 올바르지 않습니다.');
  template.hook=template.hook&&typeof template.hook==='object'?template.hook:{};
  template.comment=template.comment&&typeof template.comment==='object'?template.comment:{};
  template.credit=template.credit&&typeof template.credit==='object'?template.credit:{};
  Object.assign(template.hook,{
    on:template.hook.on!==false,
    text:String(template.hook.text??''),
    font:template.hook.font||'"Black Han Sans"',
    size:finite(template.hook.size,82),
    color:template.hook.color||'#ffffff',
    accent:template.hook.accent||'#ffe14d',
    background:hex(template.hook.background,hex(template.bg,'#000000')),
    y:finite(template.hook.y,.10),
  });
  Object.assign(template.credit,{
    on:template.credit.on!==false,
    text:String(template.credit.text??''),
    font:template.credit.font||'"Noto Sans KR"',
    size:finite(template.credit.size,58),
    color:template.credit.color||'#ffffff',
    accent:template.credit.accent||template.credit.color||'#ffffff',
    background:hex(template.credit.background,hex(template.bg,'#000000')),
    y:finite(template.credit.y,.90),
  });
  if(typeof template.comment.on!=='boolean')template.comment.on=false;
  template.bg=hex(template.bg,'#000000');
  return template;
}

export function quickFormatState(template) {
  const top=finite(template?.videoTop,.20);
  const height=finite(template?.videoHeight,.60);
  const margins=normalizedMargins(top,1-top-height);
  const preset=QUICK_FORMAT_PRESETS.find(item=>Math.abs(item.top-margins.top)<.001&&Math.abs(item.bottom-margins.bottom)<.001);
  const topStyle=template?.hook||{},bottomStyle=template?.credit||{};
  return {
    enabled:template?.mode==='band'&&template?.quickFormat===true,
    top:margins.top,
    bottom:margins.bottom,
    videoHeight:round(1-margins.top-margins.bottom),
    topText:String(template?.hook?.text??''),
    bottomText:String(template?.credit?.text??''),
    topStyle:{
      position:bandPosition(topStyle,0,margins.top,.50),
      font:String(topStyle.font||'"Black Han Sans"'),
      size:clamp(finite(topStyle.size,82),MIN_TEXT_SIZE,MAX_TEXT_SIZE),
      color:hex(topStyle.color,'#ffffff'),
      accent:hex(topStyle.accent,'#ffe14d'),
      background:hex(topStyle.background,hex(template?.bg,'#000000')),
    },
    bottomStyle:{
      position:bandPosition(bottomStyle,1-margins.bottom,margins.bottom,.33),
      font:String(bottomStyle.font||'"Noto Sans KR"'),
      size:clamp(finite(bottomStyle.size,58),MIN_TEXT_SIZE,MAX_TEXT_SIZE),
      color:hex(bottomStyle.color,'#ffffff'),
      accent:hex(bottomStyle.accent,bottomStyle.color||'#ffe14d'),
      background:hex(bottomStyle.background,hex(template?.bg,'#000000')),
    },
    preset:preset?.id||'custom',
  };
}

export function setQuickFormatMargins(template, top, bottom, changed='both') {
  const previous=quickFormatState(template);
  ensureTemplate(template);
  const margins=normalizedMargins(top,bottom,changed);
  template.videoTop=margins.top;
  template.videoHeight=round(1-margins.top-margins.bottom);
  template.hook.bandPosition=previous.topStyle.position;
  template.credit.bandPosition=previous.bottomStyle.position;
  template.hook.y=round(margins.top*previous.topStyle.position);
  template.credit.y=round(1-margins.bottom+margins.bottom*previous.bottomStyle.position);
  return quickFormatState(template);
}

export function setQuickFormatEnabled(template, enabled) {
  if(!enabled){template.mode='none';return quickFormatState(template);}
  const firstUse=template.quickFormat!==true;
  ensureTemplate(template);
  template.quickFormat=true;
  template.mode='band';
  template.comment.on=false;
  template.hook.on=true;
  template.credit.on=true;
  if(firstUse){
    template.hook.text='';
    template.credit.text='';
    template.hook.size=82;
    template.credit.size=58;
    template.hook.bandPosition=.50;
    template.credit.bandPosition=.33;
    template.hook.color='#ffffff';
    template.hook.accent='#ffe14d';
    template.credit.color='#ffffff';
    template.credit.accent='#ffe14d';
    template.hook.background='#000000';
    template.credit.background='#000000';
    setQuickFormatMargins(template,.20,.20);
  }else{
    const state=quickFormatState(template);
    setQuickFormatMargins(template,state.top,state.bottom);
  }
  return quickFormatState(template);
}

export function applyQuickFormatPreset(template, id) {
  const preset=QUICK_FORMAT_PRESETS.find(item=>item.id===id);
  if(!preset)throw new Error('지원하지 않는 퀵포맷입니다.');
  setQuickFormatEnabled(template,true);
  setQuickFormatMargins(template,preset.top,preset.bottom);
  return quickFormatState(template);
}

export function setQuickFormatText(template, position, text) {
  ensureTemplate(template);
  const value=String(text??'').slice(0,240);
  if(position==='top')template.hook.text=value;
  else if(position==='bottom')template.credit.text=value;
  else throw new Error('상단 또는 하단 문구 위치가 올바르지 않습니다.');
  return quickFormatState(template);
}

export function setQuickFormatTextStyle(template, position, property, value) {
  ensureTemplate(template);
  const style=position==='top'?template.hook:position==='bottom'?template.credit:null;
  if(!style)throw new Error('상단 또는 하단 문구 위치가 올바르지 않습니다.');
  if(property==='position'){
    const state=quickFormatState(template),relative=clamp(finite(value,.5),MIN_TEXT_POSITION,MAX_TEXT_POSITION);
    const margin=position==='top'?state.top:state.bottom,start=position==='top'?0:1-margin;
    style.bandPosition=round(relative);style.y=round(start+margin*relative);
  }else if(property==='font'){
    const font=String(value||'').trim();
    if(!font||font.length>100)throw new Error('글꼴 설정이 올바르지 않습니다.');
    style.font=font;
  }else if(property==='size')style.size=Math.round(clamp(finite(value,style.size||58),MIN_TEXT_SIZE,MAX_TEXT_SIZE));
  else if(property==='color')style.color=hex(value,'#ffffff');
  else if(property==='accent')style.accent=hex(value,'#ffe14d');
  else if(property==='background')style.background=hex(value,'#000000');
  else throw new Error('지원하지 않는 퀵포맷 글자 설정입니다.');
  return quickFormatState(template);
}

export const QUICK_FORMAT_LIMITS = Object.freeze({
  maxMargin:MAX_MARGIN,minVideoHeight:MIN_VIDEO_HEIGHT,
  minTextPosition:MIN_TEXT_POSITION,maxTextPosition:MAX_TEXT_POSITION,
  minTextSize:MIN_TEXT_SIZE,maxTextSize:MAX_TEXT_SIZE,
});
