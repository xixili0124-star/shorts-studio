// UI 연결 — 상태를 바꾸고, 다시 그리라고 시키는 층
import {
  project, sel, FONTS, clipDuration, totalDuration, clipStartTime,
  getOverlay, selectedClip, newOverlay, sortCaptions,
} from './state.js';
import { $, $$, uid, fmtTime, clamp, pct, download, wireDropzone, on } from './util.js';
import { createClip, disposeClip } from './media.js';
import { loadFonts } from './render.js';
import { Player } from './player.js';
import { parseSrt, buildSrt } from './srt.js';
import { decodeAudioFile, mixTimeline, hasClipAudio } from './audio.js';
import { detectEngine, exportVideo } from './exporter.js';
import { isAvailable as sttAvailable, transcribe } from './transcribe.js';
import * as yt from './youtube.js';

const el = new Proxy({}, { get: (_, id) => document.getElementById(id) });

let player;
let engine = null;
let exportCtrl = null;
let bgmAudioEl = null;
let lastExport = null;   // { blob, seconds } — 유튜브 업로드가 이걸 쓴다
let ytCtrl = null;

// ── 시작 ───────────────────────────────────────────────
init();

async function init() {
  player = new Player(el.canvas, { onTick: onTick });
  fillFontSelects();
  wireDropzone(el.dropzone, el.file, addFiles);
  wireDropzone(el.bgmDrop, el.bgmFile, files => setBgm(files[0]));
  wireTabs();
  wireTransport();
  wireCanvasGestures();
  wireClipPanel();
  wireTextPanel();
  wireCaptionPanel();
  wireAudioPanel();
  wireExportPanel();
  wireYouTubePanel();
  wireKeyboard();

  // 페이지 전체가 드롭 영역
  ['dragover', 'drop'].forEach(ev => document.addEventListener(ev, e => e.preventDefault()));

  loadFonts().then(() => player.invalidate());

  engine = await detectEngine();
  el.engineBadge.textContent = engine.ok ? engine.label : '내보내기 미지원';
  el.engineBadge.className = `badge ${engine.ok ? (engine.mode === 'webcodecs' ? 'ok' : 'warn') : 'warn'}`;
  el.engineHint.textContent = engine.mode === 'webcodecs'
    ? '이 브라우저는 하드웨어 인코딩(WebCodecs)을 지원합니다. 실제 재생 시간보다 빠르게 저장돼요.'
    : '이 브라우저는 WebCodecs 인코딩을 지원하지 않아 실시간 녹화 방식으로 저장합니다. 영상 길이만큼 시간이 걸리고, 그동안 탭을 그대로 두세요. (크롬·엣지 권장)';
  el.autoCap.disabled = !sttAvailable();

  renderAll();
}

// ── 소재 추가 ──────────────────────────────────────────
async function addFiles(files) {
  const errors = [];
  const status = msg => {
    el.dropIdle.hidden = Boolean(msg);
    el.dropStatus.hidden = !msg;
    el.dropStatus.textContent = msg || '';
  };

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const prefix = files.length > 1 ? `(${i + 1}/${files.length}) ` : '';
    try {
      status(`${prefix}${f.name} 불러오는 중…`);
      const clip = await createClip(f, msg => status(prefix + msg));
      project.clips.push(clip);
      if (!sel.clipId) sel.clipId = clip.id;
      if (clip.decoderOnly) notifyDecoderMode(clip);
    } catch (e) {
      errors.push(e.message);
    }
  }
  status('');

  if (errors.length) alert(errors.join('\n\n'));
  renderAll();
  player.seek(player.time);
}

let decoderNoticeShown = false;
function notifyDecoderMode(clip) {
  console.info(`[media] ${clip.name}: 디코더 모드로 열었습니다.`);
  if (decoderNoticeShown) return;
  decoderNoticeShown = true;
  alert(`${clip.name} 은(는) 브라우저 기본 재생기로 열리지 않아 디코더 모드로 불러왔습니다.\n\n`
    + '편집과 내보내기는 똑같이 됩니다. 다만 미리보기에서 이 클립의 소리는 나오지 않고 화면이 조금 늦게 따라올 수 있어요. '
    + '완성된 영상에는 소리가 정상적으로 들어갑니다.');
}

function removeClip(id) {
  const i = project.clips.findIndex(c => c.id === id);
  if (i < 0) return;
  disposeClip(project.clips[i]);
  project.clips.splice(i, 1);
  if (sel.clipId === id) sel.clipId = project.clips[Math.min(i, project.clips.length - 1)]?.id ?? null;
  player.seek(Math.min(player.time, Math.max(0, totalDuration() - 0.01)));
  renderAll();
}

function moveClip(id, dir) {
  const i = project.clips.findIndex(c => c.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= project.clips.length) return;
  [project.clips[i], project.clips[j]] = [project.clips[j], project.clips[i]];
  renderAll();
  player.invalidate();
}

// ── 전체 다시 그리기 ───────────────────────────────────
function renderAll() {
  renderClipList();
  renderTimeline();
  renderClipPanel();
  renderOverlayList();
  renderOverlayPanel();
  renderCaptionList();
  renderCaptionStyle();
  renderAudioPanel();

  const has = project.clips.length > 0;
  const total = totalDuration();
  el.canvas.classList.toggle('empty', !has);
  el.emptyMsg.hidden = has;
  el.dragHint.hidden = !has;
  el.clearAll.hidden = !has;
  el.totalDur.textContent = `${total.toFixed(1)}초`;
  el.lenWarn.hidden = total <= 60;
  el.tAll.textContent = fmtTime(total);
  for (const b of [el.btnPlay, el.btnPrevF, el.btnNextF, el.scrub, el.btnExport, el.btnExportTop]) {
    b.disabled = !has || (b === el.btnExport || b === el.btnExportTop ? !engine?.ok : false);
  }
  player.draw();
}

