// 편집 레시피 템플릿.
//
// VN·캡컷에서 "타임라인을 공유한다" 고 할 때의 그 템플릿입니다. 색보정이나 필터가 아니라
// **컷 리듬**입니다. 몇 초짜리 컷을 몇 개, 어떤 순서로, 어떤 전환으로 이어 붙이는지가 전부입니다.
//
// 그래서 템플릿은 영상 파일을 담지 않습니다. 슬롯 목록만 담고, 적용할 때 사용자가 올린
// 소재를 슬롯에 꽂습니다. 소재가 슬롯보다 적으면 앞에서부터 다시 씁니다.
//
// 저장 방식은 퀵포맷(saved-quick-formats.js)과 같은 규칙을 따릅니다.
// 저장소의 값을 통째로 믿지 않고, 지원하는 값만 다시 만들어 씁니다.

import { project, buildLayout, clipDuration, clipSpeed, MIN_SPEED, MAX_SPEED, trackIdFor, timelineTracks } from './state.js';
import { TRANSITIONS } from './presets.js';

export const TEMPLATE_STORAGE_KEY = 'shorts-studio.edit-templates.v1';
export const MAX_TEMPLATES = 30;
export const MAX_SLOTS = 120;
const VERSION = 1;
const MAX_STORAGE_CHARACTERS = 256 * 1024;
const MIN_SLOT = 0.1;          // 한 컷의 최소 길이(초)
const MAX_SLOT = 60;

const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(id);
const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round = value => Math.round(value * 1000) / 1000;
const transitionId = value => TRANSITIONS.some(t => t.id === value) ? value : 'cut';

function storageAccess(storage) {
  try {
    const resolved = storage ?? globalThis.localStorage;
    if (!resolved || typeof resolved.getItem !== 'function' || typeof resolved.setItem !== 'function') throw new Error();
    return resolved;
  } catch {
    throw new Error('템플릿을 저장할 수 없습니다. 브라우저의 사이트 저장소를 허용한 뒤 다시 시도해 주세요.');
  }
}

function nameValue(name) {
  const cleaned = typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : '';
  if (!cleaned) throw new Error('저장할 템플릿 이름을 입력해 주세요.');
  return cleaned.slice(0, 40);
}

/** 저장소에서 읽은 슬롯을 그대로 믿지 않고 지원하는 값만 다시 만듭니다. */
function normalizeSlot(raw) {
  if (!record(raw)) return null;
  // 음수나 0 은 범위로 자르지 않고 버립니다. 자르면 없던 0.1 초짜리 컷이 생깁니다.
  const value = finite(raw.duration, 0);
  if (!(value > 0)) return null;
  const duration = clamp(value, MIN_SLOT, MAX_SLOT);
  return {
    duration: round(duration),
    speed: round(clamp(finite(raw.speed, 1), MIN_SPEED, MAX_SPEED)),
    transition: transitionId(raw.transition),
    transitionDuration: round(clamp(finite(raw.transitionDuration, 0), 0, 2)),
  };
}

export function normalizeTemplate(raw) {
  if (!record(raw) || !validId(raw.id)) return null;
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 40) : '';
  const slots = (Array.isArray(raw.slots) ? raw.slots : []).map(normalizeSlot).filter(Boolean).slice(0, MAX_SLOTS);
  if (!name || !slots.length) return null;
  return { version: VERSION, id: raw.id, name, slots, createdAt: finite(raw.createdAt, 0) };
}

