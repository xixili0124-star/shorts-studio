// 편집 데이터와 미디어 자원을 분리합니다. 되돌리기는 DOM/File을 복제하지 않습니다.
import { project, newClipDefaults, syncAnchoredItems } from './state.js';
import { createClip, disposeClip } from './media.js';
import { decodeAudioFile } from './audio.js';
import { uid } from './util.js';

export const assets = new Map();
const clipRuntime = new Map();
const audioRuntime = new Map();
let assetReady = () => {};
export function onAssetReady(callback) { assetReady = callback; }
export let documentName = '새 프로젝트';
export function setDocumentName(name) { documentName = String(name).trim().slice(0, 100) || '새 프로젝트'; }
const clipKeys = ['id','assetId','type','name','trimStart','trimEnd','imgDuration','ken','fit','bg','scale','offX','offY','fadeIn','fadeOut','volume','muted','transitionOut'];
const audioKeys = ['id','assetId','name','start','trimStart','trimEnd','volume','fadeIn','fadeOut','muted','lane','aiGenerated'];
const copy = value => JSON.parse(JSON.stringify(value));
const pick = (object, keys) => Object.fromEntries(keys.filter(k => object[k] !== undefined).map(k => [k, object[k]]));

export function captureDocument() {
  return copy({ version: 1, name: documentName,
    settings: pick(project, ['width','height','fps','quality']),
    clips: project.clips.map(c => pick(c, clipKeys)),
    overlays: project.overlays, captions: project.captions,
    captionStyle: project.captionStyle, template: project.template,
    tracks: (project.audio.tracks || []).map(t => pick(t, audioKeys)),
    originalVolume: project.audio.originalVolume,
  });
}

export function restoreDocument(doc) {
  // 필요한 자원이 모두 있는지 먼저 검사해 중간 상태를 남기지 않습니다.
  const clips = doc.clips.map(c => {
    const runtime = clipRuntime.get(c.id);
    if (!runtime) throw new Error('프로젝트 소재를 먼저 불러와야 합니다.');
    return { ...runtime, ...copy(pick(c,clipKeys)) };
  });
  const tracks = (doc.tracks || []).map(t => {
    const runtime = audioRuntime.get(t.id);
    if (!runtime) throw new Error('프로젝트 오디오를 먼저 불러와야 합니다.');
    return { ...runtime, ...copy(pick(t,audioKeys)) };
  });
  setDocumentName(doc.name);
  Object.assign(project, pick(doc.settings || {}, ['width','height','fps','quality']));
  project.clips = clips;
  project.audio.tracks = tracks;
  project.audio.bgm = null;
  project.audio.originalVolume = doc.originalVolume ?? 1;
  project.overlays = copy(doc.overlays || []);
  project.captions = copy(doc.captions || []);
  project.captionStyle = copy(doc.captionStyle || project.captionStyle);
  project.template = copy(doc.template || project.template);
  syncAnchoredItems();
}

export class History {
  constructor(onRestore = () => {}) { this.past = []; this.future = []; this.onRestore = onRestore; }
  push(before, label) {
    if (JSON.stringify(before) === JSON.stringify(captureDocument())) return false;
    this.past.push({ doc: before, label });
    if (this.past.length > 60) this.past.shift();
    this.future = [];
    return true;
  }
  undo() {
    const item = this.past.pop();
    if (!item) return null;
    this.future.push({ doc: captureDocument(), label: item.label });
    restoreDocument(item.doc);this.onRestore();return item.label;
  }
  redo() {
    const item = this.future.pop();
    if (!item) return null;
    this.past.push({ doc: captureDocument(), label: item.label });
    restoreDocument(item.doc);this.onRestore();return item.label;
  }
  clear() { this.past = [];this.future = []; }
}

export async function addAsset(file, options = {}) {
  if (!(file instanceof Blob) || !file.size) throw new Error('빈 파일은 추가할 수 없습니다.');
  if (file.size > 600 * 1024 * 1024) throw new Error('실험판은 파일 하나당 600MB까지 지원합니다. 필요한 구간을 잘라서 가져와 주세요.');
  if (assets.size >= 200) throw new Error('실험판에는 소재를 최대 200개까지 추가할 수 있습니다.');
  const id = options.id || uid();
  if (assets.has(id)) return assets.get(id);
  const isAudio = file.type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|flac|opus)$/i.test(file.name);
  let asset;
  if (isAudio) {
    const buffer = await decodeAudioFile(file);
    asset = { id, kind: 'audio', file, buffer, url: URL.createObjectURL(file), duration: buffer.duration, waveform: waveformOf(buffer), aiGenerated: !!options.aiGenerated };
  } else {
    const base = await createClip(file, options.onStatus);
    asset = { id, kind: base.type, file, base, duration: base.type === 'video' ? base.srcDuration : 3, thumb: base.thumb };
  }
  assets.set(id, asset);
  return asset;
}

