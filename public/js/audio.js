// 오디오 믹싱 — 클립 원본 소리 + 배경음악을 하나의 AudioBuffer 로 합친다.
import { Input, BlobSource, ALL_FORMATS, AudioBufferSink } from '../vendor/mediabunny.min.js';
import { project, clipDuration, clipStartTime, totalDuration } from './state.js';

const RATE = 48000;

/** 배경음악 파일 디코딩 (mp3/wav/m4a 등) */
export async function decodeAudioFile(file) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  try {
    return await ctx.decodeAudioData(await file.arrayBuffer());
  } finally {
    ctx.close?.();
  }
}

export function hasAnyAudio() {
  if (project.audio.bgm?.buffer) return true;
  return project.clips.some(c => c.type === 'video' && !c.muted && (c.volume ?? 1) > 0);
}

/** 영상 클립에서 트림 구간만큼의 오디오를 뽑아 AudioBuffer 로 만든다 */
export async function extractClipAudio(clip, signal) {
  if (clip.type !== 'video' || clip.muted || !clip.file) return null;
  let input = null;
  try {
    input = new Input({ formats: ALL_FORMATS, source: new BlobSource(clip.file) });
    const track = await input.getPrimaryAudioTrack();
    if (!track) return null;
    if (track.canDecode && !(await track.canDecode())) return null;

    const dur = clipDuration(clip);
    const sink = new AudioBufferSink(track);
    let out = null, rate = 0, ch = 0;

    for await (const w of sink.buffers(clip.trimStart, clip.trimEnd)) {
      if (signal?.aborted) throw new DOMException('취소됨', 'AbortError');
      if (!w?.buffer) continue;
      if (!out) {
        rate = w.buffer.sampleRate;
        ch = Math.min(2, w.buffer.numberOfChannels);
        out = new AudioBuffer({
          length: Math.max(1, Math.ceil(dur * rate) + 1),
          numberOfChannels: ch,
          sampleRate: rate,
        });
      }
      const offset = Math.round((w.timestamp - clip.trimStart) * rate);
      for (let c = 0; c < ch; c++) {
        const src = w.buffer.getChannelData(Math.min(c, w.buffer.numberOfChannels - 1));
        let s = 0, d = offset;
        if (d < 0) { s = -d; d = 0; }
        const n = Math.min(src.length - s, out.length - d);
        if (n > 0) out.copyToChannel(src.subarray(s, s + n), c, d);
      }
    }
    return out;
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    console.warn('[audio] 추출 실패:', clip.name, e);
    return null;
  } finally {
    try { input?.dispose?.(); } catch { /* noop */ }
  }
}

/**
 * 타임라인 전체 오디오 믹스.
 * @returns {Promise<AudioBuffer|null>}
 */
export async function mixTimeline({ onProgress, signal } = {}) {
  const total = totalDuration();
  if (total <= 0 || !hasAnyAudio()) return null;

  const length = Math.ceil(total * RATE);
  const ctx = new OfflineAudioContext(2, length, RATE);
  const master = ctx.createGain();
  master.gain.value = 1;
  master.connect(ctx.destination);

  // 1) 클립 원본 소리
  const videoClips = project.clips.filter(c => c.type === 'video' && !c.muted && (c.volume ?? 1) > 0);
  for (let i = 0; i < videoClips.length; i++) {
    const clip = videoClips[i];
    onProgress?.(i / Math.max(1, videoClips.length), `소리 추출 중… (${i + 1}/${videoClips.length})`);
    const buf = await extractClipAudio(clip, signal);
    if (!buf) continue;

    const at = clipStartTime(project.clips.indexOf(clip));
    const dur = clipDuration(clip);
    const node = ctx.createBufferSource();
    node.buffer = buf;

    const gain = ctx.createGain();
    const vol = (clip.volume ?? 1) * project.audio.originalVolume;
    applyFade(gain.gain, vol, at, dur, clip.fadeIn, clip.fadeOut);

    node.connect(gain).connect(master);
    node.start(at, 0, Math.min(dur, buf.duration));
  }

  // 2) 배경음악
  const bgm = project.audio.bgm;
  if (bgm?.buffer) {
    onProgress?.(0.95, '배경음악 합치는 중…');
    const node = ctx.createBufferSource();
    node.buffer = bgm.buffer;
    if (bgm.loop) {
      node.loop = true;
      node.loopStart = 0;
      node.loopEnd = bgm.buffer.duration;
    }
    const gain = ctx.createGain();
    applyFade(gain.gain, bgm.volume, 0, total, bgm.fadeIn, bgm.fadeOut);
    node.connect(gain).connect(master);
    const offset = Math.min(Math.max(0, bgm.offset), Math.max(0, bgm.buffer.duration - 0.05));
    node.start(0, offset, total);
  }

  onProgress?.(1, '오디오 렌더링 중…');
  return ctx.startRendering();
}

function applyFade(param, volume, start, duration, fadeIn = 0, fadeOut = 0) {
  const end = start + duration;
  fadeIn = Math.min(fadeIn, duration / 2);
  fadeOut = Math.min(fadeOut, duration / 2);

  if (fadeIn > 0) {
    param.setValueAtTime(0.0001, start);
    param.linearRampToValueAtTime(volume, start + fadeIn);
  } else {
    param.setValueAtTime(volume, start);
  }
  if (fadeOut > 0) {
    param.setValueAtTime(volume, end - fadeOut);
    param.linearRampToValueAtTime(0.0001, end);
  }
}

/** 큰 AudioBuffer 를 초 단위 조각으로 잘라 준다 (인코더에 나눠 넣기 위함) */
export function sliceBuffer(buffer, from, seconds) {
  const rate = buffer.sampleRate;
  const start = Math.floor(from * rate);
  const len = Math.min(Math.floor(seconds * rate), buffer.length - start);
  if (len <= 0) return null;
  const out = new AudioBuffer({ length: len, numberOfChannels: buffer.numberOfChannels, sampleRate: rate });
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    out.copyToChannel(buffer.getChannelData(c).subarray(start, start + len), c, 0);
  }
  return out;
}
