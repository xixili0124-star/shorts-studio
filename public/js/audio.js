// 오디오 믹싱 — 클립 원본 소리 + 배경음악을 하나의 AudioBuffer 로 합친다.
import { Input, BlobSource, ALL_FORMATS, AudioBufferSink } from '../vendor/mediabunny.min.js';
import { project, clipDuration, totalDuration, buildLayout, clipFadeGain } from './state.js';

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

export function hasClipAudio() {
  return project.clips.some(c => c.type === 'video' && !c.muted && (c.volume ?? 1) > 0);
}

export function hasAnyAudio() {
  return Boolean(project.audio.bgm?.buffer) || hasClipAudio() || (project.audio.tracks || []).some(t => t.buffer && !t.muted);
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
export async function mixTimeline({ onProgress, signal, includeBgm = true, includeVoice = false } = {}) {
  const total = totalDuration();
  const wanted = includeBgm ? hasAnyAudio() : hasClipAudio() || (includeVoice && project.audio.tracks?.some(t => t.lane === 'voice' && !t.muted));
  if (total <= 0 || !wanted) return null;

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

    const at = buildLayout().entries.find(entry => entry.clip.id === clip.id)?.start || 0;
    const dur = clipDuration(clip);
    const node = ctx.createBufferSource();
    node.buffer = buf;

    const gain = ctx.createGain();
    const vol = (clip.volume ?? 1) * project.audio.originalVolume;
    applyFade(gain.gain, vol, at, dur, clip.fadeIn, clip.fadeOut, clip.fadeEnvelope);
    const e = buildLayout().entries.find(e => e.clip.id === clip.id);
    const crossfade = ctx.createGain();
    applyFade(crossfade.gain, 1, at, dur, e?.overlapIn || 0, e?.overlapOut || 0);
    node.connect(gain).connect(crossfade).connect(master);
    node.start(at, 0, Math.min(dur, buf.duration));
  }

  // 통합 소재함의 독립 오디오. 자동자막에는 사용자 선택 시 보이스만 포함합니다.
  for (const track of project.audio.tracks || []) {
    if (signal?.aborted) throw new DOMException('취소됨', 'AbortError');
    if (track.muted || !track.buffer || (!includeBgm && !(includeVoice && track.lane === 'voice'))) continue;
    const duration = Math.min(track.trimEnd - track.trimStart, total - track.start);
    if (!(duration > 0)) continue;
    const node = ctx.createBufferSource();
    node.buffer = track.buffer;
    const gain = ctx.createGain();
    applyFade(gain.gain, track.volume ?? 1, track.start, duration, track.fadeIn, track.fadeOut, track.fadeEnvelope);
    node.connect(gain).connect(master);
    node.start(track.start, track.trimStart, duration);
  }

  // 2) 배경음악
  // 음성 인식에 넘길 때는 빼고 부른다. 노래가 섞이면 알아듣는 정확도가 떨어진다.
  const bgm = includeBgm ? project.audio.bgm : null;
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

export function applyFade(param, volume, start, duration, fadeIn = 0, fadeOut = 0, envelope = null) {
  if (envelope) {
    const gainAt = t => clipFadeGain({ fadeEnvelope: envelope }, t, duration) * volume;
    const points = [...new Set([0, duration, -envelope.offset, envelope.duration-envelope.offset, Math.min(envelope.fadeIn, envelope.duration / 2) - envelope.offset,
      envelope.duration - Math.min(envelope.fadeOut, envelope.duration / 2) - envelope.offset])].filter(t => t >= 0 && t <= duration).sort((a,b) => a-b);
    param.setValueAtTime(gainAt(0), start);
    for (const point of points.slice(1)) param.linearRampToValueAtTime(gainAt(point), start + point);
    return;
  }
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

/**
 * 소리는 나는데 자막이 없는 구간을 찾는다.
 *
 * 말이 흐려지면 Whisper 가 그 구간을 아예 버리고 넘어간다. 틀린 자막이 생기는 게 아니라
 * 자막이 통째로 빠지는 것이라, 눈으로는 잘 안 보이고 다 들어봐야 알 수 있다.
 * 그래서 소리 크기만 보고 "여기 말이 있었는데 자막이 없다" 를 짚어 준다.
 */
export function findUncaptioned(buffer, captions, { minLen = 0.6, pad = 0.15 } = {}) {
  if (!buffer) return [];

  const win = Math.floor(buffer.sampleRate * 0.05);   // 50ms 단위로 본다
  const ch = buffer.getChannelData(0);
  const frames = Math.floor(ch.length / win);
  const rms = new Float32Array(frames);

  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const base = f * win;
    for (let i = 0; i < win; i += 4) {
      const v = ch[base + i];
      sum += v * v;
    }
    rms[f] = Math.sqrt(sum / (win / 4));
  }

  // 문턱값을 피크 기준으로 잡으면 안 된다. 웅얼거린 말은 또렷한 말보다 10배쯤 작아서
  // "피크의 몇 %" 로 자르면 정작 찾아야 할 구간이 통째로 묵음 처리된다.
  // 그래서 무음 바닥에서 살짝 올린 값을 쓰되, 시끄러운 녹음에서는 바닥을 따라 올린다.
  const sorted = Float32Array.from(rms).sort();
  const noise = sorted[Math.floor(sorted.length * 0.2)] || 0;
  const peak = sorted[Math.floor(sorted.length * 0.95)] || 0;
  if (peak < 0.01) return [];                      // 처음부터 조용한 파일
  const ABS_FLOOR = 0.004;                         // 대략 -48dBFS
  const gate = Math.min(
    Math.max(noise * 3, ABS_FLOOR),
    noise + (peak - noise) * 0.25,                 // 아무리 시끄러워도 이 위로는 안 올린다
  );

  // 소리가 나는 구간 묶기
  const loud = [];
  let start = -1;
  for (let f = 0; f < frames; f++) {
    if (rms[f] > gate) {
      if (start < 0) start = f;
    } else if (start >= 0) {
      loud.push([start * 0.05, f * 0.05]);
      start = -1;
    }
  }
  if (start >= 0) loud.push([start * 0.05, frames * 0.05]);

  // 짧은 끊김은 이어 붙인다 (말 사이 숨 쉬는 간격)
  const merged = [];
  for (const seg of loud) {
    const prev = merged[merged.length - 1];
    if (prev && seg[0] - prev[1] < 0.35) prev[1] = seg[1];
    else merged.push(seg);
  }

  // 자막이 덮고 있는 부분을 빼고 남는 곳
  const gaps = [];
  for (const [s, e] of merged) {
    let cursor = s;
    const covering = captions
      .filter(c => c.end > s && c.start < e)
      .sort((a, b) => a.start - b.start);
    for (const c of covering) {
      if (c.start - cursor > minLen) gaps.push([cursor, c.start]);
      cursor = Math.max(cursor, c.end);
    }
    if (e - cursor > minLen) gaps.push([cursor, e]);
  }

  return gaps.map(([s, e]) => ({
    start: Math.max(0, s - pad),
    end: e + pad,
  }));
}
