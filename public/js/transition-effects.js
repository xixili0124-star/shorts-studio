// 투명 레이어를 보존하는 장면 전환. 두 프레임을 외부 캔버스에 합성합니다.
import { clamp } from './util.js';

export function paintTransition(ctx,left,right,progress,type='dissolve') {
  const W=ctx.canvas.width,H=ctx.canvas.height,p=clamp(progress,0,1),smooth=p*p*(3-2*p);
  ctx.save();ctx.setTransform(1,0,0,1,0,0);ctx.globalAlpha=1;ctx.globalCompositeOperation='source-over';ctx.filter='none';ctx.clearRect(0,0,W,H);
  if(p<=0){ctx.drawImage(left,0,0);ctx.restore();return;}
  if(p>=1){ctx.drawImage(right,0,0);ctx.restore();return;}
  if(type.startsWith('push-')){
    const dir=type.slice(5),horizontal=dir==='left'||dir==='right',sign=dir==='left'||dir==='up'?-1:1;
    const delta=(horizontal?W:H)*sign;
    ctx.drawImage(left,horizontal?delta*smooth:0,horizontal?0:delta*smooth);
    ctx.drawImage(right,horizontal?delta*(smooth-1):0,horizontal?0:delta*(smooth-1));
  }else if(type.startsWith('wipe-')){
    ctx.drawImage(left,0,0);const dir=type.slice(5);
    const rect=dir==='left'?[W*(1-smooth),0,W*smooth,H]:dir==='right'?[0,0,W*smooth,H]:dir==='up'?[0,H*(1-smooth),W,H*smooth]:[0,0,W,H*smooth];
    ctx.beginPath();ctx.rect(...rect);ctx.clip();ctx.clearRect(0,0,W,H);ctx.drawImage(right,0,0);
  }else{
    const zoom=type==='zoom-in'?1:type==='zoom-out'?-1:0;
    if(type==='blur')ctx.filter='blur('+(Math.sin(Math.PI*p)*H*.012)+'px)';
    const draw=(canvas,alpha,scale)=>{ctx.save();ctx.globalAlpha=alpha;ctx.translate(W/2,H/2);ctx.scale(scale,scale);ctx.drawImage(canvas,-W/2,-H/2);ctx.restore();};
    draw(left,1-p,1+zoom*.22*smooth);ctx.globalCompositeOperation='lighter';
    draw(right,p,1-zoom*.22*(1-smooth));ctx.globalAlpha=1;ctx.filter='none';
    if(type==='fade'||type==='flash'){
      ctx.globalCompositeOperation='source-atop';ctx.fillStyle=type==='fade'?'#000':'#fff';ctx.globalAlpha=Math.sin(Math.PI*p);ctx.fillRect(0,0,W,H);
    }
  }
  ctx.restore();
}
