// 미리보기 재생기 — <video> 엘리먼트를 타임라인에 맞춰 몰고 다니면서 캔버스에 그린다.
import { project, clipAt, totalDuration } from './state.js';
import { renderFrame } from './render.js';
import { clamp } from './util.js';

export class Player {
  constructor(canvas, { onTick } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.time = 0;
    this.playing = false;
    this.loop = false;   // 편집 중에는 한 번만 재생되는 편이 낫다. 위 [반복] 으로 켤 수 있다.
    this.safeArea = false;
    this.onTick = onTick || (() => {});
    this._raf = null;
    this._startWall = 0;
    this._startTime = 0;
    this.bgmEl = null;
    this.narrationEl = null;

    // 탭이 가려지면 requestAnimationFrame 이 멈춘다.
    // 그대로 두면 돌아왔을 때 시간이 훌쩍 뛰므로 그냥 일시정지한다.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.playing) this.pause();
    });
  }

  get duration() { return totalDuration(); }

  // ── 그리기 ───────────────────────────────────────────
  source = (clip, local) => {
    if (clip.type === 'image') {
      return clip.bitmap ? { img: clip.bitmap, w: clip.natW, h: clip.natH } : null;
    }
    if (clip.decoderOnly) return this._sinkSource(clip, clip.trimStart + local);
    const el = clip.el;
    if (!el || el.readyState < 2 || !el.videoWidth) return null;
    return { img: el, w: el.videoWidth, h: el.videoHeight };
  };

  /**
   * <video> 로 못 여는 파일용 — 디코더에서 프레임을 하나씩 받아 온다.
   * 비동기라서, 도착할 때까지는 직전 프레임을 계속 보여준다.
   */
  _sinkSource(clip, t) {
    const held = clip._frame;
    if (!held || Math.abs(held.t - t) > 0.06) this._requestSinkFrame(clip, t);
    return held ? { img: held.canvas, w: held.canvas.width, h: held.canvas.height } : null;
  }

  _requestSinkFrame(clip, t) {
    if (clip._pending) { clip._queued = t; return; }   // 한 번에 하나만
    clip._pending = true;
    clip.sink.getCanvas(t)
      .then(w => { if (w) clip._frame = { t: w.timestamp, canvas: w.canvas }; })
      .catch(() => { /* 디코딩 실패한 지점은 직전 프레임 유지 */ })
      .finally(() => {
        clip._pending = false;
        const next = clip._queued;
        clip._queued = null;
        if (next != null) this._requestSinkFrame(clip, next);
        else if (!this.playing) this.draw();
      });
  }

  draw() {
    renderFrame(this.ctx, this.time, { source: this.source, safeArea: this.safeArea });
  }

  /** 상태가 바뀌었을 때 정지 상태에서도 한 프레임 다시 그린다 */
  invalidate() {
    if (!this.playing) {
      this._syncVideos(true);
      this.draw();
      this.onTick(this.time);
    }
  }

  // ── 이동 ─────────────────────────────────────────────
  seek(t, { redraw = true } = {}) {
    this.time = clamp(t, 0, Math.max(0, this.duration - 0.001));
    if (this.playing) {
      this._startWall = performance.now() / 1000;
      this._startTime = this.time;
    }
    this._syncVideos(!this.playing);
    this._syncBgm();
    this._syncNarration();
    if (redraw) this.draw();
    this.onTick(this.time);
  }

  step(frames) {
    this.pause();
    this.seek(this.time + frames / project.fps);
  }

  // ── 재생 ─────────────────────────────────────────────
  play() {
    if (this.playing || this.duration <= 0) return;
    this.playing = true;
    this._startWall = performance.now() / 1000;
    this._startTime = this.time;
    this._syncBgm();
    this._syncNarration();
    this.bgmEl?.play().catch(() => {});
    this.narrationEl?.play().catch(() => {});
    const tick = () => {
      if (!this.playing) return;
      const now = performance.now() / 1000;
      let t = this._startTime + (now - this._startWall);
      if (t >= this.duration) {
        if (this.loop) {
          t = 0;
          this._startWall = now;
          this._startTime = 0;
        } else {
          this.time = this.duration;
          this.pause();
          this.draw();
          this.onTick(this.time);
          return;
        }
      }
      this.time = t;
      this._syncVideos(false);
      this.draw();
      this.onTick(this.time);
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  pause() {
    this.playing = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    for (const c of project.clips) { try { c.el?.pause(); } catch { /* noop */ } }
    try { this.bgmEl?.pause(); } catch { /* noop */ }
    try { this.narrationEl?.pause(); } catch { /* noop */ }
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  // ── 내부: 비디오 동기화 ──────────────────────────────
  _syncVideos(exact) {
    const at = clipAt(this.time);
    const active = at?.clip;

    for (const c of project.clips) {
      if (c.type !== 'video' || !c.el) continue;
      if (c !== active) {
        if (!c.el.paused) c.el.pause();
        continue;
      }
      const want = c.trimStart + at.local;
      c.el.muted = !!c.muted;
      c.el.volume = clamp((c.volume ?? 1) * project.audio.originalVolume, 0, 1);

      if (this.playing) {
        if (Math.abs(c.el.currentTime - want) > 0.22) c.el.currentTime = want;
        if (c.el.paused) c.el.play().catch(() => {});
      } else {
        if (!c.el.paused) c.el.pause();
        if (exact && Math.abs(c.el.currentTime - want) > 0.02) {
          c.el.currentTime = want;
          c.el.addEventListener('seeked', () => { if (!this.playing) this.draw(); }, { once: true });
        }
      }
    }
  }

  setNarrationElement(el) {
    try { this.narrationEl?.pause(); } catch { /* noop */ }
    this.narrationEl = el;
    this._syncNarration();
  }

  /** 내레이션은 0초부터 그대로 깔리므로 재생 위치만 맞추면 된다 */
  _syncNarration() {
    const n = project.audio.narration;
    const el = this.narrationEl;
    if (!el || !n) return;
    el.volume = clamp(n.volume ?? 1, 0, 1);
    if (Math.abs(el.currentTime - this.time) > 0.25) {
      el.currentTime = Math.max(0, Math.min(this.time, (el.duration || 1e9) - 0.05));
    }
    if (this.playing && el.paused) el.play().catch(() => {});
  }

  // ── 내부: 배경음악 ───────────────────────────────────
  setBgmElement(el) {
    try { this.bgmEl?.pause(); } catch { /* noop */ }
    this.bgmEl = el;
    this._syncBgm();
  }

  _syncBgm() {
    const bgm = project.audio.bgm;
    const el = this.bgmEl;
    if (!el || !bgm) return;
    el.loop = !!bgm.loop;
    const len = el.duration || bgm.buffer?.duration || 0;
    let pos = bgm.offset + this.time;
    if (len > 0) pos = bgm.loop ? pos % len : Math.min(pos, len - 0.05);
    if (isFinite(pos) && Math.abs(el.currentTime - pos) > 0.25) el.currentTime = Math.max(0, pos);
    el.volume = clamp(bgm.volume * bgmFadeGain(bgm, this.time, this.duration), 0, 1);
    if (this.playing && el.paused) el.play().catch(() => {});
  }
}

export function bgmFadeGain(bgm, t, total) {
  let g = 1;
  if (bgm.fadeIn > 0 && t < bgm.fadeIn) g = Math.min(g, t / bgm.fadeIn);
  if (bgm.fadeOut > 0 && t > total - bgm.fadeOut) g = Math.min(g, Math.max(0, (total - t) / bgm.fadeOut));
  return Math.max(0, g);
}
