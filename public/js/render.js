// 프레임 렌더러 — 미리보기와 내보내기가 "이 함수 하나"를 공유한다.
// opts.source(clip, localTime) 가 그릴 이미지({img, w, h})를 돌려준다.
//   미리보기 → <video> 엘리먼트 / 내보내기 → 디코딩된 VideoSample
import {
  project, layersAt, activeOverlays, activeCaption, FONTS, ACCENT,
  videoBand, splitAccent,
} from './state.js';

const REF_H = 1920; // 스타일 수치의 기준 높이 (해상도가 달라져도 같은 비율로 보이게)
const plateCache = new WeakMap();

function transitionPlates(canvas) {
  let plates = plateCache.get(canvas);
  if (!plates || plates[0].width !== canvas.width || plates[0].height !== canvas.height) {
    plates = [0, 1].map(() => {
      const c = document.createElement('canvas');
      c.width = canvas.width; c.height = canvas.height;
      return c;
    });
    plateCache.set(canvas, plates);
  }
  return plates;
}

export function renderFrame(ctx, t, opts = {}) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const k = H / REF_H;

  const tpl = project.template;
  const band = videoBand(W, H);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.filter = 'none';
  ctx.fillStyle = band ? tpl.bg : '#000';
  ctx.fillRect(0, 0, W, H);

  const paintLayer = (ctx, at) => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.filter = 'none';
    ctx.fillStyle = band ? tpl.bg : '#000';
    ctx.fillRect(0, 0, W, H);
    const src = opts.source ? opts.source(at.clip, at.local) : null;
    if (src?.img && src.w > 0 && src.h > 0) {
      if (band) {
        // 영상은 밴드 안에만 그린다. 밖으로 삐져나가면 잘라낸다.
        ctx.save();
        ctx.beginPath();
        ctx.rect(band.x, band.y, band.w, band.h);
        ctx.clip();
        ctx.translate(band.x, band.y);
        drawClipLayer(ctx, band.w, band.h, at, src);
        ctx.restore();
      } else {
        drawClipLayer(ctx, W, H, at, src);
      }
    }
    const f = fadeAlpha(at.clip, at.local, at.duration);
    if (f > 0) {
      ctx.fillStyle = `rgba(0,0,0,${f})`;
      ctx.fillRect(0, 0, W, H);
    }
  };

  const layers = layersAt(t, opts.layout);
  if (layers.length === 1) paintLayer(ctx, layers[0]);
  else if (layers.length > 1) {
    // 불투명한 A 위에 B를 p만큼 덮어 정확한 선형 디졸브를 만듭니다.
    // drawClipLayer가 alpha를 초기화하므로 별도 판에 먼저 완성해야 합니다.
    const plates = transitionPlates(ctx.canvas);
    layers.slice(0, 2).forEach((at, i) => paintLayer(plates[i].getContext('2d', { alpha: false }), at));
    ctx.globalAlpha = 1;
    ctx.drawImage(plates[0], 0, 0);
    const p = layers[1].weight;
    ctx.globalAlpha = p;
    ctx.drawImage(plates[1], 0, 0);
    ctx.globalAlpha = 1;
    const type = layers[0].clip.transitionOut?.type;
    if (type === 'fade' || type === 'flash') {
      ctx.fillStyle = type === 'fade' ? '#000' : '#fff';
      ctx.globalAlpha = Math.sin(Math.PI * p);
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }
  }

  if (band) drawTemplate(ctx, W, H, tpl, k);

  for (const o of activeOverlays(t)) drawOverlay(ctx, W, H, o, t, k);

  const cap = activeCaption(t);
  if (cap && cap.text.trim()) drawCaption(ctx, W, H, cap, { ...project.captionStyle, ...cap.style }, k, t);

  if (opts.safeArea) drawSafeArea(ctx, W, H);
}

// ── 영상/이미지 레이어 ─────────────────────────────────
export function clipGeometry(W, H, sw, sh, clip, progress = 0) {
  let base = clip.fit === 'cover'
    ? Math.max(W / sw, H / sh)
    : Math.min(W / sw, H / sh);

  let k = clip.scale, ox = clip.offX, oy = clip.offY;

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
  ctx.globalAlpha = 1;
  drawSource(ctx, src, g.dx, g.dy, g.dw, g.dh);
}

function drawBackdrop(ctx, W, H, clip, src) {
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

function fadeAlpha(clip, local, duration) {
  let a = 0;
  if (clip.fadeIn > 0 && local < clip.fadeIn) a = Math.max(a, 1 - local / clip.fadeIn);
  if (clip.fadeOut > 0 && local > duration - clip.fadeOut) {
    a = Math.max(a, 1 - (duration - local) / clip.fadeOut);
  }
  return Math.min(1, Math.max(0, a));
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
    align: 'center', x, y, maxWidth: w * .88, anchor: 'middle', alpha: Math.min(1, p * 3, q), ...extra,
  });
  ctx.save();
  ctx.globalAlpha = Math.min(1, p * 3, q);
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
  } else {
    ctx.translate(0, (1 - progress) * H * .04);
    ctx.strokeStyle = accent;ctx.lineWidth = 2 * k;
    for (const sy of [-1,1]) {ctx.beginPath();ctx.moveTo(x-w*.35,y+sy*size*1.1);ctx.lineTo(x+w*.35,y+sy*size*1.1);ctx.stroke();}
    title({ font: '"Noto Serif KR"', color: '#f2f3ec', size: size * .8 });
  }
  ctx.restore();
}

export function drawTextBlock(ctx, o) {
  const text = String(o.text ?? '');
  if (!text.trim()) return;

  const weight = (FONTS.find(f => f.css === o.font)?.weight) ?? 700;
  ctx.save();
  ctx.globalAlpha = o.alpha ?? 1;
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
function drawSafeArea(ctx, W, H) {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,59,92,.75)';
  ctx.setLineDash([12, 10]);
  ctx.lineWidth = Math.max(2, W / 400);
  const x = W * 0.05, top = H * 0.10, bottom = H * 0.82;
  ctx.strokeRect(x, top, W - x * 2, bottom - top);
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(255,59,92,.85)';
  ctx.font = `700 ${Math.round(H / 70)}px "Noto Sans KR", sans-serif`;
  ctx.textAlign = 'left';
  ctx.fillText('안전영역 — 이 밖은 UI에 가려질 수 있어요', x + 8, top - 12);
  ctx.restore();
}

// ── 폰트 로딩 ──────────────────────────────────────────
export async function loadFonts() {
  if (!document.fonts) return;
  await Promise.all(FONTS.map(f =>
    document.fonts.load(`${f.weight} 80px ${f.css}`).catch(() => {})));
  await document.fonts.ready;
}
