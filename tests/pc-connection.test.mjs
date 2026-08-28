// 실제 로컬 서비스·브라우저 저장소 대신 가짜 응답으로 승인과 취소 경계를 검사합니다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PC_BRIDGE_URL, PC_CONNECTION_KEY, isLoopbackEditor, isPcSupportedSite, savedPcConnection, canUsePcEngine,
  rememberPcConnection, pcTransportContext, pcConnectionStatus, connectPc, disconnectPc } from '../public/js/pc-connection.js';
import { PC_TRACKING_MODEL, pcTrackingResult, trackPcVideo } from '../public/js/pc-tracking.js';

const site = { protocol: 'https:', hostname: 'shorts-studio-75p.pages.dev', origin: 'https://shorts-studio-75p.pages.dev' };
const lab = { protocol: 'https:', hostname: 'codex-studio-lab.shorts-studio-75p.pages.dev', origin: 'https://codex-studio-lab.shorts-studio-75p.pages.dev' };
const local = { protocol: 'http:', hostname: '127.0.0.1', origin: 'http://127.0.0.1:9999' };
const invalid = { protocol: 'https:', hostname: 'invalid.test', origin: 'https://invalid.test' };
const token = 'a'.repeat(43), requestId = 'b'.repeat(32), requestSecret = 'c'.repeat(43);
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const bridgeStatus = () => ({ app: 'shorts-studio-pc', version: 1, engines: { voice: { configured: false }, asr: { configured: false }, tracking: { configured: false } } });
const storage = () => { const values = new Map();return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }; };
const reset = store => disconnectPc({ location: invalid, storage: store });

test('only two published sites or an exact loopback editor may use PC transport', async () => {
  const store = storage();await reset(store);
  try {
    for (const location of [site, lab]) { assert.equal(isPcSupportedSite(location), true);assert.equal(canUsePcEngine(location, store), false); }
    for (const location of [invalid, { ...site, origin: site.origin + '.evil.test' }, { protocol: 'http:', hostname: '127.0.0.1.evil.test' }, { protocol: 'file:', hostname: '' }]) {
      assert.equal(isPcSupportedSite(location), false);assert.throws(() => pcTransportContext(location, store), { code: 'PC_CONNECTION_REQUIRED' });
    }
    assert.equal(isLoopbackEditor(local), true);assert.deepEqual(pcTransportContext(local, store), { base: '', headers: {}, options: {} });
    let fetched = false;
    await assert.rejects(pcConnectionStatus({ location: site, storage: store, fetchImpl: () => { fetched = true; } }), { code: 'PC_CONNECTION_REQUIRED' });
    assert.equal(fetched, false);
  } finally { await reset(store); }
});

test('saved approval survives session reset but cannot change its endpoint or origin', async () => {
  const store = storage();await reset(store);
  try {
    rememberPcConnection(token, site, store);
    await reset(storage());
    assert.equal(savedPcConnection(site, store).token, token);
    assert.equal(savedPcConnection(lab, store), null);
    const context = pcTransportContext(site, store);
    assert.equal(context.base, PC_BRIDGE_URL);assert.equal(context.headers.Authorization, 'Bearer ' + token);assert.equal(context.options.targetAddressSpace, 'loopback');
    const valid = JSON.parse(store.getItem(PC_CONNECTION_KEY));
    for (const patch of [{ endpoint: 'http://127.0.0.1:9000' }, { endpoint: 'https://external.invalid' }, { origin: lab.origin }, { token: 'short' }, { version: 2 }]) {
      store.setItem(PC_CONNECTION_KEY, JSON.stringify({ ...valid, ...patch }));assert.equal(savedPcConnection(site, store), null);
    }
  } finally { await reset(store); }
});

