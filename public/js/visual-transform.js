// 모든 화면 요소가 공유하는 변형·화면 자르기 좌표계입니다.
import { clamp } from './util.js';
export function transformOf(item) {
  return { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, flipX: false, flipY: false, ...item.transform };
}
export function croppedBounds(bounds, crop = {}) {
  const left=clamp(crop.left||0,0,.95),right=clamp(crop.right||0,0,.98-left);
  const top=clamp(crop.top||0,0,.95),bottom=clamp(crop.bottom||0,0,.98-top);
  return {x:bounds.x+bounds.w*left,y:bounds.y+bounds.h*top,w:bounds.w*(1-left-right),h:bounds.h*(1-top-bottom)};
}
export function transformPoint(point, bounds, item, W, H) {
  const t=transformOf(item),cx=bounds.x+bounds.w/2,cy=bounds.y+bounds.h/2,a=t.rotation*Math.PI/180;
  const x=(point.x-cx)*t.scaleX*(t.flipX?-1:1),y=(point.y-cy)*t.scaleY*(t.flipY?-1:1);
  return {x:cx+t.offsetX*W+x*Math.cos(a)-y*Math.sin(a),y:cy+t.offsetY*H+x*Math.sin(a)+y*Math.cos(a)};
}
export function visualCorners(bounds, item, W, H) {
  const b=croppedBounds(bounds,item.crop);
  return [{x:b.x,y:b.y},{x:b.x+b.w,y:b.y},{x:b.x+b.w,y:b.y+b.h},{x:b.x,y:b.y+b.h}]
    .map(p=>transformPoint(p,bounds,item,W,H));
}
export function alignVisual(item, bounds, W, H, axis) {
  const zero={...item,transform:{...transformOf(item),offsetX:0,offsetY:0}};
  const corners=visualCorners(bounds,zero,W,H);
  const x=corners.reduce((n,p)=>n+p.x,0)/4,y=corners.reduce((n,p)=>n+p.y,0)/4;
  item.transform={...transformOf(item),...(axis==='x'?{offsetX:(W/2-x)/W}:{offsetY:(H/2-y)/H})};
}
export function withVisualTransform(ctx, bounds, item, W, H, paint) {
  const t=transformOf(item),cx=bounds.x+bounds.w/2,cy=bounds.y+bounds.h/2;
  ctx.save();
  ctx.translate(cx+t.offsetX*W,cy+t.offsetY*H);ctx.rotate(t.rotation*Math.PI/180);
  ctx.scale(t.scaleX*(t.flipX?-1:1),t.scaleY*(t.flipY?-1:1));ctx.translate(-cx,-cy);
  ctx.globalAlpha*=t.opacity;
  if(item.crop&&Object.values(item.crop).some(value=>value>0)){
    const b=croppedBounds(bounds,item.crop);ctx.beginPath();ctx.rect(b.x,b.y,b.w,b.h);ctx.clip();
  }
  paint();ctx.restore();
}
