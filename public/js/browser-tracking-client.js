// Worker 요청 수명과 취소를 한 곳에서 관리합니다. 취소 시 진행 중 추론도 종료합니다.
import { checkTrackingAbort, loadBrowserTrackingModel, trackingError } from './browser-tracking-models.js';

export class TrackingWorkerClient {
  constructor(worker, signal) {
    this.worker = worker;this.signal = signal;this.sequence = 0;this.pending = new Map();this.closed = false;
    this.message = event => {
      const data = event.data || {}, pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);clearTimeout(pending.timer);
      if (data.error) pending.reject(trackingError(data.error.code || 'MODEL_INFERENCE_FAILED', data.error.message || '추적 모델 실행에 실패했습니다.'));
      else pending.resolve(data.result);
    };
    this.error = () => this.close(trackingError('TRACKING_WORKER_FAILED', '추적 Worker를 실행하지 못했습니다. 앱 파일과 브라우저 지원을 확인해 주세요.'));
    this.abort = () => this.close(new DOMException('취소됨', 'AbortError'));
    worker.addEventListener('message', this.message);worker.addEventListener('error', this.error);worker.addEventListener('messageerror', this.error);
    signal?.addEventListener('abort', this.abort, { once: true });
    if (signal?.aborted) this.abort();
  }

  request(type, payload = {}, transfer = [], timeout = 30000) {
    if (this.closed) return Promise.reject(this.closeReason || new DOMException('취소됨', 'AbortError'));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => this.close(trackingError('TRACKING_TIMEOUT', '추적 모델의 응답 시간이 초과됐습니다. 결과는 적용되지 않았습니다.')), timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.worker.postMessage({ id, type, ...payload }, transfer); }
      catch { this.close(trackingError('TRACKING_WORKER_FAILED', '영상 프레임을 추적 Worker로 전달하지 못했습니다.')); }
    });
  }

  close(reason = new DOMException('취소됨', 'AbortError')) {
    if (this.closed) return;
    this.closed = true;this.closeReason = reason;
    this.worker.removeEventListener('message', this.message);this.worker.removeEventListener('error', this.error);this.worker.removeEventListener('messageerror', this.error);
    this.signal?.removeEventListener('abort', this.abort);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer);pending.reject(reason); }
    this.pending.clear();this.worker.terminate();
  }
}

export async function createBrowserDetector(task, {
  signal, allowModelDownload = false, onProgress = () => {},
  workerFactory = () => new Worker(new URL('./mosaic-worker.js', import.meta.url), { type: 'module' }),
} = {}) {
  checkTrackingAbort(signal);
  const model = await loadBrowserTrackingModel(task, { signal, allowModelDownload, onProgress });
  checkTrackingAbort(signal);
  let client;
  try { client = new TrackingWorkerClient(workerFactory(), signal); }
  catch { throw trackingError('BROWSER_UNSUPPORTED', '이 브라우저는 추적 Worker를 시작할 수 없습니다.'); }
  try {
    onProgress(1, 'MediaPipe CPU 모델을 준비하는 중…');
    const info = await client.request('init', { task, model: model.buffer }, [model.buffer], 120000);
    checkTrackingAbort(signal);
    return {
      info,
      async detect(bitmap, rect) {
        try { return await client.request('detect', { bitmap, rect }, [bitmap]); }
        catch (error) { bitmap?.close?.();throw error; }
      },
      close: () => client.close(),
    };
  } catch (error) { client.close();throw error; }
}
