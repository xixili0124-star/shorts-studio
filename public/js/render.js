// 프레임 렌더러 — 미리보기와 내보내기가 "이 함수 하나"를 공유한다.
// opts.source(clip, localTime) 가 그릴 이미지({img, w, h})를 돌려준다.
//   미리보기 → <video> 엘리먼트 / 내보내기 → 디코딩된 VideoSample
import {
  project, layersAt, buildLayout, trackIdFor, timelineTracks, clipFadeGain, FONTS, ACCENT,
  videoBand, splitAccent,
} from './state.js';
import { withVisualTransform, visualCorners } from './visual-transform.js';
import { safeAreaConfig, safeAreaRect } from './safe-areas.js';
import { ensureFont } from './font-catalog.js';
import { redactSource } from './mosaic.js';

const REF_H = 1920; // 스타일 수치의 기준 높이 (해상도가 달라져도 같은 비율로 보이게)
const plateCache = new WeakMap();

function transitionPlates(canvas) {
  let plates = plateCache.get(canvas);
  if (!plates || plates[0].width !== canvas.width || plates[0].height !== canvas.height) {
    plates = [0, 1, 2, 3].map(() => {
      const c = document.createElement('canvas');
      c.width = canvas.width; c.height = canvas.height;
      return c;
    });
    plateCache.set(canvas, plates);
  }
  return plates;
}

export function renderFrame(ctx, t, opts = {}) {
  const W=ctx.canvas.width,H=ctx.canvas.height,k=H/REF_H;
  const tpl=project.template,band=videoBand(W,H),layout=opts.layout||buildLayout();
  const visualTracks=layout.tracks.filter(track=>track.kind==='visual');
  ctx.setTransform(1,0,0,1,0,0);ctx.globalAlpha=1;ctx.globalCompositeOperation='source-over';ctx.filter='none';
  ctx.fillStyle=band?tpl.bg:'#000';ctx.fillRect(0,0,W,H);
  const atTime=t===layout.total?Math.max(0,t-1e-7):t;
  const paintMedia=(target,at)=>{
    let source=opts.source?.(at.clip,at.local);
    if(!source?.img||source.w<=0||source.h<=0)return;
    source=redactSource(ctx,source,at.clip,at.clip.trimStart+at.local);
    paintTransformed(target,'clip',at.clip,dest=>{
      if(band&&at.trackId===visualTracks[0]?.id){
        dest.save();dest.beginPath();dest.rect(band.x,band.y,band.w,band.h);dest.clip();
        dest.translate(band.x,band.y);drawClipLayer(dest,band.w,band.h,at,source);dest.restore();
      }else drawClipLayer(dest,W,H,at,source);
    },clipFadeGain(at.clip,at.local,at.duration),at);
  };
  const clearPlate=canvas=>{
    const target=canvas.getContext('2d');
    target.setTransform(1,0,0,1,0,0);target.globalAlpha=1;target.globalCompositeOperation='source-over';
    target.filter='none';target.clearRect(0,0,W,H);return target;
  };
  const paintTransformed=(target,type,item,painter,gain=1,timing=null)=>{
    const alpha=(item.transform?.opacity??1)*gain;
    if(alpha<=0)return;
    const bounds=measureVisual(target,type,item,W,H,atTime,timing);
    const opaqueItem={...item,transform:{...item.transform,opacity:1}};
    if(alpha>=1){withVisualTransform(target,bounds,opaqueItem,W,H,()=>painter(target));return;}
    // 배경·글자·테두리를 먼저 완성하고 요소 전체에 불투명도를 한 번만 적용합니다.
    const plate=transitionPlates(ctx.canvas)[3],dest=clearPlate(plate);
    withVisualTransform(dest,bounds,opaqueItem,W,H,()=>painter(dest));
    target.save();target.globalAlpha*=alpha;target.drawImage(plate,0,0);target.restore();
  };
  const media=layersAt(t,layout);
  for(const [index,track] of visualTracks.entries()){
    const active=media.filter(e=>e.trackId===track.id);
    if(active.length===1)paintMedia(ctx,active[0]);
    else if(active.length===2){
      // 두 투명 RGBA 레이어의 premultiplied 색과 알파를 선형 보간합니다.
      // 아래 트랙을 먼저 칠한 뒤 일반 source-over 디졸브를 하면 배경이 과하게 비칩니다.
      const plates=transitionPlates(ctx.canvas);
      active.forEach((at,i)=>paintMedia(clearPlate(plates[i]),at));
      const mixed=clearPlate(plates[2]),p=active[1].weight;
      mixed.globalAlpha=1-p;mixed.drawImage(plates[0],0,0);
      mixed.globalCompositeOperation='lighter';mixed.globalAlpha=p;mixed.drawImage(plates[1],0,0);
      mixed.globalAlpha=1;
      const type=active[0].clip.transitionOut?.type;
      if(type==='fade'||type==='flash'){
        mixed.globalCompositeOperation='source-atop';mixed.fillStyle=type==='fade'?'#000':'#fff';
        mixed.globalAlpha=Math.sin(Math.PI*p);mixed.fillRect(0,0,W,H);
      }
      ctx.drawImage(plates[2],0,0);
    }
    if(index===0&&band)drawTemplate(ctx,W,H,tpl,k);
    for(const entry of layout.items.filter(e=>e.trackId===track.id&&e.type!=='clip'&&atTime>=e.start&&atTime<e.end)){
      const item=entry.item;
      paintTransformed(ctx,entry.type,item,dest=>{
        if(entry.type==='graphic')drawOverlay(dest,W,H,item,atTime,k);
        if(entry.type==='caption'&&item.text.trim())drawCaption(dest,W,H,item,{...project.captionStyle,...item.style},k,atTime);
      });
    }
  }
  if(opts.safeArea)drawSafeArea(ctx,W,H,opts.safeArea);
  if(opts.selection){
    const selected=layout.items.find(e=>e.type===opts.selection.type&&e.id===opts.selection.id&&atTime>=e.start&&atTime<e.end);
    if(selected&&selected.type!=='audio'){
      const bounds=measureVisual(ctx,selected.type,selected.item,W,H,atTime);
      drawSelection(ctx,visualCorners(bounds,selected.item,W,H),H);
    }
  }
}

