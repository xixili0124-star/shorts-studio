// 다중 선택은 ID만 보관합니다. 미디어 준비가 끝나기 전에는 프로젝트를 바꾸지 않습니다.
import { project, buildLayout, migrateTimeline, syncAnchoredItems, newOverlay, trackItems, timelineTracks, trackKind, isTrackLocked } from './state.js';
import { captureDocument, makeClip, makeAudio, discardStagedInstance } from './project-store.js';
import { timelineCollection, itemRange, splitAvailability, deleteTimelineItem, normalizeTransitions, planPlacement, LOCKED_TRACK_REASON } from './timeline-edits.js';
import { transformOf } from './visual-transform.js';
import { uid, clamp } from './util.js';
import { TEXT_STYLE_KEYS } from './text-effects.js';
import { KEYFRAME_CHANNELS, sliceKeyframes, splitKeyframes, setValueAt } from './keyframes.js';
import { splitCropTracking } from './crop-tracking.js';
import { relinkCopies } from './link-groups.js';

const EPS = 1e-6;
const clone = value => JSON.parse(JSON.stringify(value));
const cut = () => ({ type: 'cut', duration: 0 });
export const selectionKey = ref => ref.type + ':' + ref.id;
export function resolveSelection(refs, doc = project) {
  const available = new Map(buildLayout(doc).items.map(item => [selectionKey(item), item]));
  const seen = new Set(), result = [];
  for (const ref of refs || []) {
    if (!ref) continue;
    const key = selectionKey(ref), entry = available.get(key);
    if (!entry || seen.has(key)) continue;
    seen.add(key);result.push({ ...entry, item: entry.item || entry.clip });
  }
  return result;
}
export const selectionRefs = (refs, doc = project) => resolveSelection(refs, doc).map(({ type, id }) => ({ type, id }));
export function combineSelection(base, hits, mode = 'replace') {
  const chosen = new Map((mode === 'replace' ? [] : base).map(ref => [selectionKey(ref), { type: ref.type, id: ref.id }]));
  for (const ref of hits) {
    const key = selectionKey(ref);
    if (mode === 'toggle' && chosen.has(key)) chosen.delete(key);
    else chosen.set(key, { type: ref.type, id: ref.id });
  }
  return [...chosen.values()];
}
export function marqueeHits(a, b, boxes) {
  const left = Math.min(a.x,b.x), right = Math.max(a.x,b.x), top = Math.min(a.y,b.y), bottom = Math.max(a.y,b.y);
  return boxes.filter(box => box.left < right && box.right > left && box.top < bottom && box.bottom > top)
    .map(({ type, id }) => ({ type, id }));
}