/** 지금 타임라인의 영상 트랙에서 컷 리듬만 떠냅니다. 영상 파일은 담지 않습니다. */
export function captureTemplate(name, doc = project) {
  const layout = buildLayout(doc);
  const visual = timelineTracks(doc).filter(track => track.kind === 'visual');
  // 영상이 놓인 첫 트랙만 봅니다. 여러 겹으로 쌓은 화면은 리듬 템플릿으로 옮기지 않습니다.
  const trackId = visual.find(track => layout.entries.some(entry => entry.trackId === track.id))?.id;
  const entries = layout.entries.filter(entry => entry.trackId === trackId);
  if (!entries.length) throw new Error('타임라인에 영상이나 이미지를 먼저 올려 주세요.');
  const slots = entries.slice(0, MAX_SLOTS).map(entry => normalizeSlot({
    duration: entry.duration,
    speed: clipSpeed(entry.clip),
    transition: entry.clip.transitionOut?.type,
    transitionDuration: entry.clip.transitionOut?.duration,
  })).filter(Boolean);
  if (!slots.length) throw new Error('템플릿으로 만들 컷이 없습니다.');
  return { version: VERSION, id: 'tpl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    name: nameValue(name), slots, createdAt: Date.now() };
}

/**
 * 템플릿을 소재에 맞춰 어떻게 꽂을지 계산합니다. 프로젝트를 바꾸지 않는 순수 계산입니다.
 *
 * 소재가 슬롯보다 적으면 앞에서부터 다시 씁니다. 슬롯이 요구하는 원본 길이보다 소재가
 * 짧으면 먼저 배속을 올려 맞춰 보고, 그래도 모자라면 그 컷만 짧게 둡니다. 없는 화면을
 * 만들어 내지는 않습니다.
 */
export function planTemplate(template, sources) {
  const normalized = normalizeTemplate(template);
  if (!normalized) return { ok: false, reason: '템플릿을 읽지 못했습니다.' };
  const list = (sources || []).filter(s => record(s) && finite(s.duration, 0) > 0);
  if (!list.length) return { ok: false, reason: '템플릿에 넣을 영상을 먼저 라이브러리에 올려 주세요.' };

  let cursor = 0;
  const slots = normalized.slots.map((slot, index) => {
    const source = list[index % list.length];
    const available = Number(source.duration);
    // 슬롯이 요구하는 원본 길이. 2배속이면 2초짜리 컷에 원본 4초가 필요합니다.
    let speed = slot.speed;
    let span = slot.duration * speed;
    let shortened = false;
    if (span > available) {
      // 배속을 올려 맞춰 봅니다. 화면이 빨라질 뿐 리듬은 지켜집니다.
      speed = clamp(available / slot.duration, MIN_SPEED, MAX_SPEED);
      span = slot.duration * speed;
    }
    if (span > available) { span = available;shortened = true; }
    const duration = round(span / speed);
    const trimStart = round(Math.max(0, (available - span) / 2));   // 가운데를 씁니다
    const entry = {
      index, assetId: source.assetId, name: source.name,
      start: round(cursor), duration,
      trimStart, trimEnd: round(trimStart + span),
      speed: round(speed), transition: slot.transition,
      transitionDuration: slot.transition === 'cut' ? 0 : slot.transitionDuration,
      shortened,
    };
    cursor = round(cursor + duration);
    return entry;
  });
  return { ok: true, name: normalized.name, slots, total: round(cursor),
    shortened: slots.filter(s => s.shortened).length,
    reused: Math.max(0, normalized.slots.length - list.length) };
}

// ── 저장소 ────────────────────────────────────────────
function readAll(storage) {
  let raw;
  try { raw = storageAccess(storage).getItem(TEMPLATE_STORAGE_KEY); } catch { return []; }
  if (typeof raw !== 'string' || raw.length > MAX_STORAGE_CHARACTERS) return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return []; }
  const list = Array.isArray(parsed?.templates) ? parsed.templates : [];
  const seen = new Set();
  return list.map(normalizeTemplate).filter(item => {
    if (!item || seen.has(item.id)) return false;
    seen.add(item.id);return true;
  }).slice(0, MAX_TEMPLATES);
}

function writeAll(list, storage) {
  // 저장소를 아예 못 쓰는 것과 공간이 모자란 것은 원인이 다릅니다.
  // storageAccess 를 try 밖에서 불러야 "사이트 저장소를 허용해 달라" 는 안내가 살아남습니다.
  const target = storageAccess(storage);
  const payload = JSON.stringify({ version: VERSION, templates: list.slice(0, MAX_TEMPLATES) });
  if (payload.length > MAX_STORAGE_CHARACTERS) throw new Error('템플릿이 너무 많습니다. 쓰지 않는 템플릿을 지운 뒤 다시 저장해 주세요.');
  try { target.setItem(TEMPLATE_STORAGE_KEY, payload); }
  catch { throw new Error('템플릿을 저장하지 못했습니다. 브라우저 저장 공간을 확인해 주세요.'); }
}

export function listTemplates(storage) { return readAll(storage); }

/** 이미 만들어 둔 슬롯으로 템플릿을 꾸립니다. 음악에서 뽑은 리듬이 이 길로 들어옵니다. */
export function templateFromSlots(name, slots) {
  const cleaned = (Array.isArray(slots) ? slots : []).map(normalizeSlot).filter(Boolean).slice(0, MAX_SLOTS);
  if (!cleaned.length) throw new Error('템플릿으로 만들 컷이 없습니다.');
  return { version: VERSION, id: 'tpl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    name: nameValue(name), slots: cleaned, createdAt: Date.now() };
}

export function saveTemplate(name, { storage, doc, slots } = {}) {
  const template = slots ? templateFromSlots(name, slots) : captureTemplate(name, doc || project);
  const list = readAll(storage);
  if (list.length >= MAX_TEMPLATES) throw new Error('템플릿은 ' + MAX_TEMPLATES + '개까지 저장할 수 있습니다. 쓰지 않는 것을 먼저 지워 주세요.');
  const next = [template, ...list.filter(item => item.name !== template.name)];
  writeAll(next, storage);
  return template;
}

export function deleteTemplate(id, storage) {
  const list = readAll(storage);
  const next = list.filter(item => item.id !== id);
  if (next.length === list.length) return false;
  writeAll(next, storage);
  return true;
}

export function renameTemplate(id, name, storage) {
  const cleaned = nameValue(name);
  const list = readAll(storage);
  const target = list.find(item => item.id === id);
  if (!target) return false;
  target.name = cleaned;
  writeAll(list, storage);
  return true;
}