/** 값만 바뀐 경우 — 입력 포커스를 잃지 않도록 최소한만 갱신 */
function softRefresh() {
  renderTimeline();
  el.totalDur.textContent = `${totalDuration().toFixed(1)}초`;
  el.tAll.textContent = fmtTime(totalDuration());
  player.invalidate();
}

function onTick(t) {
  el.tNow.textContent = fmtTime(t);
  const total = totalDuration();
  if (total > 0 && document.activeElement !== el.scrub) {
    el.scrub.value = String(Math.round((t / total) * 1000));
  }
  el.tlPlayhead.style.left = `${total > 0 ? (t / total) * 100 : 0}%`;
  el.btnPlay.textContent = player.playing ? '❚❚' : '▶';
}

// ── 왼쪽 목록 ──────────────────────────────────────────
function renderClipList() {
  el.clipList.innerHTML = '';
  project.clips.forEach((c, i) => {
    const li = document.createElement('li');
    li.className = c.id === sel.clipId ? 'sel' : '';
    li.innerHTML = `
      <img class="thumb" src="${c.thumb || ''}" alt="">
      <div class="meta">
        <div class="nm">${escapeHtml(c.name)}</div>
        <div class="du">${c.type === 'video' ? '🎬' : '🖼'} ${clipDuration(c).toFixed(1)}초</div>
      </div>
      <div class="ops">
        <button data-op="up" title="위로">▲</button>
        <button data-op="down" title="아래로">▼</button>
        <button data-op="del" title="삭제">✕</button>
      </div>`;
    li.addEventListener('click', e => {
      const op = e.target.dataset?.op;
      if (op === 'up') return moveClip(c.id, -1);
      if (op === 'down') return moveClip(c.id, 1);
      if (op === 'del') return removeClip(c.id);
      selectClip(c.id, true);
    });
    el.clipList.appendChild(li);
  });
}

function selectClip(id, seekToIt = false) {
  sel.clipId = id;
  if (seekToIt) {
    const i = project.clips.findIndex(c => c.id === id);
    if (i >= 0) player.seek(clipStartTime(i) + 0.01);
  }
  renderClipList();
  renderTimeline();
  renderClipPanel();
  switchTab('clip');
}

// ── 타임라인 ───────────────────────────────────────────
function renderTimeline() {
  const total = totalDuration() || 1;
  el.tlClips.innerHTML = '';
  el.tlOverlays.innerHTML = '';
  el.tlCaptions.innerHTML = '';

  project.clips.forEach((c, i) => {
    const d = clipDuration(c);
    const b = block(clipStartTime(i), d, total, `tl-block tl-clip${c.id === sel.clipId ? ' sel' : ''}`,
      `${c.type === 'video' ? '🎬' : '🖼'} ${c.name}`);
    b.addEventListener('click', () => selectClip(c.id, true));
    el.tlClips.appendChild(b);
  });

  for (const o of project.overlays) {
    const b = block(o.start, o.end - o.start, total, `tl-block movable tl-ov${o.id === sel.ovId ? ' sel' : ''}`, o.text.split('\n')[0]);
    b.addEventListener('click', () => {
      if (b._dragged) { b._dragged = false; return; }
      sel.ovId = o.id; switchTab('text'); player.seek(o.start + 0.05);
      renderOverlayList(); renderOverlayPanel(); renderTimeline();
    });
    attachBlockDrag(b, o, 'ov');
    el.tlOverlays.appendChild(b);
  }

  for (const c of project.captions) {
    const b = block(c.start, c.end - c.start, total, `tl-block movable tl-cap${c.id === sel.capId ? ' sel' : ''}`, c.text.split('\n')[0]);
    b.addEventListener('click', () => {
      if (b._dragged) { b._dragged = false; return; }
      sel.capId = c.id; switchTab('cap'); player.seek(c.start + 0.05);
      renderCaptionList(); renderTimeline();
    });
    attachBlockDrag(b, c, 'cap');
    el.tlCaptions.appendChild(b);
  }
}

/**
 * 타임라인 블록을 손으로 끌 수 있게 한다.
 *   양 끝 손잡이 -> 시작·끝 지점 조정
 *   가운데      -> 길이는 그대로 두고 통째로 이동
 *
 * 끄는 동안에는 타임라인을 다시 그리지 않는다. 다시 그리면 지금 잡고 있는
 * 엘리먼트가 사라져서 드래그가 끊긴다. 위치만 직접 바꾸고, 목록·패널은 놓을 때 맞춘다.
 */
const MIN_BLOCK_SEC = 0.2;

