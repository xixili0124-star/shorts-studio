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
/** 화면 반전 후에도 원본의 왼쪽·오른쪽 경계를 구분하는 역변환입니다. */
export function inverseTransformPoint(point, bounds, item, W, H) {
  const t=transformOf(item),sx=t.scaleX*(t.flipX?-1:1),sy=t.scaleY*(t.flipY?-1:1);
  if(![point.x,point.y,bounds.x,bounds.y,bounds.w,bounds.h,sx,sy].every(Number.isFinite)||bounds.w<=0||bounds.h<=0||Math.abs(sx)<1e-9||Math.abs(sy)<1e-9)return null;
  const cx=bounds.x+bounds.w/2,cy=bounds.y+bounds.h/2,a=t.rotation*Math.PI/180;
  const x=point.x-cx-t.offsetX*W,y=point.y-cy-t.offsetY*H;
  return{x:cx+(Math.cos(a)*x+Math.sin(a)*y)/sx,y:cy+(-Math.sin(a)*x+Math.cos(a)*y)/sy};
}
export function hitVisual(point,bounds,item,W,H) {
  const local=inverseTransformPoint(point,bounds,item,W,H),b=croppedBounds(bounds,item.crop);
  return !!local&&local.x>=b.x&&local.x<=b.x+b.w&&local.y>=b.y&&local.y<=b.y+b.h;
}
export function cropFromDrag(item,bounds,W,H,from,to,edges) {
  const a=inverseTransformPoint(from,bounds,item,W,H),b=inverseTransformPoint(to,bounds,item,W,H);
  const crop={left:0,right:0,top:0,bottom:0,...item.crop};if(!a||!b)return crop;
  const dx=(b.x-a.x)/bounds.w,dy=(b.y-a.y)/bounds.h;
  if(edges.includes('move')){
    const horizontal=crop.left+crop.right,vertical=crop.top+crop.bottom;
    crop.left=clamp(crop.left+dx,Math.max(0,horizontal-.95),Math.min(.95,horizontal));crop.right=horizontal-crop.left;
    crop.top=clamp(crop.top+dy,Math.max(0,vertical-.95),Math.min(.95,vertical));crop.bottom=vertical-crop.top;
  }else for(const [edge,delta,opposite] of [['left',dx,'right'],['right',-dx,'left'],['top',dy,'bottom'],['bottom',-dy,'top']]) {
    if(edges.includes(edge))crop[edge]=clamp(crop[edge]+delta,0,Math.min(.95,.98-crop[opposite]));
  }
  return crop;
}
/** 확대·회전 중 반대쪽 경계나 지정한 중심이 화면에서 움직이지 않도록 보정합니다. */
export function transformAroundAnchor(item,bounds,W,H,next,anchor) {
  const fixed=transformPoint(anchor,bounds,item,W,H);
  const transformed=transformPoint(anchor,bounds,{transform:{...next,offsetX:0,offsetY:0}},W,H);
  return{...next,offsetX:clamp((fixed.x-transformed.x)/W,-3,3),offsetY:clamp((fixed.y-transformed.y)/H,-3,3)};
}
export function resizeFromDrag(item,bounds,W,H,from,to,edges,uniform=true) {
  const t=transformOf(item),b=croppedBounds(bounds,item.crop);
  const a=inverseTransformPoint(from,bounds,item,W,H),p=inverseTransformPoint(to,bounds,item,W,H);if(!a||!p)return t;
  const horizontal=edges.includes('left')||edges.includes('right'),vertical=edges.includes('top')||edges.includes('bottom');
  const anchor={x:edges.includes('left')?b.x+b.w:edges.includes('right')?b.x:b.x+b.w/2,y:edges.includes('top')?b.y+b.h:edges.includes('bottom')?b.y:b.y+b.h/2};
  const handle={x:edges.includes('left')?b.x:edges.includes('right')?b.x+b.w:anchor.x,y:edges.includes('top')?b.y:edges.includes('bottom')?b.y+b.h:anchor.y};
  let rx=horizontal?1+(p.x-a.x)/(handle.x-anchor.x):1,ry=vertical?1+(p.y-a.y)/(handle.y-anchor.y):1;
  if(uniform&&horizontal&&vertical){
    const h=transformPoint(handle,bounds,item,W,H),q=transformPoint(anchor,bounds,item,W,H),x=h.x-q.x,y=h.y-q.y;
    rx=ry=clamp(1+((to.x-from.x)*x+(to.y-from.y)*y)/Math.max(1,x*x+y*y),Math.max(.05/t.scaleX,.05/t.scaleY),Math.min(10/t.scaleX,10/t.scaleY));
  }
  const next={...t,scaleX:clamp(t.scaleX*rx,.05,10),scaleY:clamp(t.scaleY*ry,.05,10)};
  return transformAroundAnchor(item,bounds,W,H,next,anchor);
}
export function snapVisualCenter(item,bounds,W,H,tolerance={x:8,y:8}) {
  const tr=transformOf(item),corners=visualCorners(bounds,item,W,H);
  const x=corners.reduce((sum,p)=>sum+p.x,0)/4,y=corners.reduce((sum,p)=>sum+p.y,0)/4;
  const guides={x:Math.abs(x-W/2)<=tolerance.x,y:Math.abs(y-H/2)<=tolerance.y};
  return{transform:{...tr,offsetX:guides.x?clamp(tr.offsetX+(W/2-x)/W,-3,3):tr.offsetX,offsetY:guides.y?clamp(tr.offsetY+(H/2-y)/H,-3,3):tr.offsetY},guides};
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