test('paired status uses only the fixed URL and bearer token without cookies or redirects', async () => {
  const store = storage();await reset(store);
  try {
    rememberPcConnection(token, site, store);let call;
    const result = await pcConnectionStatus({ location: site, storage: store, fetchImpl: async (url, options) => { call = { url, options };return json(bridgeStatus()); } });
    assert.equal(result.app, 'shorts-studio-pc');assert.equal(call.url, PC_BRIDGE_URL + '/api/pc-bridge/status');
    assert.equal(call.options.headers.Authorization, 'Bearer ' + token);assert.equal(call.options.headers['X-Studio-PC-Bridge'], '1');
    assert.equal(call.options.credentials, 'omit');assert.equal(call.options.redirect, 'error');assert.equal(call.options.targetAddressSpace, 'loopback');
    assert.equal(call.options.body, undefined);
  } finally { await reset(store); }
});

function popupFixture() {
  const popup = { location: '', closed: false, close() { this.closed = true; } };
  const windowImpl = { open: () => popup };
  return { popup, windowImpl };
}

const pairStarted = () => json({ requestId, requestSecret, approvalPath: '/pc-connect.html?request=' + requestId }, 201);
const waitForAbort = signal => new Promise((resolve, reject) => {
  const cancel = () => reject(new DOMException('cancelled', 'AbortError'));
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
});

test('the first pairing request waits for permission for 60 seconds and reports its own timeout', async t => {
  const store = storage(), { popup, windowImpl } = popupFixture();
  await reset(store);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requestSignal;
  try {
    const pending = connectPc({ location: site, storage: store, windowImpl, fetchImpl: (url, options) => {
      assert.ok(url.endsWith('/pair/start'));
      requestSignal = options.signal;
      return waitForAbort(requestSignal);
    } });
    const rejected = assert.rejects(pending, error => {
      assert.equal(error.code, 'PC_PAIR_START_TIMEOUT');
      assert.match(error.message, /60초/);
      assert.match(error.message, /원래 편집기 창/);
      return true;
    });
    t.mock.timers.tick(5000);
    assert.equal(requestSignal.aborted, false);
    t.mock.timers.tick(54999);
    assert.equal(requestSignal.aborted, false);
    t.mock.timers.tick(1);
    await rejected;
    assert.equal(requestSignal.aborted, true);
    assert.equal(popup.closed, true);
    assert.equal(store.getItem(PC_CONNECTION_KEY), null);
    assert.equal(savedPcConnection(site, store), null);
  } finally {
    t.mock.timers.reset();
    await reset(store);
  }
});

test('status and approval result requests retain the five second timeout', async t => {
  const store = storage();
  for (const phase of ['status', 'pair/result']) {
    await reset(store);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let requestSignal, ready;
    const waiting = new Promise(resolve => { ready = resolve; });
    const { popup, windowImpl } = popupFixture();
    try {
      if (phase === 'status') rememberPcConnection(token, site, store);
      const options = { location: site, storage: store, windowImpl, fetchImpl: (url, init) => {
        if (url.endsWith('/pair/start')) return pairStarted();
        assert.ok(url.endsWith('/' + phase));
        requestSignal = init.signal;
        ready();
        return waitForAbort(requestSignal);
      } };
      const pending = phase === 'status' ? pcConnectionStatus(options) : connectPc(options);
      const rejected = assert.rejects(pending, error => {
        assert.notEqual(error.code, 'PC_PAIR_START_TIMEOUT');
        assert.match(error.message, /PC 연결 프로그램/);
        assert.doesNotMatch(error.message, /60초/);
        return true;
      });
      await waiting;
      t.mock.timers.tick(4999);
      assert.equal(requestSignal.aborted, false);
      t.mock.timers.tick(1);
      await rejected;
      assert.equal(requestSignal.aborted, true);
      if (phase === 'pair/result') {
        assert.equal(popup.closed, true);
        assert.equal(savedPcConnection(site, store), null);
      }
    } finally {
      t.mock.timers.reset();
      await reset(store);
    }
  }
});

