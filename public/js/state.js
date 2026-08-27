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
    ? Math.max(0.000001, c.trimEnd - c.trimStart)
    : Math.max(0.000001, c.imgDuration);
}

export function totalDuration() {
  return buildLayout().total;
}

export function clipStartTime(index) {
  return buildLayout().entries.find(entry => entry.index === index)?.start ?? 0;
}

/** 전체 타임라인 시각 t 에서 재생 중인 클립과 그 내부 시각 */
export function clipAt(t) {
  return layersAt(t).reduce((a, b) => !a || b.weight >= a.weight ? b : a, null);
}

/** 시작 시각이 없는 이전 프로젝트만 연속 배치로 해석합니다. 조회 중에는 문서를 바꾸지 않습니다. */
export function buildLayout(doc = project) {
  let cursor = 0;
  const entries = (doc.clips || []).map((clip, index) => {
    const duration = clipDuration(clip);
    const next = doc.clips[index + 1];
    const requested = Number(clip.transitionOut?.duration) || 0;
    const legacyOverlap = next && ['dissolve', 'fade', 'flash'].includes(clip.transitionOut?.type)
      ? Math.max(0, Math.min(2, requested, duration / 2, clipDuration(next) / 2)) : 0;
    const start = Number.isFinite(clip.start) ? Math.max(0, clip.start) : cursor;
    const entry = { clip, index, start, end: start + duration, duration, overlapIn: 0, overlapOut: 0 };
    cursor = entry.end - legacyOverlap;
    return entry;
  }).sort((a, b) => a.start - b.start || a.index - b.index);
  for (let i = 0; i < entries.length - 1; i++) {
    const left = entries[i], right = entries[i + 1], transition = left.clip.transitionOut;
    const overlap = Math.round((left.end - right.start) * 1e9) / 1e9;
    const limit = Math.min(2, left.duration / 2, right.duration / 2);
    if (['dissolve', 'fade', 'flash'].includes(transition?.type)
      && (!transition.toId || transition.toId === right.clip.id)
      && overlap > 1e-7 && overlap <= limit + 1e-6) {
      left.overlapOut = overlap;
      right.overlapIn = overlap;
    }
  }
  const videoEnd = Math.max(0, ...entries.map(e => e.end));
  const tracks = doc.tracks || doc.audio?.tracks || [];
  const total = Math.max(videoEnd,
    ...(doc.overlays || []).map(item => Number(item.end) || 0),
    ...(doc.captions || []).map(item => Number(item.end) || 0),
    ...tracks.map(item => (Number(item.start) || 0) + Math.max(0, item.trimEnd - item.trimStart)));
  return { entries, videoEnd, total };
}

/** 편집 전에 이전 연속 배치를 절대 시각으로 고정해, 삭제·분할이 다른 클립을 밀지 않게 합니다. */
export function pinClipPositions(doc = project) {
  const layout = buildLayout(doc);
  for (const entry of layout.entries) entry.clip.start = entry.start;
  for (let i = 0; i < layout.entries.length - 1; i++) {
    const entry = layout.entries[i];
    if (entry.overlapOut > 0) entry.clip.transitionOut = {
      ...entry.clip.transitionOut, duration: entry.overlapOut, toId: layout.entries[i + 1].clip.id,
    };
  }
  return layout;
}

/** 같은 영상 트랙에서 실제로 맞닿거나 전환으로 겹치는 두 클립의 연결점입니다. */
export function transitionPairs(doc = project) {
  const entries = buildLayout(doc).entries;
  return entries.slice(0, -1).flatMap((left, index) => {
    const right = entries[index + 1];
    if (!left.overlapOut && Math.abs(left.end - right.start) > 1e-6) return [];
    const duration = left.overlapOut;
    return [{ left, right, duration, start: left.end - duration, end: left.end,
      center: left.end - duration / 2, type: duration ? left.clip.transitionOut.type : 'cut' }];
  });
}

/** 미리보기·인코더·오디오가 공유하는 활성 레이어와 선형 교차 가중치. */
export function layersAt(t, layout = buildLayout()) {
  if (!layout.total) return [];
  if (!Number.isFinite(t) || t < 0 || t > layout.total) return [];
  // 마지막 프레임 표시만 허용합니다. 영상이 없는 구간을 마지막 영상으로 채우지 않습니다.
  if (t === layout.total) t = Math.max(0, t - 1e-7);
  let active = layout.entries.filter(e => t >= e.start && t < e.end);
  if (active.length > 1 && !(active.length === 2 && active[0].overlapOut && active[1].overlapIn)) {
    active = [active.at(-1)];
  }
  return active.map(e => {
    const local = t - e.start;
    let weight = 1;
    if (e.overlapIn > 0 && local < e.overlapIn) weight = local / e.overlapIn;
    if (e.overlapOut > 0 && local > e.duration - e.overlapOut) weight = (e.duration - local) / e.overlapOut;
    return { ...e, local, weight: Math.min(1, Math.max(0, weight)) };
  });
}

export function clipFadeGain(clip, local, duration) {
  if (clip.fadeEnvelope) {
    local += clip.fadeEnvelope.offset;
    duration = clip.fadeEnvelope.duration;
    clip = clip.fadeEnvelope;
  }
  let g = 1;
  const fadeIn = Math.min(clip.fadeIn || 0, duration / 2);
  const fadeOut = Math.min(clip.fadeOut || 0, duration / 2);
  if (fadeIn > 0 && local < fadeIn) g = Math.min(g, local / fadeIn);
  if (fadeOut > 0 && local > duration - fadeOut) g = Math.min(g, (duration - local) / fadeOut);
  return Math.max(0, g);
}

/** 연결은 이동 관계이며 길이 제한이 아닙니다. 영상이 없어져도 다른 트랙을 삭제하지 않습니다. */
export function syncAnchoredItems() {
  const entries = new Map(buildLayout().entries.map(e => [e.clip.id, e]));
  for (const item of [...project.overlays, ...project.captions]) {
    if (!item.anchor) continue;
    const e = entries.get(item.anchor.clipId);
    if (!e) { delete item.anchor; continue; }
    const sourceStart = e.clip.type === 'video' ? e.clip.trimStart : 0;
    const start = e.start + item.anchor.sourceStart - sourceStart;
    const duration = Math.max(0, item.anchor.sourceEnd - item.anchor.sourceStart);
    item.start = Math.max(0, start);
    item.end = item.start + duration;
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
    end: t + 3,
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