export async function makeClip(assetId, overrides = {}) {
  const asset = assets.get(assetId);
  if (!asset || asset.kind === 'audio') throw new Error('영상 또는 이미지 소재를 선택해 주세요.');
  let runtime = { ...asset.base };
  const id = overrides.id || uid();
  if (runtime.decoderOnly) runtime = await createClip(asset.file);
  else if (runtime.type === 'video') {
    const el = document.createElement('video');
    el.src = runtime.url; el.preload = 'auto';el.playsInline = true;
    el.addEventListener('loadeddata', () => assetReady(), { once: true });
    runtime.el = el;
  }
  const clip = { ...runtime, ...pick(newClipDefaults(runtime.type), ['transitionOut']), assetId, id, ...overrides };
  clipRuntime.set(id, clip);
  return clip;
}

export function makeAudio(assetId, overrides = {}) {
  const asset = assets.get(assetId);
  if (!asset || asset.kind !== 'audio') throw new Error('오디오 소재를 선택해 주세요.');
  const id = overrides.id || uid();
  const el = document.createElement('audio');el.src = asset.url;el.preload = 'auto';
  const track = { id, assetId, name: asset.file.name, file: asset.file, buffer: asset.buffer, el,
    start: 0, trimStart: 0, trimEnd: asset.duration, volume: .65, fadeIn: .15, fadeOut: .4,
    muted: false, lane: asset.aiGenerated ? 'voice' : 'music', aiGenerated: !!asset.aiGenerated, ...overrides };
  audioRuntime.set(id, track);
  return track;
}

export function waveformOf(buffer, count = 112) {
  const bins = new Array(count).fill(0);
  const step = Math.max(1, Math.floor(buffer.length / count));
  for (let b = 0; b < count; b++) {
    let square = 0, n = 0;
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const channel = buffer.getChannelData(c);
      for (let i = b * step; i < Math.min(channel.length, (b + 1) * step); i += Math.max(1, Math.floor(step / 50))) { square += channel[i] ** 2; n++; }
    }
    bins[b] = Math.sqrt(square / Math.max(1, n));
  }
  const peak = Math.max(.00001, ...bins);
  return bins.map(v => v / peak);
}

function disposeResources(assetMap, clipMap, audioMap) {
  for (const c of clipMap.values()) { c.el?.pause(); if(c.el)c.el.src=''; if(c.decoderOnly)try{c.input?.dispose?.();}catch{} }
  for (const t of audioMap.values()) { t.el?.pause();if(t.el)t.el.src=''; }
  for (const a of assetMap.values()) {
    if (a.base) disposeClip(a.base);
    if (a.url) URL.revokeObjectURL(a.url);
  }
}

export function clearAssets() {
  disposeResources(assets, clipRuntime, audioRuntime);
  assets.clear();clipRuntime.clear();audioRuntime.clear();
}

async function hydrate(doc, records) {
  // 파일이 손상되었거나 디코딩에 실패해도 열려 있던 프로젝트와 undo 자원은 유지합니다.
  const before=captureDocument(), oldAssets=new Map(assets), oldClips=new Map(clipRuntime), oldAudio=new Map(audioRuntime);
  assets.clear();clipRuntime.clear();audioRuntime.clear();
  try {
    for (const record of records) await addAsset(record.file, record);
    for (const clip of doc.clips) {
      const asset=assets.get(clip.assetId);
      if(asset.kind!==clip.type || (clip.type==='video' && clip.trimEnd>asset.duration+.05)) throw new Error('영상 소재와 편집 구간이 일치하지 않습니다.');
      await makeClip(clip.assetId, pick(clip,clipKeys));
    }
    for (const track of doc.tracks || []) {
      const asset=assets.get(track.assetId);
      if(asset.kind!=='audio' || track.trimEnd>asset.duration+.05) throw new Error('오디오 소재와 편집 구간이 일치하지 않습니다.');
      makeAudio(track.assetId, pick(track,audioKeys));
    }
    restoreDocument(doc);
  } catch(error) {
    clearAssets();
    for(const [key,value] of oldAssets)assets.set(key,value);
    for(const [key,value] of oldClips)clipRuntime.set(key,value);
    for(const [key,value] of oldAudio)audioRuntime.set(key,value);
    restoreDocument(before);
    throw error;
  }
  disposeResources(oldAssets,oldClips,oldAudio);
}