test('pairing shows static permission guidance and safely focuses the editor before the approval popup', async () => {
  const store = storage();
  for (const unavailable of [false, true]) {
    await reset(store);
    const { popup, windowImpl } = popupFixture(), events = [], progress = [];
    const document = { title: '', body: { textContent: '', style: {} } };
    Object.defineProperty(popup, 'document', { get() {
      if (unavailable) throw new Error('document is not accessible');
      return document;
    } });
    windowImpl.focus = () => { events.push('editor-focus');if (unavailable) throw new Error('focus is not available'); };
    popup.focus = () => { events.push('popup-focus');if (unavailable) throw new Error('focus is not available'); };
    try {
      await connectPc({ location: site, storage: store, windowImpl, onProgress: text => progress.push(text), fetchImpl: async (url, options) => {
        if (url.endsWith('/pair/start')) {
          assert.deepEqual(events, ['editor-focus']);
          if (!unavailable) {
            assert.match(document.body.textContent, /원래 편집기 창/);
            assert.match(document.body.textContent, /로컬 네트워크/);
          }
          return pairStarted();
        }
        if (url.endsWith('/pair/result')) {
          assert.deepEqual(events, ['editor-focus', 'popup-focus']);
          assert.equal(popup.location, PC_BRIDGE_URL + '/pc-connect.html?request=' + requestId);
          return json({ state: 'approved', token });
        }
        assert.equal(url, PC_BRIDGE_URL + '/api/pc-bridge/status');
        assert.equal(options.headers.Authorization, 'Bearer ' + token);
        assert.equal(store.getItem(PC_CONNECTION_KEY), null);
        assert.equal(savedPcConnection(site, store), null);
        return json(bridgeStatus());
      } });
      assert.match(progress[0], /원래 편집기 창/);
      assert.match(progress[0], /로컬 네트워크/);
      assert.equal(savedPcConnection(site, store).token, token);
      assert.equal(popup.closed, true);
    } finally { await reset(store); }
  }
});

test('a network rejection during initial pairing is not mislabeled as the 60 second timeout', async () => {
  const store = storage(), { popup, windowImpl } = popupFixture();
  await reset(store);
  try {
    await assert.rejects(connectPc({ location: site, storage: store, windowImpl, fetchImpl: async () => {
      throw new TypeError('network request failed');
    } }), error => {
      assert.notEqual(error.code, 'PC_PAIR_START_TIMEOUT');
      assert.doesNotMatch(error.message, /60초/);
      return true;
    });
    assert.equal(popup.closed, true);
    assert.equal(savedPcConnection(site, store), null);
  } finally { await reset(store); }
});

test('explicit cancellation during the first permission wait closes the popup without saving approval', async () => {
  const store = storage(), controller = new AbortController(), { popup, windowImpl } = popupFixture();
  await reset(store);
  let requestSignal;
  try {
    const pending = connectPc({ signal: controller.signal, location: site, storage: store, windowImpl, fetchImpl: (url, options) => {
      assert.ok(url.endsWith('/pair/start'));
      requestSignal = options.signal;
      return waitForAbort(requestSignal);
    } });
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    controller.abort();
    await rejected;
    assert.equal(requestSignal.aborted, true);
    assert.equal(popup.location, '');
    assert.equal(popup.closed, true);
    assert.equal(store.getItem(PC_CONNECTION_KEY), null);
    assert.equal(savedPcConnection(site, store), null);
  } finally { await reset(store); }
});

test('pairing navigates only to the fixed approval path and saves a successfully approved token', async () => {
  const store = storage(), { popup, windowImpl } = popupFixture(), calls = [];await reset(store);
  try {
    const result = await connectPc({ location: site, storage: store, windowImpl, fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/pair/start')) return json({ requestId, requestSecret, approvalPath: '/pc-connect.html?request=' + requestId }, 201);
      if (url.endsWith('/pair/result')) return json({ state: 'approved', version: 1, token });
      return json(bridgeStatus());
    } });
    assert.equal(result.version, 1);assert.equal(savedPcConnection(site, store).token, token);
    assert.equal(popup.location, PC_BRIDGE_URL + '/pc-connect.html?request=' + requestId);assert.equal(popup.closed, true);
    assert.ok(!popup.location.includes(token) && !popup.location.includes(requestSecret));
    assert.deepEqual(JSON.parse(calls[1].options.body), { requestId, requestSecret });
    assert.equal(calls[0].options.headers.Authorization, undefined);assert.equal(calls.at(-1).options.headers.Authorization, 'Bearer ' + token);
  } finally { await reset(store); }
});

