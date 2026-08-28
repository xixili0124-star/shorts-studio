// 오디오 믹싱 — 클립 원본 소리 + 배경음악을 하나의 AudioBuffer 로 합친다.
import { Input, BlobSource, ALL_FORMATS, AudioBufferSink } from '../vendor/mediabunny.min.js';
import { project, clipDuration, totalDuration, buildLayout, clipFadeGain } from './state.js';
import { automateVolume, hasAudibleVolume } from './audio-gain.js';

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
  return project.clips.some(c => c.type === 'video' && !c.audioSeparated && !c.muted && hasAudibleVolume(c));
}

export function hasAnyAudio() {
  return Boolean(project.audio.bgm?.buffer)
    || Boolean(project.audio.narration?.buffer && !project.audio.narration.muted)
    || hasClipAudio()
    || (project.audio.tracks || []).some(t => t.buffer && !t.muted);
}

/** 영상 클립에서 트림 구간만큼의 오디오를 뽑아 AudioBuffer 로 만든다 */
export async function extractClipAudio(clip, signal, { ignoreMute = false, strict = false, allChannels = false, allowBoundaryGaps = false, allowMissingTrack = false, maxBytes = Infinity } = {}) {
  if (signal?.aborted) throw new DOMException('취소됨', 'AbortError');
  if (clip.type !== 'video' || (!ignoreMute && (clip.muted || clip.audioSeparated)) || !clip.file) return null;
  let input = null;
  const cancel = () => { try { input?.dispose(); } catch {} };
  try {
    input = new Input({ formats: ALL_FORMATS, source: new BlobSource(clip.file) });
    signal?.addEventListener('abort', cancel, { once: true });
    const track = await input.getPrimaryAudioTrack();
    if (!track) { if (strict && !allowMissingTrack) throw new Error('선택한 영상에는 오디오 트랙이 없습니다.'); return null; }
    if (track.canDecode && !(await track.canDecode())) { if (strict) throw new Error('이 브라우저에서 영상의 오디오 코덱을 읽을 수 없습니다.'); return null; }

    let coverageStart = clip.trimStart, coverageEnd = clip.trimEnd;
    if (strict && allowBoundaryGaps) {
      const [first, end] = await Promise.all([track.getFirstTimestamp(), track.computeDuration()]);
      if (!Number.isFinite(first) || !Number.isFinite(end)) throw new Error('오디오의 시작·끝 시각을 확인하지 못했습니다.');
      coverageStart = Math.max(clip.trimStart, first, 0);coverageEnd = Math.min(clip.trimEnd, end);
      if (coverageEnd <= coverageStart) { if (allowMissingTrack) return null;throw new Error('선택한 구간에는 오디오가 없습니다.'); }
    }

    const dur = clip.trimEnd - clip.trimStart;
    const sink = new AudioBufferSink(track);
    let out = null, rate = 0, ch = 0, covered = 0;

    for await (const w of sink.buffers(clip.trimStart, clip.trimEnd)) {
      if (signal?.aborted) throw new DOMException('취소됨', 'AbortError');
      if (!w?.buffer) continue;
      if (!out) {
        rate = w.buffer.sampleRate;
        ch = Math.min(allChannels ? 32 : 2, w.buffer.numberOfChannels);
        const length = Math.max(1, Math.ceil(dur * rate));
        if (!Number.isSafeInteger(length) || length * ch * 4 > maxBytes) throw new Error('소리를 분리하기에 영상이 너무 깁니다. 필요한 구간을 잘라서 가져와 주세요.');
        covered = Math.max(0, Math.round((coverageStart - clip.trimStart) * rate));
        out = new AudioBuffer({
          length,
          numberOfChannels: ch,
          sampleRate: rate,
        });
      }
      if (strict && (w.buffer.sampleRate !== rate || Math.min(allChannels ? 32 : 2, w.buffer.numberOfChannels) !== ch)) throw new Error('중간에 오디오 형식이 바뀌어 정확히 분석할 수 없습니다.');
      const offset = Math.round((w.timestamp - clip.trimStart) * rate);
      if (strict && offset > covered + 1) throw new Error('오디오를 읽지 못한 구간이 있습니다. 무음으로 간주하지 않고 분석을 중단합니다.');
      covered = Math.max(covered, offset + w.buffer.length);
      for (let c = 0; c < ch; c++) {
        const src = w.buffer.getChannelData(Math.min(c, w.buffer.numberOfChannels - 1));
        let s = 0, d = offset;
        if (d < 0) { s = -d; d = 0; }
        const n = Math.min(src.length - s, out.length - d);
        if (n > 0) out.copyToChannel(src.subarray(s, s + n), c, d);
      }
    }
    if (signal?.aborted) throw new DOMException('취소됨', 'AbortError');
    if (strict && (!out || covered < (coverageEnd - clip.trimStart) * rate - 1)) throw new Error('선택 구간의 오디오를 끝까지 읽지 못했습니다.');
    return out;
  } catch (e) {
    if (signal?.aborted) throw new DOMException('취소됨', 'AbortError');
    if (e?.name === 'AbortError' || strict) throw e;
    console.warn('[audio] 추출 실패:', clip.name, e);
    return null;
  } finally {
    signal?.removeEventListener('abort', cancel);
    try { input?.dispose?.(); } catch { /* noop */ }
  }
}

