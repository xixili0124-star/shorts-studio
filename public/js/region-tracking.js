// 검출기 없이, 사용자가 그린 상자 안의 픽셀 무늬만으로 대상을 따라갑니다.
//
// 왜 따로 만들었나
//   기존 모자이크 추적은 얼굴 검출기(BlazeFace)에 묶여 있어 얼굴이 아니면 시작조차
//   되지 않았고, 한 번 놓치면 locked 로 잠겨 끝까지 유실이었습니다. 가림 뒤에 같은
//   사람임을 위치만으로 증명할 수 없다는 판단이었는데, 사용자가 직접 고른 사물을
//   따라가는 용도에서는 그 잠금이 곧 기능 실패입니다.
//
// 무엇으로 따라가나
//   대상을 잘라 24×24 밝기 패치로 만들고(평균 0, 표준편차 1로 정규화),
//   다음 프레임에서 예상 위치 둘레를 여러 크기로 훑어 정규화 상관(NCC)이 가장 높은
//   자리를 고릅니다. 밝기를 정규화하므로 조명이 조금 변해도 견딥니다.
//
// 가림을 어떻게 넘기나
//   점수가 낮으면 템플릿을 그대로 둔 채 그 프레임만 유실로 표시하고, 예측 위치를
//   이어가며 탐색 범위를 넓힙니다. 다시 점수가 충분히 높아지면 재연결합니다.
//   재연결 문턱은 평소 문턱보다 높습니다. 엉뚱한 곳에 붙는 쪽이 잠깐 못 따라가는
//   것보다 나쁘기 때문입니다. 유실 구간은 lost 로 남아 화면의 주황 점선과
//   타임라인의 빨간 마커로 그대로 드러납니다.

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

export const TEMPLATE_SIZE = 20;
/**
 * 절대 문턱은 "이 밑은 무늬가 아니라 우연"이라는 바닥값입니다.
 * 실제 영상에서는 잘 맞는 프레임도 0.58~0.77 정도로 나옵니다. 고정 문턱을 높게 두면
 * 한 프레임만 놓쳐도 다시는 그 문턱을 넘지 못해 영영 유실로 남습니다.
 * 그래서 실제로 맞아 온 점수의 이동평균(baseline)에 비례해 문턱을 함께 움직입니다.
 */
export const ACCEPT_SCORE = .42;
/** 놓친 뒤 다시 붙을 때 더 엄격하게 봅니다. 잘못 붙는 쪽이 잠깐 못 따라가는 것보다 나쁩니다. */
export const REACQUIRE_SCORE = .5;
/** 이어 갈 때와 다시 붙을 때, 그동안 맞아 온 점수의 몇 할을 요구할지입니다. */
export const KEEP_RATIO = .72;
export const REACQUIRE_RATIO = .88;
/**
 * 이 시간까지는 놓쳐도 예측 위치로 계속 가립니다.
 * 손이 스쳐 지나가는 정도(10Hz 에서 두어 프레임)에 모자이크가 깜빡 꺼지면 오히려
 * 사고입니다. 대상이 그 사이에 순간이동하지는 않으므로 속도로 이어 갑니다.
 */
export const COAST_SECONDS = .5;
/** 이보다 오래 못 찾으면 포기합니다. */
export const MAX_GAP_SECONDS = 5;
/** 무늬가 서서히 변해도 따라가되, 가려진 프레임으로는 절대 갱신하지 않습니다. */
export const TEMPLATE_UPDATE_SCORE = .82;
const TEMPLATE_UPDATE_RATE = .12;

/** 평균 0 · 표준편차 1 로 맞춥니다. 밝기와 대비가 변해도 같은 무늬로 읽힙니다. */
export function normalizePatch(values) {
  const patch = Float32Array.from(values);
  if (!patch.length) return null;
  let sum = 0;
  for (const value of patch) { if (!Number.isFinite(value)) return null;sum += value; }
  const mean = sum / patch.length;
  let variance = 0;
  for (let i = 0; i < patch.length; i++) { patch[i] -= mean;variance += patch[i] * patch[i]; }
  const deviation = Math.sqrt(variance / patch.length);
  // 완전한 단색은 따라갈 무늬가 없습니다. 어디에나 들어맞아 엉뚱한 곳에 붙습니다.
  if (!(deviation > 1e-4)) return null;
  for (let i = 0; i < patch.length; i++) patch[i] /= deviation;
  return patch;
}