test('pairing rejects a redirected approval page without persisting any connection', async () => {
  const store = storage(), { popup, windowImpl } = popupFixture();await reset(store);
  try {
    await assert.rejects(connectPc({ location: site, storage: store, windowImpl, fetchImpl: async () =>
      json({ requestId, requestSecret, approvalPath: 'https://outside.invalid/approve' }) }));
    assert.equal(popup.location, '');assert.equal(popup.closed, true);assert.equal(savedPcConnection(site, store), null);
  } finally { await reset(store); }
});

test('a late approved response after cancellation cannot persist a bearer token', async () => {
  const store = storage(), controller = new AbortController(), { popup, windowImpl } = popupFixture();await reset(store);
  let started, approve;
  const polling = new Promise(resolve => { started = resolve; });
  try {
    const pending = connectPc({ signal: controller.signal, location: site, storage: store, windowImpl, fetchImpl: async url => {
      if (url.endsWith('/pair/start')) return json({ requestId, requestSecret, approvalPath: '/pc-connect.html?request=' + requestId });
      if (url.endsWith('/pair/result')) { started();return new Promise(resolve => { approve = resolve; }); }
      return json(bridgeStatus());
    } });
    await polling;controller.abort();approve(json({ state: 'approved', version: 1, token }));
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(store.getItem(PC_CONNECTION_KEY), null);assert.equal(savedPcConnection(site, store), null);assert.equal(popup.closed, true);
  } finally { await reset(store); }
});

test('cancelling the final status check cannot persist the approved token even after a late response', async () => {
  const store = storage(), controller = new AbortController(), { popup, windowImpl } = popupFixture();
  await reset(store);
  let checking, finishStatus;
  const statusStarted = new Promise(resolve => { checking = resolve; });
  try {
    const pending = connectPc({ signal: controller.signal, location: site, storage: store, windowImpl, fetchImpl: async (url, options) => {
      if (url.endsWith('/pair/start')) return pairStarted();
      if (url.endsWith('/pair/result')) return json({ state: 'approved', token });
      assert.equal(url, PC_BRIDGE_URL + '/api/pc-bridge/status');
      assert.equal(options.headers.Authorization, 'Bearer ' + token);
      checking();
      return new Promise(resolve => { finishStatus = resolve; });
    } });
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await statusStarted;
    assert.equal(store.getItem(PC_CONNECTION_KEY), null);
    assert.equal(savedPcConnection(site, store), null);
    controller.abort();
    finishStatus(json(bridgeStatus()));
    await rejected;
    assert.equal(store.getItem(PC_CONNECTION_KEY), null);
    assert.equal(savedPcConnection(site, store), null);
    assert.equal(popup.closed, true);
  } finally { await reset(store); }
});

test('revoke uses the bearer token and clears persistent and session connection state', async () => {
  const store = storage();await reset(store);
  try {
    rememberPcConnection(token, site, store);let call;
    await disconnectPc({ location: site, storage: store, fetchImpl: async (url, options) => { call = { url, options };return json({ revoked: true }); } });
    assert.equal(call.url, PC_BRIDGE_URL + '/api/pc-bridge/revoke');assert.equal(call.options.headers.Authorization, 'Bearer ' + token);
    assert.equal(call.options.method, 'POST');assert.equal(savedPcConnection(site, store), null);assert.equal(store.getItem(PC_CONNECTION_KEY), null);
  } finally { await reset(store); }
});

const rect = { x: .2, y: .25, w: .3, h: .4 };
const clip = () => ({ type: 'video', trimStart: 10, trimEnd: 12, natW: 320, natH: 180, file: new Blob(['synthetic video'], { type: 'video/mp4' }) });
const trackingResult = () => ({ model: PC_TRACKING_MODEL, device: 'cuda', computeType: 'bfloat16', duration: 2, seedTime: .5,
  points: [0, .5, 1, 1.5].map(t => ({ t, ...rect, lost: false, confidence: .9 })) });

