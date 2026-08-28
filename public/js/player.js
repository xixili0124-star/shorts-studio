// 미리보기 재생기 — <video> 엘리먼트를 타임라인에 맞춰 몰고 다니면서 캔버스에 그린다.
import { project, layersAt, totalDuration, clipFadeGain } from './state.js';
import { renderFrame } from './render.js';
import { clamp } from './util.js';
import { PreviewAudioGain, volumeAt } from './audio-gain.js';
const tracksVisualSubject=clip=>!!(clip?.cropTracking&&clip.cropTracking.enabled!==false)||!!clip?.mosaics?.some(m=>m.enabled!==false&&m.mode==='tracked');

export class Player {
  constructor(canvas, { onTick, onAudioError } = {}) {
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
    this.previewMuted = false;
    this.previewGain = new PreviewAudioGain(onAudioError);
    this.trackElements = new Map();
    // undo는 클립 데이터를 교체하므로 비동기 디코더 상태는 sink에 연결합니다.
    this.sinkStates = new WeakMap();
    this.presentedTimes = new WeakMap();
    this.presentedFrames = new WeakMap();
    this.watchedVideos = new WeakSet();

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
    if (el.requestVideoFrameCallback && !this.watchedVideos.has(el)) {
      this.watchedVideos.add(el);
      const remember = (_, meta) => {
        this.presentedTimes.set(el, meta.mediaTime);
        const current = project.clips.find(c => c.el === el);
        if (!current) { this.watchedVideos.delete(el); return; }
        if (tracksVisualSubject(current)) {
          this.rememberPresentedFrame(el, el, meta.mediaTime);
        }
        if (!this.playing) this.draw();
        el.requestVideoFrameCallback(remember);
      };
      el.requestVideoFrameCallback(remember);
    }
    if (tracksVisualSubject(clip)) {
      const held = this.presentedFrames.get(el);
      if (held) return { img: held.canvas, w: held.canvas.width, h: held.canvas.height, sourceTime: held.time };
      return { img: el, w: el.videoWidth, h: el.videoHeight, timeReliable: false };
    }
    return { img: el, w: el.videoWidth, h: el.videoHeight,
      sourceTime: this.presentedTimes.get(el) ?? el.currentTime,
      timeReliable: !el.seeking };
  };

  // 프레임 픽셀과 시각을 함께 복사합니다. 원본 video의 뒤늦은 이동과 섞지 않습니다.
  rememberPresentedFrame(el, source, time) {
    let held = this.presentedFrames.get(el);
    if (!held) { held = { canvas: document.createElement('canvas') };this.presentedFrames.set(el, held); }
    const width = source.videoWidth || source.width, height = source.videoHeight || source.height;
    if (held.canvas.width !== width || held.canvas.height !== height) { held.canvas.width = width;held.canvas.height = height; }
    held.canvas.getContext('2d').drawImage(source, 0, 0);held.time = time;
  }

  /**
   * <video> 로 못 여는 파일용 — 디코더에서 프레임을 하나씩 받아 온다.
   * 비동기라서, 도착할 때까지는 직전 프레임을 계속 보여준다.
   */
  _sinkSource(clip, t) {
    const held = this._sinkState(clip).frame;
    const tracked = tracksVisualSubject(clip);
    const covers = held && (Number.isFinite(held.duration) && held.duration > 0
      ? t >= held.t - 1e-6 && t <= held.t + held.duration + 1e-6 : Math.abs(held.t - t) <= .06);
    if (!covers || (tracked && !held.owned)) this._requestSinkFrame(clip, t);
    return held ? { img: held.canvas, w: held.canvas.width, h: held.canvas.height, sourceTime: held.t, timeReliable: !tracked || !!held.owned } : null;
  }

  _sinkState(clip) {
    let state=this.sinkStates.get(clip.sink);
    if(!state){state={frame:null,pending:false,queued:null};this.sinkStates.set(clip.sink,state);}
    return state;
  }

  _requestSinkFrame(clip, t) {
    const state=this._sinkState(clip);
    if (state.pending) { state.queued = t; return; }   // 한 번에 하나만
    state.pending = true;
    clip.sink.getCanvas(t)
      .then(w => {
        if (!w) return;
        const current = project.clips.find(c => c.id === clip.id && c.sink === clip.sink);
        if (tracksVisualSubject(current)) {
          const canvas = document.createElement('canvas');canvas.width = w.canvas.width;canvas.height = w.canvas.height;
          canvas.getContext('2d').drawImage(w.canvas, 0, 0);
          state.frame = { t: w.timestamp, duration: w.duration, canvas, owned: true };
        } else state.frame = { t: w.timestamp, duration: w.duration, canvas: w.canvas };
      })
      .catch(() => { /* 디코딩 실패한 지점은 직전 프레임 유지 */ })
      .finally(() => {
        state.pending = false;
        const next = state.queued;
        state.queued = null;
        if (next != null) this._requestSinkFrame(clip, next);
        else if (!this.playing) this.draw();
      });
  }

  draw() {
    renderFrame(this.ctx, this.time, { source: this.source, safeArea: this.safeArea, selection: this.playing || this.selectionOverlay ? null : this.selection });
    this.onDraw?.();
  }

