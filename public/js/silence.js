// 원본 PCM의 모든 채널을 검사합니다. 볼륨·페이드·음소거는 무음 판정에 쓰지 않습니다.
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function complementRanges(ranges, duration) {
  const kept = [];
  let cursor = 0;
  for (const r of ranges) {
    if (r.start > cursor + 1e-7) kept.push({ start: cursor, end: r.start });
    cursor = Math.max(cursor, r.end);
  }
  if (cursor < duration - 1e-7) kept.push({ start: cursor, end: duration });
  return kept;
}

export function analyzeSilence(buffer, options = {}) {
  if (!buffer || !Number.isFinite(buffer.sampleRate) || buffer.sampleRate <= 0 || !buffer.length || !buffer.numberOfChannels) {
    throw new Error('분석할 소리를 읽지 못했습니다. 소리가 없는 파일을 무음으로 처리하지 않습니다.');
  }
  const thresholdDb = clamp(Number(options.thresholdDb ?? -38), -70, -10);
  const minSilence = clamp(Number(options.minSilence ?? .45), .1, 5);
  const padding = clamp(Number(options.padding ?? .1), 0, .5);
  const fps = clamp(Number(options.fps ?? 30), 1, 120);
  if (![thresholdDb, minSilence, padding, fps].every(Number.isFinite)) throw new Error('무음 분석 설정이 올바르지 않습니다.');
  const rate = buffer.sampleRate, duration = Math.min(buffer.length / rate, options.duration ?? Infinity), step = Math.max(1, Math.round(rate * .02));
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('분석 구간이 올바르지 않습니다.');
  const sampleLength = Math.min(buffer.length, Math.ceil(duration * rate));
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  const gate = 10 ** (thresholdDb / 20), levels = [], silent = [];
  let quietStart = null, peak = 0;
  for (let offset = 0; offset < sampleLength; offset += step) {
    const end = Math.min(sampleLength, offset + step);
    let level = 0;
    for (const channel of channels) {
      let sum = 0;
      for (let i = offset; i < end; i++) {
        if (!Number.isFinite(channel[i])) throw new Error('소리 데이터에 손상된 샘플이 있습니다.');
        sum += channel[i] ** 2;
      }
      level = Math.max(level, Math.sqrt(sum / (end - offset)));
    }
    levels.push(level);
    peak = Math.max(peak, level);
    if (level < gate && quietStart === null) quietStart = offset / rate;
    if (level >= gate && quietStart !== null) {
      silent.push({ start: quietStart, end: Math.min(duration, offset / rate) }); quietStart = null;
    }
  }
  if (quietStart !== null) silent.push({ start: quietStart, end: duration });
  const removed = [];
  for (const range of silent) {
    if (range.end - range.start < minSilence - 1e-7) continue;
    // 프레임 안쪽으로 반올림하여 말소리 쪽으로 삭제 범위를 넓히지 않습니다.
    const start = range.start <= 1e-7 ? 0 : Math.ceil((range.start + padding) * fps - 1e-7) / fps;
    const end = range.end >= duration - 1e-7 ? duration : Math.floor((range.end - padding) * fps + 1e-7) / fps;
    if (end - start >= 1 / fps - 1e-7) removed.push({ start, end });
  }
  if (removed.length > 200) throw new Error('한 번에 200개 구간까지 자를 수 있습니다. 클립을 나눠 분석해 주세요.');
  const kept = complementRanges(removed, duration);
  return { duration, thresholdDb, minSilence, padding, fps, levels, step: step / rate,
    removed, kept, removedDuration: removed.reduce((sum, r) => sum + r.end - r.start, 0),
    allSilent: peak < gate, peak };
}

/** 16kHz 등 분석용 PCM으로 낮춥니다. 반대 위상의 스테레오도 말소리를 잃지 않습니다. */
export function monoPcm(buffer, targetRate = 16000) {
  if (!buffer?.length || !Number.isInteger(buffer.numberOfChannels) || buffer.numberOfChannels < 1 || buffer.numberOfChannels > 32 || !Number.isFinite(buffer.sampleRate) || buffer.sampleRate <= 0 || !Number.isFinite(targetRate) || targetRate <= 0) throw new Error('인식할 소리 형식이 올바르지 않습니다.');
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  const ratio = buffer.sampleRate / targetRate, length = Math.max(1, Math.floor(buffer.length / ratio));
  const out = new Float32Array(length);
  const window = Math.max(1, Math.round(buffer.sampleRate * .02));
  let previousWindow = -1, strongest = channels[0];
  for (let i = 0; i < length; i++) {
    const start = i * ratio, end = Math.min(buffer.length, (i + 1) * ratio);
    const block = Math.floor(start / window);
    if (block !== previousWindow) {
      previousWindow = block;
      const energies = channels.map(channel => {
        let energy = 0;
        for (let j = block * window; j < Math.min(buffer.length, (block + 1) * window); j++) {
          if (!Number.isFinite(channel[j])) throw new Error('소리 데이터에 손상된 샘플이 있습니다.');
          energy += channel[j] ** 2;
        }
        return energy;
      });
      strongest = channels[energies.indexOf(Math.max(...energies))];
    }
    let sum = 0, weight = 0;
    for (let j = Math.floor(start); j < Math.ceil(end); j++) {
      const w = Math.min(j + 1, end) - Math.max(j, start);
      if (w > 0) { sum += (strongest[j] || 0) * w; weight += w; }
    }
    out[i] = weight ? sum / weight : 0;
  }
  return out;
}