/** 자르기는 원본 파일을 바꾸지 않고, 이 요소의 기본 경계 안에서만 적용합니다. */
export function measureVisual(ctx,type,item,W,H,t=0,timing=null) {
  const k=H/REF_H;
  if(type==='clip'){
    const isBase=trackIdFor('clip',item)===timelineTracks().find(track=>track.kind==='visual')?.id;
    const band=isBase?videoBand(W,H):null,bw=band?.w||W,bh=band?.h||H;
    const local=timing?.local??(t-(buildLayout().entries.find(e=>e.id===item.id)?.start||0));
    const duration=item.motionDuration||(item.type==='image'?item.imgDuration:item.trimEnd-item.trimStart);
    const g=clipGeometry(bw,bh,item.natW||W,item.natH||H,item,(local+(item.motionOffset||0))/Math.max(.001,duration));
    return {x:g.dx+(band?.x||0),y:g.dy+(band?.y||0),w:g.dw,h:g.dh};
  }
  const st=type==='caption'?{...project.captionStyle,...item.style}:item;
  const size=st.size*k,font=st.font,maxWidth=W*(type==='caption'?.86:.88);
  ctx.save();ctx.font=(FONTS.find(f=>f.css===font)?.weight||700)+' '+size+'px '+font+', "Noto Sans KR", sans-serif';
  const lines=wrapLines(ctx,String(item.text||' '),maxWidth);
  const textWidth=Math.max(size,...lines.map(line=>ctx.measureText(line).width));
  ctx.restore();
  const lineHeight=lines.length*size*1.28;
  if(type==='caption'){
    const w=textWidth+size*.76,h=lineHeight+size*.32;
    return {x:(W-w)/2,y:H*(1-st.bottom)-lineHeight-size*.16,w,h};
  }
  const x=(item.x??.5)*W,y=(item.y??.5)*H;
  if(item.graphic){
    if(item.graphic==='count')return {x:x-W*.43,y:y-size*1.3,w:W*.86,h:size*3.2};
    if(item.graphic==='speedlines'||item.graphic==='burst')return {x:x-W*.48,y:y-W*.48,w:W*.96,h:W*.96};
    const h=Math.max(size*2.7,lineHeight+size*.7);
    const width=W*(item.graphic==='ribbon'?.97:.86);
    return {x:x-width/2,y:y-h/2,w:width,h};
  }
  const w=textWidth+size*.76,h=lineHeight+size*.32;
  const bx=item.align==='left'?Math.max(maxWidth*.02,x-maxWidth/2)-size*.38
    :item.align==='right'?x+maxWidth/2-w+size*.38:x-w/2;
  return {x:bx,y:y-h/2,w,h};
}
function drawSelection(ctx,corners,H){
  ctx.save();ctx.strokeStyle='#d5ffa0';ctx.lineWidth=Math.max(2,H/650);ctx.setLineDash([]);
  ctx.beginPath();corners.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.closePath();ctx.stroke();
  const r=Math.max(5,H/190);ctx.fillStyle='#172011';
  for(const p of corners){ctx.fillRect(p.x-r/2,p.y-r/2,r,r);ctx.strokeRect(p.x-r/2,p.y-r/2,r,r);}
  ctx.restore();
}

