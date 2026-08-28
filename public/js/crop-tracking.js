// 브라우저 물체 검출 또는 PC 분할 추적으로 고른 대상을 연결합니다.
// 실패 구간은 카메라 위치를 유지하고 경고하며, 저장 경로는 클립 안의 시각을 사용합니다.
import { normalizedRect, MAX_TRACK_SECONDS, MAX_TRACK_KEYS } from './mosaic.js';

export const MAX_CROP_TRACK_SECONDS = MAX_TRACK_SECONDS;
export const MAX_CROP_TRACK_KEYS = MAX_TRACK_KEYS;
const EPSILON = 1e-6;
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const aborted = signal => { if (signal?.aborted) throw new DOMException('취소됨', 'AbortError'); };
const validRect = rect => !!rect && ['x', 'y', 'w', 'h'].every(key => Number.isFinite(rect[key]))
  && rect.x >= 0 && rect.y >= 0 && rect.w >= .005 && rect.h >= .005
  && rect.x + rect.w <= 1 + EPSILON && rect.y + rect.h <= 1 + EPSILON;
const keyCopy = key => ({ time: key.time, x: key.x, y: key.y, w: key.w, h: key.h, confidence: key.confidence, lost: key.lost });

export function validCropTracking(data, duration = Infinity) {
  if (data === undefined) return true;
  return !!data && typeof data === 'object' && !Array.isArray(data) && data.version === 1
    && Object.keys(data).every(key => ['version', 'enabled', 'zoom', 'anchorX', 'anchorY', 'keys'].includes(key))
    && typeof data.enabled === 'boolean' && Number.isFinite(data.zoom) && data.zoom >= 1 && data.zoom <= 5
    && ['anchorX', 'anchorY'].every(key => Number.isFinite(data[key]) && data[key] >= 0 && data[key] <= 1)
    && Array.isArray(data.keys) && data.keys.length > 0 && data.keys.length <= MAX_CROP_TRACK_KEYS
    && duration >= 0 && data.keys.every((key, index, keys) => validRect(key)
      && Number.isFinite(key.time) && key.time >= 0 && key.time <= Math.min(86400, duration + EPSILON)
      && (!index || key.time - keys[index - 1].time > EPSILON)
      && Number.isFinite(key.confidence) && key.confidence >= 0 && key.confidence <= 1 && typeof key.lost === 'boolean'
      && Object.keys(key).every(name => ['time', 'x', 'y', 'w', 'h', 'confidence', 'lost'].includes(name)));
}

/** 가림 경계를 보간해 대상이 확인되지 않은 위치로 카메라가 흘러가지 않게 합니다. */
export function cropTrackingAt(item, localTime) {
  const data = item?.cropTracking;
  if (!data || data.enabled === false || !data.keys?.length) return null;
  const keys = data.keys, time = Number.isFinite(localTime) ? localTime : 0;
  let lo = 0, hi = keys.length - 1;
  while (lo < hi) { const middle = Math.ceil((lo + hi) / 2); if (keys[middle].time <= time) lo = middle; else hi = middle - 1; }
  const first = keys[lo], next = keys[lo + 1];
  if (time < keys[0].time - EPSILON || time > keys.at(-1).time + EPSILON) return { ...keyCopy(first), time, lost: true };
  if (!next || first.lost || next.lost) return { ...keyCopy(first), time, lost: first.lost || !!next?.lost && time > first.time + EPSILON };
  const weight = clamp((time - first.time) / (next.time - first.time), 0, 1);
  const rect = Object.fromEntries(['x', 'y', 'w', 'h'].map(key => [key, first[key] + (next[key] - first[key]) * weight]));
  return { ...rect, time, confidence: Math.min(first.confidence, next.confidence), lost: false };
}

/** geometry는 확대·맞춤을 마친 원본 영상의 사각형이며 변형 키프레임 적용 전입니다. */
export function cropTrackingGeometry(clip, localTime, geometry, W, H) {
  const point = cropTrackingAt(clip, localTime);
  if (!point || ![W, H, geometry.dx, geometry.dy, geometry.dw, geometry.dh].every(Number.isFinite) || W <= 0 || H <= 0 || geometry.dw <= 0 || geometry.dh <= 0) return geometry;
  const settings = clip.cropTracking, zoom = clamp(settings.zoom ?? 1.15, 1, 5);
  const dw = geometry.dw * zoom, dh = geometry.dh * zoom;
  const x = clamp(settings.anchorX ?? .5, 0, 1) * W - (point.x + point.w / 2) * dw;
  const y = clamp(settings.anchorY ?? .5, 0, 1) * H - (point.y + point.h / 2) * dh;
  return { ...geometry, dw, dh, dx: dw >= W ? clamp(x, W - dw, 0) : (W - dw) / 2, dy: dh >= H ? clamp(y, H - dh, 0) : (H - dh) / 2 };
}

export function cropTrackingWarnings(item) {
  const keys = item?.cropTracking?.keys || [];
  if (!keys.some(key => key.lost)) return [];
  return ['대상을 놓친 구간이 있습니다. 해당 구간은 마지막 확인 위치를 유지합니다. 가림이 끝난 지점에서 대상을 다시 지정하거나 위치 키프레임으로 보정해 주세요.'];
}

