// 내레이션(TTS) 층.
//
// 편집기는 "누가 읽었는지" 몰라야 한다. 텍스트를 주면 오디오와 구간 정보를 받을 뿐이고,
// 실제로 읽는 쪽(Azure / OpenAI / 로컬 VoiceBox …)은 워커 뒤에 숨는다.
// 나중에 목소리를 바꿀 때 이 파일과 워커만 건드리면 되고, 편집기 쪽은 그대로다.
//
// 자동 자막(transcribe.js)과 같은 구조다. 정적 사이트는 API 키를 숨길 수 없어서
// 워커가 대신 부른다.
//
// 서버 쪽 계약(약속):
//   POST {ENDPOINT}  application/json
//     { text: string, voice?: string, speed?: number, format?: 'mp3' }
//   200 -> {
//     audio:  base64 문자열,
//     mime:   'audio/mpeg',
//     marks:  [{ text: string, start: number, end: number }],   // 없을 수도 있다
//     provider: 'azure' | 'openai' | ...
//   }
//   501 -> { error, configured: false }   // 아직 목소리를 안 꽂았을 때

import { uid } from './util.js';

// 워커는 자동 자막과 같은 것을 쓴다. 경로만 다르다.
export const ENDPOINT = 'https://shorts-studio-stt.xixili0124.workers.dev/tts';

/** 한 번에 보낼 수 있는 길이. 너무 길면 워커가 시간 안에 못 끝낸다. */
export const MAX_CHARS = 2000;

export class NotConfiguredError extends Error {
  constructor(msg) {
    super(msg || '내레이션 목소리가 아직 연결되지 않았습니다.');
    this.name = 'NotConfiguredError';
  }
}

/**
 * 텍스트를 읽은 오디오를 받아 온다.
 * @returns {Promise<{blob:Blob, marks:Array<{text,start,end}>, provider:string}>}
 */
export async function speak(text, { voice = '', speed = 1, signal } = {}) {
  const script = String(text || '').trim();
  if (!script) throw new Error('읽을 내용을 입력해 주세요.');
  if (script.length > MAX_CHARS) {
    throw new Error(`한 번에 ${MAX_CHARS}자까지 됩니다. (지금 ${script.length}자)`);
  }

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: script, voice, speed }),
    signal,
  });

  let data = {};
  try { data = await res.json(); } catch { /* 아래에서 처리 */ }

  if (res.status === 501) throw new NotConfiguredError(data.error);
  if (!res.ok) throw new Error(data.error || `내레이션 생성 실패 (${res.status})`);
  if (!data.audio) throw new Error('오디오를 받지 못했습니다.');

  return {
    blob: base64ToBlob(data.audio, data.mime || 'audio/mpeg'),
    marks: Array.isArray(data.marks) ? data.marks : [],
    provider: data.provider || '',
  };
}

/** 목소리를 꽂아 뒀는지 워커에 물어본다. UI 를 켤지 정하는 데 쓴다. */
export async function checkAvailable() {
  try {
    const res = await fetch(ENDPOINT, { method: 'GET' });
    if (!res.ok) return { ok: false, reason: `워커 응답 ${res.status}` };
    const d = await res.json();
    return { ok: Boolean(d.configured), provider: d.provider || '', voices: d.voices || [], reason: d.error || '' };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// ── 받은 구간 정보를 자막으로 ─────────────────────────
const MAX_CAPTION_CHARS = 20;
const MAX_CAPTION_SEC = 4.0;

/**
 * 내레이션 구간 정보를 자막 목록으로 바꾼다.
 *
 * TTS 로 읽었으면 대본을 이미 알고 있으므로 음성 인식이 필요 없다.
 * 받아쓰기 오류도 없고 비용도 안 든다.
 *
 * marks 가 비어 있으면(타임스탬프를 안 주는 서비스) 글자 수에 비례해 나눈다.
 * 정확하진 않지만 없는 것보다 낫고, 타임라인에서 끌어 맞출 수 있다.
 */
export function marksToCaptions(marks, { text = '', duration = 0, offset = 0 } = {}) {
  if (marks?.length) return fromMarks(marks, offset);
  if (text && duration > 0) return fromLength(text, duration, offset);
  return [];
}

function fromMarks(marks, offset) {
  const out = [];
  let buf = [];

  const flush = () => {
    if (!buf.length) return;
    const body = buf.map(m => m.text).join(' ').replace(/\s+([.!?,…])/g, '$1').trim();
    if (body) {
      out.push({
        id: uid(),
        start: offset + buf[0].start,
        end: offset + buf[buf.length - 1].end,
        text: body,
      });
    }
    buf = [];
  };

  for (const m of marks) {
    if (!m?.text) continue;
    buf.push(m);
    const body = buf.map(x => x.text).join(' ');
    const span = m.end - buf[0].start;
    if (body.length >= MAX_CAPTION_CHARS || span >= MAX_CAPTION_SEC || /[.!?。？!]$/.test(m.text)) {
      flush();
    }
  }
  flush();
  return out;
}

function fromLength(text, duration, offset) {
  // 문장으로 먼저 끊고, 그래도 길면 글자 수로 자른다
  const pieces = [];
  for (const sentence of text.split(/(?<=[.!?。？!])\s+/)) {
    const s = sentence.trim();
    if (!s) continue;
    if (s.length <= MAX_CAPTION_CHARS * 1.5) { pieces.push(s); continue; }
    let line = '';
    for (const word of s.split(/\s+/)) {
      if ((line + ' ' + word).trim().length > MAX_CAPTION_CHARS && line) {
        pieces.push(line.trim());
        line = word;
      } else {
        line += ' ' + word;
      }
    }
    if (line.trim()) pieces.push(line.trim());
  }

  const total = pieces.reduce((n, p) => n + p.length, 0) || 1;
  const out = [];
  let cursor = offset;
  for (const p of pieces) {
    const d = duration * (p.length / total);
    out.push({ id: uid(), start: cursor, end: cursor + d, text: p });
    cursor += d;
  }
  return out;
}

// ── 도우미 ─────────────────────────────────────────────
function base64ToBlob(b64, mime) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