// ── 영상/이미지 레이어 ─────────────────────────────────
export function clipGeometry(W, H, sw, sh, clip, progress = 0) {
  let base = clip.fit === 'cover'
    ? Math.max(W / sw, H / sh)
    : Math.min(W / sw, H / sh);

  let k = clip.scale ?? 1, ox = clip.offX || 0, oy = clip.offY || 0;

  if (clip.type === 'image' && clip.ken && clip.ken !== 'none') {
    const p = Math.min(1, Math.max(0, progress));
    if (clip.ken === 'in') k *= 1 + 0.12 * p;
    else if (clip.ken === 'out') k *= 1.12 - 0.12 * p;
    else if (clip.ken === 'left') { k *= 1.12; ox += 0.06 - 0.12 * p; }
    else if (clip.ken === 'right') { k *= 1.12; ox += -0.06 + 0.12 * p; }
  }

  const s = base * k;
  const dw = sw * s, dh = sh * s;
  return {
    dw, dh,
    dx: (W - dw) / 2 + ox * W,
    dy: (H - dh) / 2 + oy * H,
  };
}

function drawClipLayer(ctx, W, H, at, src) {
  const clip = at.clip;
  const duration = clip.type === 'image' ? clip.motionDuration || at.duration : at.duration;
  const offset = clip.type === 'image' ? clip.motionOffset || 0 : 0;
  const progress = duration > 0 ? (at.local + offset) / duration : 0;
  const g = clipGeometry(W, H, src.w, src.h, clip, progress);

  const covers = g.dx <= 0.5 && g.dy <= 0.5 && g.dx + g.dw >= W - 0.5 && g.dy + g.dh >= H - 0.5;
  if (!covers) drawBackdrop(ctx, W, H, clip, src);

  ctx.filter = 'none';
  drawSource(ctx, src, g.dx, g.dy, g.dw, g.dh);
}

function drawBackdrop(ctx, W, H, clip, src) {
  if (clip.bg === 'transparent') return;
  if (clip.bg === 'black' || clip.bg === 'white') {
    ctx.fillStyle = clip.bg === 'white' ? '#fff' : '#000';
    ctx.fillRect(0, 0, W, H);
    return;
  }
  // 흐린 원본으로 여백 채우기
  const s = Math.max(W / src.w, H / src.h) * 1.25;
  const dw = src.w * s, dh = src.h * s;
  ctx.save();
  ctx.filter = `blur(${Math.round(H / 42)}px)`;
  drawSource(ctx, src, (W - dw) / 2, (H - dh) / 2, dw, dh);
  ctx.restore();
  ctx.filter = 'none';
  ctx.fillStyle = 'rgba(0,0,0,.25)';
  ctx.fillRect(0, 0, W, H);
}

/** 소스가 자체 draw() 를 가지고 있으면(회전 메타데이터가 있는 영상 프레임) 그걸 쓴다 */
function drawSource(ctx, src, dx, dy, dw, dh) {
  try {
    if (typeof src.draw === 'function') src.draw(ctx, dx, dy, dw, dh);
    else ctx.drawImage(src.img, dx, dy, dw, dh);
  } catch { /* 아직 디코딩되지 않은 프레임은 조용히 건너뛴다 */ }
}

// ── 텍스트 ─────────────────────────────────────────────
const easeOut = p => 1 - Math.pow(1 - p, 3);

function drawOverlay(ctx, W, H, o, t, k) {
  if (o.graphic) { drawGraphic(ctx, W, H, o, t, k); return; }
  const ANIM = 0.35;
  const inP = Math.min(1, Math.max(0, (t - o.start) / ANIM));
  const outP = Math.min(1, Math.max(0, (o.end - t) / ANIM));
  let alpha = 1, dy = 0, scale = 1;

  if (o.anim === 'fade') alpha = Math.min(inP, outP);
  else if (o.anim === 'up') { alpha = Math.min(inP, outP); dy = (1 - easeOut(inP)) * H * 0.05; }
  else if (o.anim === 'pop') { alpha = Math.min(inP, outP); scale = 0.72 + 0.28 * easeOut(inP); }

  if (alpha <= 0.001) return;

  ctx.save();
  if (scale !== 1) {
    ctx.translate(o.x * W, o.y * H);
    ctx.scale(scale, scale);
    ctx.translate(-o.x * W, -o.y * H);
  }
  drawTextBlock(ctx, {
    text: o.text,
    font: o.font, size: o.size * k, color: o.color,
    stroke: o.stroke, strokeW: o.strokeW * k,
    box: o.box, align: o.align,
    x: o.x * W, y: o.y * H + dy,
    maxWidth: W * 0.88,
    anchor: 'middle',
    alpha,
  });
  ctx.restore();
}

