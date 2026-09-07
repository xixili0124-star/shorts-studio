// 검출기 없는 픽셀 추적기 검사. 합성 장면으로 이동·가림·재연결·포기를 확인합니다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePatch, patchScore, searchCandidates, createRegionTracker,
  TEMPLATE_SIZE, ACCEPT_SCORE, REACQUIRE_SCORE, MAX_GAP_SECONDS } from '../public/js/region-tracking.js';

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
  assert.ok(lost.length >= 5, '가린 구간은 유실로 남습니다');
  assert.ok(lost.every(t => t >= .7 && t <= 1.6), '가리지 않은 구간까지 버리지 않습니다: ' + lost.join(','));
  assert.ok(seen.includes('reacquired'), '다시 붙었음을 알립니다');
  assert.ok(!seen.includes('gave-up'));
});

test('a long disappearance gives up instead of latching onto something else', () => {
  const start = box(.3, .3);
  const warns = [];
  const tracker = createRegionTracker(scene({ target: start }), start, 0, { onWarn: kind => warns.push(kind) });
  for (let n = 1; n <= Math.ceil(MAX_GAP_SECONDS * 10) + 6; n++) {
    const result = tracker.step(scene({ target: start, hidden: true }), n / 10);
    assert.equal(result.lost, true);
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
  tracker.step(scene({ target: start, hidden: true }), .1);
  const decoy = { sample: rect => normalizePatch(Float32Array.from({ length: TEMPLATE_SIZE * TEMPLATE_SIZE },
    (_, i) => (i * 37 % 11) + rect.x * 3)) };
  assert.equal(tracker.step(decoy, .2).lost, true, '다른 무늬에 재연결하지 않습니다');
});

test('frames must arrive in order and with usable timestamps', () => {
  const start = box(.3, .3);
  const tracker = createRegionTracker(scene({ target: start }), start, 0);
  assert.throws(() => tracker.step(scene({ target: start }), NaN), /시각이 올바르지 않습니다/);
  tracker.step(scene({ target: start }), .1);
  assert.throws(() => tracker.step(scene({ target: start }), .05), /순서가 바뀌었습니다/);
  assert.deepEqual(tracker.step(scene({ target: start }), .1).lost, false, '같은 시각은 앞 결과를 그대로 줍니다');
});
