// UI와 드래그 미리보기가 함께 쓰는 편집 명령입니다. 다른 트랙은 명시적으로 선택하지 않으면 자르지 않습니다.
import { project, buildLayout, clipDuration, pinClipPositions, transitionPairs, syncAnchoredItems } from './state.js';
import { captureDocument, makeClip, makeAudio } from './project-store.js';
import { uid, clamp } from './util.js';

const EPS = 1e-6;
const cut = () => ({ type: 'cut', duration: 0 });
export const frameTime = (time, fps = project.fps) => Math.max(0, Math.round(time * fps) / fps);

export function timelineCollection(type, doc = project) {
  if (type === 'clip') return doc.clips || [];
  if (type === 'graphic') return doc.overlays || [];
  if (type === 'caption') return doc.captions || [];
  if (type === 'audio') return doc.tracks || doc.audio?.tracks || [];
  return [];
}

export function itemRange(type, id, doc = project) {
  const item = timelineCollection(type, doc).find(item => item.id === id);
  if (!item) return null;
  if (type === 'clip') {
    const entry = buildLayout(doc).entries.find(entry => entry.clip.id === id);
    return { ...entry, item, type, id };
  }
  const duration = type === 'audio' ? item.trimEnd - item.trimStart : item.end - item.start;
  return { item, type, id, start: item.start, end: item.start + duration, duration };
}

export function splitAvailability(selection, time, doc = project) {
  if (!Number.isFinite(time)) return { ok: false, reason: '유효한 재생 위치를 선택해 주세요.' };
  const range = selection && itemRange(selection.type, selection.id, doc);
  if (!range) return { ok: false, reason: '자르려는 타임라인 클립을 먼저 선택해 주세요.' };
  const minimum = 1 / (doc.fps || doc.settings?.fps || 30);
  const local = time - range.start;
  if (local < minimum - EPS || range.duration - local < minimum - EPS) {
    return { ok: false, reason: '선택한 클립 안쪽에 재생 막대를 놓아 주세요.' };
  }
  if (range.type === 'clip' && (local < 2 * range.overlapIn - EPS || range.duration - local < 2 * range.overlapOut - EPS)) {
    return { ok: false, reason: '전환 구간 밖에서 자르거나 먼저 전환 길이를 줄여 주세요.' };
  }
  return { ok: true, ...range, local };
}

/** 직접 움직인 자막/그래픽은 독립 시각을 사용합니다. 원래 길이는 그대로 유지합니다. */
export function setItemRange(item, start, end) {
  const duration = Math.max(1 / project.fps, end - start);
  item.start = Math.max(0, start);
  item.end = item.start + duration;
  delete item.anchor;
}

/** 빈 곳에는 정확한 시각에 배치하고, 점유된 곳은 앞/뒤 경계로 삽입합니다. 덮어쓰지 않습니다. */
export function planVideoPlacement(time, duration, excludeId = null, doc = project) {
  const entries = buildLayout(doc).entries.filter(entry => entry.clip.id !== excludeId);
  let start = Math.max(0, time);
  let nextIndex = entries.findIndex(entry => entry.start >= start - EPS);
  const covering = entries.filter(entry => start > entry.start + EPS && start < entry.end - EPS).at(-1);
  if (covering) {
    const index = entries.indexOf(covering);
    nextIndex = start < (covering.start + covering.end) / 2 ? index : index + 1;
    start = nextIndex === index ? covering.start : covering.end;
  }
  if (nextIndex < 0) nextIndex = entries.length;
  const previous = entries[nextIndex - 1], next = entries[nextIndex];
  // 디졸브 중간에 새 소재를 넣을 때 이전 장면의 원본 끝을 보존하고 연결만 해제합니다.
  if (previous) start = Math.max(start, previous.end);
  const end = start + duration;
  const shift = next ? Math.max(0, end - next.start) : 0;
  const shifts = shift > EPS ? entries.slice(nextIndex).map(entry => ({ id: entry.clip.id, start: entry.start + shift })) : [];
  return { start, end, duration, shifts, shift, breakAfterId: next ? previous?.clip.id : null,
    mode: shifts.length ? 'insert' : 'place', excludeId };
}