function attachBlockDrag(node, item, kind) {
  let mode = null, startX = 0, orig = null, moved = false, raf = 0;

  node.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    mode = e.target.classList.contains('l') ? 'start'
      : e.target.classList.contains('r') ? 'end'
        : 'move';
    startX = e.clientX;
    orig = { start: item.start, end: item.end };
    moved = false;
    // 캡처가 안 되는 상황(합성 이벤트 등)에서도 드래그 자체는 계속돼야 한다
    try { node.setPointerCapture(e.pointerId); } catch { /* noop */ }
    node.classList.add('dragging');
    e.preventDefault();
  });

  node.addEventListener('pointermove', e => {
    if (!mode) return;
    const total = totalDuration() || 1;
    const width = node.parentElement?.getBoundingClientRect().width || 1;
    const dx = e.clientX - startX;
    if (Math.abs(dx) > 3) moved = true;
    const dt = (dx / width) * total;

    if (mode === 'move') {
      const len = orig.end - orig.start;
      const s = clamp(orig.start + dt, 0, Math.max(0, total - len));
      item.start = s;
      item.end = s + len;
    } else if (mode === 'start') {
      item.start = clamp(orig.start + dt, 0, orig.end - MIN_BLOCK_SEC);
    } else {
      item.end = clamp(orig.end + dt, orig.start + MIN_BLOCK_SEC, total);
    }

    node.style.left = `${(item.start / total) * 100}%`;
    node.style.width = `${Math.max(0.8, ((item.end - item.start) / total) * 100)}%`;
    node.title = `${fmtTime(item.start)} ~ ${fmtTime(item.end)}`;
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; player.invalidate(); });
  });

  const finish = e => {
    if (!mode) return;
    mode = null;
    node.classList.remove('dragging');
    try { node.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    if (!moved) return;

    node._dragged = true;   // 이어서 오는 click 은 선택이 아니라 드래그의 꼬리다
    // 끌던 것을 선택 상태로 만든다 (타임라인은 다시 그리지 않고 표시만 바꾼다)
    for (const sib of node.parentElement.children) sib.classList.remove('sel');
    node.classList.add('sel');

    if (kind === 'cap') {
      sel.capId = item.id;
      sortCaptions();
      renderCaptionList();
    } else {
      sel.ovId = item.id;
      renderOverlayList();
      renderOverlayPanel();
    }
    player.invalidate();
  };

  node.addEventListener('pointerup', finish);
  node.addEventListener('pointercancel', finish);
}

function block(start, dur, total, cls, label) {
  const d = document.createElement('div');
  d.className = cls;
  d.style.left = `${(start / total) * 100}%`;
  d.style.width = `${Math.max(0.8, (dur / total) * 100)}%`;
  d.textContent = label;
  d.title = `${fmtTime(start)} ~ ${fmtTime(start + dur)}`;
  if (cls.includes('movable')) {
    // 양 끝 손잡이. textContent 를 먼저 넣고 붙여야 지워지지 않는다.
    for (const side of ['l', 'r']) {
      const grip = document.createElement('span');
      grip.className = `grip ${side}`;
      d.appendChild(grip);
    }
  }
  return d;
}

// ── 재생 컨트롤 ────────────────────────────────────────
function wireTransport() {
  el.btnPlay.addEventListener('click', () => { player.toggle(); onTick(player.time); });
  el.btnPrevF.addEventListener('click', () => player.step(-1));
  el.btnNextF.addEventListener('click', () => player.step(1));
  el.safeArea.addEventListener('change', () => { player.safeArea = el.safeArea.checked; player.invalidate(); });
  el.loopPlay.addEventListener('change', () => { player.loop = el.loopPlay.checked; });
  el.scrub.addEventListener('input', () => {
    player.pause();
    player.seek((Number(el.scrub.value) / 1000) * totalDuration());
  });
  el.clearAll.addEventListener('click', () => {
    if (!confirm('모든 클립을 지울까요?')) return;
    project.clips.forEach(disposeClip);
    project.clips = [];
    sel.clipId = null;
    player.pause();
    player.seek(0);
    renderAll();
  });
}

function wireKeyboard() {
  document.addEventListener('keydown', e => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.code === 'Space') { e.preventDefault(); player.toggle(); onTick(player.time); }
    else if (e.code === 'ArrowLeft') { e.preventDefault(); player.step(-1); }
    else if (e.code === 'ArrowRight') { e.preventDefault(); player.step(1); }
  });
}

// ── 캔버스 제스처 ──────────────────────────────────────
function wireCanvasGestures() {
  let dragging = false, lastX = 0, lastY = 0;

  el.canvas.addEventListener('pointerdown', e => {
    const c = ensureSelectedClip();
    if (!c) return;
    dragging = true;
    lastX = e.clientX; lastY = e.clientY;
    el.canvas.setPointerCapture(e.pointerId);
    el.canvas.classList.add('dragging');
  });

  el.canvas.addEventListener('pointermove', e => {
    if (!dragging) return;
    const c = selectedClip();
    if (!c) return;
    const rect = el.canvas.getBoundingClientRect();
    c.offX = clamp(c.offX + (e.clientX - lastX) / rect.width, -0.5, 0.5);
    c.offY = clamp(c.offY + (e.clientY - lastY) / rect.height, -0.5, 0.5);
    lastX = e.clientX; lastY = e.clientY;
    el.offX.value = c.offX; el.offY.value = c.offY;
    player.invalidate();
  });

  ['pointerup', 'pointercancel'].forEach(ev => el.canvas.addEventListener(ev, e => {
    dragging = false;
    el.canvas.classList.remove('dragging');
    try { el.canvas.releasePointerCapture(e.pointerId); } catch { /* noop */ }
  }));

  el.canvas.addEventListener('wheel', e => {
    const c = ensureSelectedClip();
    if (!c) return;
    e.preventDefault();
    c.scale = clamp(c.scale * (e.deltaY < 0 ? 1.06 : 0.94), 0.3, 3);
    el.scale.value = c.scale;
    el.scaleOut.textContent = pct(c.scale);
    player.invalidate();
  }, { passive: false });
}