function drawCaption(ctx, W, H, cap, st, k, t) {
  const p = Math.min(1, Math.max(0, (t - cap.start) / .18));
  ctx.save();
  if (st.anim === 'pop') {
    const s = .86 + .14 * easeOut(p);
    ctx.translate(W / 2, H * (1 - st.bottom));
    ctx.scale(s, s);
    ctx.translate(-W / 2, -H * (1 - st.bottom));
  }
  drawTextBlock(ctx, {
    text: cap.text,
    font: st.font, size: st.size * k, color: st.color,
    stroke: st.stroke, strokeW: st.strokeW * k,
    box: st.box, boxColor: st.boxColor, glow: st.glow, align: 'center',
    x: W / 2, y: H * (1 - st.bottom),
    maxWidth: W * 0.86,
    anchor: 'bottom',
    alpha: st.anim === 'fade' ? p : 1,
  });
  ctx.restore();
}

/** 액션 프리셋도 같은 캔버스 렌더러에서 그려 내보내기에 그대로 들어갑니다. */
function drawGraphic(ctx, W, H, o, t, k) {
  const p = Math.min(1, Math.max(0, (t - o.start) / .42));
  const q = Math.min(1, Math.max(0, (o.end - t) / .24));
  if (p <= 0 || q <= 0) return;
  const progress = easeOut(p);
  const x = o.x * W, y = o.y * H, w = W * .82;
  const size = o.size * k;
  const accent = o.color || '#b8ee63';
  const title = (extra = {}) => drawTextBlock(ctx, {
    text: o.text, font: o.font, size, color: accent, stroke: '#101510', strokeW: 0,
    align: 'center', x, y, maxWidth: w * .88, anchor: 'middle', alpha: 1, ...extra,
  });
  ctx.save();
  ctx.globalAlpha *= Math.min(1, p * 3, q);
  if (o.graphic === 'kinetic') {
    const s = .68 + .32 * progress + Math.sin(p * Math.PI) * .065;
    ctx.translate(x, y); ctx.rotate(-.035 * (1 - p)); ctx.scale(s, s); ctx.translate(-x, -y);
    const h = size * (String(o.text).includes('\n') ? 2.75 : 1.7);
    ctx.fillStyle = '#101810e8';
    ctx.fillRect(x - w / 2, y - h / 2, w, h);
    ctx.strokeStyle = accent; ctx.lineWidth = 4 * k;
    ctx.strokeRect(x - w / 2, y - h / 2, w, h);
    title({ strokeW: 2 * k });
  } else if (o.graphic === 'lower') {
    const dx = -(1 - progress) * W * .45;
    ctx.translate(dx, 0);
    const h = size * 2.2;
    ctx.fillStyle = '#101813ed'; roundRect(ctx, x - w / 2, y - h / 2, w, h, 8 * k); ctx.fill();
    ctx.fillStyle = accent; ctx.fillRect(x - w / 2, y - h / 2, 8 * k, h);
    title({ color: '#f0f5eb', size: size * .85, y: y - size * .28 });
    title({ text: o.subtitle || 'SHORTS STUDIO', color: accent, font: '"Noto Sans KR"', size: size * .3, y: y + size * .55 });
  } else if (o.graphic === 'swipe') {
    ctx.translate(-(1 - progress) * W, 0);
    const h = size * 1.7;
    ctx.fillStyle = accent;
    ctx.beginPath();ctx.moveTo(x - w / 2 + 20 * k, y - h / 2);ctx.lineTo(x + w / 2, y - h / 2);ctx.lineTo(x + w / 2 - 20 * k, y + h / 2);ctx.lineTo(x - w / 2, y + h / 2);ctx.closePath();ctx.fill();
    title({ color: '#13210d', size: size * .87 });
  } else if (o.graphic === 'focus') {
    const h = size * 2.35;
    ctx.strokeStyle = accent;ctx.lineWidth = 5 * k;
    const arm = 38 * k * progress;
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      const cx = x + sx * w / 2, cy = y + sy * h / 2;
      ctx.beginPath();ctx.moveTo(cx - sx * arm, cy);ctx.lineTo(cx, cy);ctx.lineTo(cx, cy - sy * arm);ctx.stroke();
    }
    title({ color: '#fff', strokeW: 6 * k });
  } else if (o.graphic === 'count') {
    const r = size * 1.15;
    ctx.fillStyle = '#101510cd';ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();
    ctx.strokeStyle = accent;ctx.lineWidth = 8 * k;ctx.beginPath();ctx.arc(x,y,r,-Math.PI/2,-Math.PI/2+Math.PI*2*Math.max(0,(o.end-t)/(o.end-o.start)));ctx.stroke();
    title({ text: String(Math.max(1,Math.ceil(o.end-t))), size: size * 1.5 });
    title({ text: o.text, size: size * .3, y:y+r+size*.5,color:'#fff' });
  } else if (o.graphic === 'burst' || o.graphic === 'speedlines') {
    const rays=o.graphic==='burst'?14:24;
    ctx.strokeStyle=accent;ctx.lineWidth=(o.graphic==='burst'?8:3)*k;
    for(let i=0;i<rays;i++){
      const angle=i*Math.PI*2/rays+(o.graphic==='burst'?.12:0),inner=W*(.22+.04*Math.sin(i*3));
      const outer=W*(.42+.05*Math.cos(i*7))*progress;
      ctx.beginPath();ctx.moveTo(x+Math.cos(angle)*inner,y+Math.sin(angle)*inner);
      ctx.lineTo(x+Math.cos(angle)*outer,y+Math.sin(angle)*outer);ctx.stroke();
    }
    const s=.6+.4*progress;ctx.translate(x,y);ctx.scale(s,s);ctx.translate(-x,-y);
    title({color:'#fff',strokeW:7*k});
  } else if (o.graphic === 'stomp') {
    const s=1+1.5*Math.pow(1-progress,2);
    ctx.translate(x,y);ctx.rotate((1-progress)*-.15);ctx.scale(s,s);ctx.translate(-x,-y);
    title({color:accent,strokeW:8*k});
    ctx.fillStyle=accent;ctx.fillRect(x-w*.3,y+size*.7,w*.6,6*k*progress);
  } else if (o.graphic === 'typewriter') {
    const h=Math.max(size*1.8,String(o.text).split('\n').length*size*1.5),elapsed=t-o.start;
    ctx.fillStyle='#111916ed';roundRect(ctx,x-w/2,y-h/2,w,h,14*k);ctx.fill();
    const count=Math.ceil([...o.text].length*Math.min(1,elapsed/Math.min(1.1,(o.end-o.start)*.6)));
    title({text:[...o.text].slice(0,count).join('')+(Math.floor(elapsed*5)%2===0?'▌':''),size:size*.85});
  } else if (o.graphic === 'glitch') {
    const d=(1-progress)*size*.32+Math.sin((t-o.start)*70)*size*.018;
    title({x:x-d,color:'#55eddf'});title({x:x+d,color:'#fc5f94'});title({color:accent});
    if(p<.8){ctx.save();ctx.beginPath();ctx.rect(x-w/2,y-size*.1,w,size*.14);ctx.clip();title({x:x+size*.14,color:'#fff'});ctx.restore();}
  } else if (o.graphic === 'underline' || o.graphic === 'marker') {
    ctx.fillStyle=accent;
    const h=o.graphic==='marker'?size*1.38:size*.15,by=o.graphic==='marker'?y-h/2:y+size*.62;
    ctx.save();ctx.translate(x-w*.45,by);ctx.transform(1,0,-.09,1,0,0);ctx.fillRect(0,0,w*.9*progress,h);ctx.restore();
    title({color:o.graphic==='marker'?'#182011':'#fff'});
  } else if (o.graphic === 'ribbon') {
    const h=size*1.6;
    ctx.translate(0,(1-progress)*size);
    ctx.fillStyle='#372a49';ctx.beginPath();ctx.moveTo(x-w/2,y);ctx.lineTo(x-w*.58,y+h*.7);ctx.lineTo(x-w*.25,y+h*.7);ctx.closePath();ctx.fill();
    ctx.beginPath();ctx.moveTo(x+w/2,y);ctx.lineTo(x+w*.58,y+h*.7);ctx.lineTo(x+w*.25,y+h*.7);ctx.closePath();ctx.fill();
    ctx.fillStyle=accent;ctx.fillRect(x-w/2,y-h/2,w,h);title({color:'#192012'});
  } else if (o.graphic === 'chapter') {
    ctx.strokeStyle=accent;ctx.lineWidth=3*k;ctx.beginPath();ctx.moveTo(x-w/2,y-size*.3);ctx.lineTo(x-w/2+w*progress,y-size*.3);ctx.stroke();
    title({text:o.subtitle||'CHAPTER 01',font:o.font,size:size*.34,y:y-size*.95});
    title({y:y+size*.48,color:'#fff'});
  } else if (o.graphic === 'sticker') {
    const s=.6+.4*progress+Math.sin(p*Math.PI)*.1;
    ctx.translate(x,y);ctx.rotate(-.08);ctx.scale(s,s);ctx.translate(-x,-y);
    ctx.fillStyle=accent;ctx.strokeStyle='#fff';ctx.lineWidth=9*k;
    roundRect(ctx,x-w*.42,y-size*.9,w*.84,size*1.8,size*.6);ctx.fill();ctx.stroke();title({color:'#282331',size:size*.88});
  } else if (o.graphic === 'zoom') {
    const s=.2+.8*progress;ctx.translate(x,y);ctx.scale(s,s);ctx.translate(-x,-y);title({strokeW:7*k});
  } else if (o.graphic === 'brackets') {
    const h=size*1.85,bw=w*(.55+.45*progress);
    ctx.strokeStyle=accent;ctx.lineWidth=6*k;
    for(const sign of [-1,1]){const bx=x+sign*bw/2;ctx.beginPath();ctx.moveTo(bx-sign*size*.22,y-h/2);ctx.lineTo(bx,y-h/2);ctx.lineTo(bx,y+h/2);ctx.lineTo(bx-sign*size*.22,y+h/2);ctx.stroke();}
    title({color:'#fff',size:size*.86});
  } else if (o.graphic === 'bounce') {
    const bounce=Math.abs(Math.sin((t-o.start)*13))*Math.exp(-(t-o.start)*7);
    ctx.translate(x,y-size*.9*bounce);ctx.scale(1+bounce*.12,1-bounce*.12);ctx.translate(-x,-y);title({strokeW:7*k});
  } else if (o.graphic === 'split') {
    for(const sign of [-1,1]){
      ctx.save();ctx.beginPath();ctx.rect(x-w/2,sign<0?y-H:y,w,H);ctx.clip();
      title({x:x+sign*(1-progress)*W*.6,color:accent,strokeW:4*k});ctx.restore();
    }
  } else {
    ctx.translate(0, (1 - progress) * H * .04);
    ctx.strokeStyle = accent;ctx.lineWidth = 2 * k;
    for (const sy of [-1,1]) {ctx.beginPath();ctx.moveTo(x-w*.35,y+sy*size*1.1);ctx.lineTo(x+w*.35,y+sy*size*1.1);ctx.stroke();}
    title({ color: '#f2f3ec', size: size * .8 });
  }
  ctx.restore();
}