const graphicKeys = ['graphic','align','x','y',...TEXT_STYLE_KEYS];
const mediaKeys = ['fit','bg','scale','offX','offY','fadeIn','fadeOut'];
const pick = (item, keys) => Object.fromEntries(keys.filter(key => item[key] !== undefined).map(key => [key, clone(item[key])]));
export function captureItemSettings(ref, doc = project) {
  const range = resolveSelection([ref],doc)[0];if (!range) return null;
  const { type, item } = range, payload = { version: 1, type, name: item.name || item.text || '클립' };
  payload.keyframes=item.keyframes?clone(item.keyframes):null;
  if (type !== 'audio') payload.visual = { transform: transformOf(item), crop: { left:0, right:0, top:0, bottom:0, ...item.crop } };
  if (type === 'clip') {
    payload.media = pick(item, mediaKeys);
    if (item.type === 'image') payload.image = { ken: item.ken || 'none' };
  }
  if (type === 'audio' || (type === 'clip' && item.type === 'video')) {
    payload.audio = { volume:item.volume??1, muted:!!item.muted, fadeIn:item.fadeIn||0, fadeOut:item.fadeOut||0 };
  }
  if (type === 'caption') payload.caption = { anim:'none', glow:null, ...doc.captionStyle, ...item.style };
  if (type === 'graphic') payload.graphic = { ...pick({ ...newOverlay(0), ...item },graphicKeys), graphic:item.graphic||null };
  if (type === 'caption' || type === 'graphic') payload.typography = pick(payload.caption || payload.graphic,TEXT_STYLE_KEYS);
  return clone(payload);
}
export function planPasteSettings(refs, payload, doc = captureDocument()) {
  if (!payload || payload.version !== 1) throw new Error('먼저 클립의 설정을 복사해 주세요.');
  const patches = [], skipped = [];
  for (const { type,id,item,duration } of resolveSelection(refs,doc)) {
    const patch = {}, remove = [];
    if (type !== 'audio' && payload.visual) {
      patch.transform = clone(transformOf({ transform:payload.visual.transform }));
      if(type==='clip')patch.crop = pick(payload.visual.crop || {},['left','right','top','bottom']);
    }
    if (type === 'clip' && payload.media) { Object.assign(patch,pick(payload.media,mediaKeys));remove.push('fadeEnvelope'); }
    if (type === 'clip' && item.type === 'image' && payload.image) { patch.ken=payload.image.ken;remove.push('motionDuration','motionOffset'); }
    if ((type === 'audio' || (type === 'clip' && item.type === 'video')) && payload.audio) {
      Object.assign(patch,pick(payload.audio,['volume','muted','fadeIn','fadeOut']));remove.push('fadeEnvelope');
    }
    if (type === 'caption' && (payload.caption || payload.typography)) {
      patch.style = { ...doc.captionStyle, ...item.style, ...clone(payload.caption || payload.typography) };
    }
    if (type === 'graphic' && (payload.graphic || payload.typography)) {
      Object.assign(patch,pick(payload.graphic || payload.typography,graphicKeys));
    }
    if(payload.keyframes!==undefined){
      const tracks=clone(item.keyframes?.tracks||{});
      const copied=payload.keyframes?sliceKeyframes({keyframes:payload.keyframes},0,duration)?.tracks||{}:{};
      for(const channel of KEYFRAME_CHANNELS){
        const compatible=channel==='volume'?!!payload.audio&&(type==='audio'||type==='clip'&&item.type==='video'):!!payload.visual&&type!=='audio';
        if(!compatible)continue;
        if(copied[channel])tracks[channel]=copied[channel];else delete tracks[channel];
      }
      if(Object.keys(tracks).length)patch.keyframes={version:1,tracks};else remove.push('keyframes');
    }
    if (Object.keys(patch).length) patches.push({ type,id,patch,remove });
    else skipped.push({ type,id });
  }
  return { document:doc, patches, skipped };
}
export function applySettingsPlan(plan) {
  if (JSON.stringify(captureDocument()) !== JSON.stringify(plan.document)) throw new Error('선택 항목이 변경되었습니다. 설정을 다시 붙여넣어 주세요.');
  for (const { type,id,patch,remove } of plan.patches) {
    const item = timelineCollection(type).find(item => item.id === id);
    for (const key of remove) delete item[key];
    Object.assign(item,clone(patch));
  }
  return { applied:plan.patches.length, skipped:plan.skipped.length };
}

/** 값은 UI의 퍼센트가 아닌 실제 저장 단위로 받습니다. 내용·시간·소재는 일괄 덮어쓰지 않습니다. */
export function applySharedProperty(refs, prop, value, {time=0}={}) {
  let count = 0;
  for (const { type,item,start,duration } of resolveSelection(refs)) {
    const local=clamp(time-start,0,duration);
    if (prop.startsWith('transform.') && type !== 'audio') {
      const key=prop.slice(10),limits={offsetX:[-3,3],offsetY:[-3,3],scaleX:[.05,10],scaleY:[.05,10],rotation:[-360,360],opacity:[0,1]};
      if (['flipX','flipY'].includes(key)) { if (typeof value !== 'boolean') continue; }
      else { if (!limits[key] || !Number.isFinite(value)) continue;value=clamp(value,...limits[key]); }
      if(['flipX','flipY'].includes(key))item.transform={...transformOf(item),[key]:value};
      else setValueAt(item,key,local,value,{duration});
    } else if (prop.startsWith('crop.') && type === 'clip') {
      const key=prop.slice(5),other={left:'right',right:'left',top:'bottom',bottom:'top'}[key];
      if (!other || !Number.isFinite(value)) continue;
      item.crop={...item.crop,[key]:clamp(value,0,Math.min(.95,.98-(item.crop?.[other]||0)))};
    } else if (prop.startsWith('textStyle.') && ['caption','graphic'].includes(type)) {
      const key=prop.slice(10);if (!TEXT_STYLE_KEYS.includes(key)) continue;
      if (type==='caption') item.style={...project.captionStyle,...item.style,[key]:value};else item[key]=value;
    } else if (prop.startsWith('style.') && type==='caption') {
      const key=prop.slice(6);if (![...TEXT_STYLE_KEYS,'bottom'].includes(key)) continue;
      item.style={...project.captionStyle,...item.style,[key]:value};
    } else if (['fadeIn','fadeOut'].includes(prop) && ['clip','audio'].includes(type)) {
      if (!Number.isFinite(value)) continue;item[prop]=clamp(value,0,10);delete item.fadeEnvelope;
    } else if (['volume','muted'].includes(prop) && (type==='audio'||(type==='clip'&&item.type==='video'))) {
      if (prop==='volume'&&!Number.isFinite(value)) continue;
      if(prop==='volume')setValueAt(item,'volume',local,clamp(value,0,3),{duration});else item.muted=!!value;
    } else if (['fit','bg'].includes(prop) && type==='clip') {
      if (!(prop==='fit'?['cover','contain']:['blur','black','white','transparent']).includes(value)) continue;item[prop]=value;
    } else if (prop==='ken' && type==='clip' && item.type==='image') {
      if (!['none','in','out','left','right'].includes(value)) continue;
      item.ken=value;delete item.motionDuration;delete item.motionOffset;
    } else continue;
    count++;
  }
  return count;
}