  /** 상태가 바뀌었을 때 정지 상태에서도 한 프레임 다시 그린다 */
  invalidate() {
    if (!this.playing) {
      this._syncVideos(true);
      this._syncBgm();
      this._syncNarration();
      this._syncTracks();
      this.draw();
      this.onTick(this.time);
    }
  }

  // ── 이동 ─────────────────────────────────────────────
  seek(t, { redraw = true, allowBeyond = false } = {}) {
    this.time = clamp(t, 0, allowBeyond ? 86400 : Math.max(0, this.duration - 0.001));
    if (this.playing) {
      this._startWall = performance.now() / 1000;
      this._startTime = this.time;
    }
    this._syncVideos(!this.playing);
    this._syncBgm();
    this._syncNarration();
    this._syncTracks();
    if (redraw) this.draw();
    this.onTick(this.time);
  }

  step(frames) {
    this.pause();
    this.seek(this.time + frames / project.fps, { allowBeyond: true });
  }

  // ── 재생 ─────────────────────────────────────────────
  play() {
    this.previewGain.resume().catch(error=>this.previewGain.report(error));
    if (this.playing || this.duration <= 0) return;
    if (this.time >= this.duration) this.time = 0;
    this.playing = true;
    this._startWall = performance.now() / 1000;
    this._startTime = this.time;
    this._syncBgm();
    this._syncNarration();
    this._syncTracks();
    this.bgmEl?.play().catch(() => {});
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
      this._syncBgm();
      this._syncNarration();
      this._syncTracks();
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
    try { this.narrationEl?.pause(); } catch { /* 이미 해제된 요소 */ }
    for (const el of this.trackElements.values()) el.pause();
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  // ── 내부: 비디오 동기화 ──────────────────────────────
  _syncVideos(exact) {
    const active = new Map(layersAt(this.time).map(at => [at.clip.id, at]));

    for (const c of project.clips) {
      if (c.type !== 'video' || !c.el) continue;
      const at = active.get(c.id);
      if (!at) {
        if (!c.el.paused) c.el.pause();
        continue;
      }
      const want = c.trimStart + at.local;
      // 분리된 원음은 별도 오디오 클립만 재생합니다. 영상 음소거를 풀어도 중복되지 않습니다.
      c.el.muted = !!c.audioSeparated || !!c.muted || this.previewMuted;
      this.previewGain.set(c.el,c.audioSeparated ? 0 : volumeAt(c,at.local)*project.audio.originalVolume*at.weight*clipFadeGain(c,at.local,at.duration));

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
    try { this.narrationEl?.pause(); } catch { /* 이미 해제된 요소 */ }
    this.narrationEl = el;
    this._syncNarration();
  }

  // 내레이션은 0초부터 재생하고, 끝난 뒤 마지막 부분을 반복하지 않는다.
  _syncNarration() {
    const n = project.audio.narration;
    const el = this.narrationEl;
    if (!el) return;
    if (!n) { el.pause(); return; }
    el.loop = false;
    el.volume = clamp(n.volume ?? 1, 0, 1);
    el.muted = this.previewMuted || !!n.muted;
    const duration = Number.isFinite(n.buffer?.duration) ? n.buffer.duration : el.duration;
    if (!Number.isFinite(duration) || duration <= 0) { el.pause(); return; }
    const wanted = clamp(this.time, 0, duration);
    if (Math.abs(el.currentTime - wanted) > (this.playing ? .2 : .02)) el.currentTime = wanted;
    if (!this.playing || n.muted || this.time < 0 || this.time >= duration) { el.pause(); return; }
    if (el.paused) el.play().catch(() => {});
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
    el.muted = this.previewMuted;
    if (this.playing && el.paused) el.play().catch(() => {});
  }

  _syncTracks() {
    const tracks = project.audio.tracks || [];
    const ids = new Set(tracks.map(t => t.id));
    for (const [id, el] of this.trackElements) {
      if (!ids.has(id)) { el.pause(); this.previewGain.disconnect(el);this.trackElements.delete(id); }
    }
    for (const track of tracks) {
      const el = track.el;
      if (!el) continue;
      this.trackElements.set(track.id, el);
      const duration = track.trimEnd - track.trimStart;
      const local = this.time - track.start;
      if (local < 0 || local >= duration || track.muted) { el.pause(); continue; }
      const desired = track.trimStart + local;
      if (Math.abs(el.currentTime - desired) > (this.playing ? .2 : .02)) el.currentTime = desired;
      el.muted = this.previewMuted || !!track.muted;
      this.previewGain.set(el,volumeAt(track,local)*clipFadeGain(track,local,duration));
      if (this.playing && el.paused) el.play().catch(() => {});
      if (!this.playing && !el.paused) el.pause();
    }
  }
}

export function bgmFadeGain(bgm, t, total) {
  let g = 1;
  if (bgm.fadeIn > 0 && t < bgm.fadeIn) g = Math.min(g, t / bgm.fadeIn);
  if (bgm.fadeOut > 0 && t > total - bgm.fadeOut) g = Math.min(g, Math.max(0, (total - t) / bgm.fadeOut));
  return Math.max(0, g);
}
