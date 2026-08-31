// 모델 다운로드·실제 영상 없이 대상 연결, 취소, 무결성, 원본 시각을 검사합니다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { createTargetTracker, normalizeModelDetections, faceSearchRegion } from '../public/js/browser-tracking.js';
import { browserTrackingModelInfo, readTrackingModelResponse, verifyTrackingModel, loadBrowserTrackingModel } from '../public/js/browser-tracking-models.js';
import { TrackingWorkerClient } from '../public/js/browser-tracking-client.js';
import { analyzeTrackingFrames, pcTrackingKeys, trackMosaic } from '../public/js/video-analysis.js';
import { mosaicAt, validMosaics, MAX_TRACK_KEYS } from '../public/js/mosaic.js';
import { trackCrop, validCropTracking, sliceCropTracking } from '../public/js/crop-tracking.js';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, a + ' != ' + b);
const face = (x = .2, y = .3, more = {}) => ({ x, y, w: .1, h: .14, confidence: .94, label: 'face', ...more });
const box = (originX, originY, width, height, score = .9, categoryName = 'person') => ({
  boundingBox: { originX, originY, width, height }, categories: [{ index: 0, score, categoryName }],
});

test('model pixel boxes and cropped search boxes return original normalized coordinates', () => {
  const result = normalizeModelDetections({ detections: [box(10, 20, 30, 40), box(NaN, 0, 10, 10), box(1, 1, 1, 1, NaN)] }, 100, 200, 'crop');
  assert.equal(result.length, 1);near(result[0].x, .1);near(result[0].y, .1);near(result[0].w, .3);near(result[0].h, .2);
  assert.equal(result[0].label, 'person');
  const cropped = normalizeModelDetections({ detections: [box(10, 20, 30, 40)] }, 100, 200, 'mosaic', { x: .3, y: .4, w: .5, h: .4 });
  near(cropped[0].x, .35);near(cropped[0].y, .44);near(cropped[0].w, .15);near(cropped[0].h, .08);assert.equal(cropped[0].label, 'face');
  const edge = normalizeModelDetections({ detections: [box(-10, -20, 30, 60)] }, 100, 200, 'mosaic')[0];
  near(edge.x, 0);near(edge.y, 0);near(edge.w, .2);near(edge.h, .2);
});

test('small face search retains the target and stays inside the frame', () => {
  const rect = face(.94, .93, { w: .04, h: .04 }), region = faceSearchRegion(rect);
  assert.ok(region.x <= rect.x && region.y <= rect.y);assert.ok(region.x + region.w >= rect.x + rect.w);
  assert.ok(region.y + region.h >= rect.y + rect.h);assert.ok(region.x + region.w <= 1 && region.y + region.h <= 1);
  assert.equal(faceSearchRegion({ x: NaN }), null);
});

test('association preserves a manually expanded head rectangle as the face moves and scales', () => {
  const initial = face(), selected = { x: .18, y: .25, w: .15, h: .23 };
  const tracker = createTargetTracker([initial, face(.75)], selected, 0);
  const next = face(.21, .31, { w: .11, h: .154 }), result = tracker.step([next, face(.75, .3, { confidence: 1 })], .1);
  assert.equal(result.lost, false);near(result.w, selected.w * 1.1);near(result.h, selected.h * 1.1);
  near(result.x, next.x + (selected.x - initial.x) * 1.1);near(result.y, next.y + (selected.y - initial.y) * 1.1);
  assert.deepEqual(tracker.initial, { ...selected, confidence: initial.confidence, lost: false, manual: true });
});

test('same category and backward velocity retain the selected object rather than a higher score elsewhere', () => {
  const initial = face(.4, .3, { label: 'person' }), tracker = createTargetTracker([initial], initial, 2, { task: 'crop' });
  for (let i = 1; i <= 5; i++) {
    const current = face(.4 - i * .01, .3, { label: 'person' });
    const result = tracker.step([face(.8, .3, { label: 'person', confidence: 1 }), face(current.x, .3, { label: 'dog', confidence: 1 }), current], 2 - i * .1);
    assert.equal(result.lost, false);near(result.x, current.x);
  }
});