export function deleteSelectedItems(refs, ripple = false) {
  const ranges = resolveSelection(refs).sort((a,b) => b.start-a.start || b.end-a.end);
  for (const ref of ranges) deleteTimelineItem(ref,ripple);
  return ranges.length;
}

/**
 * 여러 행의 상대 시각을 보존해 움직입니다. 선택하지 않은 클립을 덮어쓰지 않습니다.
 * retarget 을 주면 그 항목 하나만 다른 행으로 옮깁니다. 나머지는 원래 행에 남습니다.
 * 연결된 영상을 다른 영상 트랙으로 끌 때, 원음이 오디오 트랙에 그대로 남아야 하기 때문입니다.
 */
export function planBatchMove(refs, delta, doc = captureDocument(), { retarget = null } = {}) {
  const ranges=resolveSelection(refs,doc),keys=new Set(ranges.map(selectionKey));
  if (!ranges.length || !Number.isFinite(delta)) return {ok:false,reason:'이동할 클립을 선택해 주세요.'};
  if (retarget) {
    const track=timelineTracks(doc).find(entry=>entry.id===retarget.trackId);
    if (!track||track.kind!==trackKind(retarget.type)) return {ok:false,reason:'영상은 영상 트랙에, 소리는 오디오 트랙에 놓아 주세요.',document:doc,delta:0,moves:[]};
    if (!keys.has(selectionKey(retarget))) return {ok:false,reason:'옮길 클립을 다시 선택해 주세요.',document:doc,delta:0,moves:[]};
  }
  if (ranges.some(r=>isTrackLocked(r.trackId,doc))||(retarget&&isTrackLocked(retarget.trackId,doc))) {
    return {ok:false,reason:LOCKED_TRACK_REASON,document:doc,delta:0,moves:[]};
  }
  delta=clamp(delta,-Math.min(...ranges.map(r=>r.start)),86400-Math.max(...ranges.map(r=>r.end)));
  const moves=ranges.map(r=>({type:r.type,id:r.id,from:r.trackId,
    trackId:retarget&&selectionKey(retarget)===selectionKey(r)?retarget.trackId:r.trackId,
    start:r.start+delta,end:r.end+delta,duration:r.duration}));
  const moved=moves.some(r=>Math.abs(delta)>EPS||r.trackId!==r.from);
  const others=buildLayout(doc).items.filter(r=>!keys.has(selectionKey(r)));
  const overlaps=(a,b)=>a.start<b.end-EPS&&a.end>b.start+EPS;
  const collision=moved&&(moves.some(r=>others.some(o=>o.trackId===r.trackId&&overlaps(o,r)))
    // 행을 옮긴 항목만 같은 묶음의 다른 항목과 겹치는지 봅니다.
    // 전환으로 이어진 클립들은 원래 서로 겹쳐 있으므로 제자리 이동은 검사하지 않습니다.
    ||moves.some((r,i)=>r.trackId!==r.from&&moves.some((other,j)=>j!==i&&other.trackId===r.trackId&&overlaps(other,r))));
  return {ok:!collision,reason:collision?'선택하지 않은 클립과 겹칩니다. 빈 구간에 놓아 주세요.':'',document:doc,delta,moves,
    retargeted:moves.some(r=>r.trackId!==r.from)};
}
export function applyBatchMove(plan) {
  if (!plan.ok) throw new Error(plan.reason);
  if (JSON.stringify(captureDocument())!==JSON.stringify(plan.document)) throw new Error('편집 내용이 변경되었습니다. 다시 드래그해 주세요.');
  if (Math.abs(plan.delta)<EPS&&!plan.retargeted) return false;
  for (const move of plan.moves) if (isTrackLocked(move.trackId)||isTrackLocked(move.from)) throw new Error(LOCKED_TRACK_REASON);
  migrateTimeline();
  const moving=new Set(plan.moves.filter(r=>r.type==='clip').map(r=>r.id));
  for (const clip of project.clips) if (clip.transitionOut?.toId && moving.has(clip.id)!==moving.has(clip.transitionOut.toId)) clip.transitionOut=cut();
  for (const move of plan.moves) {
    const item=timelineCollection(move.type).find(item=>item.id===move.id);
    if (move.trackId&&move.trackId!==move.from) item.trackId=move.trackId;
    item.start=move.start;if (move.type==='caption'||move.type==='graphic') item.end=move.end;delete item.anchor;
  }
  normalizeTransitions();syncAnchoredItems();return true;
}

