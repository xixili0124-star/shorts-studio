import {
  quickFormatState, setQuickFormatEnabled, setQuickFormatMargins,
  setQuickFormatText, setQuickFormatTextStyle,
} from './quick-format.js';

export const SAVED_QUICK_FORMATS_KEY = 'shorts-studio.saved-quick-formats.v1';
export const MAX_SAVED_QUICK_FORMATS = 20;
const VERSION = 1;
const MAX_STORAGE_CHARACTERS = 128 * 1024;
const STYLE_PROPERTIES = ['position', 'font', 'size', 'color', 'accent', 'background'];
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(id);

function storageAccess(storage) {
  try {
    const resolved = storage ?? globalThis.localStorage;
    if (!resolved || typeof resolved.getItem !== 'function' || typeof resolved.setItem !== 'function') throw new Error();
    return resolved;
  } catch {
    throw new Error('퀵포맷을 저장할 수 없습니다. 브라우저의 사이트 저장소를 허용한 뒤 다시 시도해 주세요.');
  }
}

function nameValue(name) {
  const cleaned = typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : '';
  if (!cleaned) throw new Error('저장할 퀵포맷 이름을 입력해 주세요.');
  return cleaned.slice(0, 40);
}

// 저장소의 속성을 통째로 복사하지 않고, 편집기에서 지원하는 값만 다시 적용합니다.
function applySettings(template, settings) {
  setQuickFormatEnabled(template, true);
  setQuickFormatMargins(template, settings.top, settings.bottom);
  for (const side of ['top', 'bottom']) {
    setQuickFormatText(template, side, settings[`${side}Text`]);
    const style = settings[`${side}Style`];
    for (const property of STYLE_PROPERTIES) {
      if (!own(style, property)) continue;
      let value = style[property];
      if (property === 'font' && (typeof value !== 'string' || !value.trim() || value.length > 100)) continue;
      if (property !== 'font' && !['number', 'string'].includes(typeof value)) continue;
      setQuickFormatTextStyle(template, side, property, value);
    }
  }
  if (!settings.enabled) setQuickFormatEnabled(template, false);
  return quickFormatState(template);
}

function normalizedSettings(settings) {
  if (!record(settings) || !own(settings, 'enabled') || typeof settings.enabled !== 'boolean') return null;
  for (const side of ['top', 'bottom']) {
    if (!own(settings, side) || typeof settings[side] !== 'number' || !Number.isFinite(settings[side])) return null;
    if (!own(settings, `${side}Text`) || typeof settings[`${side}Text`] !== 'string') return null;
    if (!own(settings, `${side}Style`) || !record(settings[`${side}Style`])) return null;
  }
  return applySettings({}, settings);
}

function readRecords(storage) {
  let raw;
  try { raw = storage.getItem(SAVED_QUICK_FORMATS_KEY); }
  catch { throw new Error('저장한 퀵포맷을 읽을 수 없습니다. 브라우저의 사이트 저장소를 허용한 뒤 다시 시도해 주세요.'); }
  if (raw === null || raw === undefined) return [];
  let data;
  try {
    if (typeof raw !== 'string' || raw.length > MAX_STORAGE_CHARACTERS) throw new Error();
    data = JSON.parse(raw);
    if (!record(data) || data.version !== VERSION || !Array.isArray(data.items)) throw new Error();
  } catch {
    throw new Error('저장한 퀵포맷 정보를 읽을 수 없습니다. 브라우저의 사이트 데이터를 확인해 주세요. 기존 저장값은 변경하지 않았습니다.');
  }
  const items = [], ids = new Set();
  for (const item of data.items) {
    if (!record(item) || !validId(item.id) || ids.has(item.id) || typeof item.name !== 'string' || !item.name.trim()) continue;
    const settings = normalizedSettings(item.settings);
    if (!settings) continue;
    let name;
    try { name = nameValue(item.name); } catch { continue; }
    items.push({ id:item.id, name, settings });
    ids.add(item.id);
    if (items.length === MAX_SAVED_QUICK_FORMATS) break;
  }
  return items;
}

function writeRecords(storage, items) {
  try { storage.setItem(SAVED_QUICK_FORMATS_KEY, JSON.stringify({ version:VERSION, items })); }
  catch {
    throw new Error('퀵포맷을 저장하지 못했습니다. 브라우저 저장 공간이 부족하거나 저장이 차단되어 있습니다. 공간을 확보한 뒤 다시 시도해 주세요.');
  }
}

export function listSavedQuickFormats(storage) {
  return readRecords(storageAccess(storage));
}

export function saveQuickFormat(template, name, { storage, id } = {}) {
  if (!record(template)) throw new Error('저장할 퀵포맷 설정이 올바르지 않습니다.');
  const resolved = storageAccess(storage), items = readRecords(resolved);
  let label;
  if (name === undefined) {
    const names = new Set(items.map(item => item.name));
    let number = 1;
    while (names.has(`퀵포맷 ${number}`)) number++;
    label = `퀵포맷 ${number}`;
  } else label = nameValue(name);
  const index = id === undefined ? -1 : items.findIndex(item => item.id === id);
  if (id !== undefined && index < 0) throw new Error('저장한 퀵포맷을 찾을 수 없습니다. 목록을 다시 열어 주세요.');
  if (index < 0 && items.length >= MAX_SAVED_QUICK_FORMATS) throw new Error('퀵포맷은 20개까지 저장할 수 있습니다. 사용하지 않는 퀵포맷을 삭제한 뒤 다시 저장해 주세요.');
  let nextId = id;
  if (nextId === undefined) {
    do { nextId = globalThis.crypto?.randomUUID?.() || `format-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`; }
    while (items.some(item => item.id === nextId));
  }
  const item = { id:nextId, name:label, settings:normalizedSettings(quickFormatState(template)) };
  if (!item.settings) throw new Error('저장할 퀵포맷 설정이 올바르지 않습니다.');
  if (index >= 0) items[index] = item;
  else items.push(item);
  writeRecords(resolved, items);
  return item;
}

export function deleteSavedQuickFormat(id, storage) {
  const resolved = storageAccess(storage), items = readRecords(resolved), next = items.filter(item => item.id !== id);
  if (items.length === next.length) return false;
  writeRecords(resolved, next);
  return true;
}

// 이름 편집에는 현재 프로젝트를 받지 않아 저장한 문구와 스타일이 덮어써지지 않습니다.
export function renameSavedQuickFormat(id, name, storage) {
  const resolved = storageAccess(storage), items = readRecords(resolved), index = items.findIndex(item => item.id === id);
  if (index < 0) throw new Error('저장한 퀵포맷을 찾을 수 없습니다. 목록을 다시 열어 주세요.');
  const item = { ...items[index], name:nameValue(name) };
  items[index] = item;
  writeRecords(resolved, items);
  return item;
}

export function applySavedQuickFormat(template, id, storage) {
  if (!record(template)) throw new Error('퀵포맷을 적용할 프로젝트 설정이 올바르지 않습니다.');
  const item = listSavedQuickFormats(storage).find(item => item.id === id);
  if (!item) throw new Error('저장한 퀵포맷을 찾을 수 없습니다. 목록을 다시 열어 주세요.');
  return applySettings(template, item.settings);
}
