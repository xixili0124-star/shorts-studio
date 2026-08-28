// 편집기의 재생용 디코더와 분리된 분석 전용 프레임 공급자입니다.
import { Input, BlobSource, ALL_FORMATS, CanvasSink } from '../vendor/mediabunny.min.js';
import { normalizedRect, MAX_TRACK_SECONDS, MAX_TRACK_KEYS } from './mosaic.js';
import { createTargetTracker } from './browser-tracking.js';
import { createBrowserDetector } from './browser-tracking-client.js';
import { trackingError } from './browser-tracking-models.js';

const aborted = signal => { if (signal?.aborted) throw new DOMException('취소됨', 'AbortError'); };
function deadline(promise, signal, ms = 30000) {
  return new Promise((resolve, reject) => {
    const done = (fn, value) => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); fn(value); };
    const cancel = () => done(reject, new DOMException('취소됨', 'AbortError'));
    const timer = setTimeout(() => done(reject, new Error('영상 프레임을 읽는 시간이 초과됐습니다.')), ms);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) return cancel();
    promise.then(v => done(resolve, v), e => done(reject, e));
  });
}

export async function videoFrameReader(clip, signal) {
  aborted(signal);
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(clip.file) });
  try {
    const track = await deadline(input.getPrimaryVideoTrack(), signal);
    if (!track || (track.canDecode && !(await deadline(track.canDecode(), signal)))) throw new Error('이 영상의 프레임을 분석할 수 없습니다. H.264 MP4로 변환해 주세요.');
    const sink = new CanvasSink(track);
    return {
      async frame(time) {
        aborted(signal);
        const frame = await deadline(sink.getCanvas(Math.max(0, Math.min(time, clip.srcDuration - .00001))), signal);
        aborted(signal);
        if (!frame?.canvas || !Number.isFinite(frame.timestamp) || !Number.isFinite(frame.duration) || frame.duration <= 0) throw new Error('선택한 시각의 영상 프레임과 정확한 표시 시간을 읽지 못했습니다.');
        return { canvas: frame.canvas, time: frame.timestamp, duration: frame.duration };
      },
      close() { try { input.dispose(); } catch {} },
    };
  } catch (error) { try { input.dispose(); } catch {} throw error; }
}

function trackingRange(clip, rect, seedTime) {
  const duration = clip?.trimEnd - clip?.trimStart;
  if (clip?.type !== 'video' || !Number.isFinite(duration) || duration <= 0 || !Number.isFinite(clip.trimStart)
    || clip.trimStart < 0 || clip.trimEnd > 86400 || duration > MAX_TRACK_SECONDS)
    throw trackingError('INVALID_TRACKING_INPUT', '추적은 3분 이내의 영상 클립에서 사용할 수 있습니다. 필요한 구간으로 트림해 주세요.');
  if (!rect || !['x', 'y', 'w', 'h'].every(key => Number.isFinite(rect[key])) || rect.x < 0 || rect.y < 0
    || rect.w < .005 || rect.h < .005 || rect.x + rect.w > 1.000001 || rect.y + rect.h > 1.000001 || !Number.isFinite(seedTime))
    throw trackingError('INVALID_TRACKING_INPUT', '추적할 대상과 시작 프레임을 다시 지정해 주세요.');
  return { duration, seedTime: Math.max(clip.trimStart, Math.min(seedTime, clip.trimEnd - .000001)) };
}

function validFrame(frame) {
  if (!frame || !Number.isFinite(frame.time) || frame.time < 0 || !Number.isFinite(frame.duration) || frame.duration <= 0)
    throw trackingError('INVALID_FRAME', '영상 프레임의 정확한 표시 시간을 읽지 못했습니다.');
  return frame;
}

/** 실제 프레임 시각을 기록합니다. 검출 유실은 키로 남기며 다음 프레임도 계속 검사합니다. */
export async function analyzeTrackingFrames(clip, rect, seedTime, {
  readFrame, detectFrame, signal, onProgress = () => {}, task = 'mosaic',
}) {
  aborted(signal);
  const range = trackingRange(clip, rect, seedTime), time = range.seedTime;
  const seed = validFrame(await readFrame(time));aborted(signal);
  const detections = await detectFrame(seed, rect);aborted(signal);
  const initial = createTargetTracker(detections, rect, seed.time, { task }).initial;
  const keys = [{ ...initial, time: seed.time, duration: seed.duration }];
  const maximum = Math.ceil(range.duration * 10) + 3;
  let completed = 1, missed = 0;
  for (const direction of [-1, 1]) {
    const tracker = createTargetTracker(detections, rect, seed.time, { task });
    let lastTime = seed.time;
    const limit = direction < 0 ? clip.trimStart : clip.trimEnd - .000001;
    for (let n = 1; n <= maximum; n++) {
      aborted(signal);
      const target = direction < 0 ? Math.max(limit, time - n / 10) : Math.min(limit, time + n / 10);
      const current = validFrame(await readFrame(target));aborted(signal);
      if (Math.abs(current.time - lastTime) > .000001) {
        const detected = await detectFrame(current, tracker.rect);aborted(signal);
        const result = tracker.step(detected, current.time);
        keys.push({ ...result, time: current.time, duration: current.duration });lastTime = current.time;
        if (result.lost) missed++;
      }
      onProgress(Math.min(.99, ++completed / maximum), '검출 모델로 대상 연결 중… ' + completed + '프레임 · 유실 ' + missed);
      if (target === limit) break;
    }
  }
  const unique = [...new Map(keys.sort((a, b) => a.time - b.time).map(key => [key.time.toFixed(6), key])).values()];
  if (unique.length > MAX_TRACK_KEYS) throw trackingError('TRACKING_KEY_LIMIT', '추적 키가 너무 많습니다. 영상을 더 짧게 나눠 주세요.');
  return unique;
}

