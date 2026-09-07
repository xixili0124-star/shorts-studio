// 검출기 없는 픽셀 추적기 검사. 합성 장면으로 이동·가림·재연결·포기를 확인합니다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeTrackingKeys } from '../public/js/mosaic.js';
import { normalizePatch, patchScore, searchCandidates, createRegionTracker,
  TEMPLATE_SIZE, ACCEPT_SCORE, REACQUIRE_SCORE, MAX_GAP_SECONDS, COAST_SECONDS } from '../public/js/region-tracking.js';

/** 대상 안에서만 뚜렷한 무늬가 나오고, 밖은 완만한 배경입니다. */
function scene({ target, hidden = false }) {
  const pattern = (u, v) => Math.sin(u * 17.3) * 40 + Math.cos(v * 11.7) * 40 + Math.sin((u + v) * 29) * 30 + 128;
  const background = (x, y) => 90 + x * 12 + y * 8;
  const pixel = (x, y) => {
    if (!hidden && x >= target.x && x < target.x + target.w && y >= target.y && y < target.y + target.h) {
      return pattern((x - target.x) / target.w, (y - target.y) / target.h);
    }
    return background(x, y);
  };
  return {
    sample(rect) {
      const values = new Float32Array(TEMPLATE_SIZE * TEMPLATE_SIZE);
      for (let j = 0; j < TEMPLATE_SIZE; j++) for (let i = 0; i < TEMPLATE_SIZE; i++) {
        values[j * TEMPLATE_SIZE + i] = pixel(rect.x + (i + .5) / TEMPLATE_SIZE * rect.w,
          rect.y + (j + .5) / TEMPLATE_SIZE * rect.h);
      }
      return normalizePatch(values);
    },
  };
}
const box = (x, y, size = .2) => ({ x, y, w: size, h: size });

test('a flat area has no pattern to follow and is refused instead of latching anywhere', () => {
  assert.equal(normalizePatch(new Float32Array(16).fill(7)), null);
  assert.equal(normalizePatch([]), null);
  assert.equal(normalizePatch([1, NaN, 3]), null);
  const flat = { sample: () => null };
  assert.throws(() => createRegionTracker(flat, box(.4, .4), 0), /무늬가 없습니다/);
  const patch = normalizePatch([0, 1, 2, 3]);
  assert.ok(Math.abs(patch.reduce((s, v) => s + v, 0)) < 1e-6, '평균은 0 입니다');
  assert.equal(patchScore(patch, patch).toFixed(5), '1.00000');
  assert.ok(patchScore(patch, normalizePatch([3, 2, 1, 0])) < -.9, '뒤집힌 무늬는 음수입니다');
  assert.equal(patchScore(patch, null), -1);
  assert.equal(patchScore(patch, normalizePatch([1, 2])), -1, '길이가 다르면 비교하지 않습니다');
});

test('search widens and offers more sizes after a miss but never leaves the frame', () => {
  const near = searchCandidates(box(.4, .4), { misses: 0 });
  const far = searchCandidates(box(.4, .4), { misses: 3 });
  assert.ok(far.length > near.length, '놓치면 더 넓게 훑습니다');
  const spread = list => Math.max(...list.map(r => r.x)) - Math.min(...list.map(r => r.x));
  assert.ok(spread(far) > spread(near));
  for (const list of [near, far, searchCandidates(box(0, 0, .05)), searchCandidates(box(.95, .95, .04))]) {
    for (const r of list) {
      assert.ok(r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.w <= 1 + 1e-9 && r.y + r.h <= 1 + 1e-9,
        '화면 밖 후보는 만들지 않습니다');
    }
  }
});

