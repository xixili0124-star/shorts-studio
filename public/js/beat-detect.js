// 음악에서 컷 자리를 찾습니다.
//
// 목표는 음악 분석이 아니라 "어디서 자르면 리듬에 맞나" 하나입니다. 그래서 FFT 없이
// 짧은 구간의 에너지 변화만 봅니다. 숏츠에 쓰는 음악은 대개 타격이 뚜렷해서 이 정도로
// 충분하고, 외부 라이브러리를 들이지 않아도 됩니다.
//
// 순서는 세 단계입니다.
//   1) 에너지가 갑자기 커지는 지점(온셋)을 찾는다
//   2) 온셋이 반복되는 주기로 템포를 추정한다
//   3) 템포로 박자 격자를 만들고, 몇 박마다 자를지 정해 컷 자리를 낸다
//
// 모든 함수는 Float32Array 와 숫자만 받습니다. 브라우저 API 를 쓰지 않아 그대로 검사합니다.

export const ANALYSIS_RATE = 11025;   // 비트만 볼 것이므로 이 정도면 충분하고 빠릅니다
export const DEFAULT_HOP = 128;       // 11025Hz 에서 약 12ms. 박 간격을 정수로 떨어뜨리기에 충분합니다

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * 소리 세기 곡선을 만듭니다.
 * 에너지를 그대로 쓰면 큰 소리 구간이 전부를 덮으므로 로그로 눌러 담고,
 * 커지는 방향의 변화만 남깁니다. 작아지는 순간은 컷 자리가 아닙니다.
 */
export function onsetEnvelope(samples, sampleRate, { hop = DEFAULT_HOP } = {}) {
  if (!samples?.length || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error('분석할 소리를 읽지 못했습니다.');
  }
  const step = Math.max(1, Math.round(hop));
  const frames = Math.floor(samples.length / step);
  const flux = new Float32Array(Math.max(0, frames));
  let previous = 0;
  for (let f = 0; f < frames; f++) {
    const start = f * step, end = Math.min(samples.length, start + step);
    let sum = 0;
    for (let i = start; i < end; i++) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / Math.max(1, end - start));
    const level = Math.log10(1 + 1000 * rms);
    if (f > 0) flux[f] = Math.max(0, level - previous);
    previous = level;
  }
  return { flux, hopSeconds: step / sampleRate };
}

/**
 * 세기 곡선에서 튀는 지점을 고릅니다.
 * 고정 문턱값은 곡의 조용한 부분을 통째로 놓칩니다. 주변 구간의 평균과 흔들림을 보고
 * 그때그때 기준을 정합니다. 무음 분석에서 절대 문턱값을 쓴 것과 같은 이유입니다.
 */
export function pickOnsets(flux, hopSeconds, { sensitivity = 1.3, minGap = 0.12 } = {}) {
  if (!flux?.length || !Number.isFinite(hopSeconds) || hopSeconds <= 0) return [];
  const half = Math.max(2, Math.round(0.4 / hopSeconds));   // 좌우 0.4초를 주변으로 봅니다
  const gapFrames = Math.max(1, Math.round(minGap / hopSeconds));
  const times = [];
  let last = -Infinity;
  for (let f = 1; f < flux.length - 1; f++) {
    if (flux[f] <= flux[f - 1] || flux[f] < flux[f + 1]) continue;   // 봉우리만
    const from = Math.max(0, f - half), to = Math.min(flux.length, f + half + 1);
    let sum = 0, square = 0;
    for (let i = from; i < to; i++) { sum += flux[i];square += flux[i] * flux[i]; }
    const n = to - from, mean = sum / n;
    const deviation = Math.sqrt(Math.max(0, square / n - mean * mean));
    if (flux[f] < mean + sensitivity * deviation || flux[f] <= 0) continue;
    if (f - last < gapFrames) continue;
    last = f;
    times.push(f * hopSeconds);
  }
  return times;
}

