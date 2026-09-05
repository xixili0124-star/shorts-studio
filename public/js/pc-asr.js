// 설치·승인한 PC 연결만 사용하며 외부 음성 API로 전환하지 않습니다.
import { encodeWav } from './ai-client.js';
import { whisperCaptions } from './local-ai.js';
import { canUsePcEngine, pcTransportContext } from './pc-connection.js';

export const PC_ASR_MODEL = 'large-v3-turbo';
export const PC_ASR_SETUP_URL = '/pc-asr-setup.html';
const PREFIX = '/api/pc-asr';
const JOB_ID = /^[a-f0-9]{32}$/;
const abortError = () => new DOMException('PC 자막 결과 받기를 취소했습니다.', 'AbortError');
const check = signal => { if (signal?.aborted) throw abortError(); };
const validDevice = value => value === 'cuda' || value === 'cpu';

export function isPcAsrOrigin(location = globalThis.location) {
  return canUsePcEngine(location);
}

export function pcAsrDeviceLabel(status) {
  if (!validDevice(status?.device)) return '실행 장치 미확인';
  return (status.device === 'cuda' ? 'GPU (CUDA)' : 'CPU') + (typeof status.computeType === 'string' && status.computeType ? ' · ' + status.computeType : '');
}

async function readBounded(response, maximum, signal) {
  const announced = Number(response.headers.get('Content-Length') || 0);
  if (!Number.isFinite(announced) || announced < 0 || announced > maximum) throw new Error('PC 자막 응답이 너무 큽니다. 인식 구간을 나누어 주세요.');
  if (!response.body?.getReader) {
    const bytes = await response.arrayBuffer();check(signal);
    if (bytes.byteLength > maximum) throw new Error('PC 자막 응답이 너무 큽니다.');
    return new Uint8Array(bytes);
  }
  const reader = response.body.getReader(), parts = [];let length = 0;
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once:true });
  try {
    while (true) {
      check(signal);const { value, done } = await reader.read();check(signal);if (done) break;
      length += value.byteLength;
      if (length > maximum) { await reader.cancel();throw new Error('PC 자막 응답이 너무 큽니다.'); }
      parts.push(value);
    }
  } finally { signal?.removeEventListener('abort', cancel);reader.releaseLock(); }
  const bytes = new Uint8Array(length);let offset = 0;
  for (const part of parts) { bytes.set(part, offset);offset += part.byteLength; }
  return bytes;
}

async function request(path, { method = 'GET', body, signal, timeout = 15000, maximum = 65536, location = globalThis.location, fetchImpl = globalThis.fetch } = {}) {
  const transport = pcTransportContext(location);
  if (!['/status', '/transcribe', '/cancel'].includes(path) && !/^\/jobs\/[a-f0-9]{32}$/.test(path)) throw new Error('지원하지 않는 PC 자막 요청입니다.');
  check(signal);const ctrl = new AbortController();let expired = false;
  const cancel = () => ctrl.abort();signal?.addEventListener('abort', cancel, { once:true });
  const timer = setTimeout(() => { expired = true;ctrl.abort(); }, timeout);
  let stop;
  const stopped = new Promise((resolve, reject) => {
    stop = () => reject(expired ? new Error('PC 자막 연결 시간이 초과되었습니다. 작업이 남아 있을 수 있으니 연결 상태를 확인해 주세요.') : abortError());
    ctrl.signal.addEventListener('abort', stop, { once:true });
  });
  const work = async () => {
    const headers = { ...transport.headers, 'X-Studio-PC-ASR':'1' };
    if (method === 'POST') {
      headers['X-Studio-Consent'] = 'audio-to-local-asr';
      headers['Content-Type'] = path === '/transcribe' ? 'audio/wav' : 'application/json';
    }
    const response = await fetchImpl(transport.base + PREFIX + path, { ...transport.options, method, headers, ...(body === undefined ? {} : { body }), signal:ctrl.signal, credentials:'omit', cache:'no-store', redirect:'error' });
    check(ctrl.signal);
    const json = /^application\/json(?:;|$)/i.test(response.headers.get('Content-Type') || '');
    if (!response.ok) {
      let message = 'PC 자막 기능에 연결하지 못했습니다. 설치·실행 상태를 확인해 주세요.';
      if (json) {
        try {
          const payload = JSON.parse(new TextDecoder().decode(await readBounded(response, 65536, ctrl.signal)));
          if (typeof payload?.error?.message === 'string' && payload.error.message.length <= 1000) message = payload.error.message;
        } catch {}
      }
      check(ctrl.signal);throw new Error(message);
    }
    if (!json) throw new Error('PC 자막 서버를 찾지 못했습니다. 최신 PC용 편집기로 다시 실행해 주세요.');
    const bytes = await readBounded(response, maximum, ctrl.signal);check(ctrl.signal);
    try {
      const value = JSON.parse(new TextDecoder().decode(bytes));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      return value;
    } catch { throw new Error('PC 자막 서버 응답을 읽지 못했습니다.'); }
  };
  try { return await Promise.race([work(), stopped]); }
  catch (error) {
    if (signal?.aborted) throw abortError();
    if (expired) throw new Error('PC 자막 연결 시간이 초과되었습니다. 작업이 남아 있을 수 있으니 연결 상태를 확인해 주세요.');
    if (error instanceof TypeError) throw new Error('PC 자막 연결이 끊겼습니다. 기존 편집은 유지됩니다. PC 서버를 확인해 주세요.');
    throw error;
  } finally { clearTimeout(timer);signal?.removeEventListener('abort', cancel);ctrl.signal.removeEventListener('abort', stop); }
}

