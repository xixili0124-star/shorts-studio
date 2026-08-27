// 한국어 음성의 생성·파형 처리를 기기 안에서 수행합니다. HTTP는 공개 모델 GET에만 사용합니다.
import * as ort from '../vendor/onnxruntime-web/1.23.2/ort.wasm.min.mjs';
import { TextToSpeech, UnicodeProcessor, Style, writeWavFile } from '../vendor/supertonic/helper.js';
import { TTS_MODEL, chunkSpeechText } from './local-ai.js';
import { cachedModel } from './model-download.js';

ort.env.wasm.numThreads = 1;ort.env.wasm.proxy = false;
ort.env.wasm.wasmPaths = new URL('../vendor/onnxruntime-web/1.23.2/', import.meta.url).href;
const models = [['duration_predictor',1521526],['text_encoder',27431318],['vector_estimator',132471364],['vocoder',101405066]];
const progress = (value, message) => self.postMessage({ type: 'progress', progress: value, message });
const json = async name => JSON.parse(new TextDecoder().decode(await cachedModel(TTS_MODEL.base + name)));

self.onmessage = async event => {
  const sessions = [];
  try {
    const { text, voice, speed = 1, steps = 5 } = event.data;
    if (!TTS_MODEL.voices.includes(voice) || !Number.isFinite(speed) || speed < .75 || speed > 1.5 || ![3,5,8].includes(steps)) throw new Error('음성 설정이 올바르지 않습니다.');
    const chunks = chunkSpeechText(text);
    progress(.01, '음성 모델 준비 중… 처음에는 약 264MB를 내려받습니다.');
    const cfg = await json('onnx/tts.json'), indexer = await json('onnx/unicode_indexer.json');
    for (let i = 0; i < models.length; i++) {
      const [name, bytes] = models[i];
      const data = await cachedModel(TTS_MODEL.base + 'onnx/' + name + '.onnx', bytes,
        p => progress(.02 + (i + p) / models.length * .43, '음성 모델 ' + (i + 1) + '/4 준비 · ' + Math.round(p * 100) + '%'));
      sessions.push(await ort.InferenceSession.create(data, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }));
    }
    const rawStyle = await json('voice_styles/' + voice + '.json');
    const style = new Style(new ort.Tensor('float32', Float32Array.from(rawStyle.style_ttl.data.flat(Infinity)), rawStyle.style_ttl.dims),
      new ort.Tensor('float32', Float32Array.from(rawStyle.style_dp.data.flat(Infinity)), rawStyle.style_dp.dims));
    const tts = new TextToSpeech(cfg, new UnicodeProcessor(indexer), ...sessions), parts = [];
    let length = 0;
    for (let i = 0; i < chunks.length; i++) {
      const result = await tts._infer([chunks[i]], ['ko'], style, steps, speed,
        (step,total) => progress(.45 + (i + step / total) / chunks.length * .53, '기기에서 음성 생성 중… ' + (i + 1) + '/' + chunks.length + ' 문장'));
      const samples = Math.min(result.wav.length, Math.floor(result.duration[0] * tts.sampleRate));
      if (!Number.isFinite(samples) || samples <= 0 || result.duration[0] > 40) throw new Error('음성 길이를 계산하지 못했습니다. 원고를 짧게 나눠 주세요.');
      const pcm = Float32Array.from(result.wav.slice(0, samples));
      if (pcm.some(v => !Number.isFinite(v))) throw new Error('생성된 음성에 잘못된 샘플이 있습니다.');
      if (i) { const silence = new Float32Array(Math.round(.22 * tts.sampleRate));parts.push(silence);length += silence.length; }
      parts.push(pcm);length += pcm.length;
      if (length / tts.sampleRate > 180) throw new Error('생성 음성은 한 번에 3분까지 지원합니다. 원고를 나눠 주세요.');
    }
    const joined = new Float32Array(length);let at = 0, peak = 0;
    for (const part of parts) { joined.set(part, at);at += part.length;for (const v of part) peak = Math.max(peak, Math.abs(v)); }
    if (peak < .0001) throw new Error('생성된 음성이 무음입니다. 다른 목소리로 다시 시도해 주세요.');
    if (peak > .98) for (let i = 0; i < joined.length; i++) joined[i] *= .98 / peak;
    const wav = writeWavFile(joined, tts.sampleRate);
    self.postMessage({ type: 'result', result: { wav, sampleRate: tts.sampleRate, duration: length / tts.sampleRate } }, [wav]);
  } catch (error) { self.postMessage({ type: 'error', message: error.message || '음성 생성을 완료하지 못했습니다.' }); }
  finally { for (const session of sessions) try { await session.release(); } catch {} }
};
