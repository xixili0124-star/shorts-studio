// 편집기의 재생용 디코더와 분리된 분석 전용 프레임 공급자입니다.
import { Input, BlobSource, ALL_FORMATS, CanvasSink } from '../vendor/mediabunny.min.js';
import { normalizedRect, MAX_TRACK_SECONDS, mergeTrackingKeys } from './mosaic.js';

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

export async function trackMosaic(clip, effect, seedTime, { signal, onProgress = () => {} } = {}) {
  if (clip.trimEnd - clip.trimStart > MAX_TRACK_SECONDS) throw new Error('추적은 클립당 3분까지 지원합니다. 필요한 구간으로 트림해 주세요.');
  const reader = await videoFrameReader(clip, signal);
  let worker;
  try { worker = new Worker(new URL('./mosaic-worker.js', import.meta.url), { type: 'module' }); }
  catch (error) { reader.close(); throw error; }
  const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });
  const ratio = Math.min(1, 320 / Math.max(clip.natW, clip.natH));
  canvas.width = Math.max(16, Math.round(clip.natW * ratio));canvas.height = Math.max(16, Math.round(clip.natH * ratio));
  let sequence = 0;
  const ask = (type, pixels, rect) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const cleanup = () => { clearTimeout(timer); worker.removeEventListener('message', message); worker.removeEventListener('error', error); signal?.removeEventListener('abort', cancel); };
    const message = e => { if (e.data.id !== id) return; cleanup(); e.data.error ? reject(new Error(e.data.error)) : resolve(e.data.result); };
    const error = () => { cleanup(); reject(new Error('추적 작업을 실행하지 못했습니다.')); };
    const cancel = () => { cleanup(); reject(new DOMException('취소됨', 'AbortError')); };
    const timer = setTimeout(error, 20000);
    worker.addEventListener('message', message);worker.addEventListener('error', error);signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) return cancel();
    worker.postMessage({ id, type, pixels, rect, width: canvas.width, height: canvas.height }, [pixels.buffer]);
  });
  const sample = async time => {
    const frame = await reader.frame(time);
    ctx.drawImage(frame.canvas, 0, 0, canvas.width, canvas.height);
    return { pixels: ctx.getImageData(0, 0, canvas.width, canvas.height).data, time: frame.time, duration: frame.duration };
  };
  try {
    const time = Math.max(clip.trimStart, Math.min(seedTime, clip.trimEnd - .00001));
    const seed = await sample(time), rect = normalizedRect(effect.rect);
    const keys = [{ ...rect, time: seed.time, duration: seed.duration, confidence: 1, lost: false, manual: true }];
    const maximum = Math.ceil((clip.trimEnd - clip.trimStart) * 10) + 2;
    let completed = 0;
    for (const direction of [-1, 1]) {
      await ask('reset', seed.pixels.slice(), rect);
      let previous = rect, lastTime = seed.time;
      const limit = direction < 0 ? clip.trimStart : clip.trimEnd - .00001;
      for (let n = 1; n <= maximum; n++) {
        aborted(signal);
        const target = direction < 0 ? Math.max(limit, time - n / 10) : Math.min(limit, time + n / 10);
        const current = await sample(target);
        if (Math.abs(current.time - lastTime) > 1e-6) {
          const result = await ask('step', current.pixels, previous);
          keys.push({ ...result, time: current.time, duration: current.duration });previous = result;lastTime = current.time;
          if (result.lost) {
            if (Math.abs(current.time - limit) > .000001) keys.push({ ...result, time: direction < 0 ? Math.max(0, limit) : clip.trimEnd, duration: current.duration });
            break;
          }
        }
        onProgress(Math.min(.99, ++completed / maximum), '원본에서 움직임 추적 중… ' + completed + ' / 약 ' + maximum + '프레임');
        if (target === limit) break;
      }
    }
    const unique = [...new Map(keys.sort((a,b) => a.time-b.time).map(k => [k.time.toFixed(6), k])).values()];
    const keyframes = mergeTrackingKeys(effect.mode === 'tracked' ? effect.keyframes : [], unique);
    onProgress(1, '추적 결과를 확인해 주세요.');
    return { ...effect, rect, mode: 'tracked', range: [clip.trimStart, clip.trimEnd], keyframes };
  } finally { worker.terminate();reader.close(); }
}
