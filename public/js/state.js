// 프로젝트 상태 모델 + 타임라인 계산
// 여기 있는 값들만이 "진실"이고, 미리보기와 내보내기는 둘 다 이 값으로 그린다.

import { TRANSITIONS } from './presets.js';
export { FONTS } from './font-catalog.js';

export const ACCENT = '#ff3b5c';

// 구형 화면만 명시적으로 켭니다. 프로젝트 저장값과 새 스튜디오의 기본 동작에는 섞지 않습니다.
export let legacyEditorMode = false;
export function setLegacyEditorMode(enabled) { legacyEditorMode = enabled === true; }

export const project = {
  // 출력 설정
  width: 1080,
  height: 1920,
  fps: 30,
  quality: 'high',
  fileName: 'shorts',

  clips: [],
  timelineTracks: undefined, // 구형 파일은 시각·쌓임 순서를 보존하고 트랙 용도를 보충합니다.
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
    // 내레이션은 배경음악과 별개 트랙이다. 항상 0초부터 깔리고 반복하지 않는다.
    narration: null, // { name, blob, buffer(AudioBuffer), volume }
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

/** 용도는 기본 배치와 이름에만 사용합니다. 호환되는 다른 행으로도 이동할 수 있습니다. */
export const TRACK_ROLES = Object.freeze([
  { id: 'video', kind: 'visual', label: '영상', code: 'V' },
  { id: 'graphic', kind: 'visual', label: '그래픽', code: 'G' },
  { id: 'caption', kind: 'visual', label: '자막', code: 'T' },
  { id: 'auto-caption', kind: 'visual', label: '자동자막', code: 'CC', optional: true },
  { id: 'audio', kind: 'audio', label: '오디오', code: 'A' },
  { id: 'voice', kind: 'audio', label: '보이스', code: 'V' },
]);
export const DEFAULT_TRACKS = Object.freeze([
  { id: 'v1', kind: 'visual', role: 'video' }, { id: 'v2', kind: 'visual', role: 'graphic' }, { id: 'v3', kind: 'visual', role: 'caption' },
  { id: 'a1', kind: 'audio', role: 'audio' }, { id: 'a2', kind: 'audio', role: 'voice' },
]);
export const MAX_TRACKS_PER_KIND = 24;
export function trackRole(track) {
  if (TRACK_ROLES.some(role => role.id === track?.role && role.kind === track.kind)) return track.role;
  return DEFAULT_TRACKS.find(t => t.id === track?.id && t.kind === track.kind)?.role || (track?.kind === 'audio' ? 'audio' : 'video');
}
export function itemTrackRole(type, item = {}) {
  return type === 'audio' ? ((item.role || item.lane) === 'voice' ? 'voice' : 'audio')
    : type === 'caption' ? 'caption' : type === 'graphic' ? 'graphic' : 'video';
}
export function timelineTracks(doc = project) {
  return (doc.timelineTracks?.length ? doc.timelineTracks : DEFAULT_TRACKS).map(track => ({ ...track, role: trackRole(track) }));
}
export const trackKind = type => type === 'audio' ? 'audio' : 'visual';
export function trackIdFor(type, item = {}, doc = project) {
  const registry = timelineTracks(doc), kind = trackKind(type);
  if (registry.some(track => track.id === item.trackId && track.kind === kind)) return item.trackId;
  return registry.find(track => track.role === itemTrackRole(type, item) && track.kind === kind)?.id
    || registry.find(track => track.kind === kind)?.id;
}
export function trackLabel(id, doc = project) {
  const tracks = timelineTracks(doc), track = tracks.find(track => track.id === id);
  if (!track) return '';
  const siblings = tracks.filter(t => t.role === track.role), number = siblings.findIndex(t => t.id === id) + 1;
  return TRACK_ROLES.find(role => role.id === track.role).label + (number > 1 ? ' ' + number : '');
}
export function trackBadge(id, doc = project) {
  const tracks = timelineTracks(doc), track = tracks.find(track => track.id === id);
  if (!track) return '';
  const number = tracks.filter(t => t.role === track.role).findIndex(t => t.id === id) + 1;
  return TRACK_ROLES.find(role => role.id === track.role).code + (number > 1 ? number : '');
}

/**
 * 트랙 스위치입니다. 각각 딱 한 가지만 건드립니다.
 *   hidden  영상 계열 · 화면에서만 뺍니다. 클립에 붙어 있는 소리는 그대로 납니다.
 *   muted   오디오 · 미리보기와 내보내기 양쪽에서 뺍니다.
 *   solo    오디오 · 미리보기에서만 그 트랙만 듣습니다. 내보내기는 따르지 않습니다.
 *           솔로를 켜 둔 채 내보내다가 배경음악이 통째로 빠지는 사고를 막기 위해서입니다.
 *   locked  편집만 막습니다. 화면과 소리는 그대로입니다.
 * 꺼진 상태는 값을 지웁니다. 저장 문서가 항상 같은 모양이어야 되돌리기 비교가 흔들리지 않습니다.
 */
export const TRACK_SWITCHES = Object.freeze(['hidden', 'muted', 'solo', 'locked']);
export const SWITCH_KINDS = Object.freeze({ hidden: 'visual', muted: 'audio', solo: 'audio', locked: null });
const trackEntry = (id, doc) => timelineTracks(doc).find(track => track.id === id);
export const isTrackHidden = (id, doc = project) => trackEntry(id, doc)?.hidden === true;
export const isTrackLocked = (id, doc = project) => trackEntry(id, doc)?.locked === true;
export const isTrackMuted = (id, doc = project) => trackEntry(id, doc)?.muted === true;
export const hasAudioSolo = (doc = project) => timelineTracks(doc).some(track => track.kind === 'audio' && track.solo === true);

/** 미리보기에서 들리는지입니다. 솔로가 하나라도 켜지면 솔로가 아닌 트랙은 모두 빠집니다. */
export function isTrackAudible(id, doc = project) {
  const track = trackEntry(id, doc);
  if (!track || track.kind !== 'audio') return false;
  if (track.muted === true) return false;
  return hasAudioSolo(doc) ? track.solo === true : true;
}

/** 원음 분리를 건너뛴 영상 클립의 소리입니다. 오디오 트랙이 아니라 솔로에만 영향받습니다. */
export const inlineClipAudible = (doc = project) => !hasAudioSolo(doc);

export function setTrackSwitch(id, name, value) {
  if (!TRACK_SWITCHES.includes(name)) throw new Error('지원하지 않는 트랙 스위치입니다.');
  const track = trackEntry(id);
  if (!track) throw new Error('트랙을 찾을 수 없습니다.');
  const kind = SWITCH_KINDS[name];
  if (kind && track.kind !== kind) {
    throw new Error(kind === 'visual' ? '영상 계열 트랙만 화면에서 숨길 수 있습니다.' : '오디오 트랙만 음소거하거나 솔로로 들을 수 있습니다.');
  }
  migrateTimeline();
  const entry = project.timelineTracks.find(item => item.id === id);
  if (value) entry[name] = true; else delete entry[name];
  return entry[name] === true;
}

/** 자동자막 결과를 적용할 때만 전용 행을 만들며 수동 자막 행은 그대로 둡니다. */
export function ensureAutoCaptionTrack() {
  const existing = timelineTracks().find(track => track.role === 'auto-caption');
  return existing || addTimelineTrack('visual', { role: 'auto-caption' });
}

/** 구형 파일의 실제 시각은 보존하고, 자동 연결 정보만 제거합니다. */
export function migrateTimeline(doc = project) {
  pinClipPositions(doc);
  doc.timelineTracks = timelineTracks(doc).map(track => ({ ...track }));
  const groups = [['clip', doc.clips], ['graphic', doc.overlays], ['caption', doc.captions],
    ['audio', doc.tracks || doc.audio?.tracks]];
  for (const [type, items] of groups) for (const item of items || []) {
    item.trackId = trackIdFor(type, item, doc);
    if (type === 'audio') item.role ||= item.lane === 'voice' ? 'voice' : 'music';
    delete item.anchor;
  }
}
export function addTimelineTrack(kind, { role, afterId } = {}) {
  if (!['visual', 'audio'].includes(kind)) throw new Error('지원하지 않는 트랙입니다.');
  const registry = timelineTracks(), after = registry.find(t => t.id === afterId);
  if (afterId && (!after || after.kind !== kind)) throw new Error('기준 트랙이 변경되었습니다. 다시 선택해 주세요.');
  role ||= after?.role || (kind === 'audio' ? 'audio' : 'video');
  if (!TRACK_ROLES.some(r => r.id === role && r.kind === kind)) throw new Error('트랙 용도가 올바르지 않습니다.');
  if (registry.filter(t => t.kind === kind).length >= MAX_TRACKS_PER_KIND) throw new Error('영상 계열과 오디오 계열은 각각 24개 트랙까지 지원합니다.');
  migrateTimeline();
  const prefix = kind === 'audio' ? 'a' : 'v';
  let number = 1;
  while (project.timelineTracks.some(t => t.id === prefix + number)) number++;
  const track = { id: prefix + number, kind, role };
  const previous = after || registry.filter(t => t.role === role).at(-1) || registry.filter(t => t.kind === kind).at(-1);
  project.timelineTracks.splice(project.timelineTracks.findIndex(t => t.id === previous?.id) + 1, 0, track);
  return track;
}
export function removeTimelineTrack(id) {
  const registry = timelineTracks(), track = registry.find(t => t.id === id);
  if (!track || (!TRACK_ROLES.find(role => role.id === track.role).optional
    && registry.filter(t => t.role === track.role).length < 2)) return false;
  if (trackItems(id).length) throw new Error('빈 트랙만 삭제할 수 있습니다.');
  migrateTimeline();
  project.timelineTracks = project.timelineTracks.filter(t => t.id !== id);
  return true;
}

/** 가장 위에 있는 영상 트랙의 현재 미디어 클립입니다. */
export function clipAt(t) {
  const active = layersAt(t);
  if (!active.length) return null;
  const top = active.at(-1).trackId;
  return active.filter(e => e.trackId === top).reduce((a, b) => !a || b.weight >= a.weight ? b : a, null);
}

/** 모든 종류의 항목을 공통 시각으로 조회합니다. 조회는 원본을 변경하지 않습니다. */
export function buildLayout(doc = project) {
  const registry = timelineTracks(doc), entries = [];
  for (const track of registry.filter(t => t.kind === 'visual')) {
    const clips = (doc.clips || []).map((clip, index) => ({ clip, index }))
      .filter(e => trackIdFor('clip', e.clip, doc) === track.id);
    let cursor = 0;
    for (let i = 0; i < clips.length; i++) {
      const { clip, index } = clips[i], duration = clipDuration(clip), next = clips[i + 1]?.clip;
      const legacyOverlap = next && TRANSITIONS.some(t => t.id !== 'cut' && t.id === clip.transitionOut?.type)
        ? Math.max(0, Math.min(2, Number(clip.transitionOut.duration) || 0, duration / 2, clipDuration(next) / 2)) : 0;
      const start = Number.isFinite(clip.start) ? Math.max(0, clip.start) : cursor;
      const entry = { clip, item: clip, id: clip.id, type: 'clip', trackId: track.id,
        index, start, end: start + duration, duration, overlapIn: 0, overlapOut: 0 };
      entries.push(entry);
      cursor = entry.end - legacyOverlap;
    }
  }
  entries.sort((a, b) => a.start - b.start || a.index - b.index);
  const items = [...entries];
  for (const [type, list] of [['graphic', doc.overlays], ['caption', doc.captions],
    ['audio', doc.tracks || doc.audio?.tracks]]) {
    for (const [index, item] of (list || []).entries()) {
      const start = Number(item.start) || 0;
      const duration = type === 'audio' ? Math.max(0, item.trimEnd - item.trimStart) : Math.max(0, item.end - start);
      items.push({ item, type, id: item.id, trackId: trackIdFor(type, item, doc), index, start, end: start + duration, duration });
    }
  }
  items.sort((a, b) => a.start - b.start || a.index - b.index);
  for (const track of registry.filter(t => t.kind === 'visual')) {
    const row = items.filter(e => e.trackId === track.id);
    for (let i = 0; i < row.length - 1; i++) {
      const left = row[i], right = row[i + 1];
      if (left.type !== 'clip' || right.type !== 'clip') continue;
      left.nextId = right.id;
      const transition = left.clip.transitionOut;
      const overlap = Math.round((left.end - right.start) * 1e9) / 1e9;
      const limit = Math.min(2, left.duration / 2, right.duration / 2);
      if (TRANSITIONS.some(t => t.id !== 'cut' && t.id === transition?.type)
        && (!transition.toId || transition.toId === right.id)
        && overlap > 1e-7 && overlap <= limit + 1e-6) {
        left.overlapOut = overlap;
        right.overlapIn = overlap;
      }
    }
  }
  const videoEnd = Math.max(0, ...entries.map(e => e.end));
  const total = legacyEditorMode && doc === project ? videoEnd : Math.max(0, ...items.map(e => e.end));
  return { entries, items, tracks: registry, videoEnd, total };
}
export function trackItems(trackId, doc = project, layout = buildLayout(doc)) {
  return layout.items.filter(e => e.trackId === trackId);
}

/** 삭제·이동 전에 구형 연속 배치를 절대 시각으로 고정합니다. */
export function pinClipPositions(doc = project) {
  const layout = buildLayout(doc);
  for (const entry of layout.entries) {
    entry.clip.start = entry.start;
    if (entry.overlapOut > 0) entry.clip.transitionOut = {
      ...entry.clip.transitionOut, duration: entry.overlapOut, toId: entry.nextId,
    };
  }
  return layout;
}

/** 같은 트랙에서 실제로 맞닿거나 전환으로 겹치는 두 미디어 클립의 연결점입니다. */
export function transitionPairs(doc = project) {
  const layout = buildLayout(doc);
  return layout.entries.flatMap(left => {
    const right = layout.entries.find(e => e.id === left.nextId);
    if (!right || (!left.overlapOut && Math.abs(left.end - right.start) > 1e-6)) return [];
    const duration = left.overlapOut;
    return [{ left, right, trackId: left.trackId, duration, start: left.end - duration, end: left.end,
      center: left.end - duration / 2, type: duration ? left.clip.transitionOut.type : 'cut' }];
  });
}

/** 겹침 가중치는 트랙 안에서만 계산합니다. 위 트랙 때문에 아래 영상·오디오가 사라지지 않습니다. */
export function layersAt(t, layout = buildLayout()) {
  if (!layout.total || !Number.isFinite(t) || t < 0 || t > layout.total) return [];
  if (t === layout.total) t = Math.max(0, t - 1e-7);
  const result = [];
  for (const track of (layout.tracks || timelineTracks()).filter(track => track.kind === 'visual')) {
    let active = layout.entries.filter(e => e.trackId === track.id && t >= e.start && t < e.end);
    if (active.length > 1 && !(active.length === 2 && active[0].overlapOut && active[1].overlapIn
      && active[0].nextId === active[1].id)) active = [active.at(-1)];
    result.push(...active.map(e => {
      const local = t - e.start;
      let weight = 1;
      if (e.overlapIn > 0 && local < e.overlapIn) weight = local / e.overlapIn;
      if (e.overlapOut > 0 && local > e.duration - e.overlapOut) weight = (e.duration - local) / e.overlapOut;
      return { ...e, local, weight: Math.min(1, Math.max(0, weight)) };
    }));
  }
  return result;
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

/** 이전 파일의 자동 연결을 해제합니다. 보이는 시각과 길이는 절대로 바꾸지 않습니다. */
export function syncAnchoredItems() {
  for (const item of [...project.overlays, ...project.captions]) delete item.anchor;
}
// 구형 진입점 호환용. 새 편집기는 자동 연결을 만들지 않습니다.
export function anchorItem(item) { delete item.anchor; }

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
