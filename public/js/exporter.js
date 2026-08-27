// 내보내기 — WebCodecs(mediabunny)로 프레임을 직접 인코딩한다.
// 브라우저가 WebCodecs 인코딩을 못 하면 MediaRecorder 실시간 녹화로 자동 폴백.
import * as MB from '../vendor/mediabunny.min.js';
import { project, buildLayout, layersAt, totalDuration } from './state.js';
import { renderFrame, loadFonts } from './render.js';
import { mixTimeline, sliceBuffer } from './audio.js';
import { clamp } from './util.js';

const QUALITY = {
  'medium': () => MB.QUALITY_MEDIUM,
  'high': () => MB.QUALITY_HIGH,
  'very-high': () => MB.QUALITY_VERY_HIGH,
};

/** 이 브라우저에서 쓸 수 있는 내보내기 방식을 알아낸다 */
export async function detectEngine() {
  try {
    if (typeof VideoEncoder === 'undefined') return recorderEngine();

    for (const [container, Format, mime] of [
      ['mp4', MB.Mp4OutputFormat, 'video/mp4'],
      ['webm', MB.WebMOutputFormat, 'video/webm'],
    ]) {
      const format = new Format();
      const vList = order(format.getSupportedVideoCodecs(), ['avc', 'av1', 'vp9', 'hevc', 'vp8']);
      const videoCodec = await MB.getFirstEncodableVideoCodec(vList, { width: 1080, height: 1920 });
      if (!videoCodec) continue;
      const aList = order(format.getSupportedAudioCodecs(), ['aac', 'opus']);
      const audioCodec = await MB.getFirstEncodableAudioCodec(aList, { numberOfChannels: 2, sampleRate: 48000 });
      return {
        mode: 'webcodecs', container, Format, mime,
        ext: container, videoCodec, audioCodec,
        label: `${container.toUpperCase()} · ${videoCodec.toUpperCase()}${audioCodec ? ' + ' + audioCodec.toUpperCase() : ' (무음)'}`,
        ok: true,
      };
    }
    return recorderEngine();
  } catch (e) {
    console.warn('[export] 엔진 확인 실패', e);
    return recorderEngine();
  }
}

function recorderEngine() {
  const mime = pickRecorderMime();
  return {
    mode: 'recorder',
    container: mime.includes('mp4') ? 'mp4' : 'webm',
    ext: mime.includes('mp4') ? 'mp4' : 'webm',
    mime,
    label: '실시간 녹화 방식',
    ok: Boolean(mime),
  };
}

function order(available, preferred) {
  const set = new Set(available);
  return preferred.filter(c => set.has(c));
}

function pickRecorderMime() {
  const list = [
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  return list.find(m => window.MediaRecorder?.isTypeSupported?.(m)) || '';
}

/**
 * 타임라인 전체를 영상 파일로 만든다.
 * @returns {Promise<Blob>}
 */
export async function exportVideo({ engine, onProgress = () => {}, signal, player }) {
  const total = totalDuration();
  if (total <= 0) throw new Error('클립을 먼저 추가하세요.');
  await loadFonts({ signal });
  abortCheck(signal);

  if (engine.mode === 'recorder') {
    return recordFallback({ engine, onProgress, signal, player });
  }

  const { width, height, fps } = project;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });

  onProgress(0.01, '오디오 준비 중…');
  const mixed = await mixTimeline({
    onProgress: (p, msg) => onProgress(0.01 + p * 0.17, msg || '오디오 준비 중…'),
    signal,
  });
  abortCheck(signal);

  const output = new MB.Output({
    format: engine.container === 'mp4'
      ? new MB.Mp4OutputFormat({ fastStart: 'in-memory' })
      : new MB.WebMOutputFormat(),
    target: new MB.BufferTarget(),
  });

  const videoSource = new MB.CanvasSource(canvas, {
    codec: engine.videoCodec,
    quality: (QUALITY[project.quality] || QUALITY.high)(),
  });
  output.addVideoTrack(videoSource, { frameRate: fps });

  // 소리가 하나도 없어도 무음 트랙을 넣는다.
  // 인스타 릴스는 오디오 트랙이 아예 없는 파일을 처리하다 실패하는 경우가 있다.
  const audioBuffer = mixed || makeSilence(total);
  let audioSource = null;
  if (audioBuffer && engine.audioCodec) {
    audioSource = new MB.AudioBufferSource({
      codec: engine.audioCodec,
      quality: MB.QUALITY_HIGH,
    });
    output.addAudioTrack(audioSource);
  }

  await output.start();

  try {
    // ── 오디오 먼저 넣는다 (이미 다 계산돼 있으므로) ──
    if (audioSource && audioBuffer) {
      onProgress(0.19, mixed ? '소리 인코딩 중…' : '무음 트랙 넣는 중…');
      for (let t = 0; t < audioBuffer.duration; t += 2) {
        abortCheck(signal);
        const chunk = sliceBuffer(audioBuffer, t, 2);
        if (chunk) await audioSource.add(chunk);
      }
      audioSource.close();
    }

    // ── 프레임 ──
    const layout = buildLayout();
    const frameCount = Math.max(1, Math.ceil(total * fps - 1e-8));
    const providers = new Map();
    try {
      for (let f = 0; f < frameCount; f++) {
        abortCheck(signal);
        const t = f / fps;
        const layers = layersAt(t, layout);
        const sources = new Map();
        for (const at of layers) {
          const c = at.clip;
          if (c.type === 'image') {
            sources.set(c.id, { img: c.bitmap, w: c.natW, h: c.natH });
            continue;
          }
          let provider = providers.get(c.id);
          if (!provider) {
            provider = await videoProvider(at, fps);
            providers.set(c.id, provider);
          }
          const next = await provider.iterator.next();
          if (next.value && next.value !== provider.last) {
            provider.last?.close();
            provider.last = next.value;
          }
          const sample = provider.last;
          if (!sample) throw new Error(`${c.name}: 영상 프레임을 읽지 못했습니다.`);
          sources.set(c.id, { img: sample, w: sample.displayWidth, h: sample.displayHeight, draw: (context, ...args) => sample.draw(context, ...args) });
        }
        renderFrame(ctx, t, { layout, source: clip => sources.get(clip.id) });
        await videoSource.add(t, Math.min(1 / fps, total - t));
        for (const [id, provider] of providers) {
          if (provider.end <= t + 1 / fps) { await closeProvider(provider); providers.delete(id); }
        }
        if (f % 3 === 0 || f === frameCount - 1) onProgress(.2 + .78 * (f + 1) / frameCount, `영상 만드는 중… ${f + 1}/${frameCount} 프레임`);
        if (f % 6 === 0) await yieldToUi();
      }
    } finally {
      for (const provider of providers.values()) await closeProvider(provider);
    }

    onProgress(0.99, '파일 마무리 중…');
    await output.finalize();
    return new Blob([output.target.buffer], { type: engine.mime });
  } catch (e) {
    try { await output.cancel(); } catch { /* noop */ }
    throw e;
  }
}