const limits={clip:1000,audio:1000,caption:5000,graphic:1000};
function checkCapacity(refs, doc) {
  for (const [type,limit] of Object.entries(limits)) if (timelineCollection(type,doc).length+refs.filter(r=>r.type===type).length>limit) {
    throw new Error('선택 항목을 추가하면 프로젝트의 클립 개수 제한을 넘습니다.');
  }
}
function verifySnapshot(doc, signal) {
  if (signal?.aborted) throw new DOMException('편집을 취소했습니다.','AbortError');
  if (JSON.stringify(captureDocument())!==JSON.stringify(doc)) throw new Error('소재 준비 중 편집 내용이 변경되었습니다. 다시 시도해 주세요.');
}
export function planBatchSplit(refs, time, doc = captureDocument()) {
  const entries=selectionRefs(refs,doc).map(ref=>({...ref,check:splitAvailability(ref,time,doc)}));
  const eligible=entries.filter(entry=>entry.check.ok),skipped=entries.filter(entry=>!entry.check.ok);
  checkCapacity(eligible,doc);
  return {document:doc,time,eligible,skipped};
}
export async function applyBatchSplit(plan, {signal} = {}) {
  const staged=[];
  try {
    verifySnapshot(plan.document,signal);
    for (const {type,id,check} of plan.eligible) {
      const saved=clone(check.item),left={},rightId=uid(),local=check.local;
      const motion=splitKeyframes(saved,local,check.duration);
      left.keyframes=motion.left;
      const envelope=clone(saved.fadeEnvelope||{offset:0,duration:check.duration,fadeIn:saved.fadeIn||0,fadeOut:saved.fadeOut||0});
      let right;
      if (type==='clip') right=await makeClip(saved.assetId,{...saved,id:rightId,start:plan.time,fadeIn:0});
      else if (type==='audio') right=makeAudio(saved.assetId,{...saved,id:rightId,start:plan.time,trimStart:saved.trimStart+local,fadeIn:0});
      else right={...saved,id:rightId,start:plan.time,end:check.end};
      right.keyframes=motion.right;
      if(type==='clip'&&saved.cropTracking){const tracking=splitCropTracking(saved,local,check.duration);left.cropTracking=tracking.left;right.cropTracking=tracking.right;}
      staged.push({type,id,left,right});
      verifySnapshot(plan.document,signal);
      if (type==='clip') {
        if (saved.type==='video') {right.trimStart=saved.trimStart+local;left.trimEnd=right.trimStart;}
        else {
          const motionDuration=saved.motionDuration||check.duration,motionOffset=saved.motionOffset||0;
          Object.assign(right,{imgDuration:check.duration-local,motionDuration,motionOffset:motionOffset+local});
          Object.assign(left,{imgDuration:local,motionDuration,motionOffset});
        }
        left.transitionOut=cut();
      } else if (type==='audio') left.trimEnd=right.trimStart;
      else Object.assign(left,{start:check.start,end:plan.time});
      if (type==='clip'||type==='audio') {
        left.fadeOut=0;left.fadeEnvelope=clone(envelope);right.fadeEnvelope={...envelope,offset:envelope.offset+local};
      }
    }
    // 잘라낸 오른쪽 조각끼리 다시 묶습니다. 원본 묶음을 물려받으면 남의 짝과 함께 움직입니다.
    relinkCopies(staged.map(entry=>entry.right));
    verifySnapshot(plan.document,signal);migrateTimeline();
    for (const {type,id,left,right} of staged) {
      const list=timelineCollection(type),index=list.findIndex(item=>item.id===id);
      Object.assign(list[index],left);delete list[index].anchor;delete right.anchor;
      list.splice(index+1,0,right);
    }
    normalizeTransitions();syncAnchoredItems();
    return {items:staged.map(({type,right})=>({type,id:right.id,start:plan.time,end:itemRange(type,right.id).end})),skipped:plan.skipped.length};
  } catch (error) {
    for (const {type,right} of staged) if (type==='clip'||type==='audio') discardStagedInstance(type,right.id);
    throw error;
  }
}

