// 검출기는 얼굴/물체의 위치를 찾고, 이 모듈은 사용자가 고른 대상만 연결합니다.
// 외형이나 신원을 판별하지 않으므로 애매한 교차·긴 가림에서는 수동 재지정을 요구합니다.
import { normalizedRect } from './mosaic.js';
import { trackingError } from './browser-tracking-models.js';

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const area = rect => rect.w * rect.h;
const center = rect => ({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 });
const rectCopy = rect => ({ x: rect.x, y: rect.y, w: rect.w, h: rect.h });
const validRect = rect => rect && ['x', 'y', 'w', 'h'].every(key => Number.isFinite(rect[key]))
  && rect.x >= 0 && rect.y >= 0 && rect.w >= .005 && rect.h >= .005
  && rect.x + rect.w <= 1.000001 && rect.y + rect.h <= 1.000001;

export function rectangleOverlap(a, b) {
  return Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
}

export function rectangleIou(a, b) {
  const overlap = rectangleOverlap(a, b);
  return overlap / Math.max(1e-9, area(a) + area(b) - overlap);
}

/** MediaPipe의 픽셀 좌표를 원본 영상의 정규화 좌표로 바꿉니다. */
export function normalizeModelDetections(result, width, height, task = 'mosaic', region = { x: 0, y: 0, w: 1, h: 1 }) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || !validRect(region))
    throw trackingError('INVALID_DETECTION', '검출 영상의 크기가 올바르지 않습니다.');
  const detections = [];
  for (const item of result?.detections || []) {
    const box = item.boundingBox, category = item.categories?.[0];
    if (!box || !['originX', 'originY', 'width', 'height'].every(key => Number.isFinite(box[key]))
      || box.width <= 0 || box.height <= 0 || !Number.isFinite(category?.score) || category.score < 0 || category.score > 1) continue;
    const x = clamp(box.originX / width, 0, 1), y = clamp(box.originY / height, 0, 1);
    const right = clamp((box.originX + box.width) / width, 0, 1), bottom = clamp((box.originY + box.height) / height, 0, 1);
    const rect = { x: region.x + x * region.w, y: region.y + y * region.h, w: (right - x) * region.w, h: (bottom - y) * region.h };
    const label = task === 'mosaic' ? 'face' : category.categoryName || (Number.isFinite(category.index) ? String(category.index) : '');
    if (validRect(rect) && label) detections.push({ ...rect, confidence: category.score, label });
  }
  return cleanDetections(detections);
}

function cleanDetections(detections) {
  const sorted = (Array.isArray(detections) ? detections : []).filter(item => validRect(item)
    && Number.isFinite(item.confidence) && item.confidence >= .25 && item.confidence <= 1 && typeof item.label === 'string')
    .map(item => ({ ...rectCopy(item), confidence: item.confidence, label: item.label }))
    .sort((a, b) => b.confidence - a.confidence);
  const unique = [];
  for (const item of sorted) if (!unique.some(other => other.label === item.label && rectangleIou(other, item) > .88)) unique.push(item);
  return unique;
}

function distance(a, b) {
  const ac = center(a), bc = center(b);
  return Math.hypot(ac.x - bc.x, ac.y - bc.y);
}

function seedCandidate(detections, selected, task) {
  const ranked = cleanDetections(detections).filter(item => task !== 'mosaic' || item.label === 'face').map(item => {
    const overlap = rectangleOverlap(item, selected), containment = overlap / Math.min(area(item), area(selected));
    const proximity = distance(item, selected) / Math.max(item.w, item.h, selected.w, selected.h);
    return { item, eligible: containment >= .3 && proximity <= .8,
      score: rectangleIou(item, selected) * .55 + containment * .25 + Math.max(0, 1 - proximity) * .2 };
  }).filter(value => value.eligible).sort((a, b) => b.score - a.score);
  if (!ranked.length) throw trackingError('TARGET_NOT_FOUND', task === 'mosaic'
    ? '선택 영역에서 얼굴을 검출하지 못했습니다. 얼굴이 보이는 프레임에서 다시 지정하거나 PC 추적을 선택해 주세요.'
    : '선택 영역에서 지원되는 물체를 검출하지 못했습니다. 대상 전체가 보이는 프레임을 고르거나 PC 추적을 선택해 주세요.');
  if (ranked[1] && ranked[0].score - ranked[1].score < .12)
    throw trackingError('TARGET_AMBIGUOUS', '선택 영역에 후보가 여러 개 있습니다. 한 대상만 포함하도록 다시 지정해 주세요.');
  return ranked[0].item;
}

