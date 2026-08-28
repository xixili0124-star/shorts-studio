// 사용자가 실행한 경우에만 별도 Worker를 만듭니다. 원고·PCM을 HTTP로 보내지 않습니다.
import { transcriptionCaptions } from './ai-client.js';

export const TTS_MODEL = { name: 'Supertonic 2', revision: '75e6727618a02f323c720cba9478152d4bc16ca4',
  base: 'https://huggingface.co/Supertone/supertonic-2/resolve/75e6727618a02f323c720cba9478152d4bc16ca4/',
  bytes: 264000000, voices: ['F1','F2','F3','F4','F5','M1','M2','M3','M4','M5'] };
export const ASR_MODEL = { name: 'Whisper Tiny · 다국어', id: 'Xenova/whisper-tiny',
  revision: '5332fcc35e32a33b86612b9a57a89be7906102b1', bytes: 44000000 };

export function chunkSpeechText(text, maximum = 100) {
  if (!Number.isInteger(maximum) || maximum < 2 || maximum > 2000) throw new Error('문장 분할 길이가 올바르지 않습니다.');
  const source = String(text).replace(/\s+/g, ' ').trim();
  if (!source) throw new Error('읽을 원고를 입력해 주세요.');
  if (source.length > 2000) throw new Error('원고는 2,000자까지 입력할 수 있습니다.');
  const chunks = [];
  let rest = source;
  while (rest.length) {
    if (rest.length <= maximum) { chunks.push(rest); break; }
    let at = maximum;
    const sentence = [...rest.slice(0, maximum).matchAll(/[.!?。！？]\s/g)].at(-1);
    if (sentence && sentence.index > maximum / 3) at = sentence.index + 1;
    else { const space = rest.lastIndexOf(' ', maximum); if (space > maximum / 2) at = space; }
    // 서로게이트 쌍의 중간을 자르지 않습니다.
    if (/^[\uDC00-\uDFFF]$/.test(rest[at] || '')) at--;
    chunks.push(rest.slice(0, at).trim());rest = rest.slice(at).trim();
  }
  return chunks;
}

export function whisperCaptions(result, duration, offset = 0) {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(offset) || offset < 0) throw new Error('자막 인식 구간이 올바르지 않습니다.');
  const words = [], chunks = result?.chunks || [];
  if (!Array.isArray(chunks)) throw new Error('자막 결과 형식이 올바르지 않습니다.');
  let skipped = 0;
  for (const chunk of chunks) {
    const times = chunk.timestamp;
    if (!Array.isArray(times) || times.length !== 2 || !times.every(Number.isFinite) || times[1] <= times[0] || times[0] >= duration || !String(chunk.text || '').trim()) { skipped++; continue; }
    const start = Math.max(0, times[0]), end = Math.min(duration, times[1]);
    if (end <= start) { skipped++; continue; }
    words.push({ word: String(chunk.text), start: start + offset, end: end + offset });
  }
  words.sort((a,b) => a.start-b.start);
  return { captions: transcriptionCaptions({ words }).map(c => ({ ...c, generated: 'local-whisper' })), skipped, text: String(result?.text || '') };
}

export function runLocalAI(kind, payload, { signal, onProgress = () => {} } = {}) {
  if (!['tts','asr'].includes(kind)) return Promise.reject(new Error('지원하지 않는 처리입니다.'));
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('취소됨', 'AbortError')); return; }
    const worker = new Worker(new URL(kind === 'tts' ? './tts-worker.js' : './asr-worker.js', import.meta.url), { type: 'module' });
    let settled = false;
    const finish = (fn, result) => {
      if (settled) return;settled = true;clearTimeout(timer);signal?.removeEventListener('abort', cancel);worker.terminate();fn(result);
    };
    const cancel = () => finish(reject, new DOMException('취소됨', 'AbortError'));
    const timer = setTimeout(() => finish(reject, new Error('처리 시간이 너무 길어 중단했습니다. 더 짧은 구간으로 다시 시도해 주세요.')), 15 * 60 * 1000);
    signal?.addEventListener('abort', cancel, { once: true });
    worker.onmessage = event => {
      const data = event.data;
      if (data.type === 'progress') onProgress(data.progress, data.message);
      if (data.type === 'result') finish(resolve, data.result);
      if (data.type === 'error') finish(reject, new Error(data.message));
    };
    worker.onerror = () => finish(reject, new Error('브라우저 처리 엔진을 시작하지 못했습니다. 최신 Chrome/Edge에서 다시 열어 주세요.'));
    const transfer = kind === 'asr' && payload.audio instanceof Float32Array ? [payload.audio.buffer] : [];
    try { worker.postMessage(payload, transfer); } catch (error) { finish(reject, error); }
  });
}

export function installedVoices() {
  if (typeof speechSynthesis === 'undefined') return [];
  return speechSynthesis.getVoices().filter(v => v.localService).sort((a,b) => Number(b.lang.startsWith('ko')) - Number(a.lang.startsWith('ko')) || a.name.localeCompare(b.name));
}

export function speakInstalled(text, voiceURI, { rate = 1, signal } = {}) {
  const voice = installedVoices().find(v => v.voiceURI === voiceURI);
  if (!voice) return Promise.reject(new Error('기기에 설치된 음성을 선택해 주세요. 한국어 음성은 Windows/macOS 음성 설정에서 추가할 수 있습니다.'));
  const chunks = chunkSpeechText(text, 70);
  return new Promise((resolve, reject) => {
    let done = false, index = 0;
    const finish = (error) => { if (done) return;done = true;clearTimeout(timer);signal?.removeEventListener('abort', cancel);error ? reject(error) : resolve(); };
    const cancel = () => { finish(new DOMException('취소됨', 'AbortError'));speechSynthesis.cancel(); };
    const timer = setTimeout(() => { finish(new Error('기기 음성 재생이 응답하지 않습니다.'));speechSynthesis.cancel(); }, 5 * 60 * 1000);
    const next = () => {
      if (done) return;
      if (index >= chunks.length) { finish(); return; }
      const utterance = new SpeechSynthesisUtterance(chunks[index++]);
      utterance.voice = voice;utterance.lang = voice.lang;utterance.rate = rate;
      utterance.onend = next;utterance.onerror = event => finish(new Error('기기 음성을 재생하지 못했습니다: ' + event.error));
      speechSynthesis.speak(utterance);
    };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) return cancel();
    speechSynthesis.cancel();next();
  });
}
