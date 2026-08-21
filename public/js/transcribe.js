// 자동 자막(음성 인식) 연결 지점.
//
// 정적 사이트는 API 키를 숨길 수 없어서 음성 인식을 직접 못 부른다.
// Cloudflare Workers AI(Whisper)를 부르는 워커가 그 사이에 서 있다.
//
// 서버 쪽 계약(약속):
//   POST {ENDPOINT}  multipart/form-data { audio: File(webm/wav), lang: 'ko' }
//   200 -> { segments: [{ start: number(초), end: number(초), text: string }] }

import { uid } from './util.js';

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
  })).filter(s => s.text);
}

/** AudioBuffer -> 16bit PCM WAV (모노 16kHz, STT 용량 절약) */
export function encodeWav(buffer, targetRate = 16000) {
  const src = buffer.getChannelData(0);
  const ratio = buffer.sampleRate / targetRate;
  const len = Math.floor(src.length / ratio);
  const out = new DataView(new ArrayBuffer(44 + len * 2));

  const str = (off, s) => { for (let i = 0; i < s.length; i++) out.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); out.setUint32(4, 36 + len * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true);
  out.setUint16(22, 1, true); out.setUint32(24, targetRate, true);
  out.setUint32(28, targetRate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
  str(36, 'data'); out.setUint32(40, len * 2, true);

  for (let i = 0; i < len; i++) {
    const v = Math.max(-1, Math.min(1, src[Math.floor(i * ratio)] || 0));
    out.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Blob([out.buffer], { type: 'audio/wav' });
}
