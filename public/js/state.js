// 프로젝트 상태 모델 + 타임라인 계산
// 여기 있는 값들만이 "진실"이고, 미리보기와 내보내기는 둘 다 이 값으로 그린다.

export const FONTS = [
  { css: '"Black Han Sans"', label: '검은고딕', weight: 400 },
  { css: '"Do Hyeon"', label: '도현', weight: 400 },
  { css: '"Jua"', label: '주아', weight: 400 },
  { css: '"Gugi"', label: '구기', weight: 400 },
  { css: '"Nanum Gothic"', label: '나눔고딕', weight: 800 },
  { css: '"Nanum Pen Script"', label: '나눔손글씨', weight: 400 },
  { css: '"Noto Sans KR"', label: '본고딕', weight: 900 },
  { css: '"Noto Serif KR"', label: '본명조', weight: 900 },
];

export const ACCENT = '#ff3b5c';

export const project = {
  // 출력 설정
  width: 1080,
  height: 1920,
  fps: 30,
  quality: 'high',
  fileName: 'shorts',

  clips: [],
  overlays: [],
  captions: [],

  captionStyle: {
    font: '"Noto Sans KR"',
    size: 58,
    color: '#ffffff',
    stroke: '#000000',
    strokeW: 9,
    box: 'none',
    bottom: 0.18,   // 화면 아래에서 떨어진 비율
  },

  audio: {
    originalVolume: 1,
    bgm: null, // { name, file, buffer(AudioBuffer), volume, offset, fadeIn, fadeOut, loop }
    tracks: [], // 소재함과 연결되는 독립 오디오 클립
  },

  // 템플릿 — 영상을 화면 가운데 밴드에 넣고 위아래를 단색으로 채우는 구성.
  // 한국 숏츠에서 흔한 "상단 훅 문구 + 영상 + 하단 댓글" 형식이다.
  template: {
    mode: 'none',          // 'none' | 'band'
    bg: '#000000',
    videoTop: 0.24,        // 영상 밴드가 시작하는 높이 비율
    videoHeight: 0.44,     // 영상 밴드 높이 비율

    hook: {
      on: true,
      text: '주의) 절대 밖에서\n스피커로 보지 마시오',
      font: '"Black Han Sans"',
      size: 92,
      color: '#ffffff',
      accent: '#ffe14d',   // *별표* 로 감싼 부분에 칠할 색
      y: 0.10,             // 문구 블록의 세로 중심
    },

    comment: {
      on: true,
      name: '착한카피바라182',
      text: '와 진짜… 어떻게 저런 말을 할 수가 있지?',
      likes: '5.4천',
      time: '6시간 전',
      y: 0.76,             // 카드 상단 위치
      theme: 'dark',       // 'dark' | 'light'
    },

    credit: {
      on: false,
      text: '',
      size: 40,
      color: '#9aa3b2',
      y: 0.94,
    },
  },
};

/** 템플릿이 켜져 있으면 영상이 들어갈 사각형을, 아니면 null 을 준다 */
export function videoBand(W, H) {
  const t = project.template;
  if (t.mode !== 'band') return null;
  return {
    x: 0,
    y: H * t.videoTop,
    w: W,
    h: H * t.videoHeight,
  };
}

/** *별표* 로 감싼 조각을 강조색으로 칠하기 위해 잘라 놓는다 */
export function splitAccent(text) {
  const out = [];
  for (const part of String(text).split(/(\*[^*\n]+\*)/g)) {
    if (!part) continue;
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      out.push({ text: part.slice(1, -1), accent: true });
    } else {
      out.push({ text: part, accent: false });
    }
  }
  return out;
}

/** 현재 선택 상태 */
export const sel = { clipId: null, ovId: null, capId: null };

// ── 클립 기본값 ─────────────────────────────────────────
export function newClipDefaults(type) {
  return {
    id: null,
    type,                 // 'video' | 'image'
    name: '',
    file: null,
    url: null,
    thumb: null,
    el: null,             // HTMLVideoElement (video)
    bitmap: null,         // ImageBitmap (image)
    natW: 0, natH: 0,
    srcDuration: 0,       // 원본 길이(초) — video
    trimStart: 0,
    trimEnd: 0,
    imgDuration: 3,       // image 전용
    ken: 'none',          // image 전용 움직임
    fit: 'cover',
    bg: 'blur',
    scale: 1,
    offX: 0,
    offY: 0,
    fadeIn: 0,
    fadeOut: 0,
    volume: 1,
    muted: type === 'image',
    hasAudio: false,
    transitionOut: { type: 'cut', duration: 0 },
  };
}

// ── 타임라인 계산 ───────────────────────────────────────
export function clipDuration(c) {
  if (!c) return 0;
  return c.type === 'video'
    ? Math.max(0.05, c.trimEnd - c.trimStart)
    : Math.max(0.1, c.imgDuration);
}

export function totalDuration() {
  return buildLayout().total;
}

export function clipStartTime(index) {
  return buildLayout().entries[index]?.start ?? 0;
}