test('initial absence and ambiguous multiple targets have distinct errors', () => {
  assert.throws(() => createTargetTracker([], face(), 0), { code: 'TARGET_NOT_FOUND' });
  assert.throws(() => createTargetTracker([face(.2), face(.4)], { x: .15, y: .25, w: .4, h: .24 }, 0), { code: 'TARGET_AMBIGUOUS' });
});

test('short occlusion needs two consecutive confirmations and never moves to a distant face', () => {
  const tracker = createTargetTracker([face()], face(), 0);
  assert.equal(tracker.step([], .1).lost, true);
  const distant = tracker.step([face(.7)], .2);assert.equal(distant.lost, true);near(distant.x, .2);
  assert.equal(tracker.step([face(.21)], .3).lost, true);
  const recovered = tracker.step([face(.215)], .4);assert.equal(recovered.lost, false);near(recovered.x, .215);
});

test('crossing candidates and long missing intervals require manual re-selection', () => {
  const crossing = createTargetTracker([face()], face(), 0);
  assert.equal(crossing.step([face(.18), face(.24)], .1).lost, true);
  assert.equal(crossing.step([face(.2)], .2).lost, true);near(crossing.rect.x, .2);
  const absent = createTargetTracker([face()], face(), 0);
  absent.step([], .1);absent.step([], 1.3);
  assert.equal(absent.step([face(.2)], 1.4).lost, true);assert.equal(absent.step([face(.2)], 1.5).lost, true);
});

test('frame analysis continues after missing detections and records actual source PTS', async () => {
  const detected = [], clip = { type: 'video', trimStart: 12, trimEnd: 13 };
  const keys = await analyzeTrackingFrames(clip, face(.21), 12.2, {
    readFrame: async time => ({ time: 12 + Math.floor((time - 12 + 1e-8) * 10) / 10, duration: .1 }),
    detectFrame: async frame => {
      const i = Math.round((frame.time - 12) * 10);detected.push(i);
      return i >= 3 && i <= 5 ? [] : [face(.2 + i * .005)];
    },
  });
  assert.equal(detected.length, 10);assert.deepEqual(keys.map(key => Number(key.time.toFixed(1))), Array.from({ length: 10 }, (_, i) => 12 + i / 10));
  assert.equal(keys[2].manual, true);assert.equal(keys[3].lost, true);assert.equal(keys[6].lost, true);assert.equal(keys[7].lost, false);
  assert.equal(keys.at(-1).time, 12.9);assert.equal(keys.at(-1).duration, .1);
});

test('variable frame durations are not replaced by the 10 Hz request grid', async () => {
  const frames = [{ time: 0, duration: .25 }, { time: .25, duration: .08 }, { time: .33, duration: .34 }, { time: .67, duration: .33 }];
  const keys = await analyzeTrackingFrames({ type: 'video', trimStart: 0, trimEnd: 1 }, face(), .25, {
    readFrame: async time => frames.filter(frame => frame.time <= time + 1e-8).at(-1),
    detectFrame: async () => [face()],
  });
  assert.deepEqual(keys.map(key => ({ time: key.time, duration: key.duration })), frames);
});

test('frame analysis aborts before decoding and discards an asynchronously cancelled result', async () => {
  const clip = { type: 'video', trimStart: 0, trimEnd: .5 }, first = new AbortController();first.abort();
  let reads = 0;
  await assert.rejects(analyzeTrackingFrames(clip, face(), 0, { signal: first.signal,
    readFrame: async () => { reads++;return { time: 0, duration: .1 }; }, detectFrame: async () => [face()] }), { name: 'AbortError' });
  assert.equal(reads, 0);
  const second = new AbortController();
  await assert.rejects(analyzeTrackingFrames(clip, face(), 0, { signal: second.signal,
    readFrame: async () => ({ time: 0, duration: .1 }), detectFrame: async () => { second.abort();return [face()]; } }), { name: 'AbortError' });
});

