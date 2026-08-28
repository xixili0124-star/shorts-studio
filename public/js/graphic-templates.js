// 직접 구성한 모션 그래픽. 외부 템플릿 파일은 사용하지 않습니다.
export function drawExtraGraphic(ctx,W,H,o,t,k,title,roundRect) {
  const p=Math.min(1,Math.max(0,(t-o.start)/.42)),ease=1-(1-p)**3;
  const x=o.x*W,y=o.y*H,w=W*.82,size=o.size*k,accent=o.color||'#b8ee63';
  const box=(bx,by,bw,bh,r,fill)=>{ctx.fillStyle=fill;roundRect(ctx,bx,by,bw,bh,r);ctx.fill();};
  const caption=(text,cy,extra={})=>title({text,y:cy,...extra});
  if(o.graphic==='notification'){
    ctx.translate(0,-size*(1-ease));const h=size*3;
    box(x-w/2,y-h/2,w,h,26*k,'#172122ee');box(x-w*.44,y-size*.93,size*.6,size*.6,12*k,accent);
    caption(o.subtitle||'JUST NOW',y-size*.68,{size:size*.32,color:accent,maxWidth:w*.64});
    title({y:y+size*.36,size:size*.88,color:'#fff',maxWidth:w*.88});
  }else if(o.graphic==='chat'){
    ctx.translate(x,y);ctx.scale(.7+.3*ease,.7+.3*ease);ctx.translate(-x,-y);
    box(x-w/2,y-size,w,size*2,42*k,accent);
    ctx.beginPath();ctx.moveTo(x-w*.32,y+size*.8);ctx.lineTo(x-w*.42,y+size*1.4);ctx.lineTo(x-w*.17,y+size*.9);ctx.fill();
    title({color:'#1e2423',size:size*.92});
  }else if(o.graphic==='price'){
    ctx.translate(x,y);ctx.rotate(-.045*ease);ctx.scale(.6+.4*ease,.6+.4*ease);ctx.translate(-x,-y);
    box(x-w/2,y-size*1.35,w,size*2.7,22*k,accent);
    ctx.fillStyle='#20262c';ctx.beginPath();ctx.arc(x-w*.42,y,12*k,0,Math.PI*2);ctx.fill();
    caption(o.subtitle||'SPECIAL OFFER',y-size*.72,{size:size*.32,color:'#35232a'});
    title({y:y+size*.24,color:'#202123',size:size*.9,maxWidth:w*.78});
  }else if(o.graphic==='callout'){
    ctx.strokeStyle=accent;ctx.lineWidth=8*k;ctx.lineCap='round';
    ctx.beginPath();ctx.moveTo(x-w*.43,y+size*1.2);ctx.lineTo(x-w*.3,y+size*.55);ctx.lineTo(x+w*.3*ease,y+size*.55);ctx.stroke();
    ctx.beginPath();ctx.moveTo(x-w*.46,y+size*.87);ctx.lineTo(x-w*.43,y+size*1.2);ctx.lineTo(x-w*.26,y+size*1.03);ctx.stroke();
    title({y:y-size*.3,color:'#fff',strokeW:5*k});
  }else if(o.graphic==='checklist'){
    const lines=String(o.text).split('\n').slice(0,4),h=Math.max(size*2,lines.length*size*1.45);
    box(x-w/2,y-h/2-size*.3,w,h+size*.6,20*k,'#111b19eb');
    lines.forEach((line,i)=>{const cy=y-h/2+size*.75+i*size*1.45,appear=Math.min(1,Math.max(0,(t-o.start-i*.18)/.3));
      ctx.save();ctx.globalAlpha*=appear;ctx.strokeStyle=accent;ctx.lineWidth=5*k;
      ctx.beginPath();ctx.moveTo(x-w*.43,cy);ctx.lineTo(x-w*.4,cy+size*.18);ctx.lineTo(x-w*.34,cy-size*.24);ctx.stroke();
      caption(line,cy,{x:x+w*.04,size:size*.85,maxWidth:w*.69,color:'#fff'});ctx.restore();
    });
  }else if(o.graphic==='stack'){
    for(const direction of [-1,1]){ctx.save();ctx.globalAlpha=.28*ease;title({y:y+direction*size*.72*ease,color:accent,strokeW:2*k});ctx.restore();}
    title({color:'#fff',strokeW:6*k});
  }else if(o.graphic==='tape'){
    ctx.translate(x,y);ctx.rotate(-.035);ctx.translate(-x,-y);
    box(x-w*.48,y-size*.85,w*.96,size*1.7,4*k,accent);
    box(x-w*.22,y-size*1.04,w*.44,size*.34,0,'#ffffff77');
    title({color:'#363226'});
  }else if(o.graphic==='score'){
    box(x-w/2,y-size*1.05,w,size*2.1,20*k,'#111924f0');
    ctx.fillStyle=accent;ctx.fillRect(x-w/2,y-size*1.05,w*ease,6*k);
    title({size:size*(.78+.22*ease),color:'#fff'});
    caption(o.subtitle||'MATCH RESULT',y+size*.72,{size:size*.23,color:accent});
  }else if(o.graphic==='stamp'){
    ctx.translate(x,y);ctx.rotate(-.09);ctx.scale(1+1.2*(1-ease),1+1.2*(1-ease));ctx.translate(-x,-y);
    ctx.strokeStyle=accent;ctx.lineWidth=7*k;roundRect(ctx,x-w*.47,y-size*.8,w*.94,size*1.6,9*k);ctx.stroke();
    title({color:accent,size:size*.82});
  }else if(o.graphic==='progress'){
    const progress=Math.min(1,Math.max(0,(t-o.start)/(o.end-o.start)));
    title({y:y-size*.35,color:'#fff'});box(x-w*.46,y+size*.55,w*.92,size*.22,size*.11,'#ffffff22');
    box(x-w*.46,y+size*.55,w*.92*progress,size*.22,size*.11,accent);
    caption(Math.round(progress*100)+'%',y+size*1.18,{size:size*.38,color:accent});
  }else if(o.graphic==='neon-frame'){
    ctx.shadowColor=accent;ctx.shadowBlur=28*k;ctx.strokeStyle=accent;ctx.lineWidth=4*k;
    roundRect(ctx,x-w*.48,y-size*1.1,w*.96,size*2.2,22*k);ctx.stroke();ctx.shadowBlur=0;
    title({color:'#fff',glow:accent});
  }else if(o.graphic==='split-words'){
    const words=String(o.text).split(/\s+/),count=Math.max(1,Math.ceil(words.length*Math.min(1,(t-o.start)/.8)));
    title({text:words.slice(0,count).join(' '),color:accent,strokeW:6*k});
    ctx.fillStyle=accent;ctx.fillRect(x-w*.36,y+size*.8,w*.72*ease,5*k);
  }else return false;
  return true;
}
