// 실행 코드는 고정 vendor, 모델은 같은 사이트의 고정 파일에서만 읽습니다.
// 캐시에도 완성된 파일만 넣고, 재사용할 때 크기와 SHA-256을 다시 확인합니다.
export const BROWSER_TRACKING_CACHE = 'shorts-browser-tracking-models-v1';
export const TRACKING_RUNTIME_VERSION = '1.0.1';
export const TRACKING_RUNTIME_BYTES = 12235826;

const MODELS = Object.freeze({
  mosaic: Object.freeze({
    task: 'mosaic', name: 'BlazeFace full-range', version: 'float16 v1',
    file: 'blazeface-full-range-f16-v1.tflite', bytes: 1083786,
    sha256: '3698b18f063835bc609069ef052228fbe86d9c9a6dc8dcb7c7c2d69aed2b181b',
  }),
  crop: Object.freeze({
    task: 'crop', name: 'EfficientDet-Lite2', version: 'float32 v1',
    file: 'efficientdet-lite2-f32-v1.tflite', bytes: 23096891,
    sha256: 'ad2abbf2b4e10585e15176fd7b5ef03c28dda959ae26fc142549fdd1814db91d',
  }),
});

export function trackingError(code, message, details) {
  const error = new Error(message);error.code = code;
  if (details) error.details = details;
  return error;
}

export function checkTrackingAbort(signal) {
  if (signal?.aborted) throw new DOMException('취소됨', 'AbortError');
}

export function browserTrackingModelInfo(task = 'mosaic') {
  const model = Object.hasOwn(MODELS, task) ? MODELS[task] : null;
  if (!model) throw trackingError('INVALID_TRACKING_TASK', '지원하지 않는 추적 종류입니다.');
  return { ...model, runtimeVersion: TRACKING_RUNTIME_VERSION, runtimeBytes: TRACKING_RUNTIME_BYTES,
    url: new URL('../vendor/mediapipe/models/' + model.file, import.meta.url).href };
}

/** 잘린 응답과 HTML 오류 페이지를 모델로 실행하지 않습니다. */
export async function readTrackingModelResponse(response, bytes, { signal, onProgress = () => {} } = {}) {
  checkTrackingAbort(signal);
  if (!response?.ok) throw trackingError('MODEL_DOWNLOAD_FAILED', '추적 모델 파일을 받지 못했습니다. 연결 상태와 모델 설치를 확인해 주세요.');
  const length = Number(response.headers?.get('content-length'));
  const encoding = response.headers?.get('content-encoding');
  // Fetch는 압축을 해제한 바이트를 주므로 전송 길이와 원본 크기는 다를 수 있습니다.
  if ((!encoding || encoding === 'identity') && length > 0 && length !== bytes)
    throw trackingError('MODEL_INTEGRITY_FAILED', '추적 모델 파일 크기가 맞지 않습니다. 다시 받아 주세요.');
  if (!response.body?.getReader) {
    const data = new Uint8Array(await response.arrayBuffer());checkTrackingAbort(signal);
    if (data.byteLength !== bytes) throw trackingError('MODEL_INTEGRITY_FAILED', '추적 모델 파일이 잘렸거나 크기가 맞지 않습니다.');
    onProgress(1);return data;
  }
  const reader = response.body.getReader(), chunks = [];let received = 0;
  const cancel = () => { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {} };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      checkTrackingAbort(signal);
      const { value, done } = await reader.read();checkTrackingAbort(signal);
      if (done) break;
      received += value.byteLength;
      if (received > bytes) throw trackingError('MODEL_INTEGRITY_FAILED', '추적 모델 파일이 허용된 크기를 넘었습니다.');
      chunks.push(value);onProgress(received / bytes);
    }
    if (received !== bytes) throw trackingError('MODEL_INTEGRITY_FAILED', '추적 모델 파일이 중간에 끊겼습니다. 다시 받아 주세요.');
    const data = new Uint8Array(received);let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset);offset += chunk.byteLength; }
    return data;
  } catch (error) { cancel();throw error; }
  finally { signal?.removeEventListener('abort', cancel);try { reader.releaseLock(); } catch {} }
}