test('PC keys keep source times, real lost states and valid legacy mosaic shape', () => {
  const clip = { trimStart: 12, trimEnd: 12.3 };
  const raw = [{ ...face(), t: 12, lost: false }, { ...face(.21), t: 12.1, lost: true }, { ...face(.21), t: 12.2, lost: true }];
  const keys = pcTrackingKeys(raw, clip);
  near(keys[0].time, 12);near(keys[0].duration, .1);near(keys.at(-1).duration, .1);
  const effect = { id: 'mask', enabled: true, mode: 'tracked', rect: face(), strength: 60, padding: .1, range: [12, 12.3], keyframes: keys };
  assert.equal(validMosaics([effect]), true);assert.equal(!!mosaicAt(effect, 12.15).uncertain, true);   // 추적 범위 밖 → 고정 사각형으로 가림
  assert.equal(raw[0].duration, undefined);
  for (const invalid of [[], [raw[0], raw[0]], [{ ...raw[0], x: NaN }], [{ ...raw[0], lost: 'false' }], [{ ...raw[0], t: '12' }]])
    assert.throws(() => pcTrackingKeys(invalid, clip), { code: 'INVALID_TRACKING_RESULT' });
});

test('PC tiny masks expand safely and missing boxes keep the last confirmed position', () => {
  const raw = [
    { ...face(.998, .999), w: .001, h: .0005, t: 0, lost: false },
    { ...face(.1, .2), w: .001, h: .001, t: .1, lost: true },
  ];
  const keys = pcTrackingKeys(raw, { trimStart: 0, trimEnd: .2 });
  near(keys[0].w, .005);near(keys[0].h, .005);
  assert.ok(keys[0].x <= raw[0].x && keys[0].x + keys[0].w >= raw[0].x + raw[0].w);
  assert.ok(keys[0].y <= raw[0].y && keys[0].y + keys[0].h >= raw[0].y + raw[0].h);
  assert.equal(keys[1].lost, true);near(keys[1].x, keys[0].x);near(keys[1].y, keys[0].y);
  assert.throws(() => pcTrackingKeys([{ ...raw[0], lost: true, w: 0 }], { trimEnd: .2 }), { code: 'INVALID_TRACKING_RESULT' });
});

test('three minutes of PC 15 fps tracking fits mosaic and crop storage including boundary keys', async () => {
  const clip = { type: 'video', trimStart: 12, trimEnd: 192 };
  const raw = Array.from({ length: 2701 }, (_, index) => ({ ...face(.2 + index / 20000), t: 12 + index * 180 / 2701, lost: false }));
  const keys = pcTrackingKeys(raw, clip);
  const effect = { id: 'dense', enabled: true, mode: 'tracked', rect: face(), strength: 60, padding: .1, range: [12, 192], keyframes: keys };
  assert.equal(keys.length, 2701);assert.equal(validMosaics([effect]), true);assert.equal(mosaicAt(effect, 191.99).full, false);
  const result = await trackCrop(clip, face(), 0, { smoothing: 0, analyze: async () => ({ keyframes: keys }) });
  assert.equal(result.tracking.keys.length, 2702);assert.equal(validCropTracking(result.tracking, 180), true);
  assert.equal(validCropTracking(sliceCropTracking({ cropTracking: result.tracking }, .01, 179.99), 179.98), true);
  const tooMany = new Array(MAX_TRACK_KEYS + 1).fill(raw[0]);
  assert.throws(() => pcTrackingKeys(tooMany, clip), { code: 'INVALID_TRACKING_RESULT' });
});

test('invalid engine selection does not fall back to another tracker', async () => {
  await assert.rejects(trackMosaic({ type: 'video', trimStart: 0, trimEnd: 1 }, { rect: face() }, 0, { engine: 'template' }),
    { code: 'INVALID_TRACKING_ENGINE' });
});

const hashBytes = hex => Uint8Array.from(hex.match(/../g), pair => parseInt(pair, 16)).buffer;
const expectedCrypto = model => ({ subtle: { digest: async () => hashBytes(model.sha256) } });
function memoryCache() {
  const entries = new Map(), state = { writes: 0, deletes: 0 };
  const cache = {
    async match(url) { return entries.get(url)?.clone(); },
    async put(url, response) { state.writes++;entries.set(url, response.clone()); },
    async delete(url) { state.deletes++;return entries.delete(url); },
  };
  return { entries, state, cache, cacheStorage: { open: async () => cache } };
}

