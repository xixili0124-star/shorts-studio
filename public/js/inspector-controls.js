import { fontField } from './font-picker.js';
import { effectSettings, TEXT_EFFECTS } from './text-effects.js';
import { ACCENT } from './state.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const section=(label,body)=>'<section class="property-section"><h3>'+label+'</h3>'+body+'</section>';
const range=(label,prop,value,min,max,step=1,suffix='')=>{
  const numeric=Number(value),bounded=Math.min(max,Math.max(min,Number.isFinite(numeric)?numeric:min));
  return '<label class="property-row"><span>'+esc(label)+'</span><input type="range" data-prop="'+esc(prop)+'" min="'+min+'" max="'+max+'" step="'+step+'" value="'+bounded+'" aria-label="'+esc(label)+'"><output>'+bounded.toFixed(step<1?2:0)+esc(suffix)+'</output></label>';
};
const select=(label,prop,value,options)=>'<label class="field-label">'+label+'<select data-prop="'+prop+'" aria-label="'+label+'">'+options.map(([key,name])=>'<option value="'+key+'" '+(key===value?'selected':'')+'>'+name+'</option>').join('')+'</select></label>';
function color(label,prop,value,fallback='#000000') {
  let hex=String(value||fallback);
  if(/^#[0-9a-f]{3}$/i.test(hex))hex='#'+[...hex.slice(1)].map(c=>c+c).join('');
  if(!/^#[0-9a-f]{6}$/i.test(hex))hex=fallback;
  return '<label class="property-row"><span>'+label+'</span><input type="color" data-prop="'+prop+'" value="'+esc(hex)+'" aria-label="'+label+'"></label>';
}
export function typographyControls(style,prefix='') {
  return section('글자 스타일',fontField(prefix+'font',style.font)+range('크기',prefix+'size',style.size||58,24,200)+color('글자색',prefix+'color',style.color,'#ffffff'));
}
export function textAppearanceControls(style,prefix='') {
  const box=style.box||'none',shadow=style.shadowEnabled??box==='none';
  return section('테두리',range('두께',prefix+'strokeW',style.strokeW||0,0,24)+color('테두리 색',prefix+'stroke',style.stroke)+'<p class="inspector-note">두께 0은 테두리 없음입니다.</p>')+
    section('텍스트 박스',select('박스',prefix+'box',box,[['none','없음'],['dark','어두운 박스'],['white','밝은 박스'],['accent','사용자 색']])+
      color('박스 색',prefix+'boxColor',style.boxColor,box==='white'?'#ffffff':box==='accent'?ACCENT:'#000000')+
      range('박스 불투명도',prefix+'boxOpacity',(style.boxOpacity??(box==='dark'?.62:box==='white'?.92:1))*100,0,100,1,'%')+
      range('좌우 여유',prefix+'boxPaddingX',style.boxPaddingX??Math.round((style.size||58)*.38),0,100)+
      range('상하 여유',prefix+'boxPaddingY',style.boxPaddingY??Math.round((style.size||58)*.16),0,70)+
      range('모서리',prefix+'boxRadius',style.boxRadius??Math.round((style.size||58)*.18),0,100))+
    section('그림자','<label class="check-label"><input type="checkbox" data-prop="'+prefix+'shadowEnabled" '+(shadow?'checked':'')+'>그림자 사용</label>'+
      color('그림자 색',prefix+'shadowColor',style.shadowColor)+
      range('그림자 불투명도',prefix+'shadowOpacity',(style.shadowOpacity??.55)*100,0,100,1,'%')+
      range('흐림',prefix+'shadowBlur',style.shadowBlur??Math.round((style.size||58)*.22),0,80)+
      range('가로 거리',prefix+'shadowX',style.shadowX||0,-80,80)+
      range('세로 거리',prefix+'shadowY',style.shadowY??Math.round((style.size||58)*.05),-80,80));
}
export function captionEffectControls(style,prefix='style.',legacyOut=false) {
  const settings=effectSettings(style,legacyOut);
  return section('효과','<div class="effect-pair"><h4>시작 효과</h4>'+select('시작',prefix+'inEffect',settings.inEffect,TEXT_EFFECTS)+
    range('시작 길이',prefix+'inDuration',settings.inDuration,.05,2,.05,'초')+
    '<h4>끝지점 효과</h4>'+select('끝',prefix+'outEffect',settings.outEffect,TEXT_EFFECTS)+
    range('끝 길이',prefix+'outDuration',settings.outDuration,.05,2,.05,'초')+
    '</div><p class="inspector-note">시작과 끝에 서로 다른 효과를 적용할 수 있어요. 짧은 클립은 각 효과를 길이의 절반 안으로 맞춥니다.</p>');
}