/**
 * 온셋이 반복되는 주기로 템포를 추정합니다.
 * 세기 곡선을 자기 자신과 어긋나게 겹쳐 보고, 가장 잘 겹치는 간격을 한 박으로 봅니다.
 * 한 박과 두 박을 헷갈리는 경우가 흔하지만, 사용자가 "몇 박마다 자를지" 를 고르므로
 * 그 선택이 이 오차를 흡수합니다.
 */
export function estimateTempo(flux, hopSeconds, { minBpm = 60, maxBpm = 190 } = {}) {
  if (!flux?.length || !Number.isFinite(hopSeconds) || hopSeconds <= 0) return { bpm: 0, strength: 0 };
  const minLag = Math.max(1, Math.round(60 / maxBpm / hopSeconds));
  const maxLag = Math.min(flux.length - 1, Math.round(60 / minBpm / hopSeconds));
  if (maxLag <= minLag) return { bpm: 0, strength: 0 };
  // 자기상관만 보면 한 박과 두 박을 자주 헷갈립니다. 클릭이 0.5초 간격이면 1.0초로
  // 겹쳐 봐도 똑같이 잘 맞기 때문입니다. 사람이 박으로 느끼는 범위(120 근처)에 가중치를
  // 두어 고릅니다. 박자 추적기들이 쓰는 방법입니다.
  const preference = lag => {
    const bpm = 60 / (lag * hopSeconds);
    const octave = Math.log2(bpm / 120) / 0.9;
    return Math.exp(-0.5 * octave * octave);
  };
  const raw = new Float64Array(maxLag + 2);
  let total = 0, count = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let score = 0;
    for (let i = 0; i + lag < flux.length; i++) score += flux[i] * flux[i + lag];
    raw[lag] = score / (flux.length - lag);
    total += raw[lag];count++;
  }
  // 박 간격이 정수 프레임으로 딱 떨어지지 않으면 상관값이 이웃한 두 lag 으로 쪼개집니다.
  // 140 BPM 이 그런 경우였고, 쪼개진 탓에 절반 템포가 더 높아 보였습니다. 이웃을 함께 봅니다.
  const weighted = new Float64Array(maxLag + 1);
  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const merged = raw[lag] + 0.5 * ((raw[lag - 1] || 0) + (raw[lag + 1] || 0));
    weighted[lag] = merged * preference(lag);
    if (weighted[lag] > best) best = weighted[lag];
  }
  // 한 박과 그 배수는 똑같이 잘 겹칩니다. 0.4초 간격 타격은 0.8초로 겹쳐 봐도 다 맞습니다.
  // 그래서 가장 높은 값을 그냥 고르면 절반 템포로 떨어집니다. 잘 맞는 후보들 중
  // 가장 짧은 간격이 실제 한 박입니다. 그보다 짧은 간격은 애초에 맞지 않습니다.
  let bestLag = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (weighted[lag] >= best * 0.85) { bestLag = lag;break; }
  }
  if (!bestLag) return { bpm: 0, strength: 0 };
  // 봉우리 좌우를 보고 프레임 사이 값을 추정합니다. lag 이 정수라 생기는 오차를 줄입니다.
  const left = raw[bestLag - 1] || 0, centre = raw[bestLag], right = raw[bestLag + 1] || 0;
  const divisor = left - 2 * centre + right;
  const shift = divisor !== 0 ? clamp(0.5 * (left - right) / divisor, -0.5, 0.5) : 0;
  // 강도는 "고른 주기가 보통 주기보다 얼마나 더 잘 맞는가" 입니다. 고를 때 쓴 가중치는
  // 빼고 원래 값으로 재야 뜻이 있습니다. 반복이 없는 소리에서는 1 근처가 나옵니다.
  const average = total / Math.max(1, count);
  return {
    bpm: Math.round((60 / ((bestLag + shift) * hopSeconds)) * 10) / 10,
    strength: average > 0 ? Math.round(Math.min(4, raw[bestLag] / average) * 100) / 100 : 0,
  };
}

/**
 * 격자를 어디서 시작할지 고릅니다.
 * 박자 간격만 알고 시작점을 모르면 엇박에 자르게 됩니다. 한 박 안을 잘게 훑어
 * 격자 위에 세기가 가장 많이 얹히는 지점을 찾습니다.
 */
