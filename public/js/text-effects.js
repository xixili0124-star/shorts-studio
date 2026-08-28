// 텍스트의 시작·끝 효과는 프레임 시각만으로 계산합니다. 미리보기와 내보내기가 같습니다.
import { clamp } from './util.js';

export const TEXT_EFFECTS = [
  ['none','없음'], ['fade','페이드'], ['pop','팝업'],
  ['slide-up','위로 슬라이드'], ['slide-down','아래로 슬라이드'],
  ['slide-left','왼쪽으로 슬라이드'], ['slide-right','오른쪽으로 슬라이드'],
  ['zoom','줌'], ['bounce','바운스'], ['rotate','회전'],
  ['blur','흐림'], ['wipe','가로 펼치기'], ['typewriter','타이핑'],
];
export const TEXT_STYLE_KEYS = ['font','size','color','stroke','strokeW','box','boxColor','boxOpacity',
  'boxPaddingX','boxPaddingY','boxRadius','shadowEnabled','shadowColor','shadowOpacity','shadowBlur','shadowX','shadowY',
  'glow','anim','inEffect','outEffect','inDuration','outDuration'];
const allowed = new Set(TEXT_EFFECTS.map(([id]) => id));
const easing = p => 1 - (1-p)**3;
export function effectSettings(style = {}, legacyOut = false) {
  const old = style.anim === 'up' ? 'slide-up' : style.anim;
  const start = style.inEffect ?? old ?? 'none';
  const end = style.outEffect ?? (legacyOut && old && old !== 'none' ? 'fade' : 'none');
  const duration = (value, fallback) => Number.isFinite(value) ? clamp(value,.05,3) : fallback;
  return { inEffect:allowed.has(start)?start:'none', outEffect:allowed.has(end)?end:'none',
    inDuration:duration(style.inDuration,.35), outDuration:duration(style.outDuration,.3) };
}
function phaseEffect(type, progress) {
  const p=clamp(progress,0,1), e=easing(p), d=1-e;
  const result={alpha:1,x:0,y:0,scale:1,rotation:0,blur:0,reveal:1,characters:1};
  if(type==='none')return result;
  result.alpha=p;
  if(type==='pop')result.scale=.65+.35*e+Math.sin(p*Math.PI)*.07;
  if(type==='zoom')result.scale=.2+.8*e;
  if(type==='slide-up')result.y=d*.055;
  if(type==='slide-down')result.y=-d*.055;
  if(type==='slide-left')result.x=d*.12;
  if(type==='slide-right')result.x=-d*.12;
  if(type==='bounce'){result.y=-Math.abs(Math.sin(p*Math.PI*2.5))*(1-p)*.055;result.scale=.85+.15*e;}
  if(type==='rotate'){result.rotation=-.24*d;result.scale=.8+.2*e;}
  if(type==='blur')result.blur=d*20;
  if(type==='wipe'){result.reveal=e;result.alpha=1;}
  if(type==='typewriter'){result.characters=p;result.alpha=1;}
  return result;
}
export function textAnimationAt(style, elapsed, duration, legacyOut=false) {
  const settings=effectSettings(style,legacyOut), half=Math.max(.001,duration/2);
  const a=phaseEffect(settings.inEffect,elapsed/Math.min(half,settings.inDuration));
  const b=phaseEffect(settings.outEffect,(duration-elapsed)/Math.min(half,settings.outDuration));
  return {alpha:a.alpha*b.alpha,x:a.x+b.x,y:a.y+b.y,scale:a.scale*b.scale,
    rotation:a.rotation+b.rotation,blur:Math.max(a.blur,b.blur),reveal:Math.min(a.reveal,b.reveal),characters:Math.min(a.characters,b.characters)};
}
export function visibleText(text, progress=1) {
  if(progress>=1)return String(text);
  const chars=typeof Intl.Segmenter==='function'
    ? [...new Intl.Segmenter('ko',{granularity:'grapheme'}).segment(String(text))].map(part=>part.segment)
    : Array.from(String(text));
  return chars.slice(0,Math.floor(chars.length*clamp(progress,0,1))).join('');
}
export function withTextAnimation(ctx,motion,bounds,W,H,paint) {
  if(motion.alpha<=.001||motion.reveal<=0||motion.characters<=0)return;
  const cx=bounds.x+bounds.w/2,cy=bounds.y+bounds.h/2;
  ctx.save();ctx.globalAlpha*=motion.alpha;
  ctx.translate(cx+motion.x*W,cy+motion.y*H);ctx.rotate(motion.rotation);ctx.scale(motion.scale,motion.scale);ctx.translate(-cx,-cy);
  if(motion.blur>0)ctx.filter='blur('+(motion.blur*H/1920)+'px)';
  if(motion.reveal<1){ctx.beginPath();ctx.rect(bounds.x-H*.02,bounds.y-H*.04,(bounds.w+H*.04)*motion.reveal,bounds.h+H*.08);ctx.clip();}
  paint();ctx.restore();
}