export async function pcAsrStatus(options) {
  const status = await request('/status', options);
  const knownDevice = validDevice(status.device) && typeof status.computeType === 'string';
  const unconfigured = status.configured === false && status.available === false && status.device === null && status.computeType === null;
  if (status.localServer !== true || status.provider !== 'faster-whisper' || status.model !== PC_ASR_MODEL || typeof status.configured !== 'boolean' || typeof status.available !== 'boolean' || typeof status.busy !== 'boolean' || (!knownDevice && !unconfigured)) throw new Error('자동 자막 기능의 준비 상태를 확인하지 못했습니다.');
  return { localServer:true, provider:'faster-whisper', model:PC_ASR_MODEL, modelName:'자동 자막', configured:status.configured, available:status.available, busy:status.busy, device:status.device, computeType:knownDevice ? status.computeType.slice(0, 80) : null, reason:typeof status.reason === 'string' ? status.reason.slice(0, 1000) : '', setupUrl:PC_ASR_SETUP_URL };
}

export function pcAsrWav(audio) {
  if (!(audio instanceof Float32Array) || !audio.length || audio.length > 16000 * 180 || audio.some(value => !Number.isFinite(value))) throw new Error('PC 자막에는 최대 3분의 정상적인 16kHz 오디오가 필요합니다.');
  return encodeWav({ length:audio.length, numberOfChannels:1, sampleRate:16000, getChannelData:() => audio });
}

function validateResult(result) {
  if (!result || result.model !== PC_ASR_MODEL || !validDevice(result.device) || typeof result.computeType !== 'string' || result.computeType.length > 80 || typeof result.text !== 'string' || result.text.length > 100000 || !Array.isArray(result.words) || result.words.length > 20000 || !Array.isArray(result.segments) || result.segments.length > 10000) throw new Error('PC 자막 결과 형식이 올바르지 않습니다. 기존 자막은 유지합니다.');
  return result;
}

function mergeSourceWordFragments(text, words, duration) {
  const tokens = typeof text === 'string' ? text.match(/\S+/gu) : null;
  if (!tokens?.length) return words;
  const fragments = [];let previousStart = -Infinity, previousEnd = -Infinity;
  for (const word of words) {
    // 잘못된 시각을 이웃 조각의 시각으로 덮어 감추지 않습니다.
    if (typeof word?.word !== 'string' || !Number.isFinite(word.start) || !Number.isFinite(word.end) || word.end <= word.start || Math.min(duration, word.end) <= Math.max(0, word.start) || word.start < previousStart || word.end < previousEnd) return words;
    const fragment = word.word.replace(/\s/gu, '');
    if (!fragment) return words;
    fragments.push(fragment);previousStart = word.start;previousEnd = word.end;
  }
  if (tokens.join('') !== fragments.join('')) return words;
  const boundaries = new Map([[0, 0]]);let position = 0;
  for (let index = 0; index < fragments.length; index++) {
    position += fragments[index].length;boundaries.set(position, index + 1);
  }
  const groups = new Map();position = 0;
  for (const token of tokens) {
    const first = boundaries.get(position);position += token.length;
    const after = boundaries.get(position);
    // 원문 공백 경계가 조각 경계와 맞을 때만 합칩니다. 여러 어절에 걸친 조각은 쪼개지 않습니다.
    if (first !== undefined && after !== undefined) groups.set(first, { after, text:token });
  }
  const merged = [];let index = 0;
  while (index < words.length) {
    const group = groups.get(index);
    if (!group) { merged.push(words[index++]);continue; }
    merged.push({ word:group.text, start:words[index].start, end:words[group.after - 1].end });
    index = group.after;
  }
  return merged;
}

