// UI와 드래그 미리보기가 함께 쓰는 편집 명령입니다. 다른 트랙은 명시적으로 선택하지 않으면 자르지 않습니다.
import { project, buildLayout, clipDuration, pinClipPositions, transitionPairs, syncAnchoredItems, trackIdFor, trackItems, migrateTimeline, timelineTracks, trackKind } from './state.js';
import { captureDocument, makeClip, makeAudio, assets, discardStagedInstance } from './project-store.js';
import { complementRanges } from './silence.js';
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
  return { item, type, id, trackId: trackIdFor(type, item, doc), start: item.start, end: item.start + duration, duration };
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

/** 빈 곳은 그대로, 점유된 곳은 가까운 클립 경계에 삽입합니다. 목적지 트랙만 이동합니다. */
export function planPlacement(time, duration, trackId, excludeId = null, doc = project) {
  const entries = trackItems(trackId, doc).filter(entry => entry.id !== excludeId);
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
  if (previous) start = Math.max(start, previous.end);
  const end = start + duration;
  const shift = next ? Math.max(0, end - next.start) : 0;
  const shifts = shift > EPS ? entries.slice(nextIndex).map(entry => ({
    type: entry.type, id: entry.id, start: entry.start + shift,
  })) : [];
  return { start, end, duration, trackId, shifts, shift,
    breakAfterId: next && previous?.type === 'clip' ? previous.id : null,
    mode: shifts.length ? 'insert' : 'place', excludeId };
}
export function planVideoPlacement(time, duration, excludeId = null, doc = project, trackId = null) {
  const item = doc.clips?.find(c => c.id === excludeId);
  return planPlacement(time, duration, trackId || trackIdFor('clip', item, doc), excludeId, doc);
}
function disconnectClip(id) {
  for (const clip of project.clips) {
    if (clip.id === id || clip.transitionOut?.toId === id) clip.transitionOut = cut();
  }
}
export function normalizeTransitions() {
  for (const entry of buildLayout().entries) {
    entry.clip.transitionOut = entry.overlapOut > EPS
      ? { ...entry.clip.transitionOut, duration: entry.overlapOut, toId: entry.nextId } : cut();
  }
}
function moveRange(range, start) {
  if (range.type === 'clip' || range.type === 'audio') range.item.start = Math.max(0, start);
  else setItemRange(range.item, start, start + range.duration);
  delete range.item.anchor;
}
export function placeTimelineItem(type, item, plan) {
  const target = timelineTracks().find(t => t.id === plan.trackId && t.kind === trackKind(type));
  if (!target) throw new Error('호환되는 트랙에 놓아 주세요.');
  migrateTimeline();
  const previousRange = itemRange(type, item.id);
  if (previousRange && previousRange.trackId === target.id && Math.abs(previousRange.start - plan.start) < EPS) {
    return { type, id: item.id, trackId: target.id, start: previousRange.start, end: previousRange.end, shifted: 0 };
  }
  if (type === 'clip') disconnectClip(item.id);
  for (const shift of plan.shifts) {
    const range = itemRange(shift.type, shift.id);
    if (range && range.id !== item.id && range.trackId === target.id) moveRange(range, shift.start);
  }
  const previous = project.clips.find(c => c.id === plan.breakAfterId);
  if (previous) previous.transitionOut = cut();
  item.trackId = target.id;
  moveRange({ type, item, duration: plan.duration }, plan.start);
  const collection = timelineCollection(type);
  if (!collection.includes(item)) collection.push(item);
  normalizeTransitions();
  syncAnchoredItems();
  return { type, id: item.id, trackId: target.id, start: plan.start, end: plan.end, shifted: plan.shifts.length };
}
export function placeVideoClip(clip, plan) {
  return placeTimelineItem('clip', clip, { ...plan, trackId: plan.trackId || trackIdFor('clip', clip) });
}

/** 전환 길이 차이는 연결점 뒤의 같은 트랙 항목에만 적용합니다. */
export function setTransition(leftId, rightId, type, requested = .5) {
  if (!['cut', 'dissolve', 'fade', 'flash'].includes(type)) throw new Error('지원하지 않는 전환입니다.');
  const pair = transitionPairs().find(p => p.left.id === leftId && p.right.id === rightId);
  if (!pair) throw new Error('같은 트랙에서 맞닿은 두 미디어 클립의 연결점을 선택해 주세요.');
  const value = Number.isFinite(Number(requested)) ? Number(requested) : .5;
  const duration = type === 'cut' ? 0 : Math.max(0, Math.min(2, value, pair.left.duration / 2, pair.right.duration / 2));
  migrateTimeline();
  const delta = pair.duration - duration;
  for (const entry of trackItems(pair.trackId)) {
    if (entry.start >= pair.right.start - EPS && entry.id !== leftId) moveRange(entry, entry.start + delta);
  }
  pair.left.clip.transitionOut = duration ? { type, duration, toId: rightId } : cut();
  syncAnchoredItems();
  return transitionPairs().find(p => p.left.id === leftId && p.right.id === rightId);
}