function disconnectClip(id) {
  for (const clip of project.clips) {
    if (clip.id === id || clip.transitionOut?.toId === id) clip.transitionOut = cut();
  }
}

export function normalizeTransitions() {
  const entries = buildLayout().entries;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    entry.clip.transitionOut = entry.overlapOut > EPS
      ? { ...entry.clip.transitionOut, duration: entry.overlapOut, toId: entries[i + 1].clip.id }
      : cut();
  }
}

export function placeVideoClip(clip, plan) {
  pinClipPositions();
  const existing = project.clips.includes(clip);
  if (existing) disconnectClip(clip.id);
  project.clips = project.clips.filter(item => item.id !== clip.id);
  for (const shift of plan.shifts) {
    const item = project.clips.find(item => item.id === shift.id);
    if (item) item.start = shift.start;
  }
  const previous = project.clips.find(item => item.id === plan.breakAfterId);
  if (previous) previous.transitionOut = cut();
  clip.start = plan.start;
  clip.transitionOut = cut();
  project.clips.push(clip);
  project.clips.sort((a, b) => a.start - b.start);
  normalizeTransitions();
  syncAnchoredItems();
  return { type: 'clip', id: clip.id, start: clip.start, end: clip.start + clipDuration(clip), shifted: plan.shifts.length };
}

/** 인접한 두 장면만 변경합니다. 전환 길이 차이만큼 뒤쪽 V1 클립을 함께 이동합니다. */
export function setTransition(leftId, rightId, type, requested = .5) {
  if (!['cut', 'dissolve', 'fade', 'flash'].includes(type)) throw new Error('지원하지 않는 전환입니다.');
  const pair = transitionPairs().find(pair => pair.left.clip.id === leftId && pair.right.clip.id === rightId);
  if (!pair) throw new Error('맞닿은 두 클립 사이의 연결점을 선택해 주세요. 빈 공간에는 전환을 넣지 않습니다.');
  const value = Number.isFinite(Number(requested)) ? Number(requested) : .5;
  const duration = type === 'cut' ? 0 : Math.max(0, Math.min(2, value, pair.left.duration / 2, pair.right.duration / 2));
  const layout = pinClipPositions();
  const index = layout.entries.findIndex(entry => entry.clip.id === rightId);
  const delta = pair.duration - duration;
  for (const entry of layout.entries.slice(index)) entry.clip.start = Math.max(0, entry.start + delta);
  pair.left.clip.transitionOut = duration ? { type, duration, toId: rightId } : cut();
  syncAnchoredItems();
  return transitionPairs().find(pair => pair.left.clip.id === leftId && pair.right.clip.id === rightId);
}

/** 트림은 반대쪽 끝을 고정합니다. 다른 클립을 덮거나 밀어내지는 않습니다. */
export function planClipTrim(id, edge, time) {
  const entries = buildLayout().entries, index = entries.findIndex(entry => entry.clip.id === id);
  if (index < 0) return null;
  const entry = entries[index], clip = entry.clip, previous = entries[index - 1], next = entries[index + 1];
  const frame = 1 / project.fps;
  let start = entry.start, end = entry.end, trimStart = clip.trimStart, trimEnd = clip.trimEnd, imgDuration = clip.imgDuration;
  if (edge === 'start') {
    const minDuration = Math.max(frame, 2 * entry.overlapOut);
    const sourceLimit = clip.type === 'video' ? entry.start - clip.trimStart : entry.end - 600;
    const lower = Math.max(0, sourceLimit, previous ? previous.end - entry.overlapIn : 0);
    start = clamp(time, lower, entry.end - minDuration);
    if (clip.type === 'video') trimStart += start - entry.start;
    else imgDuration = end - start;
  } else {
    const minDuration = Math.max(frame, 2 * entry.overlapIn);
    const sourceLimit = clip.type === 'video' ? entry.end + clip.srcDuration - clip.trimEnd : entry.start + 600;
    const upper = Math.min(sourceLimit, next ? next.start + entry.overlapOut : Infinity);
    end = clamp(time, entry.start + minDuration, upper);
    if (clip.type === 'video') trimEnd += end - entry.end;
    else imgDuration = end - start;
  }
  return { id, start, end, duration: end - start, trimStart, trimEnd, imgDuration };
}

