// 소재에서 쓸 만한 구간 고르기.
//
// 템플릿이 "1.03초짜리 컷" 을 요구할 때, 30초짜리 원본의 어느 1.03초를 쓸지 정해야 합니다.
// 가운데를 쓰는 것이 기본이지만 가운데가 늘 좋지는 않습니다. 시작의 흔들림, 끝의 검은 화면,
// 손으로 가린 구간을 피하고 움직임과 결이 살아 있는 데를 고르는 편이 낫습니다.
//
// 점수는 세 가지를 봅니다.
//   결   — 화면 안의 밝기 차이. 민무늬 벽이나 초점 나간 화면은 낮습니다.
//   움직임 — 앞 프레임과 얼마나 달라졌는지. 정지 화면은 낮습니다.
//   노출  — 너무 어둡거나 하얗게 날아간 프레임은 감점합니다.
//
// 채점은 순수 계산입니다. 프레임을 읽는 일(sampleHighlights)만 브라우저가 필요합니다.

import { videoFrameReader, frameSampler } from './video-analysis.js';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = value => Number.isFinite(value) ? value : 0;

/** 회색조 한 장에서 평균 밝기와 결의 세기를 냅니다. */
export function frameStats(gray) {
  if (!gray?.length) return { mean: 0, detail: 0 };
  let sum = 0;
  for (let i = 0; i < gray.length; i++) sum += gray[i];
  const mean = sum / gray.length;
  let square = 0;
  for (let i = 0; i < gray.length; i++) { const d = gray[i] - mean;square += d * d; }
  return { mean, detail: Math.sqrt(square / gray.length) };
}

/** 두 회색조의 평균 절대 차이. 길이가 다르면 0 으로 봅니다. */
export function frameMotion(previous, current) {
  if (!previous?.length || !current?.length || previous.length !== current.length) return 0;
  let sum = 0;
  for (let i = 0; i < current.length; i++) sum += Math.abs(current[i] - previous[i]);
  return sum / current.length;
}

/**
 * 후보 구간마다 점수를 냅니다.
 * 결과는 [{ start, score }] 이며 samples 의 시각 위에서만 고릅니다.
 * 결과가 비면 고를 자리가 없다는 뜻이고, 부르는 쪽이 가운데로 되돌리면 됩니다.
 */
export function windowScores(samples, span, duration, {
  motionWeight = 1.2, darkFloor = 18, brightCeiling = 242, exposurePenalty = 1.5,
} = {}) {
  const list = (samples || []).filter(s => s && Number.isFinite(s.time)).sort((a, b) => a.time - b.time);
  if (!list.length || !(span > 0) || !(duration > 0) || span > duration) return [];
  // 두 값의 크기가 달라 그대로 더하면 한쪽이 전부를 정합니다. 각자 최대치로 나눠 맞춥니다.
  const maxDetail = Math.max(...list.map(s => finite(s.detail)), 1e-6);
  const maxMotion = Math.max(...list.map(s => finite(s.motion)), 1e-6);
  const scores = [];
  for (const candidate of list) {
    const start = candidate.time;
    if (start + span > duration + 1e-6) continue;
    // 구간은 [start, start+span) 입니다. 끝에 딱 걸친 표본은 다음 구간의 것입니다.
    const inside = list.filter(s => s.time >= start - 1e-9 && s.time < start + span - 1e-9);
    if (!inside.length) continue;
    let detail = 0, motion = 0, bad = 0;
    for (const s of inside) {
      detail += finite(s.detail) / maxDetail;
      motion += finite(s.motion) / maxMotion;
      const mean = finite(s.mean);
      if (mean < darkFloor || mean > brightCeiling) bad++;
    }
    const n = inside.length;
    const score = detail / n + motionWeight * (motion / n) - exposurePenalty * (bad / n);
    scores.push({ start: Math.round(start * 1000) / 1000, score: Math.round(score * 10000) / 10000, frames: n });
  }
  return scores;
}

/**
 * 가장 좋은 구간의 시작 시각. 고를 자리가 없으면 null 이고, 그때는 가운데를 씁니다.
 * 점수가 엇비슷하면 앞쪽을 고릅니다. 같은 소재를 여러 슬롯이 나눠 쓸 때 결과가
 * 실행마다 달라지지 않도록 하기 위해서입니다.
 */
export function bestWindowStart(samples, span, duration, options) {
  const scores = windowScores(samples, span, duration, options);
  if (!scores.length) return null;
  let best = scores[0];
  for (const entry of scores) if (entry.score > best.score + 1e-9) best = entry;
  return clamp(best.start, 0, Math.max(0, duration - span));
}

/**
 * 같은 소재를 여러 슬롯이 나눠 쓸 때, 매번 같은 구간을 주면 전부 똑같은 화면이 됩니다.
 * 이미 쓴 구간과 겹치지 않는 후보 중 가장 좋은 자리를 고릅니다. 남은 자리가 없으면
 * 겹침을 허용하고 그중 제일 좋은 데를 씁니다.
 */
export function nextWindowStart(samples, span, duration, used = [], options) {
  const scores = windowScores(samples, span, duration, options);
  if (!scores.length) return null;
  const overlaps = start => used.some(taken => start < taken + span - 1e-6 && taken < start + span - 1e-6);
  const free = scores.filter(entry => !overlaps(entry.start));
  const pool = free.length ? free : scores;
  let best = pool[0];
  for (const entry of pool) if (entry.score > best.score + 1e-9) best = entry;
  return clamp(best.start, 0, Math.max(0, duration - span));
}

/**
 * 영상에서 일정 간격으로 프레임을 읽어 채점 재료를 만듭니다.
 * 분석 전용 경로라 재생용 디코더와 섞이지 않습니다. 작은 크기로 읽어 빠르게 끝냅니다.
 */
export async function sampleHighlights(clip, { signal, maxSamples = 40, width = 160, onProgress } = {}) {
  // 소재에서 실제로 쓸 수 있는 구간만 봅니다. 시각은 그 구간의 시작을 0 으로 세어,
  // 템플릿이 쓰는 좌표와 같게 맞춥니다.
  const from = Number(clip?.trimStart) || 0;
  const to = Number.isFinite(clip?.trimEnd) ? clip.trimEnd : (Number(clip?.srcDuration) || 0);
  const duration = Math.max(0, to - from);
  if (!(duration > 0)) return [];
  const count = clamp(Math.round(maxSamples), 4, 120);
  const step = duration / count;
  const times = Array.from({ length: count }, (_, i) => Math.min(to - 1e-3, from + i * step));
  const reader = await videoFrameReader(clip, signal, { width });
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const samples = [];
  let previous = null, index = 0;
  try {
    for await (const frame of reader.sequence(times)) {
      const gray = frameSampler(frame, canvas, context, width);
      const { mean, detail } = frameStats(gray);
      samples.push({ time: Math.max(0, frame.time - from), mean, detail, motion: frameMotion(previous, gray) });
      previous = gray;
      onProgress?.(++index / count);
    }
  } finally { reader.close?.(); }
  return samples;
}