/** 전체 타임라인 시각 t 에서 재생 중인 클립과 그 내부 시각 */
export function clipAt(t) {
  return layersAt(t).reduce((a, b) => !a || b.weight >= a.weight ? b : a, null);
}

/** 전환 겹침을 포함한 유일한 시간표. 인접 클립 절반 이내라 세 장면이 겹치지 않습니다. */
export function buildLayout(doc = project) {
  let start = 0, overlapIn = 0;
  const entries = doc.clips.map((clip, index) => {
    const duration = clipDuration(clip);
    const next = doc.clips[index + 1];
    const requested = Number(clip.transitionOut?.duration) || 0;
    const overlapOut = next && ['dissolve', 'fade', 'flash'].includes(clip.transitionOut?.type)
      ? Math.max(0, Math.min(2, requested, duration / 2, clipDuration(next) / 2)) : 0;
    const entry = { clip, index, start, end: start + duration, duration, overlapIn, overlapOut };
    start += duration - overlapOut;
    overlapIn = overlapOut;
    return entry;
  });
  return { entries, total: entries.at(-1)?.end || 0 };
}

/** 미리보기·인코더·오디오가 공유하는 활성 레이어와 선형 교차 가중치. */
export function layersAt(t, layout = buildLayout()) {
  if (!layout.total) return [];
  t = Math.max(0, Math.min(t, layout.total - 1e-7));
  return layout.entries.filter(e => t >= e.start && t < e.end).map(e => {
    const local = t - e.start;
    let weight = 1;
    if (e.overlapIn > 0 && local < e.overlapIn) weight = local / e.overlapIn;
    if (e.overlapOut > 0 && local > e.duration - e.overlapOut) weight = (e.duration - local) / e.overlapOut;
    return { ...e, local, weight: Math.min(1, Math.max(0, weight)) };
  });
}

export function clipFadeGain(clip, local, duration) {
  let g = 1;
  const fadeIn = Math.min(clip.fadeIn || 0, duration / 2);
  const fadeOut = Math.min(clip.fadeOut || 0, duration / 2);
  if (fadeIn > 0 && local < fadeIn) g = Math.min(g, local / fadeIn);
  if (fadeOut > 0 && local > duration - fadeOut) g = Math.min(g, (duration - local) / fadeOut);
  return Math.max(0, g);
}

/** 연결된 자막/그래픽만 원본 시각을 따라갑니다. SRT 등 시퀀스 기준 항목은 그대로 둡니다. */
export function syncAnchoredItems() {
  const entries = new Map(buildLayout().entries.map(e => [e.clip.id, e]));
  for (const item of [...project.overlays, ...project.captions]) {
    if (!item.anchor) continue;
    const e = entries.get(item.anchor.clipId);
    if (!e) { item.start = item.end = 0; continue; }
    const sourceStart = e.clip.type === 'video' ? e.clip.trimStart : 0;
    const s = Math.max(0, item.anchor.sourceStart - sourceStart);
    const end = Math.min(e.duration, item.anchor.sourceEnd - sourceStart);
    item.start = e.start + Math.min(e.duration, s);
    item.end = e.start + Math.max(s, end);
    if (s >= e.duration || end <= 0) item.end = item.start;
  }
}

export function anchorItem(item, clipId) {
  const e = buildLayout().entries.find(e => e.clip.id === clipId);
  if (!e) { delete item.anchor; return; }
  const src = e.clip.type === 'video' ? e.clip.trimStart : 0;
  item.anchor = { clipId, sourceStart: src + item.start - e.start, sourceEnd: src + item.end - e.start };
}

/** 클립 내부 시각 -> 원본 파일 안의 시각 */
export function sourceTime(clip, local) {
  return clip.type === 'video' ? clip.trimStart + local : 0;
}

export function activeOverlays(t) {
  return project.overlays.filter(o => t >= o.start && t < o.end);
}

export function activeCaption(t) {
  // 겹칠 경우 나중에 시작한 자막이 이긴다
  let found = null;
  for (const c of project.captions) {
    if (t >= c.start && t < c.end && (!found || c.start > found.start)) found = c;
  }
  return found;
}

// ── 조회 헬퍼 ───────────────────────────────────────────
export const getClip = id => project.clips.find(c => c.id === id) || null;
export const getOverlay = id => project.overlays.find(o => o.id === id) || null;
export const getCaption = id => project.captions.find(c => c.id === id) || null;
export const selectedClip = () => getClip(sel.clipId);

export function newOverlay(t) {
  return {
    id: null,
    text: '여기에 훅 문구',
    start: t,
    end: Math.min(t + 3, Math.max(t + 1, totalDuration())),
    font: '"Black Han Sans"',
    size: 78,
    color: '#ffffff',
    stroke: '#000000',
    strokeW: 8,
    box: 'none',
    align: 'center',
    x: 0.5,
    y: 0.15,
    anim: 'up',
  };
}

export function sortCaptions() {
  project.captions.sort((a, b) => a.start - b.start);
}
