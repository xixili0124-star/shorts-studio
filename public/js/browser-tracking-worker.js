// 검출 모델은 Worker 안에서만 실행하고 원본 프레임은 네트워크로 보내지 않습니다.
import { browserTrackingModelInfo, trackingError } from './browser-tracking-models.js';
import { normalizeModelDetections, faceSearchRegion, rectangleOverlap } from './browser-tracking.js';

let detector, task, busy = false, regionCanvas;

async function initialize(data) {
  task = data.task;
  const model = browserTrackingModelInfo(task);
  if (!(data.model instanceof ArrayBuffer) || data.model.byteLength !== model.bytes)
    throw trackingError('MODEL_INTEGRITY_FAILED', 'Worker에 전달된 추적 모델 크기가 맞지 않습니다.');
  if (typeof OffscreenCanvas === 'undefined' || typeof WebAssembly === 'undefined')
    throw trackingError('BROWSER_UNSUPPORTED', '이 브라우저는 Worker 영상 추론을 지원하지 않습니다. 최신 Chrome/Safari 또는 PC 추적을 사용해 주세요.');
  let vision;
  try { vision = await import('../vendor/mediapipe/1.0.1/vision_bundle.mjs'); }
  catch { throw trackingError('RUNTIME_UNAVAILABLE', 'MediaPipe 실행 파일이 없습니다. 앱의 vendor 설치를 확인해 주세요.'); }
  // module Worker에 맞는 WASM 로더를 고릅니다. 외부 CDN 로더는 사용하지 않습니다.
  if (!(await vision.FilesetResolver.isSimdSupported()))
    throw trackingError('BROWSER_UNSUPPORTED', '이 브라우저는 추적 모델에 필요한 WebAssembly SIMD를 지원하지 않습니다.');
  const wasmPath = new URL('../vendor/mediapipe/1.0.1/wasm', import.meta.url).href;
  const fileset = await vision.FilesetResolver.forVisionTasks(wasmPath, true);
  try {
    detector?.close();detector = undefined;
    const base = { baseOptions: { modelAssetBuffer: new Uint8Array(data.model), delegate: 'CPU' }, runningMode: 'IMAGE' };
    detector = task === 'mosaic'
      ? await vision.FaceDetector.createFromOptions(fileset, { ...base, minDetectionConfidence: .4, minSuppressionThreshold: .3 })
      : await vision.ObjectDetector.createFromOptions(fileset, { ...base, scoreThreshold: .3, maxResults: 30 });
  } catch {
    throw trackingError('MODEL_INITIALIZATION_FAILED', '브라우저 추적 모델을 시작하지 못했습니다. 메모리·WebGL 지원과 vendor 파일을 확인해 주세요. 다른 엔진으로 자동 전환하지 않았습니다.');
  }
  return { model: model.name, engine: 'browser', device: 'cpu' };
}

function detect(data) {
  const bitmap = data.bitmap;
  try {
    if (!detector) throw trackingError('MODEL_NOT_READY', '추적 모델 준비가 끝나지 않았습니다.');
    if (!bitmap || !Number.isFinite(bitmap.width) || !Number.isFinite(bitmap.height) || bitmap.width <= 0 || bitmap.height <= 0)
      throw trackingError('INVALID_FRAME', '분석할 영상 프레임을 읽지 못했습니다.');
    // IMAGE 모드는 앞/뒤 두 방향에서도 비디오 타임스탬프 순서를 요구하지 않습니다.
    const found = normalizeModelDetections(detector.detect(bitmap), bitmap.width, bitmap.height, task);
    const rect = data.rect, region = task === 'mosaic' ? faceSearchRegion(rect) : null;
    const hasFace = region && found.some(face => rectangleOverlap(face, rect) >= Math.min(face.w * face.h, rect.w * rect.h) * .3);
    if (region && !hasFace && (region.w < .98 || region.h < .98)) {
      const sx = Math.floor(region.x * bitmap.width), sy = Math.floor(region.y * bitmap.height);
      const sw = Math.min(bitmap.width - sx, Math.max(1, Math.ceil(region.w * bitmap.width)));
      const sh = Math.min(bitmap.height - sy, Math.max(1, Math.ceil(region.h * bitmap.height)));
      const scale = Math.min(1, 640 / Math.max(sw, sh));
      regionCanvas ||= new OffscreenCanvas(1, 1);
      regionCanvas.width = Math.max(1, Math.round(sw * scale));regionCanvas.height = Math.max(1, Math.round(sh * scale));
      const context = regionCanvas.getContext('2d');
      if (!context) throw trackingError('BROWSER_UNSUPPORTED', '이 브라우저는 분석용 캔버스를 만들 수 없습니다.');
      context.drawImage(bitmap, sx, sy, sw, sh, 0, 0, regionCanvas.width, regionCanvas.height);
      found.push(...normalizeModelDetections(detector.detect(regionCanvas), regionCanvas.width, regionCanvas.height, task,
        { x: sx / bitmap.width, y: sy / bitmap.height, w: sw / bitmap.width, h: sh / bitmap.height }));
    }
    return found;
  } finally { bitmap?.close?.(); }
}

self.onmessage = async event => {
  const data = event.data || {}, { id, type } = data;
  if (busy) { data.bitmap?.close?.();self.postMessage({ id, error: { code: 'TRACKING_BUSY', message: '이전 프레임 분석이 끝나지 않았습니다.' } });return; }
  busy = true;
  try {
    let result;
    if (type === 'init') result = await initialize(data);
    else if (type === 'detect') result = detect(data);
    else if (type === 'close') { detector?.close();detector = undefined;result = true; }
    else throw trackingError('INVALID_TRACKING_REQUEST', '지원하지 않는 추적 요청입니다.');
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: { code: error.code || 'MODEL_INFERENCE_FAILED',
      message: error.code ? error.message : '추적 모델이 현재 프레임을 분석하지 못했습니다. 결과는 적용되지 않았습니다.' } });
  } finally { busy = false; }
};