export function sliceCropTracking(item, from, to) {
  const data = item?.cropTracking;
  if (!data) return undefined;
  if (!validCropTracking(data) || !Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 86400) throw new Error('크롭 추적을 자를 시간 범위가 올바르지 않습니다.');
  // 비활성화해 둔 경로도 분할·트림 이후 원래 시각을 보존해야 합니다.
  const enabled = { cropTracking: { ...data, enabled: true } };
  const first = { ...cropTrackingAt(enabled, from), time: 0 }, last = { ...cropTrackingAt(enabled, to), time: to - from };
  const keys = [first, ...data.keys.filter(key => key.time > from + EPSILON && key.time < to - EPSILON).map(key => ({ ...key, time: key.time - from })), last];
  const result = { ...data, keys };
  if (!validCropTracking(result, to - from)) throw new Error('자른 뒤 추적 키가 너무 많습니다. 더 짧게 나눠 주세요.');
  return result;
}

export function splitCropTracking(item, at, duration) {
  if (!Number.isFinite(at) || !Number.isFinite(duration) || at <= 0 || at >= duration) throw new Error('클립 안의 시각에서 분할해 주세요.');
  return { left: sliceCropTracking(item, 0, at), right: sliceCropTracking(item, at, duration) };
}

/** 짧은 떨림만 줄입니다. 가림 구간과 수동으로 지정한 시작 영역은 섞지 않습니다. */
export function smoothCropKeys(keys, seconds = .15) {
  const window = clamp(Number(seconds) || 0, 0, 1);
  const result = keys.map((key, index) => {
    if (!window || key.lost || key.manual || !index || index === keys.length - 1
      || keys[index - 1].lost || keys[index + 1].lost) return keyCopy(key);
    const nearby = [key];
    for (const direction of [-1, 1]) {
      for (let i = index + direction; i >= 0 && i < keys.length; i += direction) {
        if (keys[i].lost || Math.abs(keys[i].time - key.time) >= window) break;
        nearby.push(keys[i]);
      }
    }
    const sums = { x: 0, y: 0, w: 0, h: 0 };let total = 0;
    for (const point of nearby) {
      const weight = 1 - Math.abs(point.time - key.time) / window;total += weight;
      for (const name of Object.keys(sums)) sums[name] += point[name] * weight;
    }
    return { ...keyCopy(key), ...normalizedRect(Object.fromEntries(Object.entries(sums).map(([name, value]) => [name, value / total]))) };
  });
  // 실패 지점은 추적기가 마지막으로 확인한 사각형을 그대로 보관합니다.
  return result;
}

function trackingData(keys, options = {}) {
  return {
    version: 1, enabled: true, zoom: options.zoom ?? 1.15,
    anchorX: options.anchorX ?? .5, anchorY: options.anchorY ?? .5,
    keys: smoothCropKeys(keys, options.smoothing ?? .15),
  };
}

function localKeys(sourceKeys, trimStart, trimEnd) {
  const duration = trimEnd - trimStart, keys = [];
  for (const source of [...sourceKeys].sort((a, b) => a.time - b.time)) {
    if (!validRect(source) || !Number.isFinite(source.time) || !Number.isFinite(source.confidence)
      || source.confidence < 0 || source.confidence > 1 || typeof source.lost !== 'boolean') throw new Error('추적 결과의 좌표나 시각이 올바르지 않습니다.');
    const key = { ...keyCopy(source), time: clamp(source.time - trimStart, 0, duration), manual: !!source.manual };
    if (keys.length && key.time - keys.at(-1).time <= EPSILON) keys[keys.length - 1] = key;
    else keys.push(key);
  }
  if (!keys.length) throw new Error('영상에서 추적할 프레임을 찾지 못했습니다.');
  if (keys[0].time > EPSILON) keys.unshift({ ...keys[0], time: 0, lost: true });
  else keys[0].time = 0;
  if (duration - keys.at(-1).time > EPSILON) {
    const lastSource = sourceKeys.reduce((last, key) => key.time > last.time ? key : last);
    const covered = Number.isFinite(lastSource.duration) && lastSource.time + lastSource.duration >= trimEnd - EPSILON;
    keys.push({ ...keys.at(-1), time: duration, lost: keys.at(-1).lost || !covered });
  } else keys[keys.length - 1].time = duration;
  return keys;
}

/** 실제 브라우저 분석은 모자이크와 같은 프레임 공급자·Web Worker를 사용합니다. */
export async function trackCrop(clip, rect, seedLocalTime = 0, options = {}) {
  const { signal, onProgress = () => {} } = options;aborted(signal);
  const duration = clip?.trimEnd - clip?.trimStart;
  if (clip?.type !== 'video' || !Number.isFinite(duration) || duration <= 0 || clip.trimStart < 0
    || duration > MAX_CROP_TRACK_SECONDS) throw new Error('크롭 추적은 3분 이내의 영상 클립에서 사용할 수 있습니다.');
  if (!validRect(rect)) throw new Error('추적할 대상을 충분한 크기의 사각형으로 선택해 주세요.');
  const seed = clip.trimStart + clamp(Number(seedLocalTime) || 0, 0, Math.max(0, duration - .00001));
  const analyze = options.analyze || (await import('./video-analysis.js')).trackMosaic;
  aborted(signal);
  const result = await analyze(clip, { rect: normalizedRect(rect), mode: 'static', keyframes: [] }, seed,
    { signal, onProgress, task: 'crop', engine: options.engine ?? 'browser', allowModelDownload: options.allowModelDownload === true });
  aborted(signal);
  const tracking = trackingData(localKeys(result.keyframes, clip.trimStart, clip.trimEnd), options);
  if (!validCropTracking(tracking, duration)) throw new Error('추적 경로가 올바르지 않습니다. 더 짧은 클립으로 다시 시도해 주세요.');
  return { tracking, warnings: cropTrackingWarnings({ cropTracking: tracking }) };
}
