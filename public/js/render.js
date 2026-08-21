// 프레임 렌더러 — 미리보기와 내보내기가 "이 함수 하나"를 공유한다.
// opts.source(clip, localTime) 가 그릴 이미지({img, w, h})를 돌려준다.
//   미리보기 → <video> 엘리먼트 / 내보내기 → 디코딩된 VideoSample
import {
  project, clipAt, activeOverlays, activeCaption, FONTS, ACCENT,
} from './state.js';

const REF_H = 1920; // 스타일 수치의 기준 높이 (해상도가 달라져도 같은 비율로 보이게)

export function renderFrame(ctx, t, opts = {}) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const k = H / REF_H;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.filter = 'none';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);

  const at = clipAt(t);
  if (at?.clip) {
    const src = opts.source ? opts.source(at.clip, at.local) : null;
    if (src?.img && src.w > 0 && src.h > 0) {
      drawClipLayer(ctx, W, H, at, src);
    }
    const f = fadeAlpha(at.clip, at.local, at.duration);
    if (f > 0) {
      ctx.fillStyle = `rgba(0,0,0,${f})`;
      ctx.fillRect(0, 0, W, H);
    }
  }

  for (const o of activeOverlays(t)) drawOverlay(ctx, W, H, o, t, k);

  const cap = activeCaption(t);
  if (cap && cap.text.trim()) drawCaption(ctx, W, H, cap, project.captionStyle, k);

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
  const progress = at.duration > 0 ? at.local / at.duration : 0;
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

function drawCaption(ctx, W, H, cap, st, k) {
  drawTextBlock(ctx, {
    text: cap.text,
    font: st.font, size: st.size * k, color: st.color,
    stroke: st.stroke, strokeW: st.strokeW * k,
    box: st.box, align: 'center',
    x: W / 2, y: H * (1 - st.bottom),
    maxWidth: W * 0.86,
    anchor: 'bottom',
    alpha: 1,
  });
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
          : ACCENT;
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