/** 점유 구간의 합집합으로 빈 공간을 구합니다. 무한한 마지막 여백은 편집 구간이 아닙니다. */
export function trackGaps(trackId, doc = project) {
  const gaps = [];
  let end = 0;
  for (const entry of trackItems(trackId, doc)) {
    if (entry.start > end + EPS) gaps.push({ type: 'gap', id: trackId + ':' + end + ':' + entry.start,
      trackId, start: end, end: entry.start, duration: entry.start - end });
    end = Math.max(end, entry.end);
  }
  return gaps;
}
export function currentGap(selection, doc = project) {
  if (selection?.type !== 'gap') return null;
  return trackGaps(selection.trackId, doc).find(gap => Math.abs(gap.start - selection.start) < EPS && Math.abs(gap.end - selection.end) < EPS) || null;
}
export function closeTimelineGap(selection) {
  const gap = currentGap(selection);
  if (!gap) return false;
  migrateTimeline();
  for (const entry of trackItems(gap.trackId)) {
    if (entry.start >= gap.end - EPS) moveRange(entry, entry.start - gap.duration);
  }
  normalizeTransitions();
  syncAnchoredItems();
  return true;
}

/** 트림은 반대쪽 끝을 고정합니다. 다른 클립을 덮거나 밀어내지는 않습니다. */
export function planClipTrim(id, edge, time) {
  const entry = buildLayout().entries.find(entry => entry.id === id);
  if (!entry) return null;
  const entries = trackItems(entry.trackId), index = entries.findIndex(e => e.id === id);
  const clip = entry.clip, previous = entries[index - 1], next = entries[index + 1];
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

/** 오디오·자막·그래픽 트림도 같은 트랙의 경계를 지킵니다. */
export function planItemTrim(type, id, edge, time) {
  if (type === 'clip') return { ...planClipTrim(id, edge, time), type };
  const range = itemRange(type, id);
  if (!range) return null;
  const siblings = trackItems(range.trackId).filter(e => e.id !== id);
  const left = Math.max(0, ...siblings.filter(e => e.end <= range.start + EPS).map(e => e.end));
  const right = Math.min(86400, ...siblings.filter(e => e.start >= range.end - EPS).map(e => e.start));
  const sourceEnd = type === 'audio' ? range.end + (assets.get(range.item.assetId)?.duration || range.item.trimEnd) - range.item.trimEnd : 86400;
  const start = edge === 'start' ? clamp(time, Math.max(left, type === 'audio' ? range.start - range.item.trimStart : 0), range.end - 1 / project.fps) : range.start;
  const end = edge === 'end' ? clamp(time, range.start + 1 / project.fps, Math.min(right, sourceEnd)) : range.end;
  return { type, id, trackId: range.trackId, start, end, duration: end - start,
    trimStart: type === 'audio' ? range.item.trimStart + start - range.start : undefined,
    trimEnd: type === 'audio' ? range.item.trimEnd + end - range.end : undefined };
}
export function applyItemTrim(plan) {
  if (!plan) return;
  if (plan.type === 'clip') return applyClipTrim(plan);
  const range = itemRange(plan.type, plan.id);
  if (!range) return;
  if (plan.type === 'audio') {
    if (range.item.fadeEnvelope) range.item.fadeEnvelope = { ...range.item.fadeEnvelope, offset: range.item.fadeEnvelope.offset + plan.start - range.start };
    Object.assign(range.item, { start: plan.start, trimStart: plan.trimStart, trimEnd: plan.trimEnd });
  } else setItemRange(range.item, plan.start, plan.end);
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

/** 기본 삭제는 공백 유지. 잔물결 삭제는 실제로 같은 트랙인 항목만 당깁니다. */
export function deleteTimelineItem(selection, ripple = false) {
  if (selection?.type === 'gap') return closeTimelineGap(selection);
  if (selection?.type === 'transition') {
    setTransition(selection.id, selection.rightId, 'cut', 0);
    return true;
  }
  const range = selection && itemRange(selection.type, selection.id);
  if (!range) return false;
  const { type, item } = range;
  migrateTimeline();
  if (type === 'clip') disconnectClip(item.id);
  const list = timelineCollection(type);
  list.splice(list.indexOf(item), 1);
  if (ripple) {
    const amount = type === 'clip' ? range.duration - range.overlapIn - range.overlapOut : range.duration;
    const threshold = type === 'clip' ? range.end - range.overlapOut : range.end;
    for (const other of trackItems(range.trackId)) {
      if (other.start >= threshold - EPS) moveRange(other, other.start - amount);
    }
  }
  normalizeTransitions();
  syncAnchoredItems();
  return true;
}

/** 분석 결과를 선택 클립의 원본 구간에 적용할 계획입니다. 아직 프로젝트는 바꾸지 않습니다. */
export function planSilenceCuts(selection, ranges, doc = captureDocument()) {
  const range = selection && itemRange(selection.type, selection.id, doc);
  if (!range || !['clip','audio'].includes(range.type) || (range.type === 'clip' && range.item.type !== 'video')) throw new Error('소리가 있는 영상 또는 오디오 클립을 선택해 주세요.');
  if (range.overlapIn || range.overlapOut) throw new Error('이 클립의 장면 전환을 먼저 제거한 뒤 자동 컷을 적용해 주세요.');
  const siblings = trackItems(range.trackId, doc).filter(e => e.id !== range.id);
  if (siblings.some(e => e.start < range.end - EPS && e.end > range.start + EPS)) throw new Error('같은 트랙에 겹친 항목이 있습니다. 다른 트랙으로 옮긴 뒤 자동 컷을 적용해 주세요.');
  if (!Array.isArray(ranges) || ranges.length > 200) throw new Error('삭제할 무음 구간이 올바르지 않습니다.');
  let previous = -Infinity;
  const removed = ranges.map(r => {
    if (!r || !Number.isFinite(r.start) || !Number.isFinite(r.end) || r.start < 0 || r.end > range.duration + EPS || r.end <= r.start || r.start < previous - EPS) throw new Error('삭제 구간이 원본 범위를 벗어나거나 겹칩니다.');
    previous = r.end;return { start: r.start, end: Math.min(r.end, range.duration) };
  });
  if (!removed.length) throw new Error('선택된 무음 구간이 없습니다.');
  const kept = complementRanges(removed, range.duration), frame = 1 / (doc.settings?.fps || doc.fps || 30);
  if (!kept.length) throw new Error('클립 전체가 무음으로 감지됐습니다. 안전을 위해 원본을 유지합니다. 임계값을 낮춰 확인해 주세요.');
  if (kept.some(r => r.end - r.start < frame - EPS)) throw new Error('남는 구간이 한 프레임보다 짧습니다. 삭제할 구간을 줄여 주세요.');
  if (timelineCollection(range.type, doc).length - 1 + kept.length > 1000) throw new Error('자동 컷 후 클립 수가 1,000개를 넘습니다. 프로젝트를 나눠 작업해 주세요.');
  const amount = removed.reduce((sum, r) => sum + r.end - r.start, 0);
  return { before: doc, selection: { type: range.type, id: range.id }, trackId: range.trackId,
    start: range.start, duration: range.duration, item: range.item, kept, removed, removedDuration: amount,
    shifts: siblings.filter(e => e.start >= range.end - EPS).map(e => ({ type: e.type, id: e.id, start: e.start - amount })) };
}

/** 새 미디어 인스턴스를 준비한 뒤 한 번에 바꿉니다. 취소·실패·오래된 결과는 적용하지 않습니다. */
export async function applySilenceCuts(plan, { signal } = {}) {
  const signature = JSON.stringify(plan.before), staged = [];
  const check = () => {
    if (signal?.aborted) throw new DOMException('취소됨', 'AbortError');
    if (JSON.stringify(captureDocument()) !== signature) throw new Error('분석 이후 편집 내용이 바뀌었습니다. 다시 분석해 주세요.');
  };
  check();
  const { type, id } = plan.selection, original = timelineCollection(type).find(i => i.id === id);
  if (!original) throw new Error('분석한 클립을 찾을 수 없습니다.');
  const envelope = original.fadeEnvelope || { offset: 0, duration: plan.duration, fadeIn: original.fadeIn || 0, fadeOut: original.fadeOut || 0 };
  let start = plan.start;
  try {
    const replacements = [];
    for (let i = 0; i < plan.kept.length; i++) {
      check();
      const r = plan.kept[i], saved = JSON.parse(JSON.stringify(plan.item));
      Object.assign(saved, { id: i ? uid() : id, start, trimStart: original.trimStart + r.start, trimEnd: original.trimStart + r.end,
        fadeEnvelope: { ...envelope, offset: envelope.offset + r.start } });
      if (type === 'clip') saved.transitionOut = cut();
      const item = i ? (type === 'clip' ? await makeClip(original.assetId, saved) : makeAudio(original.assetId, saved)) : { ...original, ...saved };
      if (i) staged.push(item.id);
      replacements.push(item);start += r.end - r.start;
    }
    check();migrateTimeline();
    const list = timelineCollection(type), index = list.findIndex(i => i.id === id);
    list.splice(index, 1, ...replacements);
    for (const shift of plan.shifts) { const r = itemRange(shift.type, shift.id); if (r) moveRange(r, shift.start); }
    normalizeTransitions();syncAnchoredItems();
    return { type, id, trackId: plan.trackId, start: plan.start, end: start, count: replacements.length, removedDuration: plan.removedDuration };
  } catch (error) {
    for (const stagedId of staged) discardStagedInstance(type, stagedId);
    throw error;
  }
}
