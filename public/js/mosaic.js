// 추적 위치는 원본 영상의 표시 좌표(0~1)와 원본 시각으로 저장합니다.
// 이동·분할·트림으로 타임라인 위치가 달라져도 동일한 원본 프레임을 가립니다.
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const MAX_MOSAICS = 4;
export const MAX_TRACK_SECONDS = 180;
// PC 15fps의 3분 경로와 트림 경계 키를 함께 저장할 여유를 둡니다.
export const MAX_TRACK_KEYS = 3000;
const frameEnd = key => key.time + (Number.isFinite(key.duration) && key.duration > 0 ? key.duration : 0);

export function normalizedRect(rect = {}) {
  const w = clamp(Number(rect.w) || .1, .005, 1), h = clamp(Number(rect.h) || .1, .005, 1);
  return { x: clamp(Number(rect.x) || 0, 0, 1 - w), y: clamp(Number(rect.y) || 0, 0, 1 - h), w, h };
}

export function mosaicAt(effect, time) {
  if (effect.enabled === false) return null;
  if (effect.mode !== 'tracked') return { ...normalizedRect(effect.rect), full: false };
  const keys = effect.keyframes || [];
  // 미추적·추적 실패 구간은 임의의 위치로 추측하지 않고 원본 레이어 전체를 가립니다.
  if (!Number.isFinite(time) || !keys.length || time < keys[0].time - 1e-6 || time > frameEnd(keys.at(-1)) + 1e-6) return { full: true };
  let lo = 0, hi = keys.length - 1;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (keys[mid].time <= time) lo = mid; else hi = mid - 1; }
  const a = keys[lo], b = keys[Math.min(lo + 1, keys.length - 1)];
  if (a.lost || b.lost) return { full: true };
  const p = b.time > a.time ? clamp((time - a.time) / (b.time - a.time), 0, 1) : 0;
  return { ...normalizedRect(Object.fromEntries(['x','y','w','h'].map(k => [k, a[k] + (b[k] - a[k]) * p]))), full: false };
}

export function validMosaics(effects) {
  if (effects === undefined) return true;
  if (!Array.isArray(effects) || effects.length > MAX_MOSAICS) return false;
  const validRect = r => r && ['x','y','w','h'].every(k => Number.isFinite(r[k])) && r.x >= 0 && r.y >= 0 && r.w >= .005 && r.h >= .005 && r.x + r.w <= 1.000001 && r.y + r.h <= 1.000001;
  return effects.every(e => e && /^[a-zA-Z0-9_-]{1,80}$/.test(e.id) && typeof e.enabled === 'boolean'
    && ['static','tracked'].includes(e.mode) && validRect(e.rect) && Number.isFinite(e.strength) && e.strength >= 1 && e.strength <= 100
    && Number.isFinite(e.padding) && e.padding >= 0 && e.padding <= .5 && Array.isArray(e.keyframes) && e.keyframes.length <= MAX_TRACK_KEYS
    && (e.mode !== 'tracked' || (Array.isArray(e.range) && e.range.length === 2 && e.range.every(Number.isFinite) && e.range[0] >= 0 && e.range[1] > e.range[0] && e.range[1] <= 86400))
    && e.keyframes.every((k, i, list) => validRect(k) && Number.isFinite(k.time) && k.time >= 0 && k.time <= 86400
      && (!i || k.time > list[i - 1].time) && Number.isFinite(k.confidence) && k.confidence >= 0 && k.confidence <= 1
      && Number.isFinite(k.duration) && k.duration > 0 && k.duration <= 86400 && typeof k.lost === 'boolean')) && new Set(effects.map(e => e.id)).size === effects.length;
}

export function unresolvedMosaics(clip) {
  return (clip.mosaics || []).filter(e => e.enabled !== false && e.mode === 'tracked' && (
    !e.range || clip.trimStart < e.range[0] - 1e-6 || clip.trimEnd > e.range[1] + 1e-6 || !e.keyframes?.length
    || clip.trimStart < e.keyframes[0].time - 1e-6 || clip.trimEnd > frameEnd(e.keyframes.at(-1)) + 1e-6
    || e.keyframes.some((k, i, keys) => (k.lost || keys[i + 1]?.lost) && k.time < clip.trimEnd && (keys[i + 1]?.time ?? e.range[1]) > clip.trimStart)
  ));
}