/** 작은 얼굴은 실제 픽셀을 잘라 한 번 더 검출합니다. 모델의 ROI 옵션을 가정하지 않습니다. */
export function faceSearchRegion(rect) {
  if (!validRect(rect)) return null;
  const c = center(rect), w = Math.min(1, Math.max(.18, rect.w * 4)), h = Math.min(1, Math.max(.18, rect.h * 4));
  return normalizedRect({ x: c.x - w / 2, y: c.y - h / 2, w, h });
}

export function createTargetTracker(detections, rect, seedTime, { task = 'mosaic' } = {}) {
  if (!validRect(rect) || !Number.isFinite(seedTime)) throw trackingError('INVALID_TRACKING_INPUT', '추적 시작 위치나 시각이 올바르지 않습니다.');
  const seed = seedCandidate(detections, rect, task), seedCenter = center(seed);
  const selected = { dx: (rect.x - seedCenter.x) / seed.w, dy: (rect.y - seedCenter.y) / seed.h,
    w: rect.w / seed.w, h: rect.h / seed.h };
  let last = seed, lastTime = seedTime, sampleTime = seedTime, direction = 0;
  let velocity = { x: 0, y: 0 }, misses = 0, pending = null, locked = false;
  let output = { ...rectCopy(rect), confidence: seed.confidence, lost: false };
  const lost = () => { output = { ...output, confidence: 0, lost: true };return { ...output }; };
  const position = box => {
    const c = center(box);
    return normalizedRect({ x: c.x + selected.dx * box.w, y: c.y + selected.dy * box.h,
      w: selected.w * box.w, h: selected.h * box.h });
  };
  return {
    initial: { ...output, manual: true },
    get rect() { return rectCopy(output); },
    step(raw, time) {
      if (!Number.isFinite(time)) throw trackingError('INVALID_DETECTION', '검출 프레임의 시각이 올바르지 않습니다.');
      const change = time - sampleTime;
      if (Math.abs(change) < 1e-6) return { ...output };
      if (!direction) direction = Math.sign(change);
      if (Math.sign(change) !== direction) throw trackingError('INVALID_DETECTION', '추적 프레임의 순서가 바뀌었습니다.');
      sampleTime = time;
      // 위치 정보만으로 긴 가림 뒤의 동일 인물을 증명할 수 없으므로 자동 재연결하지 않습니다.
      const elapsed = Math.abs(time - lastTime);
      if (locked || elapsed > 1.2) { locked = true;return lost(); }
      const prediction = normalizedRect({ ...last, x: last.x + velocity.x * Math.min(elapsed, .4),
        y: last.y + velocity.y * Math.min(elapsed, .4) });
      const ranked = cleanDetections(raw).filter(item => item.label === seed.label).map(item => {
        const shape = Math.max(item.w / last.w, last.w / item.w, item.h / last.h, last.h / item.h);
        const separation = distance(prediction, item), size = Math.max(last.w, last.h);
        const gate = Math.max(misses ? .02 : .035, size * (misses ? .55 : .85));
        return { item, eligible: shape <= (misses ? 1.4 : 1.8) && separation <= gate,
          score: rectangleIou(prediction, item) * .6 + (1 - separation / gate) * .3 + item.confidence * .1 };
      }).filter(candidate => candidate.eligible).sort((a, b) => b.score - a.score);
      const best = ranked[0], other = ranked[1];
      if (best && other && (best.score - other.score < .16 || rectangleIou(best.item, other.item) > .12)) {
        locked = true;pending = null;misses++;return lost();
      }
      if (!best) { pending = null;misses++;return lost(); }
      if (misses) {
        // 짧게 놓쳤더라도 한 프레임의 후보만으로 대상을 바꾸지 않습니다.
        if (!pending || rectangleIou(pending, best.item) < .5) { pending = best.item;return lost(); }
      }
      const oldCenter = center(last), nextCenter = center(best.item);
      velocity = { x: clamp(velocity.x * .45 + (nextCenter.x - oldCenter.x) / Math.max(elapsed, .001) * .55, -1, 1),
        y: clamp(velocity.y * .45 + (nextCenter.y - oldCenter.y) / Math.max(elapsed, .001) * .55, -1, 1) };
      last = best.item;lastTime = time;misses = 0;pending = null;
      output = { ...position(last), confidence: last.confidence, lost: false };
      return { ...output };
    },
  };
}