test('the tracker follows a moving object without any detector', () => {
  const path = time => box(.2 + time * .06, .35 + time * .02);
  const tracker = createRegionTracker(scene({ target: path(0) }), path(0), 0);
  let worst = 1;
  for (let n = 1; n <= 20; n++) {
    const time = n / 10, truth = path(time);
    const result = tracker.step(scene({ target: truth }), time);
    assert.equal(result.lost, false, `${time}초에서 놓쳤습니다`);
    worst = Math.min(worst, result.confidence);
    assert.ok(Math.abs(result.x - truth.x) < .05 && Math.abs(result.y - truth.y) < .05,
      `${time}초 위치가 벗어났습니다: ${JSON.stringify(result)}`);
  }
  assert.ok(worst >= ACCEPT_SCORE);
});

test('a brief occlusion is reported as lost and the object is picked up again afterwards', () => {
  const path = time => box(.25 + time * .05, .4);
  const seen = [];
  const tracker = createRegionTracker(scene({ target: path(0) }), path(0), 0, { onWarn: (kind) => seen.push(kind) });
  const lost = [];
  for (let n = 1; n <= 24; n++) {
    const time = n / 10, truth = path(time);
    // 0.7~1.3초 사이에 대상이 가려집니다.
    const hidden = time > .65 && time < 1.35;
    const result = tracker.step(scene({ target: truth, hidden }), time);
    if (result.lost) lost.push(Number(time.toFixed(1)));
    if (!hidden && time > 1.6) {
      assert.equal(result.lost, false, `${time}초에 다시 따라가야 합니다`);
      assert.ok(Math.abs(result.x - truth.x) < .06, `${time}초 재연결 위치가 벗어났습니다`);
    }
  }
  assert.ok(lost.length >= 2, '오래 가린 구간은 유실로 남습니다');
  assert.ok(lost.every(t => t >= .7 && t <= 1.6), '가리지 않은 구간까지 버리지 않습니다: ' + lost.join(','));
  assert.ok(seen.includes('reacquired'), '다시 붙었음을 알립니다');
  assert.ok(!seen.includes('gave-up'));
});

test('a hand brushing past does not blink the mosaic off', () => {
  const path = time => box(.25 + time * .05, .4);
  const tracker = createRegionTracker(scene({ target: path(0) }), path(0), 0);
  const marks = [];
  for (let n = 1; n <= 12; n++) {
    const time = n / 10, truth = path(time);
    // 0.4~0.6초, 세 프레임만 손이 스쳐 지나갑니다.
    const hidden = time > .35 && time < .65;
    const result = tracker.step(scene({ target: truth, hidden }), time);
    marks.push({ time: Number(time.toFixed(1)), lost: result.lost, coasting: !!result.coasting,
      off: Math.abs(result.x - truth.x) });
  }
  const brushed = marks.filter(m => m.time >= .4 && m.time <= .6);
  assert.ok(brushed.length >= 3);
  assert.ok(brushed.every(m => !m.lost), '스치는 동안 모자이크가 꺼지면 안 됩니다: ' + JSON.stringify(brushed));
  assert.ok(brushed.every(m => m.coasting), '가린 동안은 예측으로 이어 간 것임을 표시합니다');
  assert.ok(brushed.every(m => m.off < .06), '예측 위치가 크게 벗어나면 안 됩니다');
  assert.ok(marks.filter(m => m.time > .7).every(m => !m.lost), '지나간 뒤에는 다시 실제로 따라갑니다');
});

test('a long disappearance gives up instead of latching onto something else', () => {
  const start = box(.3, .3);
  const warns = [];
  const tracker = createRegionTracker(scene({ target: start }), start, 0, { onWarn: kind => warns.push(kind) });
  for (let n = 1; n <= Math.ceil(MAX_GAP_SECONDS * 10) + 6; n++) {
    const result = tracker.step(scene({ target: start, hidden: true }), n / 10);
    // 짧게 가린 동안만 예측으로 이어 가고, 그 뒤로는 유실로 남깁니다.
    assert.equal(result.lost, n / 10 > COAST_SECONDS + 1e-9);
  }
  assert.ok(warns.includes('gave-up'));
  assert.equal(tracker.stats.done, true);
  // 포기한 뒤에는 대상이 돌아와도 조용히 붙지 않습니다.
  assert.equal(tracker.step(scene({ target: start }), MAX_GAP_SECONDS + 2).lost, true);
});

