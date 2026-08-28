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
  // 같은 로컬 서버라도 주소를 이렇게 치는 경우가 있다
  'http://127.0.0.1:5179',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:8788',
];
// Pages 미리보기 배포는 주소가 매번 달라진다
const ALLOWED_SUFFIX = '.shorts-studio-75p.pages.dev';

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (new URL(request.url).pathname === '/tts') return handleTts(request, env, cors);
    if (request.method !== 'POST') return json({ error: 'POST 로만 받습니다.' }, 405, cors);
    if (origin && !isAllowed(origin)) return json({ error: '허용되지 않은 출처입니다.' }, 403, cors);

    let file, lang, debug, hint;
    try {
      const form = await request.formData();
      file = form.get('audio');
      lang = String(form.get('lang') || 'ko').slice(0, 8);
      hint = String(form.get('hint') || '').slice(0, 400);
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
        // 채널에서 자주 쓰는 단어를 미리 알려주면 그쪽으로 알아듣는다
        ...(hint ? { initial_prompt: hint } : {}),
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
      const conf = confidenceOf(s);
      // 단어 단위 시각이 있으면 그게 제일 정확하다
      if (Array.isArray(s.words) && s.words.length) {
        out.push({ conf, words: s.words.map(w => ({
          text: String(w.word ?? w.text ?? '').trim(),
          start: num(w.start), end: num(w.end),
        })).filter(w => w.text) });
      } else if (s.text) {
        out.push({ conf, start: num(s.start), end: num(s.end), text: String(s.text).trim() });
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

/**
 * Whisper 가 구간마다 주는 지표를 0~1 신뢰도로 바꾼다.
 *
 * avg_logprob  0 에 가까울수록 확신. -0.1 쯤이면 또렷하고 -1.0 이면 웅얼거린 구간이다.
 * no_speech_prob  이게 높으면 애초에 말이 아니었을 수 있다 (숨소리, 배경음).
 *
 * 말이 흐려지는 구간은 이 둘이 같이 나빠지므로, 낮은 쪽을 신뢰도로 삼는다.
 */
function confidenceOf(s) {
  const lp = Number(s?.avg_logprob);
  const ns = Number(s?.no_speech_prob);
  let c = 1;
  if (Number.isFinite(lp)) {
    // -1.0 이하 → 0, 0 → 1 로 펼친다
    c = Math.min(c, Math.max(0, 1 + lp));
  }
  if (Number.isFinite(ns)) {
    c = Math.min(c, 1 - ns);
  }
  return Math.round(c * 100) / 100;
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
        if (text) out.push({ start: buf[0].start, end: buf[buf.length - 1].end, text, conf: item.conf });
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
      out.push({ start: item.start, end: item.end, text, conf: item.conf });
      continue;
    }
    // 시각 정보가 문장 단위뿐이면 글자 수에 비례해 나눈다
    const parts = splitByLength(text, MAX_CHARS);
    let cursor = item.start;
    for (const p of parts) {
      const d = span * (p.length / text.length);
      out.push({ start: cursor, end: cursor + d, text: p, conf: item.conf });
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
    clean.push({ start, end, text: s.text, conf: s.conf ?? 1 });
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

// ── 내레이션 (TTS) ─────────────────────────────────────
//
// 아직 목소리를 안 꽂았다. 어느 서비스를 쓸지 정하면 아래 provider 함수 하나만 채우면 된다.
// 편집기(public/js/tts.js)는 이 워커의 응답 모양만 알고 있어서, 서비스가 바뀌어도 그대로다.
//
// 꽂는 법:
//   1) 아래 PROVIDERS 에 함수를 하나 추가한다
//   2) wrangler secret put 으로 키를 넣는다 (코드에 키를 쓰지 않는다)
//   3) ACTIVE 를 그 이름으로 바꾼다
//
// 예) Azure 를 쓴다면
//   npx wrangler secret put AZURE_SPEECH_KEY
//   npx wrangler secret put AZURE_SPEECH_REGION

const ACTIVE = '';   // '' 이면 미연결. 'azure' | 'openai' 등으로 바꾼다

const PROVIDERS = {
  // azure: async (env, { text, voice, speed }) => {
  //   // 여기서 Azure Speech 를 부르고 아래 모양으로 돌려준다.
  //   // WordBoundary 이벤트를 marks 로 옮기면 자막이 오차 없이 정확해진다.
  //   return { audio: base64문자열, mime: 'audio/mpeg', marks: [{ text, start, end }] };
  // },
};

async function handleTts(request, env, cors) {
  const active = ACTIVE && PROVIDERS[ACTIVE] ? ACTIVE : '';

  // GET 은 상태 확인용. 편집기가 UI 를 켤지 정하는 데 쓴다.
  if (request.method === 'GET') {
    return json({
      configured: Boolean(active),
      provider: active,
      voices: [],
      error: active ? '' : '내레이션 목소리가 아직 연결되지 않았습니다. stt-worker/src/index.js 의 PROVIDERS 를 채우세요.',
    }, 200, cors);
  }

  if (request.method !== 'POST') return json({ error: 'POST 로만 받습니다.' }, 405, cors);

  if (!active) {
    return json({
      error: '내레이션 목소리가 아직 연결되지 않았습니다.',
      configured: false,
    }, 501, cors);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: '요청을 읽지 못했습니다. JSON 으로 보내세요.' }, 400, cors);
  }

  const text = String(body?.text || '').trim();
  if (!text) return json({ error: '읽을 내용이 없습니다.' }, 400, cors);
  if (text.length > 2000) return json({ error: '한 번에 2000자까지 됩니다.' }, 413, cors);

  try {
    const out = await PROVIDERS[active](env, {
      text,
      voice: String(body.voice || ''),
      speed: Number(body.speed) || 1,
    });
    return json({ ...out, provider: active }, 200, cors);
  } catch (e) {
    return json({ error: `내레이션 생성 실패: ${e?.message || e}` }, 502, cors);
  }
}