export function pcAsrCaptions(result, duration, offset = 0) {
  validateResult(result);
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(offset) || offset < 0) throw new Error('자막 인식 구간이 올바르지 않습니다.');
  const captions = [];let skipped = Number.isSafeInteger(result.skipped) && result.skipped >= 0 && result.skipped <= 10000 ? result.skipped : 0, wordCaptions = 0, segmentCaptions = 0;
  const appendWords = words => {
    const chunks = words.map(word => ({ text:typeof word?.word === 'string' ? word.word : '', timestamp:[word?.start, word?.end] }));
    const normalized = whisperCaptions({ text:result.text, chunks }, duration, offset);
    skipped += normalized.skipped;wordCaptions += normalized.captions.length;captions.push(...normalized.captions);
    return normalized.captions.length;
  };
  // 일부 문장은 단어 시각 없이 문장 시각만 있습니다. flat words만 읽으면 그 문장이 사라집니다.
  for (const segment of result.segments) {
    const words = Array.isArray(segment?.words) ? segment.words : [];
    if (words.length && appendWords(mergeSourceWordFragments(segment.text, words, duration))) continue;
    const normalized = whisperCaptions({ text:result.text, chunks:[{ text:typeof segment?.text === 'string' ? segment.text : '', timestamp:[segment?.start, segment?.end] }] }, duration, offset);
    skipped += normalized.skipped;segmentCaptions += normalized.captions.length;captions.push(...normalized.captions);
  }
  if (!result.segments.length) appendWords(result.words);
  captions.sort((a, b) => a.start - b.start);
  return { captions:captions.map(caption => ({ ...caption, generated:'pc-whisper-turbo' })), skipped, text:result.text, segmentFallback:segmentCaptions > 0, timingMode:segmentCaptions ? (wordCaptions ? 'mixed' : 'segment') : 'word', model:result.model, device:result.device, computeType:result.computeType };
}

// 생성 요청이 취소 뒤 작업 ID를 돌려줘도 해당 작업을 회수해 취소합니다.
export async function transcribePcAudio(audio, { signal, onProgress = () => {}, location = globalThis.location, fetchImpl = globalThis.fetch, pollInterval = 500, timeout = 15 * 60 * 1000, requestTimeout = 15000, cancelTimeout = 5000 } = {}) {
  pcTransportContext(location);
  check(signal);const wav = pcAsrWav(audio);
  return new Promise((resolve, reject) => {
    let settled = false, jobId = '', cancellationSent = false, pollTimer = null;
    const ctrl = new AbortController();
    const common = { location, fetchImpl, timeout:requestTimeout };
    const cancelRemote = () => {
      if (!jobId || cancellationSent) return;cancellationSent = true;
      request('/cancel', { ...common, method:'POST', body:JSON.stringify({ jobId }), timeout:cancelTimeout }).catch(() => {});
    };
    const finish = (fn, value, cancelJob = false) => {
      if (settled) return;settled = true;clearTimeout(timer);clearTimeout(pollTimer);
      signal?.removeEventListener('abort', cancel);ctrl.abort();if (cancelJob) cancelRemote();fn(value);
    };
    const cancel = () => finish(reject, abortError(), true);
    const timer = setTimeout(() => finish(reject, new Error('PC 자막 처리 시간이 초과되었습니다. 종료를 요청했으니 연결 상태를 확인하고 구간을 나눠 주세요.'), true), timeout);
    signal?.addEventListener('abort', cancel, { once:true });
    const poll = async () => {
      try {
        const job = await request('/jobs/' + jobId, { ...common, maximum:2 * 1024 * 1024, signal:ctrl.signal });
        if (settled) return;
        if (!['running', 'done', 'failed', 'cancelled'].includes(job.state)) throw new Error('PC 자막 작업 상태가 올바르지 않습니다.');
        if (job.state === 'done') { finish(resolve, validateResult(job.result));return; }
        if (job.state === 'failed') { finish(reject, new Error(typeof job.error?.message === 'string' && job.error.message.length <= 1000 ? job.error.message : 'PC 자막 인식에 실패했습니다. 기존 자막은 유지합니다.'));return; }
        if (job.state === 'cancelled') { finish(reject, new Error('PC 자막 작업이 취소되었습니다. 기존 자막은 유지합니다.'));return; }
        onProgress(Number.isFinite(job.progress) ? Math.max(0, Math.min(1, job.progress)) : null, typeof job.message === 'string' ? job.message.slice(0, 1000) : 'PC에서 한국어 말소리를 인식하고 있어요…');
        pollTimer = setTimeout(poll, pollInterval);
      } catch (error) { if (!settled) finish(reject, error, true); }
    };
    // 오디오 전송은 사용자가 실행한 이 요청뿐입니다. 취소해도 짧게 응답을 회수해 작업 ID를 확보합니다.
    request('/transcribe', { ...common, method:'POST', body:wav }).then(created => {
      if (typeof created.jobId !== 'string' || !JOB_ID.test(created.jobId)) throw new Error('PC 자막 작업 번호를 확인하지 못했습니다. 연결 상태를 확인해 주세요.');
      jobId = created.jobId;
      if (settled) { cancelRemote();return; }
      onProgress(null, '자동 자막을 만드는 중…');poll();
    }).catch(error => { if (!settled) finish(reject, error, true); });
  });
}
