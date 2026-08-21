// 자동 자막 서버 — Cloudflare Workers AI 의 Whisper 를 부른다.
//
// 편집기(정적 사이트)는 API 키를 숨길 수 없어서 음성 인식을 직접 못 부른다.
// 이 워커가 그 사이에 서서 AI 바인딩으로 대신 호출한다. 키를 코드에 넣을 필요가 없다.
//
// 계약(shorts-studio/public/js/transcribe.js 와 맞춰져 있다):
//   POST /  multipart/form-data { audio: File(wav), lang: 'ko' }
//   200 -> { segments: [{ start, end, text }], text, took_ms }

const MODEL = '@cf/openai/whisper-large-v3-turbo';
const MAX_BYTES = 25 * 1024 * 1024;

// 자막 한 줄이 길면 읽기 힘들다. 숏츠는 화면이 좁아서 더 그렇다.
const MAX_CHARS = 20;
const MAX_SEC = 4.0;
const MIN_SEC = 0.6;

const ALLOWED_ORIGINS = [
  'https://shorts-studio-75p.pages.dev',
  'http://localhost:5179',
  'http://localhost:3000',
  'http://localhost:8788',
];
// Pages 미리보기 배포는 주소가 매번 달라진다
const ALLOWED_SUFFIX = '.shorts-studio-75p.pages.dev';

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json({ error: 'POST 로만 받습니다.' }, 405, cors);
    if (origin && !isAllowed(origin)) return json({ error: '허용되지 않은 출처입니다.' }, 403, cors);

    let file, lang, debug;
    try {
      const form = await request.formData();
      file = form.get('audio');
      lang = String(form.get('lang') || 'ko').slice(0, 8);
      debug = form.get('debug') === '1' || new URL(request.url).searchParams.get('debug') === '1';
    } catch {
      return json({ error: '요청을 읽지 못했습니다. multipart/form-data 로 보내세요.' }, 400, cors);
    }

    if (!file || typeof file.arrayBuffer !== 'function') {
      return json({ error: 'audio 파일이 없습니다.' }, 400, cors);
    }
    if (file.size > MAX_BYTES) {
      return json({ error: `오디오가 너무 큽니다 (${(file.size / 1048576).toFixed(1)}MB, 상한 25MB).` }, 413, cors);
    }

    const started = Date.now();
    let result;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      result = await env.AI.run(MODEL, {
        audio: toBase64(bytes),
        language: lang,
        task: 'transcribe',
        vad_filter: true,
        // 무음 구간에서 같은 말을 반복해 뱉는 현상을 줄인다
        condition_on_previous_text: false,
      });
    } catch (e) {
      return json({ error: `음성 인식에 실패했습니다: ${e?.message || e}` }, 502, cors);
    }

    const segments = chunkSegments(toSegments(result));
    return json({
      segments,
      text: result?.text ?? result?.transcription_info?.text ?? '',
      took_ms: Date.now() - started,
      ...(debug ? { raw: result } : {}),
    }, 200, cors);
  },
};

// ── 응답 정리 ──────────────────────────────────────────
/** 모델 응답에서 {start, end, text} 목록을 뽑는다. 응답 모양이 바뀌어도 버티도록 여러 갈래를 본다. */
function toSegments(result) {
  if (!result) return [];

  const segs = result.segments || result.transcription_info?.segments;
  if (Array.isArray(segs) && segs.length) {
    const out = [];
    for (const s of segs) {
      // 단어 단위 시각이 있으면 그게 제일 정확하다
      if (Array.isArray(s.words) && s.words.length) {
        out.push({ words: s.words.map(w => ({
          text: String(w.word ?? w.text ?? '').trim(),
          start: num(w.start), end: num(w.end),
        })).filter(w => w.text) });
      } else if (s.text) {
        out.push({ start: num(s.start), end: num(s.end), text: String(s.text).trim() });
      }
    }
    if (out.length) return out;
  }

  if (Array.isArray(result.words) && result.words.length) {
    return [{ words: result.words.map(w => ({
      text: String(w.word ?? w.text ?? '').trim(),
      start: num(w.start), end: num(w.end),
    })).filter(w => w.text) }];
  }

  if (typeof result.vtt === 'string' && result.vtt.trim()) return parseVtt(result.vtt);

  const text = result.text || result.transcription_info?.text;
  if (text) return [{ start: 0, end: 0, text: String(text).trim() }];
  return [];
}