async function videoProvider(at, fps) {
  const { clip } = at;
  const input = new MB.Input({ formats: MB.ALL_FORMATS, source: new MB.BlobSource(clip.file) });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error(`${clip.name}: 영상 트랙이 없습니다.`);
    const limit = Math.max(0, (clip.srcDuration || Infinity) - 1 / (fps * 2));
    const stamps = [];
    for (let n = Math.ceil(at.start * fps - 1e-8); n / fps < at.end - 1e-8; n++) {
      stamps.push(clamp(clip.trimStart + n / fps - at.start, 0, limit));
    }
    const sink = new MB.VideoSampleSink(track);
    return { input, iterator: sink.samplesAtTimestamps(stamps)[Symbol.asyncIterator](), last: null, end: at.end };
  } catch (e) {
    input.dispose?.();
    throw e;
  }
}

async function closeProvider(provider) {
  try { await provider.iterator.return?.(); } catch { /* 이미 종료된 디코더 */ }
  provider.last?.close();
  try { provider.input.dispose?.(); } catch { /* 이미 해제된 입력 */ }
}

/**
 * setTimeout(0) 은 백그라운드 탭에서 1초까지 늘어난다.
 * MessageChannel 은 스로틀링을 받지 않아서, 탭을 옮겨놔도 인코딩 속도가 그대로다.
 */
const channel = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null;
function yieldToUi() {
  if (!channel) return new Promise(r => setTimeout(r, 0));
  return new Promise(resolve => {
    channel.port1.onmessage = () => { channel.port1.onmessage = null; resolve(); };
    channel.port2.postMessage(0);
  });
}

/** 무음 스테레오 버퍼 (값이 0 으로 초기화되므로 채울 필요가 없다) */
function makeSilence(seconds) {
  if (!(seconds > 0)) return null;
  return new AudioBuffer({
    length: Math.ceil(seconds * 48000),
    numberOfChannels: 2,
    sampleRate: 48000,
  });
}

function abortCheck(signal) {
  if (signal?.aborted) throw new DOMException('사용자가 취소했습니다.', 'AbortError');
}

// ── 폴백: 미리보기를 실시간으로 녹화 ─────────────────────
async function recordFallback({ engine, onProgress, signal, player }) {
  if (!engine.mime) throw new Error('이 브라우저는 영상 내보내기를 지원하지 않습니다. 크롬이나 엣지를 사용해 주세요.');
  const total = totalDuration();

  onProgress(0.02, '오디오 준비 중…');
  const mixed = await mixTimeline({ onProgress: (p, m) => onProgress(0.02 + p * 0.1, m), signal });

  const stream = player.canvas.captureStream(project.fps);
  let actx = null;
  if (mixed) {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    const dest = actx.createMediaStreamDestination();
    const node = actx.createBufferSource();
    node.buffer = mixed;
    node.connect(dest);
    for (const tr of dest.stream.getAudioTracks()) stream.addTrack(tr);
    node.start();
  }

  const rec = new MediaRecorder(stream, { mimeType: engine.mime, videoBitsPerSecond: 10_000_000 });
  const chunks = [];
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };

  // 미리보기 소리는 끄고(이미 믹스에 들어있음) 처음부터 재생
  const muteState = project.clips.map(c => c.muted);
  project.clips.forEach(c => { if (c.el) c.el.muted = true; });
  const prevLoop = player.loop;
  player.pause();
  player.loop = false;
  player.seek(0);

  const stopped = new Promise(resolve => { rec.onstop = resolve; });
  rec.start(500);
  player.play();

  await new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (signal?.aborted) {
        clearInterval(timer);
        reject(new DOMException('사용자가 취소했습니다.', 'AbortError'));
        return;
      }
      onProgress(0.12 + 0.85 * (player.time / total), `실시간 녹화 중… ${player.time.toFixed(1)} / ${total.toFixed(1)}초`);
      if (!player.playing || player.time >= total - 0.05) {
        clearInterval(timer);
        resolve();
      }
    }, 100);
  }).finally(() => {
    player.pause();
    player.loop = prevLoop;
    project.clips.forEach((c, i) => { if (c.el) c.el.muted = muteState[i]; });
    try { actx?.close(); } catch { /* noop */ }
  });

  rec.stop();
  await stopped;
  onProgress(0.99, '파일 마무리 중…');
  return new Blob(chunks, { type: engine.mime.split(';')[0] });
}