/** 정규화된 두 패치의 상관값(-1~1)입니다. 1 이면 같은 무늬입니다. */
export function patchScore(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return -1;
  let total = 0;
  for (let i = 0; i < a.length; i++) total += a[i] * b[i];
  return clamp(total / a.length, -1, 1);
}

/** 예상 위치 둘레를 훑을 후보 사각형입니다. 놓친 횟수만큼 범위와 크기 폭을 넓힙니다. */
export function searchCandidates(rect, { misses = 0, steps = 6, radius: given, scales: fixed } = {}) {
  const span = Math.max(rect.w, rect.h);
  const radius = Number.isFinite(given) ? given : Math.min(.5, span * (.55 + misses * .5));
  const scales = fixed || (misses ? [.78, .9, 1, 1.12, 1.28] : [.9, 1, 1.11]);
  const candidates = [];
  for (const scale of scales) {
    const w = clamp(rect.w * scale, .01, 1), h = clamp(rect.h * scale, .01, 1);
    for (let iy = -steps; iy <= steps; iy++) for (let ix = -steps; ix <= steps; ix++) {
      const x = rect.x + (rect.w - w) / 2 + radius * ix / steps;
      const y = rect.y + (rect.h - h) / 2 + radius * iy / steps;
      if (x < -1e-9 || y < -1e-9 || x + w > 1 + 1e-9 || y + h > 1 + 1e-9) continue;
      candidates.push({ x: clamp(x, 0, 1 - w), y: clamp(y, 0, 1 - h), w, h });
    }
  }
  return candidates;
}

/**
 * frame 은 sample(rect) 로 정규화된 밝기 패치를 돌려주는 것이면 됩니다.
 * 캔버스든 시험용 가짜든 상관없이 같은 방식으로 동작합니다.
 */
