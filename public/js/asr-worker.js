// 영상·오디오는 16kHz PCM으로 전달받아 로컬 Whisper로 인식합니다.
import { pipeline, env } from '../vendor/transformers/3.8.1/transformers.min.js';
import { ASR_MODEL } from './local-ai.js';

env.allowLocalModels = false;env.allowRemoteModels = true;env.useBrowserCache = true;
env.backends.onnx.wasm.numThreads = 1;env.backends.onnx.wasm.proxy = false;
env.backends.onnx.wasm.wasmPaths = new URL('../vendor/transformers/3.8.1/', import.meta.url).href;
const progress = (value, message) => self.postMessage({ type: 'progress', progress: value, message });
self.onmessage = async event => {
  let recognizer;
  try {
    const { audio } = event.data;
    if (!(audio instanceof Float32Array) || !audio.length || audio.length > 16000 * 180 || audio.some(v => !Number.isFinite(v))) throw new Error('인식할 오디오가 올바르지 않습니다. 3분 이하의 구간을 선택해 주세요.');
    progress(.02, '자막 모델 준비 중… 처음에는 약 44MB를 내려받습니다.');
    recognizer = await pipeline('automatic-speech-recognition', ASR_MODEL.id, {
      revision: ASR_MODEL.revision, device: 'wasm', dtype: 'q8',
      progress_callback: item => {
        if (item.status === 'progress') progress(.05 + Math.min(1, (item.progress || 0) / 100) * .3, '자막 모델 준비 · ' + Math.round(item.progress || 0) + '%');
      },
    });
    progress(NaN, '기기에서 한국어 말소리를 인식 중… 길이와 기기 성능에 따라 잠시 걸립니다.');
    const result = await recognizer(audio, { language: 'ko', task: 'transcribe', return_timestamps: 'word',
      chunk_length_s: 30, stride_length_s: 5,
    });
    self.postMessage({ type: 'result', result });
  } catch (error) { self.postMessage({ type: 'error', message: error.message || '자동 자막을 완료하지 못했습니다.' }); }
  finally { try { await recognizer?.dispose(); } catch {} }
};