/** 긴 문장을 자막 길이로 쪼갠다. 단어 시각이 있으면 그걸로, 없으면 글자 수 비율로 나눈다. */
function chunkSegments(items) {
  const out = [];

  for (const item of items) {
    if (item.words) {
      let buf = [];
      const flush = () => {
        if (!buf.length) return;
        const text = joinWords(buf);
        if (text) out.push({ start: buf[0].start, end: buf[buf.length - 1].end, text });
        buf = [];
      };
      for (const w of item.words) {
        buf.push(w);
        const text = joinWords(buf);
        const span = w.end - buf[0].start;
        const breaks = /[.!?。？!，,…]$/.test(w.text);
        if (text.length >= MAX_CHARS || span >= MAX_SEC || breaks) flush();
      }
      flush();
      continue;
    }

    const text = (item.text || '').trim();
    if (!text) continue;
    const span = Math.max(0, item.end - item.start);
    if (text.length <= MAX_CHARS * 1.5 || span <= 0) {
      out.push({ start: item.start, end: item.end, text });
      continue;
    }
    // 시각 정보가 문장 단위뿐이면 글자 수에 비례해 나눈다
    const parts = splitByLength(text, MAX_CHARS);
    let cursor = item.start;
    for (const p of parts) {
      const d = span * (p.length / text.length);
      out.push({ start: cursor, end: cursor + d, text: p });
      cursor += d;
    }
  }

  // 겹침 정리 + 너무 짧은 조각 늘리기
  const clean = [];
  for (const s of out) {
    if (!s.text) continue;
    let start = Math.max(0, round3(s.start));
    let end = round3(Math.max(s.end, start + MIN_SEC));
    const prev = clean[clean.length - 1];
    if (prev && start < prev.end) start = prev.end;
    if (end <= start) end = start + MIN_SEC;
    clean.push({ start, end, text: s.text });
  }
  return clean;
}

function joinWords(words) {
  return words.map(w => w.text).join(' ').replace(/\s+([.!?,…])/g, '$1').replace(/\s{2,}/g, ' ').trim();
}

function splitByLength(text, max) {
  const parts = [];
  let line = '';
  for (const token of text.split(/(\s+)/)) {
    if ((line + token).trim().length > max && line.trim()) {
      parts.push(line.trim());
      line = token.trim() ? token : '';
    } else {
      line += token;
    }
  }
  if (line.trim()) parts.push(line.trim());
  return parts;
}

function parseVtt(vtt) {
  const out = [];
  for (const block of vtt.replace(/\r/g, '').replace(/^WEBVTT.*\n/, '').split(/\n{2,}/)) {
    const lines = block.split('\n').filter(Boolean);
    const arrow = lines.findIndex(l => l.includes('-->'));
    if (arrow < 0) continue;
    const [a, b] = lines[arrow].split('-->');
    const text = lines.slice(arrow + 1).join(' ').trim();
    if (!text) continue;
    out.push({ start: vttTime(a), end: vttTime(b), text });
  }
  return out;
}

function vttTime(s) {
  const m = String(s).trim().match(/(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/);
  if (!m) return 0;
  return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4].padEnd(3, '0')) / 1000;
}

// ── 도우미 ─────────────────────────────────────────────
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round3 = v => Math.round(v * 1000) / 1000;

/** 큰 배열을 한 번에 넘기면 스택이 터진다. 조각내서 붙인다. */
function toBase64(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function isAllowed(origin) {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    const host = new URL(origin).hostname;
    return host.endsWith(ALLOWED_SUFFIX.slice(1)) || host.endsWith(ALLOWED_SUFFIX);
  } catch {
    return false;
  }
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': isAllowed(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors },
  });
}