/** PC 응답 t는 이미 원본 시각입니다. trimStart를 다시 더하지 않습니다. */
export function pcTrackingKeys(raw, clip) {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_TRACK_KEYS)
    throw trackingError('INVALID_TRACKING_RESULT', 'PC 추적 결과가 비어 있거나 너무 큽니다.');
  const keys = raw.map(key => ({ x: key?.x, y: key?.y, w: key?.w, h: key?.h, time: key?.t, confidence: key?.confidence, lost: key?.lost,
    duration: key?.duration })).sort((a, b) => a.time - b.time);
  let lastConfirmed;
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index], next = keys[index + 1];
    if (!['x', 'y', 'w', 'h', 'time', 'confidence'].every(name => Number.isFinite(key[name]))
      || key.x < 0 || key.y < 0 || key.w <= 0 || key.h <= 0 || key.x + key.w > 1.000001 || key.y + key.h > 1.000001
      || key.time < 0 || key.time > 86400 || key.confidence < 0 || key.confidence > 1 || typeof key.lost !== 'boolean'
      || (next && next.time - key.time <= .000001))
      throw trackingError('INVALID_TRACKING_RESULT', 'PC 추적 결과의 좌표나 시각이 올바르지 않습니다.');
    // 먼 대상의 작은 분할 상자는 중심을 유지하며 최소 표시 크기까지 넓힙니다.
    // 유실 중 위치는 마지막 확인 상자를 유지하고 lost 자체는 절대 지우지 않습니다.
    const w = Math.max(.005, key.w), h = Math.max(.005, key.h);
    const rect = normalizedRect({ x: key.x + (key.w - w) / 2, y: key.y + (key.h - h) / 2, w, h });
    const position = key.lost && lastConfirmed ? lastConfirmed : rect;
    Object.assign(key, position);
    if (!key.lost) lastConfirmed = rect;
    if (key.duration === undefined) key.duration = next ? next.time - key.time : Math.max(.000001, clip.trimEnd - key.time);
    if (!Number.isFinite(key.duration) || key.duration <= 0 || key.duration > 86400)
      throw trackingError('INVALID_TRACKING_RESULT', 'PC 추적 결과의 프레임 길이가 올바르지 않습니다.');
  }
  return keys;
}

export async function trackMosaic(clip, effect, seedTime, {
  signal, onProgress = () => {}, engine = 'browser', task = 'mosaic', allowModelDownload = false,
} = {}) {
  aborted(signal);
  const range = trackingRange(clip, effect?.rect, seedTime), rect = normalizedRect(effect.rect);
  if (!['browser', 'pc'].includes(engine)) throw trackingError('INVALID_TRACKING_ENGINE', '지원하지 않는 추적 엔진입니다.');
  if (!['mosaic', 'crop'].includes(task)) throw trackingError('INVALID_TRACKING_TASK', '지원하지 않는 추적 종류입니다.');
  let keyframes;
  if (engine === 'pc') {
    const { trackPcVideo } = await import('./pc-tracking.js');aborted(signal);
    const result = await trackPcVideo(clip, rect, { seedTime: range.seedTime, signal, onProgress });aborted(signal);
    keyframes = pcTrackingKeys(result.keyframes, clip);
  } else {
    if (typeof document === 'undefined' || typeof createImageBitmap !== 'function')
      throw trackingError('BROWSER_UNSUPPORTED', '이 브라우저는 영상 프레임 분석을 지원하지 않습니다. 최신 Chrome/Safari 또는 PC 추적을 사용해 주세요.');
    let reader, detector;
    try {
      detector = await createBrowserDetector(task, { signal, allowModelDownload,
        onProgress: (value, message) => onProgress(value * .12, message) });
      reader = await videoFrameReader(clip, signal);
      const canvas = document.createElement('canvas'), context = canvas.getContext('2d');
      if (!context) throw trackingError('BROWSER_UNSUPPORTED', '분석용 캔버스를 만들 수 없습니다.');
      keyframes = await analyzeTrackingFrames(clip, rect, range.seedTime, {
        task, signal, readFrame: time => reader.frame(time),
        onProgress: (value, message) => onProgress(.12 + value * .87, message),
        async detectFrame(frame, selected) {
          aborted(signal);
          const width = frame.canvas.width, height = frame.canvas.height;
          if (!width || !height) throw trackingError('INVALID_FRAME', '분석할 영상 프레임이 비어 있습니다.');
          const ratio = Math.min(1, 1280 / Math.max(width, height));
          canvas.width = Math.max(1, Math.round(width * ratio));canvas.height = Math.max(1, Math.round(height * ratio));
          context.drawImage(frame.canvas, 0, 0, canvas.width, canvas.height);
          const bitmap = await createImageBitmap(canvas);
          if (signal?.aborted) { bitmap.close();aborted(signal); }
          return detector.detect(bitmap, selected);
        },
      });
    } finally { detector?.close();reader?.close(); }
  }
  aborted(signal);
  onProgress(1, keyframes.some(key => key.lost) ? '대상을 놓친 구간이 있습니다. 결과를 확인하고 다시 지정해 주세요.' : '추적 결과를 확인해 주세요.');
  // 새 모델이 놓친 위치를 예전 패턴 경로의 성공 키로 채우지 않습니다.
  return { ...effect, rect, mode: 'tracked', range: [clip.trimStart, clip.trimEnd], keyframes };
}