/**
 * 타임라인 전체 오디오 믹스.
 * @returns {Promise<AudioBuffer|null>}
 */
export async function mixTimeline({ onProgress, signal, includeBgm = true, includeVoice = false, strictSources = false } = {}) {
  if (signal?.aborted) throw new DOMException('취소됨', 'AbortError');
  const total = totalDuration();
  const tracks = (project.audio.tracks || []).filter(track => !track.muted
    && (includeBgm || (includeVoice && ((track.role || track.lane) === 'voice' || track.sourceVideoAudio === true))));
  const narration = (includeBgm || includeVoice) && !project.audio.narration?.muted
    ? project.audio.narration : null;
  // 내레이션도 보이스 선택을 따른다. 선택한 원본이 없으면 엄격 모드에서 알려준다.
  const wanted = hasClipAudio() || (includeBgm && Boolean(project.audio.bgm?.buffer))
    || Boolean(narration && (narration.buffer || strictSources))
    || tracks.some(track => track.buffer || strictSources);
  if (total <= 0 || !wanted) return null;

  const length = Math.ceil(total * RATE);
  const ctx = new OfflineAudioContext(2, length, RATE);
  const master = ctx.createGain();
  master.gain.value = 1;
  master.connect(ctx.destination);

  // 1) 클립 원본 소리
  const videoClips = project.clips.filter(c => c.type === 'video' && !c.audioSeparated && !c.muted && hasAudibleVolume(c));
  for (let i = 0; i < videoClips.length; i++) {
    const clip = videoClips[i];
    onProgress?.(i / Math.max(1, videoClips.length), `소리 추출 중… (${i + 1}/${videoClips.length})`);
    let buf;
    if (strictSources && !clip.file) throw new Error((clip.name || '영상') + ': 원본 파일을 찾지 못해 자막 인식을 중단했습니다.');
    try { buf = await extractClipAudio(clip, signal, { strict: strictSources, allowBoundaryGaps: strictSources, allowMissingTrack: true }); }
    catch (error) { if (error.name === 'AbortError') throw error;throw new Error((clip.name || '영상') + ': ' + error.message); }
    if (!buf) continue;

    const at = buildLayout().entries.find(entry => entry.clip.id === clip.id)?.start || 0;
    const dur = clipDuration(clip);
    const node = ctx.createBufferSource();
    node.buffer = buf;

    const gain = ctx.createGain();
    automateVolume(gain.gain,clip,at,dur,project.audio.originalVolume);
    const envelope=ctx.createGain();
    applyFade(envelope.gain,1,at,dur,clip.fadeIn,clip.fadeOut,clip.fadeEnvelope);
    const e = buildLayout().entries.find(e => e.clip.id === clip.id);
    const crossfade = ctx.createGain();
    applyFade(crossfade.gain, 1, at, dur, e?.overlapIn || 0, e?.overlapOut || 0);
    node.connect(gain).connect(envelope).connect(crossfade).connect(master);
    node.start(at, 0, Math.min(dur, buf.duration));
  }

  // 통합 소재함의 독립 오디오. 자동자막에는 사용자 선택 시 보이스만 포함합니다.
  for (const track of tracks) {
    if (signal?.aborted) throw new DOMException('취소됨', 'AbortError');
    if (!track.buffer) { if (strictSources) throw new Error((track.name || '오디오') + ': 소리를 읽지 못해 자막 인식을 중단했습니다.');continue; }
    const duration = Math.min(track.trimEnd - track.trimStart, total - track.start);
    if (!(duration > 0)) continue;
    const node = ctx.createBufferSource();
    node.buffer = track.buffer;
    const gain = ctx.createGain();
    automateVolume(gain.gain,track,track.start,duration);
    const envelope=ctx.createGain();
    applyFade(envelope.gain,1,track.start,duration,track.fadeIn,track.fadeOut,track.fadeEnvelope);
    node.connect(gain).connect(envelope).connect(master);
    node.start(track.start, track.trimStart, duration);
  }

  // 내레이션은 독립 오디오 클립과 별도로 0초부터 한 번만 재생한다.
  if (narration) {
    if (!narration.buffer) {
      if (strictSources) throw new Error((narration.name || '내레이션') + ': 소리를 읽지 못해 자막 인식을 중단했습니다.');
    } else {
      const node = ctx.createBufferSource();
      node.buffer = narration.buffer;
      const gain = ctx.createGain();
      gain.gain.value = Math.min(1, Math.max(0, narration.volume ?? 1));
      node.connect(gain).connect(master);
      node.start(0, 0, Math.min(total, narration.buffer.duration));
    }
  }

  // 배경음악
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