export function createRegionTracker(frame, rect, seedTime, { onWarn } = {}) {
  const template = frame?.sample?.(rect);
  if (!template) {
    const error = new Error('선택한 영역에 따라갈 무늬가 없습니다. 무늬나 색이 뚜렷한 부분을 조금 더 넓게 지정해 주세요.');
    error.code = 'REGION_TEMPLATE_EMPTY';throw error;
  }
  if (!Number.isFinite(seedTime)) {
    const error = new Error('추적 시작 시각이 올바르지 않습니다.');error.code = 'INVALID_TRACKING_INPUT';throw error;
  }
  let model = Float32Array.from(template);
  let last = { ...rect }, lastTime = seedTime, sampleTime = seedTime, direction = 0;
  let velocity = { x: 0, y: 0 }, misses = 0, gap = 0, done = false;
  // 이 영상에서 실제로 맞아 온 점수입니다. 문턱은 이 값을 따라 움직입니다.
  // 1 로 시작하면 첫 프레임부터 0.72 를 요구해 시작하자마자 놓치고, 놓치면 갱신도
  // 되지 않아 영영 돌아오지 못합니다. 처음에는 절대 바닥값만 요구합니다.
  let baseline = ACCEPT_SCORE / KEEP_RATIO;
  let output = { ...rect, confidence: 1, lost: false }, seeded = false;
  const lose = () => { output = { ...output, confidence: 0, lost: true, coasting: false };return { ...output }; };
  return {
    initial: { ...output, manual: true },
    get rect() { return { ...last }; },
    get stats() { return { misses, gap, done }; },
    step(next, time) {
      if (!Number.isFinite(time)) {
        const error = new Error('추적 프레임의 시각이 올바르지 않습니다.');error.code = 'INVALID_DETECTION';throw error;
      }
      const change = time - sampleTime;
      if (Math.abs(change) < 1e-6) return { ...output };
      if (!direction) direction = Math.sign(change);
      if (Math.sign(change) !== direction) {
        const error = new Error('추적 프레임의 순서가 바뀌었습니다.');error.code = 'INVALID_DETECTION';throw error;
      }
      sampleTime = time;
      if (done) return lose();
      const elapsed = Math.abs(time - lastTime);
      const predicted = {
        x: clamp(last.x + velocity.x * Math.min(elapsed, .4), 0, 1 - last.w),
        y: clamp(last.y + velocity.y * Math.min(elapsed, .4), 0, 1 - last.h),
        w: last.w, h: last.h,
      };
      // 성기게 훑어 자리를 잡고, 그 둘레만 촘촘히 다시 봅니다.
      // 한 번에 촘촘히 훑으면 프레임당 후보가 500개를 넘어 실제 영상에서 너무 느립니다.
      const pick = list => {
        let found = null;
        for (const candidate of list) {
          const score = patchScore(model, next?.sample?.(candidate));
          if (!found || score > found.score) found = { rect: candidate, score };
        }
        return found;
      };
      let best = pick(searchCandidates(predicted, { misses, steps: 3 }));
      // 성긴 격자만으로는 위치가 매 프레임 조금씩 어긋나고, 그 오차가 쌓이면 점수가
      // 문턱 아래로 떨어져 멀쩡한 대상을 놓칩니다. 범위를 줄여 가며 세 번 더 좁힙니다.
      let radius = Math.max(predicted.w, predicted.h) * (.55 + misses * .5) / 3;
      for (let pass = 0; best && pass < 3 && radius > 1e-3; pass++) {
        const closer = pick(searchCandidates(best.rect, { steps: 2, radius,
          scales: pass ? [1] : [.95, 1, 1.06] }));
        if (closer && closer.score > best.score) best = closer;
        radius /= 2.5;
      }
      const needed = misses
        ? Math.max(REACQUIRE_SCORE, baseline * REACQUIRE_RATIO)
        : Math.max(ACCEPT_SCORE, baseline * KEEP_RATIO);
      if (!best || best.score < needed) {
        // elapsed 는 이미 "마지막으로 확인한 프레임 이후" 이므로 더하면 두 배로 불어납니다.
        misses++;gap = elapsed;
        if (gap <= COAST_SECONDS) {
          // 잠깐 스친 정도는 예측 위치로 계속 가립니다. 여기서 꺼지면 그게 더 사고입니다.
          output = { ...predicted, confidence: 0, lost: false, coasting: true };
          return { ...output };
        }
        if (gap > MAX_GAP_SECONDS) { done = true;onWarn?.('gave-up', gap); }
        return lose();
      }
      const before = { x: last.x + last.w / 2, y: last.y + last.h / 2 };
      const after = { x: best.rect.x + best.rect.w / 2, y: best.rect.y + best.rect.h / 2 };
      if (misses) onWarn?.('reacquired', gap);
      // 가려졌다 돌아온 직후에는 속도를 믿을 수 없으므로 새로 시작합니다.
      velocity = misses ? { x: 0, y: 0 } : {
        x: clamp(velocity.x * .45 + (after.x - before.x) / Math.max(elapsed, .001) * .55, -1, 1),
        y: clamp(velocity.y * .45 + (after.y - before.y) / Math.max(elapsed, .001) * .55, -1, 1),
      };
      if (!misses && best.score >= TEMPLATE_UPDATE_SCORE) {
        const fresh = next.sample(best.rect);
        if (fresh) for (let i = 0; i < model.length; i++) {
          model[i] = model[i] * (1 - TEMPLATE_UPDATE_RATE) + fresh[i] * TEMPLATE_UPDATE_RATE;
        }
      }
      baseline = seeded ? baseline * .8 + best.score * .2 : best.score;seeded = true;
      last = { ...best.rect };lastTime = time;misses = 0;gap = 0;
      output = { ...best.rect, confidence: clamp(best.score, 0, 1), lost: false };
      return { ...output };
    },
  };
}
