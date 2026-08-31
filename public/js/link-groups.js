// 영상과 그 원음처럼 함께 움직여야 하는 항목을 하나의 묶음으로 다룹니다.
//
// 프리미어의 "연결"과 같은 개념입니다. 같은 linkId 를 가진 항목은 타임라인에서
// 함께 선택되고, 함께 이동·트림·분할·삭제됩니다. 우클릭 메뉴의 [연결 해제] 로
// 풀면 각자 따로 움직입니다.
//
// 규칙 두 가지:
//   1. 혼자 남은 linkId 는 "연결 없음"과 같습니다. 짝을 지우고 남은 흔적을
//      오류로 만들지 않기 위해서입니다.
//   2. 분할·복제로 새로 생긴 항목은 원본의 linkId 를 물려받지 않습니다.
//      물려받으면 잘라낸 오른쪽 조각이 남의 짝과 함께 움직입니다.
import { uid } from './util.js';

/** 연결할 수 있는 타임라인 종류입니다. 자막·그래픽은 아직 포함하지 않습니다. */
export const LINKABLE_TYPES = ['clip', 'audio'];
export const MAX_LINK_MEMBERS = 48;
const key = ref => ref.type + ':' + ref.id;
export const isLinkId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);

function linkableItems(doc) {
  const audio = doc?.audio?.tracks || doc?.tracks || [];
  return [
    ...(doc?.clips || []).map(item => ({ type: 'clip', id: item.id, item })),
    ...audio.map(item => ({ type: 'audio', id: item.id, item })),
  ];
}

/** linkId 별 구성원입니다. 혼자인 묶음은 연결로 치지 않으므로 제외합니다. */
export function linkGroups(doc) {
  const groups = new Map();
  for (const entry of linkableItems(doc)) {
    if (!isLinkId(entry.item?.linkId)) continue;
    const list = groups.get(entry.item.linkId) || [];
    list.push({ type: entry.type, id: entry.id });
    groups.set(entry.item.linkId, list);
  }
  for (const [id, list] of groups) if (list.length < 2) groups.delete(id);
  return groups;
}

/** 화면에 연결 표시를 그릴 linkId 집합입니다. */
export const activeLinkIds = doc => new Set(linkGroups(doc).keys());

/** 이 항목이 속한 묶음 전체입니다. 연결이 없으면 자기 자신만 돌려줍니다. */
export function linkedRefs(ref, doc) {
  if (!ref || !LINKABLE_TYPES.includes(ref.type)) return ref ? [{ type: ref.type, id: ref.id }] : [];
  const item = linkableItems(doc).find(entry => entry.type === ref.type && entry.id === ref.id)?.item;
  const group = isLinkId(item?.linkId) ? linkGroups(doc).get(item.linkId) : null;
  if (!group) return [{ type: ref.type, id: ref.id }];
  // 물어본 항목을 맨 앞에 둡니다. 호출자가 이 순서로 대표 항목을 고릅니다.
  return [{ type: ref.type, id: ref.id },
    ...group.filter(entry => entry.type !== ref.type || entry.id !== ref.id).map(entry => ({ ...entry }))];
}

/** 선택에 연결된 짝을 더합니다. 순서와 중복 제거는 원래 선택을 먼저 둡니다. */
export function expandLinked(refs, doc) {
  const chosen = new Map();
  for (const ref of refs || []) {
    if (!ref) continue;
    for (const member of linkedRefs(ref, doc)) if (!chosen.has(key(member))) chosen.set(key(member), member);
  }
  return [...chosen.values()];
}

/** 이 선택이 연결되어 함께 움직이는 상태인지입니다. */
export function isLinkedSelection(refs, doc) {
  return (refs || []).some(ref => linkedRefs(ref, doc).length > 1);
}

/**
 * 선택 항목을 하나의 묶음으로 만들 계획입니다. 아직 프로젝트를 바꾸지 않습니다.
 * 이미 연결된 항목이 섞여 있으면 그 짝까지 모두 한 묶음으로 합칩니다.
 */
export function planLink(refs, doc) {
  const members = expandLinked((refs || []).filter(ref => LINKABLE_TYPES.includes(ref?.type)), doc);
  if (members.length < 2) return { ok: false, reason: '연결할 영상·오디오 클립을 두 개 이상 선택해 주세요.' };
  if (members.length > MAX_LINK_MEMBERS) return { ok: false, reason: '한 번에 연결할 수 있는 클립은 ' + MAX_LINK_MEMBERS + '개까지입니다.' };
  const items = linkableItems(doc);
  const resolved = members.map(ref => items.find(entry => entry.type === ref.type && entry.id === ref.id));
  if (resolved.some(entry => !entry)) return { ok: false, reason: '선택 항목이 변경되었습니다. 다시 선택해 주세요.' };
  const shared = resolved.every(entry => isLinkId(entry.item.linkId) && entry.item.linkId === resolved[0].item.linkId);
  if (shared) return { ok: false, reason: '이미 하나로 연결된 클립입니다.' };
  return { ok: true, linkId: uid(), members };
}

/** 계획대로 같은 linkId 를 붙입니다. 호출자가 되돌리기 기록을 담당합니다. */
export function applyLink(plan, doc) {
  if (!plan?.ok) throw new Error(plan?.reason || '연결할 클립을 선택해 주세요.');
  const items = linkableItems(doc);
  for (const ref of plan.members) {
    const entry = items.find(item => item.type === ref.type && item.id === ref.id);
    if (!entry) throw new Error('선택 항목이 변경되었습니다. 다시 선택해 주세요.');
    entry.item.linkId = plan.linkId;
  }
  return plan.members.length;
}

/** 선택 항목이 속한 묶음을 통째로 풉니다. 절반만 풀면 남은 쪽이 계속 붙어 다닙니다. */
export function applyUnlink(refs, doc) {
  const members = expandLinked(refs, doc), items = linkableItems(doc);
  let count = 0;
  for (const ref of members) {
    const entry = items.find(item => item.type === ref.type && item.id === ref.id);
    if (!entry || !isLinkId(entry.item.linkId)) continue;
    delete entry.item.linkId;
    count++;
  }
  return count;
}

/**
 * 분할·복제로 만든 사본에 새 linkId 를 배정합니다.
 * 같은 원본 묶음에서 나온 사본끼리는 서로 연결되고, 원본과는 끊어집니다.
 * 혼자만 복제됐다면 새 linkId 를 혼자 갖게 되므로 결과적으로 연결이 없습니다.
 */
export function relinkCopies(copies) {
  const remap = new Map();
  for (const item of copies) {
    if (!item || !isLinkId(item.linkId)) continue;
    if (!remap.has(item.linkId)) remap.set(item.linkId, uid());
    item.linkId = remap.get(item.linkId);
  }
  return remap;
}