test('SHA-256 verification rejects changed bytes and insecure crypto environments', async () => {
  const data = new Uint8Array([1, 2, 3, 4]), model = { bytes: 4, sha256: createHash('sha256').update(data).digest('hex') };
  assert.equal(await verifyTrackingModel(data, model, webcrypto), data);
  await assert.rejects(verifyTrackingModel(new Uint8Array([1, 2, 3, 5]), model, webcrypto), { code: 'MODEL_INTEGRITY_FAILED' });
  await assert.rejects(verifyTrackingModel(data, model, {}), { code: 'BROWSER_UNSUPPORTED' });
});

test('an absent model requires explicit download permission without making a request', async () => {
  const model = browserTrackingModelInfo('mosaic');let requests = 0;
  await assert.rejects(loadBrowserTrackingModel('mosaic', { cacheStorage: undefined, fetchImpl: async () => { requests++; } }),
    error => error.code === 'MODEL_DOWNLOAD_REQUIRED' && error.details.bytes === model.bytes && error.details.name === model.name);
  assert.equal(requests, 0);
  assert.throws(() => browserTrackingModelInfo('__proto__'), { code: 'INVALID_TRACKING_TASK' });
});

test('a verified same-origin model is cached and reused without another consent or fetch', async () => {
  const model = browserTrackingModelInfo('mosaic'), data = new Uint8Array(model.bytes), storage = memoryCache();
  const requests = [], cryptoImpl = expectedCrypto(model);
  const fetchImpl = async (url, options) => { requests.push({ url, options });return new Response(data); };
  const first = await loadBrowserTrackingModel('mosaic', { allowModelDownload: true, cacheStorage: storage.cacheStorage, fetchImpl, cryptoImpl });
  assert.equal(first.length, model.bytes);assert.equal(storage.state.writes, 1);assert.equal(requests.length, 1);
  assert.ok(requests[0].url.endsWith('/vendor/mediapipe/models/blazeface-full-range-f16-v1.tflite'));
  assert.equal(requests[0].options.credentials, 'omit');assert.equal(requests[0].options.referrerPolicy, 'no-referrer');assert.equal(requests[0].options.redirect, 'error');
  const second = await loadBrowserTrackingModel('mosaic', { cacheStorage: storage.cacheStorage, fetchImpl, cryptoImpl });
  assert.equal(second.length, model.bytes);assert.equal(requests.length, 1);assert.notEqual(first.buffer, second.buffer);
});

test('a corrupt cache entry is removed and never silently downloaded without consent', async () => {
  const model = browserTrackingModelInfo('mosaic'), storage = memoryCache();let requests = 0;
  storage.entries.set(model.url, new Response(new Uint8Array([1, 2])));
  await assert.rejects(loadBrowserTrackingModel('mosaic', { cacheStorage: storage.cacheStorage, cryptoImpl: expectedCrypto(model),
    fetchImpl: async () => { requests++; } }), { code: 'MODEL_DOWNLOAD_REQUIRED' });
  assert.equal(storage.state.deletes, 1);assert.equal(storage.state.writes, 0);assert.equal(requests, 0);
});

test('missing and damaged model files produce different errors and are never cached', async () => {
  const storage = memoryCache();
  await assert.rejects(loadBrowserTrackingModel('crop', { allowModelDownload: true, cacheStorage: storage.cacheStorage,
    fetchImpl: async () => new Response('missing', { status: 404 }) }), { code: 'MODEL_DOWNLOAD_FAILED' });
  await assert.rejects(loadBrowserTrackingModel('crop', { allowModelDownload: true, cacheStorage: storage.cacheStorage,
    fetchImpl: async () => new Response('damaged') }), { code: 'MODEL_INTEGRITY_FAILED' });
  assert.equal(storage.state.writes, 0);
});

test('stream byte limits cancel oversized responses and abort never accepts a partial model', async () => {
  const decoded = await readTrackingModelResponse(new Response(new Uint8Array(4),
    { headers: { 'content-length': '3', 'content-encoding': 'gzip' } }), 4);
  assert.equal(decoded.length, 4);
  let cancelled = 0;
  const oversized = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(5)); }, cancel() { cancelled++; } });
  await assert.rejects(readTrackingModelResponse(new Response(oversized), 4), { code: 'MODEL_INTEGRITY_FAILED' });
  assert.equal(cancelled, 1);
  const controller = new AbortController();
  const response = new Response(new ReadableStream({ start(stream) { stream.enqueue(new Uint8Array(2)); }, cancel() { cancelled++; } }));
  await assert.rejects(readTrackingModelResponse(response, 4, { signal: controller.signal, onProgress: () => controller.abort() }), { name: 'AbortError' });
  assert.equal(cancelled, 2);
});