export function validateDocument(doc, records) {
  if (!doc || doc.version !== 1 || !Array.isArray(records) || !Array.isArray(doc.clips) || !Array.isArray(doc.captions) || !Array.isArray(doc.overlays) || !Array.isArray(doc.tracks)) throw new Error('지원하지 않는 프로젝트 형식입니다.');
  if (doc.clips.length > 1000 || doc.tracks.length > 1000 || doc.captions.length > 5000 || doc.overlays.length > 1000 || records.length > 200) throw new Error('실험판의 프로젝트 크기 제한을 초과했습니다.');
  const safeId=id=>typeof id==='string' && /^[a-zA-Z0-9_-]{1,80}$/.test(id);
  if(records.some(r=>!r || !safeId(r.id)) || new Set(records.map(r=>r.id)).size!==records.length)throw new Error('소재 식별자가 올바르지 않습니다.');
  const ids = new Set(records.map(r => r.id));
  const instanceIds = new Set();
  for(const clip of doc.clips) {
    if(!clip || !['video','image'].includes(clip.type) || !Number.isFinite(clip.scale) || !Number.isFinite(clip.offX) || !Number.isFinite(clip.offY) || !Number.isFinite(clip.trimStart) || !Number.isFinite(clip.trimEnd) || !Number.isFinite(clip.imgDuration))throw new Error('클립 속성이 올바르지 않습니다.');
    if(clip.scale<.1 || clip.scale>10 || Math.abs(clip.offX)>2 || Math.abs(clip.offY)>2)throw new Error('클립 배치가 허용 범위를 벗어났습니다.');
  }
  for(const track of doc.tracks) {
    if(!track || !Number.isFinite(track.start) || !Number.isFinite(track.trimStart) || !Number.isFinite(track.trimEnd) || track.trimEnd<=track.trimStart || !['music','voice'].includes(track.lane))throw new Error('오디오 구간이 올바르지 않습니다.');
  }
  for (const item of [...doc.clips, ...(doc.tracks || [])]) {
    if (!item || !ids.has(item.assetId) || !safeId(item.id) || instanceIds.has(item.id)) throw new Error('프로젝트 소재 연결이 올바르지 않습니다.');
    instanceIds.add(item.id);
    for (const key of ['start','trimStart','trimEnd','imgDuration','scale','offX','offY','volume','fadeIn','fadeOut']) {
      if (item[key] !== undefined && (!Number.isFinite(item[key]) || Math.abs(item[key]) > 86400)) throw new Error('프로젝트 시간 또는 속성 값이 올바르지 않습니다.');
    }
    if (item.trimStart < 0 || item.trimEnd < item.trimStart || item.imgDuration <= 0 || item.start < 0 || item.scale <= 0) throw new Error('클립 구간이 올바르지 않습니다.');
    if (item.transitionOut && (!['cut','dissolve','fade','flash'].includes(item.transitionOut.type) || !Number.isFinite(item.transitionOut.duration) || item.transitionOut.duration<0 || item.transitionOut.duration>2)) throw new Error('전환 정보가 올바르지 않습니다.');
  }
  for (const item of [...doc.captions, ...doc.overlays]) {
    if (!item || !safeId(item.id) || instanceIds.has(item.id) || typeof item.text !== 'string' || item.text.length > 10000 || !Number.isFinite(item.start) || !Number.isFinite(item.end) || item.start < 0 || item.end < item.start || item.end > 86400) throw new Error('자막 또는 그래픽 정보가 올바르지 않습니다.');
    instanceIds.add(item.id);
    if(item.anchor && (!safeId(item.anchor.clipId) || !Number.isFinite(item.anchor.sourceStart) || !Number.isFinite(item.anchor.sourceEnd)))throw new Error('자막 연결 시각이 올바르지 않습니다.');
  }
  if (!doc.settings || ![720,1080,1440].includes(doc.settings.width) || doc.settings.height !== doc.settings.width * 16/9 || ![24,30,60].includes(doc.settings.fps) || !['low','medium','high','very-high'].includes(doc.settings.quality)) throw new Error('출력 설정이 올바르지 않습니다.');
}