test('re-attaching demands a higher score than staying attached', () => {
  assert.ok(REACQUIRE_SCORE > ACCEPT_SCORE, '잘못 붙는 쪽이 잠깐 못 따라가는 것보다 나쁩니다');
  const start = box(.3, .3);
  const tracker = createRegionTracker(scene({ target: start }), start, 0);
  // 무늬가 전혀 다른 물체가 같은 자리에 나타나도 붙지 않아야 합니다.
  // 예측으로 이어 가는 구간을 지난 뒤에 확인합니다.
  let time = 0;
  while (time < COAST_SECONDS + .2) { time += .1;tracker.step(scene({ target: start, hidden: true }), time); }
  const decoy = { sample: rect => normalizePatch(Float32Array.from({ length: TEMPLATE_SIZE * TEMPLATE_SIZE },
    (_, i) => (i * 37 % 11) + rect.x * 3)) };
  assert.equal(tracker.step(decoy, time + .1).lost, true, '다른 무늬에 재연결하지 않습니다');
});

test('frames must arrive in order and with usable timestamps', () => {
  const start = box(.3, .3);
  const tracker = createRegionTracker(scene({ target: start }), start, 0);
  assert.throws(() => tracker.step(scene({ target: start }), NaN), /시각이 올바르지 않습니다/);
  tracker.step(scene({ target: start }), .1);
  assert.throws(() => tracker.step(scene({ target: start }), .05), /순서가 바뀌었습니다/);
  assert.deepEqual(tracker.step(scene({ target: start }), .1).lost, false, '같은 시각은 앞 결과를 그대로 줍니다');
});

// ── 끊긴 지점부터 이어 붙이기 ──────────────────────────────────────────
// 앞부분이 멀쩡한데 중간부터 놓쳤을 때 처음부터 다시 잡을 필요가 없어야 합니다.

const key = (time, x, lost = false) => ({ time, x, y: .3, w: .2, h: .2, duration: .1, confidence: lost ? 0 : 1, lost });

test('merging keeps the good stretch of each pass and fills the other one in', () => {
  // 앞은 성공하고 3초 뒤부터 놓친 경로
  const first = [key(0, .2), key(1, .25), key(2, .3), key(3, .35, true), key(4, .4, true), key(5, .45, true)];
  // 3초 지점에서 다시 지정해 뒤쪽만 성공한 경로
  const second = [key(0, .9, true), key(1, .9, true), key(2, .9, true), key(3, .35), key(4, .4), key(5, .45)];
  const merged = mergeTrackingKeys(first, second);
  const at = time => merged.find(k => Math.abs(k.time - time) < 1e-6);
  assert.equal(at(1).lost, false, '앞부분의 성공 구간을 새 결과가 덮어쓰면 안 됩니다');
  assert.ok(Math.abs(at(1).x - .25) < 1e-9, '앞부분은 원래 위치 그대로여야 합니다');
  assert.equal(at(4).lost, false, '뒤쪽은 새 결과로 채워야 합니다');
  assert.ok(Math.abs(at(4).x - .4) < 1e-9);
  assert.ok(merged.filter(k => k.lost).length < first.filter(k => k.lost).length, '놓친 구간이 줄어야 합니다');
  assert.ok(merged.every((k, i, list) => !i || k.time > list[i - 1].time), '시각 순서와 중복 없음');
});

test('merging never invents coverage where both passes were blind', () => {
  const first = [key(0, .2), key(1, .25, true), key(2, .3, true), key(3, .35)];
  const second = [key(0, .2, true), key(1, .25, true), key(2, .3, true), key(3, .35, true)];
  const merged = mergeTrackingKeys(first, second);
  const blind = merged.filter(k => k.time > .5 && k.time < 2.5);
  assert.ok(blind.some(k => k.lost), '두 경로 모두 놓친 구간은 유실로 남아야 합니다');
  assert.deepEqual(mergeTrackingKeys([], second), second, '기존 경로가 없으면 새 결과를 그대로 씁니다');
});