export function drawTextBlock(ctx, o) {
  const text = String(o.text ?? '');
  if (!text.trim()) return;

  const weight = (FONTS.find(f => f.css === o.font)?.weight) ?? 700;
  ctx.save();
  ctx.globalAlpha *= o.alpha ?? 1;
  ctx.font = `${weight} ${o.size}px ${o.font}, "Noto Sans KR", sans-serif`;
  ctx.textBaseline = 'alphabetic';

  const lines = wrapLines(ctx, text, o.maxWidth);
  const lineH = o.size * 1.28;
  const total = lines.length * lineH;

  let top;
  if (o.anchor === 'middle') top = o.y - total / 2;
  else if (o.anchor === 'bottom') top = o.y - total;
  else top = o.y;

  const padX = o.size * 0.38, padY = o.size * 0.16;

  lines.forEach((line, i) => {
    if (!line) return;
    const w = ctx.measureText(line).width;
    let cx;
    if (o.align === 'left') cx = Math.max(o.maxWidth * 0.02, o.x - o.maxWidth / 2) + w / 2;
    else if (o.align === 'right') cx = o.x + o.maxWidth / 2 - w / 2;
    else cx = o.x;

    const baseline = top + i * lineH + o.size * 0.98;

    if (o.box && o.box !== 'none') {
      const bx = cx - w / 2 - padX;
      const by = top + i * lineH - padY + lineH * 0.06;
      const bw = w + padX * 2;
      const bh = lineH + padY * 2 - lineH * 0.12;
      ctx.fillStyle = o.box === 'dark' ? 'rgba(0,0,0,.62)'
        : o.box === 'white' ? 'rgba(255,255,255,.92)'
          : (o.boxColor || ACCENT);
      roundRect(ctx, bx, by, bw, bh, o.size * 0.18);
      ctx.fill();
    } else {
      ctx.shadowColor = 'rgba(0,0,0,.55)';
      ctx.shadowBlur = o.size * 0.22;
      ctx.shadowOffsetY = o.size * 0.05;
    }

    ctx.textAlign = 'center';
    if (o.strokeW > 0 && (!o.box || o.box === 'none')) {
      ctx.lineWidth = o.strokeW;
      ctx.strokeStyle = o.stroke;
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
      ctx.strokeText(line, cx, baseline);
    }
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.fillStyle = o.box === 'white' ? '#111' : o.color;
    if (o.glow) { ctx.shadowColor = o.glow; ctx.shadowBlur = o.size * .28; }
    ctx.fillText(line, cx, baseline);
  });

  ctx.restore();
}

