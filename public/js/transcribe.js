// 자동 자막(음성 인식) 연결 지점.
//
// 정적 사이트는 API 키를 숨길 수 없어서 음성 인식을 직접 못 부른다.
// Cloudflare Workers AI(Whisper)를 부르는 워커가 그 사이에 서 있다.
//
// 서버 쪽 계약(약속):
//   POST {ENDPOINT}  multipart/form-data { audio: File(webm/wav), lang: 'ko' }
//   200 -> { segments: [{ start: number(초), end: number(초), text: string }] }

import { uid } from './util.js';
import { transcriptionCaptions, encodeWav as encodePcmWav } from './ai-client.js';
import { monoPcm } from './silence.js';

// 서버 코드는 stt-worker/ 에 있다. 배포: 그 폴더에서 npx wrangler deploy
export const ENDPOINT = 'https://shorts-studio-stt.xixili0124.workers.dev';
export const isAvailable = () => Boolean(ENDPOINT);

/**
 * 믹싱된 오디오(AudioBuffer)를 WAV 로 만들어 STT 서버에 보내고 자막 배열을 받는다.
 * @returns {Promise<Array<{id:string,start:number,end:number,text:string}>>}
 */
export async function transcribe(audioBuffer, { lang = 'ko', signal } = {}) {
  if (!isAvailable()) {
    throw new Error('자동 자막 서버가 아직 연결되지 않았습니다.');
  }
  const wav = encodeWav(audioBuffer);
  const form = new FormData();
  form.append('audio', new File([wav], 'audio.wav', { type: 'audio/wav' }));
  form.append('lang', lang);

  const res = await fetch(ENDPOINT, { method: 'POST', body: form, signal });
  if (!res.ok) throw new Error(`자동 자막 실패 (${res.status})`);
  const data = await res.json();
  return (data.segments || []).map(s => ({
    id: uid(),
    start: Number(s.start) || 0,
    end: Math.max(Number(s.end) || 0, (Number(s.start) || 0) + 0.4),
    text: String(s.text || '').trim(),
    // 0~1. 낮으면 모델이 알아듣기 애매해한 구간이라 사람이 확인하는 게 좋다.
    conf: Number.isFinite(Number(s.conf)) ? Number(s.conf) : 1,
  })).filter(s => s.text);
}

/**
 * 워커의 원본 응답입니다. 새 편집기는 문장 시각을 그대로 쓰고 인식 원문도 함께 보여 줍니다.
 * 기존 transcribe() 는 첫 화면 편집기가 쓰고 있어 그대로 둡니다.
 */
export async function transcribeRaw(audioBuffer, { lang = 'ko', signal } = {}) {
  if (!isAvailable()) throw new Error('자동 자막 서버가 아직 연결되지 않았습니다.');
  const form = new FormData();
  form.append('audio', new File([encodeWav(audioBuffer)], 'audio.wav', { type: 'audio/wav' }));
  form.append('lang', lang);
  const res = await fetch(ENDPOINT, { method: 'POST', body: form, signal });
  if (!res.ok) {
    // 워커는 실패 이유를 JSON 으로 돌려줍니다. 상태 코드만 보여 주면 원인을 알 수 없습니다.
    let reason = '';
    try { reason = String((await res.json())?.error || ''); } catch {}
    throw new Error(reason || (res.status === 429
      ? '자막 서버의 하루 사용량을 넘었습니다. 잠시 뒤 다시 시도하거나 브라우저 엔진을 사용해 주세요.'
      : '자동 자막 서버 오류 (' + res.status + ')'));
  }
  const data = await res.json();
  if (!data || !Array.isArray(data.segments)) throw new Error('자막 서버 응답 형식이 올바르지 않습니다.');
  return data;
}

/** 서버 응답을 편집기 자막으로 바꿉니다. 문장 나누기는 워커가 이미 해 둡니다. */
export function serverCaptions(result, duration, offset = 0) {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(offset) || offset < 0) {
    throw new Error('자막 인식 구간이 올바르지 않습니다.');
  }
  const list = Array.isArray(result?.segments) ? result.segments : [];
  const usable = [];
  let skipped = 0;
  for (const segment of list) {
    const text = String(segment?.text || '').trim();
    if (!text) continue;
    const start = Number(segment.start), end = Number(segment.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start >= duration) { skipped++; continue; }
    usable.push({ text, start: Math.max(0, start) + offset, end: Math.min(duration, end) + offset });
  }
  const captions = transcriptionCaptions({ segments: usable }).map(c => ({ ...c, generated: 'server-whisper' }));
  const text = String(result?.text || '').trim()
    || list.map(s => String(s?.text || '').trim()).filter(Boolean).join(' ');
  return { captions, skipped, text };
}

/** AudioBuffer -> 16bit PCM WAV (모노 16kHz, STT 용량 절약) */
export function encodeWav(buffer, targetRate = 16000) {
  // PC·브라우저 자막과 같은 채널 선택을 사용해 오른쪽 채널의 말소리도 보존합니다.
  const samples = monoPcm(buffer, targetRate);
  return encodePcmWav({ sampleRate: targetRate, numberOfChannels: 1,
    length: samples.length, getChannelData: () => samples });
}