test('model cancellation aborts the fetch and leaves no cache write', async () => {
  const storage = memoryCache(), controller = new AbortController();let began;
  const started = new Promise(resolve => { began = resolve; });
  let fetchSignal;
  const pending = loadBrowserTrackingModel('mosaic', { allowModelDownload: true, cacheStorage: storage.cacheStorage, signal: controller.signal,
    fetchImpl: async (url, options) => new Promise((resolve, reject) => {
      fetchSignal = options.signal;began();fetchSignal.addEventListener('abort', () => reject(new DOMException('취소됨', 'AbortError')), { once: true });
    }) });
  await started;controller.abort();await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(fetchSignal.aborted, true);assert.equal(storage.state.writes, 0);
});

test('cancellation while checking cached data cannot start a late download', async () => {
  const controller = new AbortController();let resolveMatch, began, fetched = false;
  const started = new Promise(resolve => { began = resolve; });
  const cacheStorage = { open: async () => ({ match: async () => { began();return new Promise(resolve => { resolveMatch = resolve; }); } }) };
  const pending = loadBrowserTrackingModel('mosaic', { signal: controller.signal, allowModelDownload: true, cacheStorage,
    fetchImpl: async () => { fetched = true; } });
  await started;controller.abort();resolveMatch(undefined);await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(fetched, false);
});

class FakeWorker extends EventTarget {
  sent = [];terminated = 0;
  postMessage(message) { this.sent.push(message); }
  terminate() { this.terminated++; }
  emit(type, data) { const event = new Event(type);event.data = data;this.dispatchEvent(event); }
}

test('worker request IDs isolate late responses and expose initialization errors without fallback', async () => {
  const worker = new FakeWorker(), client = new TrackingWorkerClient(worker);
  const first = client.request('init');worker.emit('message', { id: 100, result: 'unrelated' });
  worker.emit('message', { id: worker.sent[0].id, error: { code: 'MODEL_INITIALIZATION_FAILED', message: '초기화 실패' } });
  await assert.rejects(first, { code: 'MODEL_INITIALIZATION_FAILED' });assert.equal(worker.sent.length, 1);
  const second = client.request('detect');worker.emit('message', { id: worker.sent[0].id, result: 'late' });
  worker.emit('message', { id: worker.sent[1].id, result: [face()] });
  assert.deepEqual(await second, [face()]);assert.equal(client.pending.size, 0);client.close();
});

test('worker cancellation rejects pending work, releases listeners and terminates exactly once', async () => {
  const worker = new FakeWorker(), controller = new AbortController(), client = new TrackingWorkerClient(worker, controller.signal);
  const pending = client.request('detect');controller.abort();
  worker.emit('message', { id: worker.sent[0].id, result: [face()] });
  await assert.rejects(pending, { name: 'AbortError' });assert.equal(client.pending.size, 0);
  await assert.rejects(client.request('detect'), { name: 'AbortError' });client.close();assert.equal(worker.terminated, 1);assert.equal(worker.sent.length, 1);
});

test('worker errors, postMessage failures and deadlines clean up pending requests', async () => {
  const worker = new FakeWorker(), client = new TrackingWorkerClient(worker), pending = client.request('detect');
  worker.emit('error');await assert.rejects(pending, { code: 'TRACKING_WORKER_FAILED' });assert.equal(worker.terminated, 1);
  const throwing = new FakeWorker();throwing.postMessage = () => { throw new Error('clone failure'); };
  const failed = new TrackingWorkerClient(throwing);
  await assert.rejects(failed.request('detect'), { code: 'TRACKING_WORKER_FAILED' });assert.equal(failed.pending.size, 0);assert.equal(throwing.terminated, 1);
  const silent = new FakeWorker(), timeout = new TrackingWorkerClient(silent);
  await assert.rejects(timeout.request('detect', {}, [], 5), { code: 'TRACKING_TIMEOUT' });assert.equal(silent.terminated, 1);assert.equal(timeout.pending.size, 0);
});