export async function verifyTrackingModel(data, model, cryptoImpl = globalThis.crypto, signal) {
  checkTrackingAbort(signal);
  if (!(data instanceof Uint8Array) || data.byteLength !== model.bytes)
    throw trackingError('MODEL_INTEGRITY_FAILED', '추적 모델 파일의 크기가 맞지 않습니다.');
  if (!cryptoImpl?.subtle) throw trackingError('BROWSER_UNSUPPORTED', '모델 검증을 위해 HTTPS 또는 PC 로컬 주소에서 열어 주세요.');
  const hash = await cryptoImpl.subtle.digest('SHA-256', data);checkTrackingAbort(signal);
  const hex = [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('');
  if (hex !== model.sha256) throw trackingError('MODEL_INTEGRITY_FAILED', '추적 모델 파일 검증에 실패했습니다. 다시 받아 주세요.');
  return data;
}

export async function loadBrowserTrackingModel(task = 'mosaic', {
  signal, allowModelDownload = false, onProgress = () => {},
  fetchImpl = globalThis.fetch, cacheStorage = globalThis.caches, cryptoImpl = globalThis.crypto,
} = {}) {
  checkTrackingAbort(signal);
  const model = browserTrackingModelInfo(task);
  let cache;
  try { cache = await cacheStorage?.open(BROWSER_TRACKING_CACHE); } catch {}
  checkTrackingAbort(signal);
  if (cache) {
    let cached;
    try { cached = await cache.match(model.url); } catch {}
    checkTrackingAbort(signal);
    if (cached) {
      try {
        const data = await readTrackingModelResponse(cached, model.bytes, { signal });
        await verifyTrackingModel(data, model, cryptoImpl, signal);
        onProgress(1, '저장된 빠른 추적 파일을 사용합니다.');return data;
      } catch (error) {
        if (error.name === 'AbortError' || error.code === 'BROWSER_UNSUPPORTED') throw error;
        try { await cache.delete(model.url); } catch {}
      }
    }
  }
  checkTrackingAbort(signal);
  if (allowModelDownload !== true) throw trackingError('MODEL_DOWNLOAD_REQUIRED',
    '빠른 추적에 필요한 파일을 처음 받아야 합니다. 다운로드 안내에 동의한 뒤 다시 실행해 주세요.', model);
  if (typeof fetchImpl !== 'function') throw trackingError('BROWSER_UNSUPPORTED', '이 브라우저는 모델 파일을 받을 수 없습니다.');
  const controller = new AbortController();let timedOut = false;
  const cancel = () => controller.abort();
  const timer = setTimeout(() => { timedOut = true;controller.abort(); }, 300000);
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    checkTrackingAbort(signal);
    onProgress(0, '빠른 추적에 필요한 파일을 받는 중…');
    const response = await fetchImpl(model.url, { credentials: 'omit', referrerPolicy: 'no-referrer',
      redirect: 'error', cache: 'no-store', signal: controller.signal });
    const data = await readTrackingModelResponse(response, model.bytes, { signal: controller.signal,
      onProgress: value => onProgress(value, '빠른 추적 파일 다운로드 중… ' + Math.round(value * 100) + '%') });
    await verifyTrackingModel(data, model, cryptoImpl, signal);checkTrackingAbort(signal);
    let saved = false;
    if (cache) {
      try { await cache.put(model.url, new Response(data, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(data.byteLength) } }));saved = true; } catch {}
    }
    checkTrackingAbort(signal);
    onProgress(1, saved ? '빠른 추적 파일을 저장했습니다.' : '빠른 추적 준비 완료 · 저장 공간을 사용할 수 없어 이번 작업에서만 사용합니다.');
    return data;
  } catch (error) {
    checkTrackingAbort(signal);
    if (timedOut) throw trackingError('MODEL_DOWNLOAD_FAILED', '추적 모델 다운로드 시간이 초과됐습니다. 연결 상태를 확인해 주세요.');
    if (error.code || error.name === 'AbortError') throw error;
    throw trackingError('MODEL_DOWNLOAD_FAILED', '추적 모델을 받지 못했습니다. 연결 상태와 설치 파일을 확인해 주세요.');
  } finally { controller.abort();clearTimeout(timer);signal?.removeEventListener('abort', cancel); }
}