export function applyClipTrim(plan) {
  if (!plan) return;
  pinClipPositions();
  const clip = project.clips.find(clip => clip.id === plan.id);
  const delta = plan.start - clip.start;
  if (clip.type === 'image') {
    clip.motionDuration = clip.motionDuration || clipDuration(clip);
    clip.motionOffset = Math.max(0, (clip.motionOffset || 0) + delta);
  }
  if (clip.fadeEnvelope) clip.fadeEnvelope = { ...clip.fadeEnvelope, offset: clip.fadeEnvelope.offset + delta };
  Object.assign(clip, { start: plan.start, trimStart: plan.trimStart, trimEnd: plan.trimEnd, imgDuration: plan.imgDuration });
  normalizeTransitions();
  syncAnchoredItems();
}

/** 선택한 종류와 ID만 분할합니다. 자막·그래픽·음성은 각각 별개의 클립입니다. */
export async function splitTimelineItem(selection, time) {
  const check = splitAvailability(selection, time);
  if (!check.ok) throw new Error(check.reason);
  const { item, type, local } = check;
  const document = captureDocument();
  const envelope = { ...(item.fadeEnvelope || { offset: 0, duration: check.duration, fadeIn: item.fadeIn || 0, fadeOut: item.fadeOut || 0 }) };
  let right;
  if (type === 'clip') {
    const saved = document.clips.find(clip => clip.id === item.id);
    right = await makeClip(item.assetId, { ...saved, id: uid(), start: time, fadeIn: 0 });
    pinClipPositions();
    if (item.type === 'video') { right.trimStart = item.trimStart + local; item.trimEnd = right.trimStart; }
    else {
      const motionDuration = item.motionDuration || check.duration, motionOffset = item.motionOffset || 0;
      Object.assign(right, { imgDuration: check.duration - local, motionDuration, motionOffset: motionOffset + local });
      Object.assign(item, { imgDuration: local, motionDuration, motionOffset });
    }
    item.transitionOut = cut(); item.fadeOut = 0;
    project.clips.splice(project.clips.indexOf(item) + 1, 0, right);
  } else if (type === 'audio') {
    right = makeAudio(item.assetId, { ...document.tracks.find(track => track.id === item.id), id: uid(), start: time, trimStart: item.trimStart + local, fadeIn: 0 });
    item.trimEnd = right.trimStart; item.fadeOut = 0;
    project.audio.tracks.push(right);
  } else {
    right = JSON.parse(JSON.stringify(item)); right.id = uid();
    setItemRange(right, time, check.end);
    setItemRange(item, check.start, time);
    timelineCollection(type).push(right);
  }
  if (type === 'clip' || type === 'audio') {
    item.fadeEnvelope = { ...envelope };
    right.fadeEnvelope = { ...envelope, offset: envelope.offset + local };
  }
  return { type, id: right.id, start: time, end: check.end };
}

/** 기본 삭제는 공백 유지. 당겨 삭제는 선택한 트랙의 뒤 항목에만 적용합니다. */
export function deleteTimelineItem(selection, ripple = false) {
  if (selection?.type === 'transition') {
    setTransition(selection.id, selection.rightId, 'cut', 0);
    return true;
  }
  const range = selection && itemRange(selection.type, selection.id);
  if (!range) return false;
  const { type, item } = range;
  pinClipPositions();
  const list = timelineCollection(type);
  if (type === 'clip') {
    disconnectClip(item.id);
    for (const other of [...project.overlays, ...project.captions]) if (other.anchor?.clipId === item.id) delete other.anchor;
  }
  list.splice(list.indexOf(item), 1);
  if (ripple) {
    const amount = type === 'clip' ? range.duration - range.overlapIn - range.overlapOut : range.duration;
    const threshold = type === 'clip' ? range.end - range.overlapOut : range.end;
    for (const other of list) {
      if (type === 'audio' && other.lane !== item.lane) continue;
      if (other.start < threshold - EPS) continue;
      if (type === 'clip' || type === 'audio') other.start = Math.max(0, other.start - amount);
      else setItemRange(other, other.start - amount, other.end - amount);
    }
  }
  normalizeTransitions();
  syncAnchoredItems();
  return true;
}
