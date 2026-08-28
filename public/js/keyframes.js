// 키 시각은 원본 영상 시각이 아니라 현재 클립의 시작을 0으로 하는 초입니다.
// 타임라인 이동은 값을 바꾸지 않고, 트림·분할은 경계를 보간한 뒤 원점을 옮깁니다.
export const KEYFRAME_LIMITS = Object.freeze({
  offsetX: [-3, 3], offsetY: [-3, 3], scaleX: [.05, 10], scaleY: [.05, 10],
  rotation: [-360, 360], opacity: [0, 1], volume: [0, 3],
});
export const KEYFRAME_CHANNELS = Object.freeze(Object.keys(KEYFRAME_LIMITS));
export const MAX_KEYFRAMES = 2400;
const DEFAULTS = { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, volume: 1 };
const EPSILON = 1e-6;
const MAX_TIME = 86400;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validTime = time => Number.isFinite(time) && time >= 0 && time <= MAX_TIME;
const easingOf = key => key?.easing === 'hold' ? 'hold' : 'linear';

export function validateKeyframes(data, duration = Infinity) {
  if (data === undefined) return true;
  if (!record(data) || data.version !== 1 || !record(data.tracks) || !(duration >= 0)) return false;
  if (Object.keys(data).some(key => !['version', 'tracks'].includes(key))) return false;
  let count = 0;
  for (const [channel, keys] of Object.entries(data.tracks)) {
    if (!own(KEYFRAME_LIMITS, channel) || !Array.isArray(keys) || !keys.length) return false;
    count += keys.length;
    if (count > MAX_KEYFRAMES) return false;
    const [minimum, maximum] = KEYFRAME_LIMITS[channel];
    if (!keys.every((key, index) => record(key) && validTime(key.time) && key.time <= duration + EPSILON
      && (!index || key.time - keys[index - 1].time > EPSILON)
      && Number.isFinite(key.value) && key.value >= minimum && key.value <= maximum
      && (key.easing === undefined || ['linear', 'hold'].includes(key.easing))
      && Object.keys(key).every(name => ['time', 'value', 'easing'].includes(name)))) return false;
  }
  return true;
}

export function hasKeyframes(item, channel) {
  return channel ? !!item?.keyframes?.tracks?.[channel]?.length
    : KEYFRAME_CHANNELS.some(name => !!item?.keyframes?.tracks?.[name]?.length);
}

function baseValue(item, channel) {
  const value = channel === 'volume' ? item?.volume : item?.transform?.[channel];
  return Number.isFinite(value) ? value : DEFAULTS[channel];
}

function leftIndex(keys, time) {
  let lo = 0, hi = keys.length - 1;
  while (lo < hi) {
    const middle = Math.ceil((lo + hi) / 2);
    if (keys[middle].time <= time) lo = middle; else hi = middle - 1;
  }
  return lo;
}

export function keyframeValue(item, channel, localTime = 0) {
  if (!own(KEYFRAME_LIMITS, channel)) throw new Error('지원하지 않는 키프레임 속성입니다.');
  const keys = item?.keyframes?.tracks?.[channel];
  if (!keys?.length) return baseValue(item, channel);
  const time = Number.isFinite(localTime) ? localTime : 0;
  if (time <= keys[0].time) return keys[0].value;
  const index = leftIndex(keys, time), first = keys[index], next = keys[index + 1];
  if (!next || easingOf(first) === 'hold') return first.value;
  const weight = Math.max(0, Math.min(1, (time - first.time) / (next.time - first.time)));
  return first.value + (next.value - first.value) * weight;
}

/** 평가 결과에는 키 데이터를 남기지 않아 불투명도 등을 두 번 적용하지 않습니다. */
export function evaluateItem(item, localTime = 0) {
  const { keyframes, ...result } = item;
  if (result.transform) result.transform = { ...result.transform };
  for (const channel of KEYFRAME_CHANNELS) {
    if (!keyframes?.tracks?.[channel]?.length) continue;
    const value = keyframeValue(item, channel, localTime);
    if (channel === 'volume') result.volume = value;
    else result.transform = { ...result.transform, [channel]: value };
  }
  return result;
}

function assertEdit(item, channel, time, value, duration = MAX_TIME) {
  if (!item || !own(KEYFRAME_LIMITS, channel) || !validTime(time) || !(duration >= 0) || time > duration + EPSILON
    || !validateKeyframes(item.keyframes)) throw new Error('키프레임의 속성이나 시각이 올바르지 않습니다.');
  if (value !== undefined) {
    const [minimum, maximum] = KEYFRAME_LIMITS[channel];
    if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error('키프레임 값이 허용 범위를 벗어났습니다.');
  }
}