export function beatOffset(flux, hopSeconds, bpm, { steps = 32 } = {}) {
  if (!flux?.length || !(bpm > 0)) return 0;
  const period = 60 / bpm;
  const periodFrames = period / hopSeconds;
  if (!(periodFrames >= 1)) return 0;
  let bestOffset = 0, best = -1;
  for (let s = 0; s < steps; s++) {
    const offset = (s / steps) * periodFrames;
    let score = 0;
    for (let position = offset; position < flux.length; position += periodFrames) {
      score += flux[Math.round(position)] || 0;
    }
    if (score > best) { best = score;bestOffset = offset; }
  }
  return Math.round(bestOffset * hopSeconds * 1000) / 1000;
}

/** 박자 격자를 초 단위로 펼칩니다. */
export function beatGrid(bpm, offset, duration) {
  if (!(bpm > 0) || !(duration > 0)) return [];
  const period = 60 / bpm;
  const times = [];
  for (let t = Math.max(0, offset); t < duration - 1e-6 && times.length < 4000; t += period) {
    times.push(Math.round(t * 1000) / 1000);
  }
  return times;
}

/**
 * 컷 자리에서 템플릿 슬롯을 만듭니다.
 * every 는 몇 박마다 자를지입니다. 릴스에서 본 리듬은 두 박에 한 번이었습니다.
 * 너무 짧거나 긴 컷은 버리지 않고 범위 안으로 당깁니다. 리듬이 끊기는 편보다 낫습니다.
 */
export function slotsFromCuts(cutTimes, duration, { minSlot = 0.2, maxSlot = 8 } = {}) {
  const marks = [...new Set((cutTimes || []).filter(t => Number.isFinite(t) && t >= 0))].sort((a, b) => a - b);
  if (!(duration > 0) || !marks.length) return [];
  const bounded = marks.filter(t => t < duration - 1e-6);
  if (!bounded.length) return [];
  // 첫 컷 앞의 자투리는 슬롯으로 만들지 않습니다. 리듬이 시작하기 전 구간이라
  // 0.2 초짜리 토막만 남고, 템플릿을 적용하면 그 토막이 맨 앞에 붙습니다.
  const edges = [...bounded, duration];
  const lengths = [];
  for (let i = 0; i + 1 < edges.length; i++) lengths.push(edges[i + 1] - edges[i]);
  // 끝자락도 마찬가지입니다. 다른 컷의 절반에도 못 미치면 앞 컷에 흡수시킵니다.
  if (lengths.length > 1) {
    const sorted = [...lengths].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (lengths[lengths.length - 1] < median / 2) {
      const tail = lengths.pop();
      lengths[lengths.length - 1] += tail;
    }
  }
  return lengths.map(value => ({
    duration: Math.round(clamp(value, minSlot, maxSlot) * 1000) / 1000,
    speed: 1, transition: 'cut', transitionDuration: 0,
  }));
}

/**
 * 음악 한 곡에서 바로 컷 리듬을 냅니다. 위 단계를 묶은 것입니다.
 * every 가 0 이면 격자를 쓰지 않고 찾아낸 온셋 자리를 그대로 씁니다.
 */
export function rhythmFromSamples(samples, sampleRate, { every = 2, maxDuration = 0, sensitivity } = {}) {
  const { flux, hopSeconds } = onsetEnvelope(samples, sampleRate);
  const duration = maxDuration > 0 ? maxDuration : samples.length / sampleRate;
  const onsets = pickOnsets(flux, hopSeconds, sensitivity === undefined ? {} : { sensitivity });
  const tempo = estimateTempo(flux, hopSeconds);
  let cuts;
  if (every > 0 && tempo.bpm > 0) {
    const offset = beatOffset(flux, hopSeconds, tempo.bpm);
    cuts = beatGrid(tempo.bpm, offset, duration).filter((_, index) => index % every === 0);
  } else {
    cuts = onsets;
  }
  return { bpm: tempo.bpm, strength: tempo.strength, onsets, cuts, duration,
    slots: slotsFromCuts(cuts, duration) };
}