test('PC tracking validates model, device and finite timing before adding the source trim offset', () => {
  const result = trackingResult(), converted = pcTrackingResult(result, clip(), 10.5);
  assert.deepEqual(converted.keyframes.map(key => key.t), [10, 10.5, 11, 11.5]);assert.equal(result.points[0].t, 0);
  for (const patch of [{ model: 'different' }, { device: 'cpu' }, { computeType: 'float32' }, { duration: NaN }, { seedTime: NaN }, { duration: undefined }, { seedTime: undefined }])
    assert.throws(() => pcTrackingResult({ ...result, ...patch }, clip(), 10.5));
  for (const points of [[{ ...result.points[0], t: -.1 }], [result.points[0], result.points[0]], [{ ...result.points[0], lost: true }]])
    assert.throws(() => pcTrackingResult({ ...result, points }, clip(), 10.5));
});

test('explicit tracking sends only the selected file and fixed options then polls the same job', async () => {
  const item = clip(), calls = [];let polled = 0;
  const result = await trackPcVideo(item, rect, { seedTime: 10.5, location: local, pollInterval: 1, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/track')) return json({ jobId: requestId }, 202);
    if (url.endsWith('/jobs/' + requestId)) return json(++polled === 1 ? { state: 'running', progress: .5, message: '추적 중' } : { state: 'done', result: trackingResult() });
    throw new Error('unexpected endpoint');
  } });
  assert.deepEqual(result.keyframes.map(key => key.t), [10, 10.5, 11, 11.5]);
  assert.equal(calls[0].url, '/api/pc-tracking/track');assert.equal(calls[0].options.body, item.file);
  assert.equal(calls[0].options.headers['X-Studio-Consent'], 'video-to-local-tracking');assert.equal(calls[0].options.headers['X-Studio-PC-Tracking'], '1');
  assert.deepEqual(JSON.parse(calls[0].options.headers['X-Studio-Tracking-Options']), { start: 10, duration: 2, seedTime: .5, box: rect });
  assert.ok(calls.slice(1).every(call => call.url === '/api/pc-tracking/jobs/' + requestId && call.options.body === undefined));
});

test('public tracking cannot upload before pairing and uses fixed authenticated loopback after approval', async () => {
  const store = storage(), calls = [];await reset(store);
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return url.endsWith('/track') ? json({ jobId: requestId }, 202) : json({ state: 'done', result: trackingResult() });
  };
  try {
    await assert.rejects(trackPcVideo(clip(), rect, { seedTime: 10.5, location: site, fetchImpl }), { code: 'PC_CONNECTION_REQUIRED' });
    assert.equal(calls.length, 0);
    rememberPcConnection(token, site, store);
    await trackPcVideo(clip(), rect, { seedTime: 10.5, location: site, fetchImpl });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(call => call.url), [PC_BRIDGE_URL + '/api/pc-tracking/track', PC_BRIDGE_URL + '/api/pc-tracking/jobs/' + requestId]);
    for (const { options } of calls) {
      assert.equal(options.headers.Authorization, 'Bearer ' + token);
      assert.equal(options.targetAddressSpace, 'loopback');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.redirect, 'error');
    }
  } finally { await reset(store); }
});

test('cancelled tracking rejects immediately and cancels a job ID received later exactly once', async () => {
  const controller = new AbortController(), calls = [];let created, cancelled;
  const cancelledRequest = new Promise(resolve => { cancelled = resolve; });
  const pending = trackPcVideo(clip(), rect, { seedTime: 10.5, signal: controller.signal, location: local, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/track')) return new Promise(resolve => { created = resolve; });
    if (url.endsWith('/cancel')) { cancelled();return json({ cancelled: true }); }
    throw new Error('a cancelled job must never be polled');
  } });
  controller.abort();await assert.rejects(pending, { name: 'AbortError' });
  created(json({ jobId: requestId }, 202));await cancelledRequest;
  assert.equal(calls.length, 2);assert.deepEqual(JSON.parse(calls[1].options.body), { jobId: requestId });
  assert.equal(calls[1].options.signal.aborted, false);
});