export function packProject() {
  const records = [...assets.values()].map(a => ({ id:a.id, name:a.file.name, type:a.file.type, size:a.file.size, lastModified:a.file.lastModified || 0, aiGenerated:!!a.aiGenerated }));
  const header = new TextEncoder().encode(JSON.stringify({ document:captureDocument(), assets:records }));
  const length = new Uint8Array(4);new DataView(length.buffer).setUint32(0, header.length, true);
  return new Blob(['SSLAB01\n',length,header,...[...assets.values()].map(a=>a.file)],{type:'application/octet-stream'});
}

export async function unpackProject(file) {
  if (file.size < 12) throw new Error('프로젝트 파일이 너무 짧습니다.');
  const prelude = await file.slice(0,12).arrayBuffer();
  if (new TextDecoder().decode(new Uint8Array(prelude,0,8)) !== 'SSLAB01\n') throw new Error('숏츠 스튜디오 .shorts 프로젝트를 선택해 주세요.');
  const length = new DataView(prelude).getUint32(8,true);
  if (!length || length > 4*1024*1024 || 12+length > file.size) throw new Error('프로젝트 헤더가 손상되었습니다.');
  let header;
  try {header=JSON.parse(await file.slice(12,12+length).text());} catch {throw new Error('프로젝트 정보를 읽지 못했습니다.');}
  if (!Array.isArray(header.assets)) throw new Error('소재 목록이 없습니다.');
  let offset=12+length;
  const records=header.assets.map(a=>{
    if (!Number.isSafeInteger(a.size) || a.size <= 0 || offset+a.size > file.size) throw new Error('프로젝트 소재가 손상되었습니다.');
    const record={...a,file:new File([file.slice(offset,offset+a.size)],String(a.name).slice(0,255),{type:a.type,lastModified:a.lastModified})};
    offset+=a.size;return record;
  });
  if (offset !== file.size) throw new Error('프로젝트 파일 크기가 일치하지 않습니다.');
  validateDocument(header.document,records);
  await hydrate(header.document,records);
}

function openDraftDb() {
  return new Promise((resolve,reject)=>{
    if (!('indexedDB' in window)) return reject(new Error('이 브라우저에서 자동 저장을 사용할 수 없습니다.'));
    const request=indexedDB.open('shorts-studio-lab-v1',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('draft');
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
}

export async function saveDraft() {
  const total=[...assets.values()].reduce((s,a)=>s+a.file.size,0);
  if(total>300*1024*1024)throw new Error('큰 프로젝트는 저장 버튼으로 .shorts 파일을 보관해 주세요.');
  const db=await openDraftDb();
  const record={document:captureDocument(),assets:[...assets.values()].map(a=>({id:a.id,file:a.file,aiGenerated:!!a.aiGenerated})),updated:Date.now()};
  try { await new Promise((resolve,reject)=>{
    const tx=db.transaction('draft','readwrite');tx.objectStore('draft').put(record,'latest');
    tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
  }); } finally {db.close();}
}

export async function loadDraft() {
  const db=await openDraftDb();
  let record;
  try {record=await new Promise((resolve,reject)=>{
    const r=db.transaction('draft').objectStore('draft').get('latest');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
  });}finally{db.close();}
  if(!record)return false;
  validateDocument(record.document,record.assets);
  await hydrate(record.document,record.assets);
  return true;
}

/** 권리 문제가 없는 짧은 시험 사운드를 PCM WAV로 생성합니다. */
export function demoSound(seconds=12) {
  const rate=24000,n=Math.floor(rate*seconds),bytes=new ArrayBuffer(44+n*2),view=new DataView(bytes);
  const str=(at,s)=>[...s].forEach((c,i)=>view.setUint8(at+i,c.charCodeAt(0)));
  str(0,'RIFF');view.setUint32(4,36+n*2,true);str(8,'WAVE');str(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,rate,true);view.setUint32(28,rate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);str(36,'data');view.setUint32(40,n*2,true);
  const notes=[220,261.63,329.63,293.66];
  for(let i=0;i<n;i++) {const t=i/rate,beat=t%.5,f=notes[Math.floor(t/.5)%4],env=Math.exp(-beat*7)*Math.min(1,t*3,(seconds-t)*3);const v=(Math.sin(2*Math.PI*f*t)*.13+Math.sin(2*Math.PI*f*.5*t)*.06)*env;view.setInt16(44+i*2,Math.round(v*32767),true);}
  return new File([bytes],'Night pulse · 샘플 사운드.wav',{type:'audio/wav'});
}