export function setKeyframe(item, channel, localTime, value = keyframeValue(item, channel, localTime), options = {}) {
  assertEdit(item, channel, localTime, value, options.duration);
  const easing = options.easing ?? item.keyframes?.tracks?.[channel]?.find(key => Math.abs(key.time - localTime) <= EPSILON)?.easing ?? 'linear';
  if (!['linear', 'hold'].includes(easing)) throw new Error('지원하지 않는 보간 방식입니다.');
  const tracks = { ...item.keyframes?.tracks }, current = tracks[channel] || [];
  const key = { time: localTime, value, easing };
  tracks[channel] = [...current.filter(point => Math.abs(point.time - localTime) > EPSILON), key].sort((a, b) => a.time - b.time);
  const data = { version: 1, tracks };
  if (!validateKeyframes(data)) throw new Error('키프레임이 너무 많습니다. 클립을 나눠 주세요.');
  item.keyframes = data;
  return key;
}

export function removeKeyframe(item, channel, localTime) {
  assertEdit(item, channel, localTime);
  const old = item.keyframes?.tracks?.[channel];
  if (!old?.some(key => Math.abs(key.time - localTime) <= EPSILON)) return false;
  const tracks = { ...item.keyframes.tracks }, remaining = old.filter(key => Math.abs(key.time - localTime) > EPSILON);
  if (remaining.length) tracks[channel] = remaining; else delete tracks[channel];
  if (Object.keys(tracks).length) item.keyframes = { version: 1, tracks }; else delete item.keyframes;
  return true;
}

export function moveKeyframe(item, channel, from, to, options = {}) {
  assertEdit(item, channel, from);assertEdit(item, channel, to, undefined, options.duration);
  const key = item.keyframes?.tracks?.[channel]?.find(point => Math.abs(point.time - from) <= EPSILON);
  if (!key) return false;
  const tracks = { ...item.keyframes.tracks };
  // 같은 시각에 놓으면 두 값을 겹치지 않고 이동한 키로 교체합니다.
  tracks[channel] = [...tracks[channel].filter(point => Math.abs(point.time - from) > EPSILON && Math.abs(point.time - to) > EPSILON), { ...key, time: to }].sort((a, b) => a.time - b.time);
  item.keyframes = { version: 1, tracks };
  return true;
}

/** 이미 애니메이션인 속성만 현재 시각에 키를 만들고, 정적 속성은 기존처럼 수정합니다. */
export function setValueAt(item, channel, localTime, value, { autoKey = false, duration } = {}) {
  assertEdit(item, channel, localTime, value, duration);
  if (autoKey || hasKeyframes(item, channel)) return setKeyframe(item, channel, localTime, value, { duration });
  if (channel === 'volume') item.volume = value;
  else item.transform = { ...item.transform, [channel]: value };
  return value;
}

export function sliceKeyframes(item, from, to) {
  if (!item?.keyframes) return undefined;
  if (!validateKeyframes(item.keyframes) || !Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > MAX_TIME) throw new Error('키프레임을 자를 시간 범위가 올바르지 않습니다.');
  const tracks = {};
  for (const [channel, keys] of Object.entries(item.keyframes.tracks)) {
    const result = [];
    const append = key => { if (result.length && key.time - result.at(-1).time <= EPSILON) result[result.length - 1] = key; else result.push(key); };
    const boundary = time => ({ time: time - from, value: keyframeValue(item, channel, time), easing: easingOf(keys[leftIndex(keys, time)]) });
    // 원래 키 바깥은 이미 끝값을 유지하므로 불필요한 경계 키를 늘리지 않습니다.
    if (from > keys[0].time + EPSILON) append(boundary(from));
    for (const key of keys) if (key.time >= from - EPSILON && key.time <= to + EPSILON) {
      append({ ...key, time: Math.max(0, Math.min(to - from, key.time - from)) });
    }
    if (to < keys.at(-1).time - EPSILON) append(boundary(to));
    if (!result.length) append(boundary(from));
    tracks[channel] = result;
  }
  const result = Object.keys(tracks).length ? { version: 1, tracks } : undefined;
  if (!validateKeyframes(result, to - from)) throw new Error('자른 뒤 키프레임이 너무 많습니다. 불필요한 키를 정리해 주세요.');
  return result;
}

export function splitKeyframes(item, at, duration) {
  if (!Number.isFinite(at) || !Number.isFinite(duration) || at <= 0 || at >= duration) throw new Error('클립 안의 시각에서 분할해 주세요.');
  return { left: sliceKeyframes(item, 0, at), right: sliceKeyframes(item, at, duration) };
}