/** 행 사이의 상대 정렬도 보존합니다. 삽입 경계가 밀리면 묶음 전체를 같은 만큼 이동합니다. */
export async function duplicateSelectedItems(refs, {signal} = {}) {
  const doc=captureDocument(),ranges=resolveSelection(refs,doc),staged=[],groups=[];
  if(!ranges.length)return [];
  checkCapacity(ranges,doc);
  for (const trackId of new Set(ranges.map(r=>r.trackId))) {
    const entries=ranges.filter(r=>r.trackId===trackId),start=Math.min(...entries.map(r=>r.start)),end=Math.max(...entries.map(r=>r.end));
    groups.push({trackId,start,end,entries});
  }
  let delta=Math.max(...ranges.map(r=>r.end))-Math.min(...ranges.map(r=>r.start));
  const attempts=buildLayout(doc).items.length+groups.length+1;
  for(let attempt=0;attempt<attempts;attempt++){
    let nextDelta=delta;
    for(const group of groups){
      const desired=group.start+delta,items=trackItems(group.trackId,doc);
      const covering=items.filter(r=>r.start<desired-EPS&&r.end>desired+EPS);
      const at=covering.length?Math.max(...covering.map(r=>r.end)):desired;
      group.placement=planPlacement(at,group.end-group.start,group.trackId,null,doc);
      nextDelta=Math.max(nextDelta,group.placement.start-group.start);
    }
    if(Math.abs(nextDelta-delta)<EPS)break;
    delta=nextDelta;if(attempt===attempts-1)throw new Error('묶음을 복제할 빈 경계를 찾지 못했습니다.');
  }
  for(const group of groups){
    if(Math.abs(group.placement.start-group.start-delta)>EPS)throw new Error('묶음의 정렬을 유지할 수 없는 위치입니다.');
    if(group.placement.end>86400+EPS||group.placement.shifts.some(shift=>{
      const range=itemRange(shift.type,shift.id,doc);return shift.start+range.duration>86400+EPS;
    }))throw new Error('복제하면 타임라인의 최대 길이를 넘습니다.');
  }
  try {
    verifySnapshot(doc,signal);
    const ids=new Map(ranges.map(r=>[r.id,uid()]));
    for (const group of groups) for (const entry of group.entries) {
      const saved=clone(entry.item),id=ids.get(entry.id),start=Math.min(86400,entry.start+delta);
      const overrides={...saved,id,start};
      if (entry.type==='clip') overrides.transitionOut=ids.has(saved.transitionOut?.toId)?{...saved.transitionOut,toId:ids.get(saved.transitionOut.toId)}:cut();
      if (entry.type==='caption'||entry.type==='graphic') overrides.end=Math.min(86400,start+entry.duration);
      const item=entry.type==='clip'?await makeClip(saved.assetId,overrides):entry.type==='audio'?makeAudio(saved.assetId,overrides):overrides;
      staged.push({type:entry.type,item});verifySnapshot(doc,signal);
    }
    // 사본끼리만 연결합니다. 원본의 짝과 함께 끌려다니지 않게 합니다.
    relinkCopies(staged.map(entry=>entry.item));
    verifySnapshot(doc,signal);migrateTimeline();
    for (const group of groups) {
      for (const shift of group.placement.shifts) {
        const range=itemRange(shift.type,shift.id);range.item.start=shift.start;
        if (shift.type==='caption'||shift.type==='graphic') range.item.end=Math.min(86400,shift.start+range.duration);
      }
      const previous=project.clips.find(c=>c.id===group.placement.breakAfterId);if (previous) previous.transitionOut=cut();
    }
    for (const {type,item} of staged) {delete item.anchor;timelineCollection(type).push(item);}
    normalizeTransitions();syncAnchoredItems();
    return staged.map(({type,item})=>({type,id:item.id,start:item.start,end:itemRange(type,item.id).end}));
  } catch (error) {
    for (const {type,item} of staged) if (type==='clip'||type==='audio') discardStagedInstance(type,item.id);
    throw error;
  }
}