/** 수동으로 새 위치를 지정해 다시 추적하면 성공한 구간만 기존 경로와 합칩니다. */
export function mergeTrackingKeys(previous, next) {
  if (!previous?.length) return next;
  const at = (keys, time) => mosaicAt({ mode: 'tracked', enabled: true, keyframes: keys }, time);
  const keys = previous.filter(k => at(next, k.time)?.full);
  for (const k of next) if (!k.lost || at(previous, k.time)?.full) keys.push(k);
  const map = new Map();
  for (const key of keys) { const id = key.time.toFixed(6), old = map.get(id); if (!old || old.lost || !key.lost) map.set(id, key); }
  const result = [...map.values()].sort((a, b) => a.time - b.time);
  const sameRect = (a,b) => a && !a.full && ['x','y','w','h'].every(k => Math.abs(a[k]-b[k]) < 1e-6);
  const covered = (keys,a,b) => {
    if (!sameRect(at(keys,a.time+1e-7),a) || !sameRect(at(keys,b.time-1e-7),b)) return false;
    const times = [a.time+1e-7, b.time-1e-7, (a.time+b.time)/2,
      ...keys.filter(k => k.time>a.time && k.time<b.time).flatMap(k => [k.time-1e-7,k.time+1e-7])];
    return times.every(time => !at(keys,time)?.full);
  };
  const safe = [];
  for (let i=0; i<result.length; i++) {
    const a=result[i], b=result[i+1];safe.push(a);
    // 두 경로가 모두 끊겼던 사이를 새 보간 선분으로 이어서 가리지 않게 되는 일을 막습니다.
    if (b && !a.lost && !b.lost && !covered(previous,a,b) && !covered(next,a,b)) safe.push({ ...a, time:(a.time+b.time)/2, confidence:0, lost:true });
  }
  if (safe.length > MAX_TRACK_KEYS) throw new Error('추적 키가 너무 많습니다. 클립을 나누거나 추적을 초기화해 주세요.');
  return safe;
}

const surfaces = new WeakMap();
export function redactSource(ctx, source, clip, fallbackTime) {
  const effects = (clip.mosaics || []).filter(e => e.enabled !== false);
  if (!effects.length) return source;
  let cache = surfaces.get(ctx.canvas);
  if (!cache) { cache = { image: document.createElement('canvas'), tile: document.createElement('canvas') }; surfaces.set(ctx.canvas, cache); }
  const W = Math.max(1, Math.round(source.w)), H = Math.max(1, Math.round(source.h));
  if (cache.image.width !== W || cache.image.height !== H) { cache.image.width = W; cache.image.height = H; }
  const dest = cache.image.getContext('2d');
  dest.setTransform(1,0,0,1,0,0);dest.globalAlpha=1;dest.globalCompositeOperation='source-over';dest.filter='none';dest.clearRect(0,0,W,H);
  if (source.draw) source.draw(dest, 0, 0, W, H); else dest.drawImage(source.img, 0, 0, W, H);
  for (const effect of effects) {
    const time = source.timeReliable === false ? NaN : (source.sourceTime ?? fallbackTime);
    const r = mosaicAt(effect, time);
    if (!r) continue;
    if (r.full) { dest.fillStyle = '#151515'; dest.fillRect(0, 0, W, H); break; }
    const pad = effect.padding ?? .12;
    const x = Math.max(0, Math.floor((r.x - r.w * pad) * W)), y = Math.max(0, Math.floor((r.y - r.h * pad) * H));
    const w = Math.min(W - x, Math.ceil((r.x + r.w * (1 + pad)) * W) - x);
    const h = Math.min(H - y, Math.ceil((r.y + r.h * (1 + pad)) * H) - y);
    const cells = Math.max(2, Math.round(34 - clamp(effect.strength, 1, 100) * .32));
    cache.tile.width = Math.max(1, Math.round(w >= h ? cells : cells * w / h));
    cache.tile.height = Math.max(1, Math.round(h >= w ? cells : cells * h / w));
    const tile = cache.tile.getContext('2d');tile.imageSmoothingEnabled = true;
    tile.drawImage(cache.image, x, y, w, h, 0, 0, cache.tile.width, cache.tile.height);
    // 투명 PNG·알파 영상도 원본 세부 무늬가 겹쳐 보이지 않도록 완전히 교체합니다.
    dest.fillStyle = '#151515';dest.fillRect(x, y, w, h);
    dest.imageSmoothingEnabled = false;dest.drawImage(cache.tile, 0, 0, cache.tile.width, cache.tile.height, x, y, w, h);
    dest.imageSmoothingEnabled = true;
  }
  return { img: cache.image, w: W, h: H, sourceTime: source.sourceTime };
}