function ensureSelectedClip() {
  let c = selectedClip();
  if (!c && project.clips.length) {
    const i = project.clips.findIndex((_, idx) => idx === 0);
    c = project.clips[i];
    sel.clipId = c.id;
    renderClipList();
    renderClipPanel();
  }
  return c;
}

// ── 탭 ─────────────────────────────────────────────────
function wireTabs() {
  $$('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));
}
function switchTab(name) {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tabpane').forEach(p => p.classList.toggle('active', p.dataset.pane === name));
}

// ── 클립 패널 ──────────────────────────────────────────
function renderClipPanel() {
  const c = selectedClip();
  el.clipNone.hidden = !!c;
  el.clipProps.hidden = !c;
  if (!c) return;

  el.clipName.textContent = c.name;
  el.trimBox.hidden = c.type !== 'video';
  el.imgDurBox.hidden = c.type !== 'image';
  el.clipAudioBox.hidden = c.type !== 'video';

  if (c.type === 'video') {
    el.trimStart.value = c.trimStart.toFixed(2);
    el.trimEnd.value = c.trimEnd.toFixed(2);
    el.trimStart.max = c.srcDuration;
    el.trimEnd.max = c.srcDuration;
    el.srcDurHint.textContent = `원본 ${c.srcDuration.toFixed(1)}초 · ${c.natW}×${c.natH}`;
    el.clipMuted.checked = c.muted;
    el.clipVol.value = c.volume;
    el.clipVolOut.textContent = pct(c.volume);
  } else {
    el.imgDur.value = c.imgDuration;
    el.imgDurOut.textContent = `${Number(c.imgDuration).toFixed(1)}초`;
    el.ken.value = c.ken;
  }
  el.fit.value = c.fit;
  el.clipBg.value = c.bg;
  el.scale.value = c.scale;
  el.scaleOut.textContent = pct(c.scale);
  el.offX.value = c.offX;
  el.offY.value = c.offY;
  el.fadeIn.value = c.fadeIn;
  el.fadeInOut.textContent = `${Number(c.fadeIn).toFixed(1)}초`;
  el.fadeOut.value = c.fadeOut;
  el.fadeOutOut.textContent = `${Number(c.fadeOut).toFixed(1)}초`;
}

function wireClipPanel() {
  const upd = (fn, { hard = false } = {}) => () => {
    const c = selectedClip();
    if (!c) return;
    fn(c);
    if (hard) { renderClipList(); renderClipPanel(); }
    softRefresh();
  };

  on(el.trimStart, 'input change', upd(c => {
    c.trimStart = clamp(Number(el.trimStart.value) || 0, 0, Math.max(0, c.trimEnd - 0.1));
  }, { hard: true }));
  on(el.trimEnd, 'input change', upd(c => {
    c.trimEnd = clamp(Number(el.trimEnd.value) || 0, c.trimStart + 0.1, c.srcDuration);
  }, { hard: true }));
  el.trimStartHere.addEventListener('click', upd(c => {
    const i = project.clips.indexOf(c);
    const local = player.time - clipStartTime(i);
    c.trimStart = clamp(c.trimStart + local, 0, c.trimEnd - 0.1);
  }, { hard: true }));
  el.trimEndHere.addEventListener('click', upd(c => {
    const i = project.clips.indexOf(c);
    const local = player.time - clipStartTime(i);
    c.trimEnd = clamp(c.trimStart + local, c.trimStart + 0.1, c.srcDuration);
  }, { hard: true }));

  el.imgDur.addEventListener('input', upd(c => {
    c.imgDuration = Number(el.imgDur.value);
    el.imgDurOut.textContent = `${c.imgDuration.toFixed(1)}초`;
  }, { hard: false }));
  el.imgDur.addEventListener('change', () => { renderClipList(); softRefresh(); });
  el.ken.addEventListener('change', upd(c => { c.ken = el.ken.value; }));

  el.fit.addEventListener('change', upd(c => { c.fit = el.fit.value; }));
  el.clipBg.addEventListener('change', upd(c => { c.bg = el.clipBg.value; }));
  el.scale.addEventListener('input', upd(c => {
    c.scale = Number(el.scale.value);
    el.scaleOut.textContent = pct(c.scale);
  }));
  el.offX.addEventListener('input', upd(c => { c.offX = Number(el.offX.value); }));
  el.offY.addEventListener('input', upd(c => { c.offY = Number(el.offY.value); }));
  el.resetTransform.addEventListener('click', upd(c => {
    c.scale = 1; c.offX = 0; c.offY = 0;
    renderClipPanel();
  }));
  el.fadeIn.addEventListener('input', upd(c => {
    c.fadeIn = Number(el.fadeIn.value);
    el.fadeInOut.textContent = `${c.fadeIn.toFixed(1)}초`;
  }));
  el.fadeOut.addEventListener('input', upd(c => {
    c.fadeOut = Number(el.fadeOut.value);
    el.fadeOutOut.textContent = `${c.fadeOut.toFixed(1)}초`;
  }));
  el.clipMuted.addEventListener('change', upd(c => { c.muted = el.clipMuted.checked; }));
  el.clipVol.addEventListener('input', upd(c => {
    c.volume = Number(el.clipVol.value);
    el.clipVolOut.textContent = pct(c.volume);
  }));
}

// ── 텍스트(오버레이) 패널 ──────────────────────────────
function fillFontSelects() {
  for (const s of $$('.fontsel')) {
    s.innerHTML = FONTS.map(f => `<option value='${f.css}'>${f.label}</option>`).join('');
  }
}

function renderOverlayList() {
  el.ovList.innerHTML = '';
  project.overlays
    .slice()
    .sort((a, b) => a.start - b.start)
    .forEach(o => {
      const li = document.createElement('li');
      li.className = o.id === sel.ovId ? 'sel' : '';
      li.innerHTML = `<span class="t">${escapeHtml(o.text.split('\n')[0] || '(빈 텍스트)')}</span>
        <span class="tm">${fmtTime(o.start)}~${fmtTime(o.end)}</span>`;
      li.addEventListener('click', () => {
        sel.ovId = o.id;
        player.seek(o.start + 0.05);
        renderOverlayList();
        renderOverlayPanel();
        renderTimeline();
      });
      el.ovList.appendChild(li);
    });
}

function renderOverlayPanel() {
  const o = getOverlay(sel.ovId);
  el.ovProps.hidden = !o;
  if (!o) return;
  el.ovText.value = o.text;
  el.ovStart.value = o.start.toFixed(1);
  el.ovEnd.value = o.end.toFixed(1);
  el.ovFont.value = o.font;
  el.ovSize.value = o.size;
  el.ovSizeOut.textContent = o.size;
  el.ovColor.value = o.color;
  el.ovStroke.value = o.stroke;
  el.ovStrokeW.value = o.strokeW;
  el.ovBox.value = o.box;
  el.ovAlign.value = o.align;
  el.ovX.value = o.x;
  el.ovY.value = o.y;
  el.ovAnim.value = o.anim;
}

function wireTextPanel() {
  el.addOverlay.addEventListener('click', () => {
    const o = { ...newOverlay(player.time), id: uid() };
    o.end = Math.min(o.end, Math.max(o.start + 0.5, totalDuration()));
    project.overlays.push(o);
    sel.ovId = o.id;
    renderOverlayList();
    renderOverlayPanel();
    softRefresh();
  });

  const upd = fn => () => {
    const o = getOverlay(sel.ovId);
    if (!o) return;
    fn(o);
    renderOverlayList();
    softRefresh();
  };

  el.ovText.addEventListener('input', upd(o => { o.text = el.ovText.value; }));
  on(el.ovStart, 'input change', upd(o => {
    o.start = clamp(Number(el.ovStart.value) || 0, 0, Math.max(0, o.end - 0.2));
  }));
  on(el.ovEnd, 'input change', upd(o => {
    o.end = clamp(Number(el.ovEnd.value) || 0, o.start + 0.2, Math.max(0.2, totalDuration()));
  }));
  el.ovStartHere.addEventListener('click', upd(o => {
    o.start = clamp(player.time, 0, Math.max(0, o.end - 0.2));
    el.ovStart.value = o.start.toFixed(1);
  }));
  el.ovEndHere.addEventListener('click', upd(o => {
    o.end = clamp(player.time, o.start + 0.2, Math.max(0.2, totalDuration()));
    el.ovEnd.value = o.end.toFixed(1);
  }));
  el.ovFont.addEventListener('change', upd(o => { o.font = el.ovFont.value; }));
  el.ovSize.addEventListener('input', upd(o => { o.size = Number(el.ovSize.value); el.ovSizeOut.textContent = o.size; }));
  el.ovColor.addEventListener('input', upd(o => { o.color = el.ovColor.value; }));
  el.ovStroke.addEventListener('input', upd(o => { o.stroke = el.ovStroke.value; }));
  el.ovStrokeW.addEventListener('input', upd(o => { o.strokeW = Number(el.ovStrokeW.value); }));
  el.ovBox.addEventListener('change', upd(o => { o.box = el.ovBox.value; }));
  el.ovAlign.addEventListener('change', upd(o => { o.align = el.ovAlign.value; }));
  el.ovX.addEventListener('input', upd(o => { o.x = Number(el.ovX.value); }));
  el.ovY.addEventListener('input', upd(o => { o.y = Number(el.ovY.value); }));
  el.ovAnim.addEventListener('change', upd(o => { o.anim = el.ovAnim.value; }));
  el.ovPos.addEventListener('click', e => {
    const y = e.target.dataset?.y;
    if (!y) return;
    const o = getOverlay(sel.ovId);
    if (!o) return;
    o.y = Number(y);
    el.ovY.value = o.y;
    softRefresh();
  });
  el.delOverlay.addEventListener('click', () => {
    project.overlays = project.overlays.filter(o => o.id !== sel.ovId);
    sel.ovId = null;
    renderOverlayList();
    renderOverlayPanel();
    softRefresh();
  });
}

// ── 자막 패널 ──────────────────────────────────────────
function renderCaptionList() {
  sortCaptions();
  el.capList.innerHTML = '';
  if (!project.captions.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = '아직 자막이 없습니다. 재생하다가 원하는 지점에서 [+ 현재 위치에 자막]을 누르세요.';
    el.capList.appendChild(p);
    return;
  }
  for (const c of project.captions) {
    const li = document.createElement('li');
    const editing = c.id === sel.capId;
    li.className = editing ? 'sel editing' : '';
    if (editing) {
      li.innerHTML = `
        <div class="row">시작 <input type="number" step="0.1" min="0" value="${c.start.toFixed(1)}" data-f="start">
          <button class="btn ghost tiny" data-f="startHere">현재</button></div>
        <div class="row">끝 <input type="number" step="0.1" min="0" value="${c.end.toFixed(1)}" data-f="end">
          <button class="btn ghost tiny" data-f="endHere">현재</button>
          <button class="del-x" data-f="del" title="삭제">✕</button></div>
        <textarea rows="2" data-f="text">${escapeHtml(c.text)}</textarea>`;
      li.querySelector('[data-f="text"]').addEventListener('input', e => {
        c.text = e.target.value; softRefresh();
      });
      li.querySelector('[data-f="start"]').addEventListener('input', e => {
        c.start = clamp(Number(e.target.value) || 0, 0, Math.max(0, c.end - 0.2)); softRefresh();
      });
      li.querySelector('[data-f="end"]').addEventListener('input', e => {
        c.end = clamp(Number(e.target.value) || 0, c.start + 0.2, Math.max(0.2, totalDuration())); softRefresh();
      });
      li.querySelector('[data-f="startHere"]').addEventListener('click', () => {
        c.start = clamp(player.time, 0, Math.max(0, c.end - 0.2)); renderCaptionList(); softRefresh();
      });
      li.querySelector('[data-f="endHere"]').addEventListener('click', () => {
        c.end = clamp(player.time, c.start + 0.2, Math.max(0.2, totalDuration())); renderCaptionList(); softRefresh();
      });
      li.querySelector('[data-f="del"]').addEventListener('click', () => {
        project.captions = project.captions.filter(x => x.id !== c.id);
        sel.capId = null;
        renderCaptionList(); softRefresh();
      });
    } else {
      li.innerHTML = `<span class="tm">${fmtTime(c.start)}</span>
        <span class="t">${escapeHtml(c.text.split('\n')[0] || '(빈 자막)')}</span>`;
      li.addEventListener('click', () => {
        sel.capId = c.id;
        player.seek(c.start + 0.05);
        renderCaptionList();
        renderTimeline();
      });
    }
    el.capList.appendChild(li);
  }
}

function renderCaptionStyle() {
  const s = project.captionStyle;
  el.capFont.value = s.font;
  el.capSize.value = s.size;
  el.capSizeOut.textContent = s.size;
  el.capColor.value = s.color;
  el.capStroke.value = s.stroke;
  el.capStrokeW.value = s.strokeW;
  el.capBox.value = s.box;
  el.capBottom.value = s.bottom;
}

function wireCaptionPanel() {
  el.addCap.addEventListener('click', () => {
    const total = totalDuration();
    const start = clamp(player.time, 0, Math.max(0, total - 0.5));
    const c = { id: uid(), start, end: Math.min(start + 2.5, Math.max(start + 0.5, total)), text: '자막 내용' };
    project.captions.push(c);
    sel.capId = c.id;
    renderCaptionList();
    softRefresh();
  });

  const s = project.captionStyle;
  const upd = fn => () => { fn(); softRefresh(); };
  el.capFont.addEventListener('change', upd(() => { s.font = el.capFont.value; }));
  el.capSize.addEventListener('input', upd(() => { s.size = Number(el.capSize.value); el.capSizeOut.textContent = s.size; }));
  el.capColor.addEventListener('input', upd(() => { s.color = el.capColor.value; }));
  el.capStroke.addEventListener('input', upd(() => { s.stroke = el.capStroke.value; }));
  el.capStrokeW.addEventListener('input', upd(() => { s.strokeW = Number(el.capStrokeW.value); }));
  el.capBox.addEventListener('change', upd(() => { s.box = el.capBox.value; }));
  el.capBottom.addEventListener('input', upd(() => { s.bottom = Number(el.capBottom.value); }));

  el.autoCap.addEventListener('click', doAutoCaption);

  el.importSrt.addEventListener('click', () => el.srtFile.click());
  el.srtFile.addEventListener('change', async () => {
    const f = el.srtFile.files?.[0];
    el.srtFile.value = '';
    if (!f) return;
    try {
      const caps = parseSrt(await f.text());
      if (!caps.length) return alert('자막을 읽지 못했습니다. SRT 또는 VTT 형식인지 확인해 주세요.');
      project.captions.push(...caps);
      renderCaptionList();
      softRefresh();
    } catch (e) {
      alert(`자막 파일을 읽지 못했습니다: ${e.message}`);
    }
  });

  el.exportSrt.addEventListener('click', () => {
    if (!project.captions.length) return alert('저장할 자막이 없습니다.');
    download(new Blob([buildSrt(project.captions)], { type: 'text/plain;charset=utf-8' }),
      `${project.fileName || 'shorts'}.srt`);
  });
}

// ── 자동 자막 ──────────────────────────────────────────
let autoCapCtrl = null;
const AUTO_CAP_LABEL = '\u{1F399} 자동 자막 만들기';

async function doAutoCaption() {
  if (autoCapCtrl) { autoCapCtrl.abort(); return; }   // 두 번째 클릭은 취소
  if (!project.clips.length) return alert('먼저 영상이나 이미지를 추가하세요.');
  if (!hasClipAudio()) {
    return alert('말소리가 담긴 영상이 있어야 합니다.\n\n'
      + '배경음악만으로는 자막을 만들 수 없고, 음소거된 클립도 인식 대상에서 빠집니다.');
  }
  if (project.captions.length
      && !confirm(`이미 있는 자막 ${project.captions.length}개를 지우고 새로 만듭니다. 계속할까요?`)) {
    return;
  }

  player.pause();
  autoCapCtrl = new AbortController();
  el.autoCap.textContent = '취소';
  setCapStatus('소리 모으는 중…');

  try {
    // 배경음악은 빼고 보낸다. 노래가 섞이면 알아듣는 정확도가 떨어진다.
    const mixed = await mixTimeline({
      includeBgm: false,
      signal: autoCapCtrl.signal,
      onProgress: (_, msg) => setCapStatus(msg || '소리 모으는 중…'),
    });
    if (!mixed) throw new Error('소리를 찾지 못했습니다.');

    setCapStatus(`음성 인식 중… (${mixed.duration.toFixed(0)}초 분량, 보통 몇 초 걸립니다)`);
    const caps = await transcribe(mixed, { lang: 'ko', signal: autoCapCtrl.signal });

    if (!caps.length) {
      setCapStatus('말소리를 찾지 못했습니다. 볼륨이 너무 작지는 않은지 확인해 보세요.');
      return;
    }
    project.captions = caps;
    sel.capId = null;
    renderCaptionList();
    softRefresh();
    setCapStatus(`자막 ${caps.length}개를 만들었습니다. 목록에서 눌러 고칠 수 있습니다.`);
  } catch (e) {
    if (e?.name === 'AbortError') setCapStatus('취소했습니다.');
    else {
      console.error(e);
      setCapStatus(`실패: ${e.message}`);
    }
  } finally {
    autoCapCtrl = null;
    el.autoCap.textContent = AUTO_CAP_LABEL;
  }
}

function setCapStatus(msg) {
  el.capStatus.textContent = msg;
}

// ── 오디오 패널 ────────────────────────────────────────
function renderAudioPanel() {
  el.origVol.value = project.audio.originalVolume;
  el.origVolOut.textContent = pct(project.audio.originalVolume);
  const b = project.audio.bgm;
  el.bgmProps.hidden = !b;
  el.bgmDrop.hidden = !!b;
  if (b) {
    el.bgmName.textContent = `🎵 ${b.name} (${b.buffer.duration.toFixed(1)}초)`;
    el.bgmVol.value = b.volume;
    el.bgmVolOut.textContent = pct(b.volume);
    el.bgmOffset.value = b.offset;
    el.bgmFadeIn.value = b.fadeIn;
    el.bgmFadeInOut.textContent = `${b.fadeIn.toFixed(1)}초`;
    el.bgmFadeOut.value = b.fadeOut;
    el.bgmFadeOutOut.textContent = `${b.fadeOut.toFixed(1)}초`;
    el.bgmLoop.checked = b.loop;
  }
}

async function setBgm(file) {
  if (!file) return;
  try {
    const buffer = await decodeAudioFile(file);
    project.audio.bgm = {
      name: file.name, file, buffer,
      volume: 0.35, offset: 0, fadeIn: 0.5, fadeOut: 1, loop: true,
    };
    if (bgmAudioEl) URL.revokeObjectURL(bgmAudioEl.src);
    bgmAudioEl = document.createElement('audio');
    bgmAudioEl.src = URL.createObjectURL(file);
    bgmAudioEl.preload = 'auto';
    player.setBgmElement(bgmAudioEl);
    renderAudioPanel();
  } catch (e) {
    alert(`이 오디오 파일은 읽지 못했습니다: ${file.name}`);
  }
}

function wireAudioPanel() {
  el.origVol.addEventListener('input', () => {
    project.audio.originalVolume = Number(el.origVol.value);
    el.origVolOut.textContent = pct(project.audio.originalVolume);
    player.invalidate();
  });
  const b = () => project.audio.bgm;
  el.bgmVol.addEventListener('input', () => { if (b()) { b().volume = Number(el.bgmVol.value); el.bgmVolOut.textContent = pct(b().volume); player.invalidate(); } });
  el.bgmOffset.addEventListener('input', () => { if (b()) { b().offset = Math.max(0, Number(el.bgmOffset.value) || 0); player.invalidate(); } });
  el.bgmFadeIn.addEventListener('input', () => { if (b()) { b().fadeIn = Number(el.bgmFadeIn.value); el.bgmFadeInOut.textContent = `${b().fadeIn.toFixed(1)}초`; } });
  el.bgmFadeOut.addEventListener('input', () => { if (b()) { b().fadeOut = Number(el.bgmFadeOut.value); el.bgmFadeOutOut.textContent = `${b().fadeOut.toFixed(1)}초`; } });
  el.bgmLoop.addEventListener('change', () => { if (b()) b().loop = el.bgmLoop.checked; });
  el.delBgm.addEventListener('click', () => {
    project.audio.bgm = null;
    if (bgmAudioEl) { bgmAudioEl.pause(); URL.revokeObjectURL(bgmAudioEl.src); }
    bgmAudioEl = null;
    player.setBgmElement(null);
    renderAudioPanel();
  });
}

// ── 내보내기 ───────────────────────────────────────────
function wireExportPanel() {
  el.outRes.addEventListener('change', () => {
    const [w, h] = el.outRes.value.split('x').map(Number);
    project.width = w; project.height = h;
    el.canvas.width = w; el.canvas.height = h;
    player.invalidate();
  });
  el.outFps.addEventListener('change', () => { project.fps = Number(el.outFps.value); });
  el.outQ.addEventListener('change', () => { project.quality = el.outQ.value; });
  el.outName.addEventListener('input', () => { project.fileName = el.outName.value.trim() || 'shorts'; });

  el.btnExportTop.addEventListener('click', () => { switchTab('out'); doExport(); });
  el.btnExport.addEventListener('click', doExport);
  el.cancelExport.addEventListener('click', () => exportCtrl?.abort());
}

async function doExport() {
  if (exportCtrl) return;
  if (!project.clips.length) return alert('먼저 영상이나 이미지를 추가하세요.');
  if (!engine?.ok) return alert('이 브라우저는 영상 내보내기를 지원하지 않습니다. 크롬이나 엣지를 사용해 주세요.');

  player.pause();
  exportCtrl = new AbortController();
  el.progWrap.hidden = false;
  el.resultBox.hidden = true;
  el.btnExport.disabled = true;
  el.btnExportTop.disabled = true;
  setProgress(0, '준비 중…');

  try {
    const blob = await exportVideo({
      engine,
      player,
      signal: exportCtrl.signal,
      onProgress: setProgress,
    });
    const url = URL.createObjectURL(blob);
    el.resultVideo.src = url;
    el.dlLink.href = url;
    el.dlLink.download = `${project.fileName || 'shorts'}.${engine.ext}`;
    el.dlLink.textContent = `다운로드 (${(blob.size / 1024 / 1024).toFixed(1)}MB)`;
    el.resultBox.hidden = false;
    setProgress(1, '완료');

    lastExport = { blob, seconds: totalDuration() };
    if (!el.ytTitle.value.trim()) el.ytTitle.value = project.fileName || 'shorts';
    refreshYt();
  } catch (e) {
    if (e?.name === 'AbortError') setProgress(0, '취소했습니다.');
    else {
      console.error(e);
      alert(`내보내기 실패: ${e.message}`);
      setProgress(0, '실패');
    }
  } finally {
    exportCtrl = null;
    el.btnExport.disabled = false;
    el.btnExportTop.disabled = false;
    setTimeout(() => { if (!exportCtrl) el.progWrap.hidden = true; }, 1500);
  }
}

function setProgress(p, msg) {
  el.progBar.style.width = `${Math.round(clamp(p, 0, 1) * 100)}%`;
  if (msg) el.progText.textContent = msg;
}

// ── 유튜브 업로드 ──────────────────────────────────────
function wireYouTubePanel() {
  el.ytClientId.value = yt.savedClientId();
  el.ytClientId.addEventListener('change', () => yt.saveClientId(el.ytClientId.value));

  el.ytSignIn.addEventListener('click', async () => {
    const id = el.ytClientId.value.trim();
    if (!id) return alert('OAuth 클라이언트 ID 를 먼저 넣어 주세요.');
    yt.saveClientId(id);
    el.ytSignIn.disabled = true;
    el.ytSignIn.textContent = '연결 중…';
    try {
      const acc = await yt.signIn(id);
      el.ytAccount.textContent = acc?.email ? `연결됨 · ${acc.email}` : '연결됨';
      el.ytSetup.hidden = true;
      el.ytForm.hidden = false;
      refreshYt();
    } catch (e) {
      alert(`구글 계정 연결 실패:\n${e.message}`);
    } finally {
      el.ytSignIn.disabled = false;
      el.ytSignIn.textContent = '구글 계정 연결';
    }
  });

  el.ytSignOut.addEventListener('click', () => {
    yt.signOut();
    el.ytForm.hidden = true;
    el.ytSetup.hidden = false;
    el.ytLink.hidden = true;
    el.ytStatus.textContent = '';
  });

  el.ytUpload.addEventListener('click', doUpload);
}

/** 업로드 버튼 상태와 사전 점검 문구를 갱신한다 */
function refreshYt() {
  const ready = Boolean(lastExport) && yt.isSignedIn() && !ytCtrl;
  el.ytUpload.disabled = !ready;
  if (!lastExport) {
    el.ytPreflight.hidden = true;
    if (yt.isSignedIn()) el.ytStatus.textContent = '먼저 MP4 로 내보내면 업로드할 수 있습니다.';
    return;
  }
  const notes = yt.preflight(lastExport.seconds, lastExport.blob);
  el.ytPreflight.hidden = notes.length === 0;
  el.ytPreflight.textContent = notes.join(' ');
}

async function doUpload() {
  if (!lastExport || ytCtrl) return;
  ytCtrl = new AbortController();
  el.ytUpload.disabled = true;
  el.ytProg.hidden = false;
  el.ytLink.hidden = true;

  const setYtProgress = (p, msg) => {
    el.ytProgBar.style.width = `${Math.round(clamp(p, 0, 1) * 100)}%`;
    if (msg) el.ytStatus.textContent = msg;
  };

  try {
    const res = await yt.uploadVideo(lastExport.blob, {
      title: el.ytTitle.value,
      description: el.ytDesc.value,
      privacyStatus: el.ytPrivacy.value,
      madeForKids: el.ytKids.checked,
      durationSec: lastExport.seconds,
    }, { onProgress: setYtProgress, signal: ytCtrl.signal });

    setYtProgress(1, res.lockedPrivate
      ? '올라갔지만 유튜브가 비공개로 잠갔습니다. (감사를 통과하지 않은 API 프로젝트)'
      : `업로드 완료 · 공개 범위: ${res.privacyStatus}`);
    el.ytLink.href = lastExport.seconds <= 180 ? res.shortsUrl : res.url;
    el.ytLink.hidden = false;
  } catch (e) {
    if (e?.name === 'AbortError') setYtProgress(0, '업로드를 취소했습니다.');
    else {
      console.error(e);
      setYtProgress(0, '업로드 실패');
      alert(`유튜브 업로드 실패:\n${e.message}`);
    }
  } finally {
    ytCtrl = null;
    refreshYt();
  }
}

// ── 기타 ───────────────────────────────────────────────
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

window.addEventListener('beforeunload', e => {
  if (project.clips.length) { e.preventDefault(); e.returnValue = ''; }
});