function wrapLines(ctx, text, maxWidth) {
  const out = [];
  for (const para of text.split('\n')) {
    if (!para.trim()) { out.push(''); continue; }
    const words = para.split(/\s+/);
    let line = '';
    for (const word of words) {
      const cand = line ? `${line} ${word}` : word;
      if (ctx.measureText(cand).width <= maxWidth || !line) {
        // 한 단어가 통째로 넘치면 글자 단위로 쪼갠다
        if (!line && ctx.measureText(cand).width > maxWidth) {
          let chunk = '';
          for (const ch of word) {
            if (ctx.measureText(chunk + ch).width > maxWidth && chunk) {
              out.push(chunk); chunk = ch;
            } else chunk += ch;
          }
          line = chunk;
          continue;
        }
        line = cand;
      } else {
        out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

function roundRect(ctx, x, y, w, h, r) {
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}


// ── 템플릿 (밴드 레이아웃 장식) ─────────────────────────
function drawTemplate(ctx, W, H, tpl, k) {
  if (tpl.hook?.on) drawHook(ctx, W, H, tpl.hook, k);
  if (tpl.comment?.on) drawCommentCard(ctx, W, H, tpl.comment, k);
  if (tpl.credit?.on && tpl.credit.text.trim()) {
    ctx.save();
    ctx.font = `700 ${tpl.credit.size * k}px "Noto Sans KR", sans-serif`;
    ctx.fillStyle = tpl.credit.color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(tpl.credit.text, W / 2, H * tpl.credit.y);
    ctx.restore();
  }
}

/**
 * 상단 훅 문구. *별표* 로 감싼 조각만 강조색으로 칠한다.
 * 한 줄 안에서 색이 바뀌므로 조각별 폭을 재서 가운데 정렬을 직접 계산한다.
 */
function drawHook(ctx, W, H, hook, k) {
  const size = hook.size * k;
  const weight = (FONTS.find(f => f.css === hook.font)?.weight) ?? 700;
  ctx.save();
  ctx.font = `${weight} ${size}px ${hook.font}, "Noto Sans KR", sans-serif`;
  ctx.textBaseline = 'alphabetic';

  const lineH = size * 1.22;
  const maxW = W * 0.92;

  // 줄바꿈은 사용자가 넣은 그대로 존중하되, 넘치는 줄만 다시 접는다
  const lines = [];
  for (const raw of String(hook.text).split('\n')) {
    const pieces = splitAccent(raw);
    let cur = [];
    let curW = 0;
    for (const piece of pieces) {
      for (const word of piece.text.split(/(\s+)/)) {
        if (!word) continue;
        const wWidth = ctx.measureText(word).width;
        if (curW + wWidth > maxW && cur.length) {
          lines.push(cur);
          cur = [];
          curW = 0;
          if (!word.trim()) continue;   // 줄 첫머리 공백은 버린다
        }
        cur.push({ text: word, accent: piece.accent, w: wWidth });
        curW += wWidth;
      }
    }
    lines.push(cur);
  }

  const total = lines.length * lineH;
  let top = H * hook.y - total / 2;

  for (const line of lines) {
    const lineW = line.reduce((a, p) => a + p.w, 0);
    let x = (W - lineW) / 2;
    const baseline = top + size * 0.92;
    for (const piece of line) {
      ctx.fillStyle = piece.accent ? hook.accent : hook.color;
      ctx.textAlign = 'left';
      ctx.fillText(piece.text, x, baseline);
      x += piece.w;
    }
    top += lineH;
  }
  ctx.restore();
}

/**
 * 하단 댓글 카드. 실제 플랫폼 UI 를 그대로 베끼지 않고
 * 아바타 + 이름 + 내용 + 좋아요 정도만 있는 일반적인 모양으로 그린다.
 */
function drawCommentCard(ctx, W, H, c, k) {
  const pad = 34 * k;
  const cardW = W - pad * 2;
  const x = pad;
  const nameSize = 30 * k;
  const textSize = 38 * k;
  const avatar = 54 * k;

  ctx.save();
  ctx.font = `400 ${textSize}px "Noto Sans KR", sans-serif`;
  const bodyLines = wrapLines(ctx, c.text, cardW - avatar - pad * 2.4);

  const innerPad = 26 * k;
  const cardH = innerPad * 2 + nameSize * 1.5 + bodyLines.length * textSize * 1.42 + 34 * k;
  const y = H * c.y;

  const dark = c.theme !== 'light';
  ctx.fillStyle = dark ? 'rgba(24,26,31,.94)' : 'rgba(255,255,255,.96)';
  roundRect(ctx, x, y, cardW, cardH, 22 * k);
  ctx.fill();

  const fg = dark ? '#f1f3f7' : '#16181d';
  const sub = dark ? '#98a0b0' : '#6b7280';

  // 아바타 — 이름 첫 글자를 원 안에 넣는다
  const ax = x + innerPad + avatar / 2;
  const ay = y + innerPad + avatar / 2;
  ctx.beginPath();
  ctx.arc(ax, ay, avatar / 2, 0, Math.PI * 2);
  ctx.fillStyle = avatarColor(c.name);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = `700 ${avatar * 0.5}px "Noto Sans KR", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText((c.name || '?').trim().charAt(0), ax, ay + avatar * 0.02);

  const tx = x + innerPad + avatar + innerPad * 0.7;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  // 이름 + 시간
  ctx.font = `700 ${nameSize}px "Noto Sans KR", sans-serif`;
  ctx.fillStyle = sub;
  const nameText = `@${(c.name || '').replace(/^@/, '')}`;
  ctx.fillText(nameText, tx, y + innerPad + nameSize);
  if (c.time) {
    const nw = ctx.measureText(nameText).width;
    ctx.font = `400 ${nameSize}px "Noto Sans KR", sans-serif`;
    ctx.fillText(c.time, tx + nw + 14 * k, y + innerPad + nameSize);
  }

  // 본문
  ctx.font = `400 ${textSize}px "Noto Sans KR", sans-serif`;
  ctx.fillStyle = fg;
  let by = y + innerPad + nameSize * 1.5 + textSize;
  for (const line of bodyLines) {
    ctx.fillText(line, tx, by);
    by += textSize * 1.42;
  }

  // 좋아요
  if (c.likes) {
    ctx.font = `400 ${nameSize}px "Noto Sans KR", sans-serif`;
    ctx.fillStyle = sub;
    ctx.fillText(`\u2665 ${c.likes}`, tx, by + 6 * k);
  }
  ctx.restore();
}

function avatarColor(name) {
  const palette = ['#e05a5a', '#4a9eff', '#3aa76d', '#c77dff', '#f0a04b', '#2bb3a3'];
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}

// ── 안전영역 가이드 (미리보기 전용) ────────────────────
function drawSafeArea(ctx,W,H,config) {
  const guide=config===true?safeAreaConfig():config,rect=safeAreaRect(guide,W,H);
  ctx.save();ctx.fillStyle='rgba(8,10,12,.36)';
  ctx.beginPath();ctx.rect(0,0,W,H);ctx.rect(rect.x,rect.y,rect.w,rect.h);ctx.fill('evenodd');
  ctx.strokeStyle=guide.color;ctx.setLineDash([12,10]);ctx.lineWidth=Math.max(2,W/400);
  ctx.strokeRect(rect.x,rect.y,rect.w,rect.h);ctx.setLineDash([]);
  ctx.fillStyle=guide.color;ctx.font='700 '+Math.round(H/78)+'px "Noto Sans KR", sans-serif';
  ctx.textAlign='left';ctx.textBaseline='bottom';ctx.fillText(guide.name+' · 참고영역',rect.x+8,rect.y-12);
  ctx.restore();
}

/** 실제 사용 중인 텍스트만 준비합니다. 내보내기는 폰트 실패를 숨기지 않습니다. */
export async function loadFonts({signal}={}) {
  if(typeof document==='undefined'||!document.fonts)return;
  const used=new Map();
  const add=(font,text,weight=null)=>{
    if(!font||!text)return;
    const key=font+':'+(weight||'default'),entry=used.get(key)||{font,weight,text:''};
    entry.text+=text;used.set(key,entry);
  };
  for(const item of project.captions)add(item.style?.font||project.captionStyle.font,item.text);
  for(const item of project.overlays){
    add(item.font,item.text);
    if(item.graphic==='count')add(item.font,'0123456789');
    if(item.graphic==='typewriter')add(item.font,'▌');
    if(item.graphic==='chapter')add(item.font,item.subtitle||'CHAPTER 01');
    if(item.graphic==='lower')add('"Noto Sans KR"',item.subtitle||'SHORTS STUDIO');
  }
  if(project.template.mode==='band'){
    const {hook,comment,credit}=project.template;
    if(hook?.on)add(hook.font,hook.text);
    if(comment?.on){
      add('"Noto Sans KR"',comment.text+(comment.time||''),400);
      add('"Noto Sans KR"','@'+(comment.name||'?')+'♥'+(comment.likes||''),700);
    }
    if(credit?.on)add('"Noto Sans KR"',credit.text,700);
  }
  await Promise.all([...used.values()].map(({font,text,weight})=>ensureFont(font,text,weight,{signal})));
}
