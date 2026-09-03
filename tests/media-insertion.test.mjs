// 사용자 파일 없이 합성 PCM·컨테이너 경계·저장·편집 명령을 검사합니다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Input, InputAudioTrack, AudioBufferSink } from '../public/vendor/mediabunny.min.js';
import { project, newClipDefaults, timelineTracks, setLegacyEditorMode } from '../public/js/state.js';
import { assets, addAsset, addDecodedAudioAsset, makeClip, makeAudio, clearAssets, captureDocument, restoreDocument, History, packProject, unpackProject, validateDocument, discardStagedAsset } from '../public/js/project-store.js';
import { createClip, disposeClip, probeVideoAudio } from '../public/js/media.js';
import { extractClipAudio, hasClipAudio, mixTimeline } from '../public/js/audio.js';
import { Player } from '../public/js/player.js';
import { planPlacement, placeTimelineItem, planItemTrim, applyItemTrim, splitTimelineItem, planLinkedTrim, applyLinkedTrim } from '../public/js/timeline-edits.js';
import { duplicateSelectedItems, planBatchSplit, applyBatchSplit, planBatchMove, applyBatchMove } from '../public/js/batch-edits.js';
import { insertMediaAsset, prepareVideoAudio, separatedAudioFile, planAudioTrack } from '../public/js/media-insertion.js';
import { isLinkId, linkGroups, activeLinkIds, linkedRefs, expandLinked, isLinkedSelection, planLink, applyLink, applyUnlink } from '../public/js/link-groups.js';

const defaults = structuredClone(project);
const originals = { document: globalThis.document, window: globalThis.window, AudioBuffer: globalThis.AudioBuffer,
  OfflineAudioContext: globalThis.OfflineAudioContext, primary: Input.prototype.getPrimaryAudioTrack, buffers: AudioBufferSink.prototype.buffers };
class Pcm {
  constructor({ length, numberOfChannels = 1, sampleRate = 1000 }) {
    Object.assign(this, { length, numberOfChannels, sampleRate, duration: length / sampleRate });
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  getChannelData(channel) { return this.channels[channel]; }
  copyToChannel(samples, channel, offset = 0) { this.channels[channel].set(samples, offset); }
}
const pcm = (seconds = 2, channels = 1, value = .25, rate = 1000) => {
  const buffer = new Pcm({ length: Math.round(seconds * rate), numberOfChannels: channels, sampleRate: rate });
  buffer.channels.forEach(channel => channel.fill(value)); return buffer;
};
let nativeDuration, track, rows, decodes, wavDecodes;
class MediaElement extends EventTarget {
  constructor() { super(); this.currentTime = 0; this.duration = nativeDuration; this.videoWidth = this.videoHeight = 16; this.paused = true; this.readyState = 2; }
  set src(value) { this.source = value; if (value) queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata'))); }
  get src() { return this.source; }
  set currentTime(value) { this.time = value; queueMicrotask(() => this.dispatchEvent(new Event('seeked'))); }
  get currentTime() { return this.time; }
  pause() { this.paused = true; }
  play() { this.paused = false; return Promise.resolve(); }
}
const documentFake = {
  addEventListener() {},
  createElement(tag) { return tag === 'canvas' ? { width: 1, height: 1, getContext: () => ({ fillRect() {}, drawImage() {} }), toDataURL: () => 'data:image/png;base64,AA==' } : new MediaElement(); },
};
function decodedWav(bytes) {
  wavDecodes++;
  const view = new DataView(bytes), channels = view.getUint16(22, true), rate = view.getUint32(24, true);
  const buffer = new Pcm({ length: view.getUint32(40, true) / channels / 2, numberOfChannels: channels, sampleRate: rate });
  for (let i = 0; i < buffer.length; i++) for (let c = 0; c < channels; c++) buffer.channels[c][i] = view.getInt16(44 + (i * channels + c) * 2, true) / 32768;
  return buffer;
}
class AudioContextFake { async decodeAudioData(bytes) { return decodedWav(bytes); } close() {} }
class Param { setValueAtTime() {} linearRampToValueAtTime() {} }
class NodeFake { constructor() { this.gain = new Param(); } connect(node) { return node; } start(...args) { this.args = args; } }
class OfflineContextFake {
  constructor(channels, length, rate) { Object.assign(this, { channels, length, rate, destination: {}, sources: [] }); }
  createGain() { return new NodeFake(); }
  createBufferSource() { const node = new NodeFake(); this.sources.push(node); return node; }
  async startRendering() {
    const source = this.sources[0];
    if (source?.buffer.numberOfChannels > 2) {
      assert.equal(source.channelInterpretation, 'speakers'); assert.equal(this.channels, 2);
      const result = new Pcm({ length: this.length, sampleRate: this.rate, numberOfChannels: 2 });
      for (let i = 0; i < this.length; i++) for (let c = 0; c < 2; c++) result.channels[c][i] = source.buffer.channels[c][i] + source.buffer.channels[2][i] * Math.SQRT1_2;
      return result;
    }
    return this;
  }
}

test.beforeEach(() => {
  clearAssets(); Object.assign(project, structuredClone(defaults)); setLegacyEditorMode(false);
  nativeDuration = 2; decodes = 0; wavDecodes = 0;
  track = Object.assign(Object.create(InputAudioTrack.prototype), { canDecode: async () => true, getFirstTimestamp: async () => 0, computeDuration: async () => nativeDuration });
  Object.defineProperty(track, 'codec', { value: 'pcm-s16', configurable: true });
  rows = [{ timestamp: 0, buffer: pcm() }];
  Input.prototype.getPrimaryAudioTrack = async () => track;
  AudioBufferSink.prototype.buffers = async function* () { decodes++; for (const row of rows) yield row; };
  globalThis.document = documentFake; globalThis.window = { AudioContext: AudioContextFake };
  globalThis.AudioBuffer = Pcm; globalThis.OfflineAudioContext = OfflineContextFake;
});
test.afterEach(() => {
  clearAssets(); Object.assign(project, structuredClone(defaults));
  globalThis.document = originals.document; globalThis.window = originals.window; globalThis.AudioBuffer = originals.AudioBuffer;
  globalThis.OfflineAudioContext = originals.OfflineAudioContext;
  Input.prototype.getPrimaryAudioTrack = originals.primary; AudioBufferSink.prototype.buffers = originals.buffers;
});

function videoAsset(id = 'video', { hasAudio = true, duration = 2 } = {}) {
  const file = new File(['synthetic container'], id + '.mp4', { type: 'video/mp4' });
  const base = { ...newClipDefaults('video'), id: id + '-base', name: file.name, file, url: 'blob:synthetic-' + id,
    srcDuration: duration, trimEnd: duration, hasAudio, natW: 16, natH: 16 };
  const asset = { id, file, kind: 'video', base, duration }; assets.set(id, asset); return asset;
}
async function audioAsset(id = 'audio') {
  const buffer = pcm(), file = await separatedAudioFile(buffer, id);
  return addDecodedAudioAsset(file, buffer, { id });
}
const savedRecords = () => [...assets.values()].map(({ id, sourceVideoAudio, sourceVideoAssetId }) => ({ id, sourceVideoAudio, sourceVideoAssetId }));

test('native import probes real track presence and keeps probe failure distinct from silent video', async () => {
  const file = new File(['synthetic container'], 'native.mp4', { type: 'video/mp4' });
  assert.deepEqual(await probeVideoAudio(file), { hasAudio: true, codec: 'pcm-s16' });
  track = null; const silent = await createClip(file); assert.equal(silent.hasAudio, false); disposeClip(silent);
  Input.prototype.getPrimaryAudioTrack = async () => { throw new Error('container error'); };
  const unknown = await createClip(file); assert.equal(unknown.hasAudio, null); assert.match(unknown.audioProbeError, /container/); disposeClip(unknown);
  const signal = AbortSignal.abort(); await assert.rejects(() => probeVideoAudio(file, signal), { name: 'AbortError' });
});

test('separated WAV retains both channels, finite PCM, duration and cancellation', async () => {
  const buffer = pcm(.004, 2, 0); buffer.channels[1].set([1, -.5, .25, 0]);
  const file = await separatedAudioFile(buffer, 'test.mp4'), bytes = new DataView(await file.arrayBuffer());
  assert.equal(file.name, 'test · 원음.wav'); assert.equal(bytes.getUint16(22, true), 2);
  assert.equal(bytes.getUint32(24, true), 1000); assert.equal(bytes.getUint32(40, true), 16);
  assert.equal(bytes.getInt16(44, true), 0); assert.equal(bytes.getInt16(46, true), 32767);
  assert.equal(bytes.getInt16(50, true), -16384);
  await assert.rejects(() => separatedAudioFile(buffer, 'cancel', { signal: AbortSignal.abort() }), { name: 'AbortError' });
  buffer.channels[0][1] = NaN; await assert.rejects(() => separatedAudioFile(buffer, 'broken'), /샘플/);
});

test('video insertion extracts actual samples and aligns independent audio to identical trim and time', async () => {
  const asset = videoAsset(); track.getFirstTimestamp = async () => .2; track.computeDuration = async () => 1.8;
  rows = [{ timestamp: .2, buffer: pcm(1.6) }];
  const before = captureDocument(), result = await insertMediaAsset(asset.id, { time: 3, overrides: { trimStart: .5, trimEnd: 1.5 } });
  const clip = project.clips[0], audio = project.audio.tracks[0], sound = assets.get(audio.assetId);
  assert.equal(result.audioStatus, 'separated'); assert.equal(result.audioResult.id, audio.id);
  assert.deepEqual([clip.start, clip.trimStart, clip.trimEnd], [audio.start, audio.trimStart, audio.trimEnd]);
  assert.deepEqual([audio.start, audio.trimStart, audio.trimEnd, audio.volume, audio.fadeIn, audio.fadeOut], [3, .5, 1.5, 1, 0, 0]);
  assert.equal(clip.audioSeparated, true); assert.equal(audio.sourceVideoAudio, true); assert.equal(audio.role, 'music');
  assert.equal(sound.buffer.length, 2000); assert.equal(sound.buffer.channels[0][0], 0);
  assert.equal(sound.buffer.channels[0][300], .25); assert.equal(sound.buffer.channels[0][1999], 0);
  assert.equal(wavDecodes, 0); assert.equal(decodes, 1); assert.notEqual(sound.file, asset.file);
  const history = new History(); history.push(before, 'insert'); const after = captureDocument();
  history.undo(); assert.deepEqual(captureDocument(), before); history.redo(); assert.deepEqual(captureDocument(), after);
  assert.doesNotThrow(() => validateDocument(after, savedRecords()));
});

test('no-audio video adds no fake audio asset or clip and image insertion stays unchanged', async () => {
  const asset = videoAsset('silent', { hasAudio: false });
  const result = await insertMediaAsset(asset.id, { time: 1 });
  assert.equal(result.audioStatus, 'silent'); assert.equal(result.audioResult, null); assert.equal(project.audio.tracks.length, 0);
  assert.equal(assets.size, 1); assert.equal(decodes, 0); assert.equal(project.clips[0].hasAudio, false);
  assets.set('image', { id: 'image', kind: 'image', file: new File(['image'], 'image.png'), base: { ...newClipDefaults('image'), bitmap: {} }, duration: 3 });
  const image = await insertMediaAsset('image', { time: 5, trackId: 'v2' });
  assert.equal(image.audioStatus, null); assert.equal(project.clips[1].audioSeparated, undefined); assert.equal(project.clips[1].bg, 'transparent');
});

test('busy audio rows create a new row atomically without shifting captions, graphics or old audio', async () => {
  const sound = await audioAsset();
  project.audio.tracks = ['a1', 'a2'].map(trackId => makeAudio(sound.id, { start: 0, trackId }));
  project.captions = [{ id: 'caption', trackId: 'v3', text: 'caption', start: 0, end: 2 }];
  project.overlays = [{ id: 'graphic', trackId: 'v2', text: 'graphic', start: 0, end: 2 }];
  const asset = videoAsset(), before = captureDocument(), history = new History();
  const result = await insertMediaAsset(asset.id, { time: 0 });
  assert.equal(result.audioResult.trackId, 'a3'); assert.equal(timelineTracks().find(t => t.id === 'a3').role, 'audio');
  assert.deepEqual(captureDocument().captions, before.captions); assert.deepEqual(captureDocument().overlays, before.overlays);
  assert.deepEqual(captureDocument().tracks.slice(0, 2), before.tracks); history.push(before, 'paired insertion'); history.undo();
  assert.deepEqual(captureDocument(), before); history.redo(); assert.equal(project.audio.tracks.length, 3);
});

test('all 24 occupied audio rows fail before insertion and do not keep a newly extracted asset', async () => {
  const sound = await audioAsset(); project.timelineTracks = [{ id: 'v1', kind: 'visual', role: 'video' }, ...Array.from({ length: 24 }, (_, i) => ({ id: 'a' + (i + 1), kind: 'audio', role: 'audio' }))];
  project.audio.tracks = project.timelineTracks.filter(t => t.kind === 'audio').map(t => makeAudio(sound.id, { trackId: t.id }));
  const asset = videoAsset(), before = captureDocument(), count = assets.size;
  await assert.rejects(() => insertMediaAsset(asset.id), /24개/); assert.deepEqual(captureDocument(), before); assert.equal(assets.size, count);
  assert.equal(planAudioTrack(2, 1).trackId, 'a1');
});

test('separated video audio creates an audio row instead of occupying an empty voice row', async () => {
  const sound = await audioAsset();
  project.timelineTracks = [{ id:'v1', kind:'visual', role:'video' }, { id:'a1', kind:'audio', role:'audio' }, { id:'a2', kind:'audio', role:'voice' }];
  project.audio.tracks = [makeAudio(sound.id, { start:0, trackId:'a1' })];
  const result = await insertMediaAsset(videoAsset().id, { time:0 });
  assert.notEqual(result.audioResult.trackId, 'a2');
  assert.equal(timelineTracks().find(row => row.id === result.audioResult.trackId).role, 'audio');
  assert.equal(project.audio.tracks.filter(row => row.trackId === 'a2').length, 0);
});

test('extraction codec errors, missing decoded tails and a stale drop plan leave the document unchanged', async () => {
  const asset = videoAsset(), before = captureDocument();
  track.canDecode = async () => false; await assert.rejects(() => insertMediaAsset(asset.id), /코덱/);
  track.canDecode = async () => true; rows = [{ timestamp: 0, buffer: pcm(.5) }];
  await assert.rejects(() => insertMediaAsset(asset.id), /끝까지/);
  await assert.rejects(() => insertMediaAsset(asset.id, { placement: { ...planPlacement(0, 2, 'v1'), end: 4 } }), /위치/);
  assert.deepEqual(captureDocument(), before); assert.equal(assets.size, 1);
});

test('an over-long source skips separation and keeps the clip audible instead of refusing it', async () => {
  const asset = videoAsset('long', { duration: 7200 });
  track.computeDuration = async () => 7200; rows = [{ timestamp: 0, buffer: pcm(.001, 2, .25, 48000) }];
  const result = await insertMediaAsset(asset.id);
  assert.equal(result.audioStatus, 'inline'); assert.equal(result.audioResult, null);
  assert.match(result.audioReason, /너무 깁니다/);
  // 분리를 건너뛴 클립은 음소거하지 않습니다. 음소거하면 소리가 완전히 사라집니다.
  const clip = project.clips[0];
  assert.ok(!clip.audioSeparated); assert.ok(!clip.muted); assert.equal(clip.linkId, undefined);
  assert.equal(project.audio.tracks.length, 0);
  assert.equal(assets.size, 1, '분리한 오디오 소재를 남기지 않습니다');
  assert.equal(hasClipAudio(), true, '내보내기와 자동자막이 이 클립의 소리를 포함합니다');
  assert.doesNotThrow(() => validateDocument(captureDocument(), savedRecords()));
});

test('a multichannel source reaches the decode budget sooner and falls back the same way', async () => {
  // 5.1 은 채널이 많아 스테레오보다 훨씬 짧은 길이에서 상한에 닿습니다.
  const asset = videoAsset('surround', { duration: 150 });
  track.computeDuration = async () => 150; rows = [{ timestamp: 0, buffer: pcm(.001, 6, .25, 48000) }];
  const result = await insertMediaAsset(asset.id);
  assert.equal(result.audioStatus, 'inline'); assert.equal(project.audio.tracks.length, 0);
  assert.ok(!project.clips[0].muted); assert.equal(assets.size, 1);
});

test('cancellation or a document change during extraction cleans only staged resources', async () => {
  const asset = videoAsset(), before = captureDocument(), controller = new AbortController();
  AudioBufferSink.prototype.buffers = async function* () { controller.abort(); yield rows[0]; };
  await assert.rejects(() => insertMediaAsset(asset.id, { signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(captureDocument(), before);
  AudioBufferSink.prototype.buffers = async function* () { yield rows[0]; };
  await assert.rejects(() => insertMediaAsset(asset.id, { onStatus() { project.captions.push({ id: 'new-caption', trackId: 'v3', text: 'later edit', start: 0, end: 1 }); } }), /변경/);
  assert.equal(project.captions[0].text, 'later edit'); assert.equal(project.clips.length, 0); assert.equal(assets.size, 1);
});

test('a failure during the second placement rolls back the already inserted video', async () => {
  const asset = videoAsset(), before = captureDocument();
  project.audio.tracks.push = () => { throw new Error('synthetic placement error'); };
  await assert.rejects(() => insertMediaAsset(asset.id), /synthetic placement/);
  assert.deepEqual(captureDocument(), before); assert.equal(assets.size, 1);
});

test('repeated insertion and packed project reload reuse one source WAV', async () => {
  const asset = videoAsset(); await insertMediaAsset(asset.id); await insertMediaAsset(asset.id, { time: 4 });
  assert.equal(decodes, 1); assert.equal(assets.size, 2); assert.equal(project.audio.tracks[0].buffer, project.audio.tracks[1].buffer);
  const saved = captureDocument(), packed = packProject(); await unpackProject(packed);
  assert.deepEqual(captureDocument(), saved); assert.equal(assets.size, 2); assert.equal(wavDecodes, 1);
  await insertMediaAsset(asset.id, { time: 8 }); assert.equal(decodes, 1); assert.equal(assets.size, 2);
  assert.equal(project.audio.tracks[2].sourceVideoAudio, true);
});

test('single-item move, trim, split and duplicate stay independent while source markers survive', async () => {
  const asset = videoAsset(); const result = await insertMediaAsset(asset.id);
  const audio = project.audio.tracks[0], originalAudio = captureDocument().tracks[0], clip = project.clips[0];
  placeTimelineItem('clip', clip, planPlacement(5, 2, 'v1', clip.id)); assert.deepEqual(captureDocument().tracks[0], originalAudio);
  applyItemTrim(planItemTrim('audio', audio.id, 'start', .5)); assert.equal(clip.start, 5); assert.equal(audio.trimStart, .5);
  await splitTimelineItem({ type: 'clip', id: result.id }, 6); assert.equal(project.audio.tracks.length, 1);
  assert.ok(project.clips.every(c => c.audioSeparated && c.sourceAudioAssetId === audio.assetId));
  const copies = await duplicateSelectedItems([{ type: 'clip', id: result.id }]); assert.equal(project.audio.tracks.length, 1);
  assert.equal(project.clips.find(c => c.id === copies[0].id).audioSeparated, true);
  await splitTimelineItem({ type: 'audio', id: audio.id }, 1); assert.ok(project.audio.tracks.every(t => t.sourceVideoAudio));
  assert.doesNotThrow(() => validateDocument(captureDocument(), savedRecords()));
});

test('selecting both source items uses existing batch split for matched boundaries without captions', async () => {
  const asset = videoAsset(), inserted = await insertMediaAsset(asset.id);
  project.captions = [{ id: 'caption', trackId: 'v3', text: 'unchanged', start: 0, end: 2 }];
  const plan = planBatchSplit([{ type: 'clip', id: inserted.id }, { type: 'audio', id: inserted.audioResult.id }], 1);
  await applyBatchSplit(plan);
  assert.equal(project.clips.length, 2); assert.equal(project.audio.tracks.length, 2); assert.equal(project.captions.length, 1);
  assert.deepEqual(project.clips.map(c => [c.start, c.trimStart, c.trimEnd]), project.audio.tracks.map(t => [t.start, t.trimStart, t.trimEnd]));
});

test('offline speech mix includes separated original audio once and cannot unmute the video copy', async () => {
  const asset = videoAsset(); await insertMediaAsset(asset.id); project.clips[0].muted = false;
  const music = await audioAsset('music'); project.audio.tracks.push(makeAudio(music.id));
  AudioBufferSink.prototype.buffers = async function* () { throw new Error('video must not be decoded again'); };
  assert.equal(hasClipAudio(), false); assert.equal(await extractClipAudio(project.clips[0]), null);
  const mix = await mixTimeline({ includeBgm: false, includeVoice: true, strictSources: true });
  assert.equal(mix.sources.length, 1); assert.equal(mix.sources[0].buffer, project.audio.tracks[0].buffer);
  const gains = [], player = { time: .5, previewMuted: false, playing: false, previewGain: { set: (el, gain) => gains.push(gain) }, draw() {} };
  Player.prototype._syncVideos.call(player, true); assert.equal(project.clips[0].el.muted, true); assert.deepEqual(gains, [0]);
  project.audio.tracks[0].muted = true; assert.equal(await mixTimeline({ includeBgm: false, includeVoice: true }), null);
});

test('multichannel extraction routes center dialogue through the speaker downmix', async () => {
  const asset = videoAsset(), surround = pcm(2, 6, 0); surround.channels[2].fill(.5); rows = [{ timestamp: 0, buffer: surround }];
  const prepared = await prepareVideoAudio(asset);
  assert.equal(prepared.asset.buffer.numberOfChannels, 2); assert.ok(prepared.asset.buffer.channels.every(channel => channel[0] > .3));
});

test('three, five and eight channel audio retains center speech outside the native downmix layouts', async () => {
  for (const channels of [3, 5, 8]) {
    const asset = videoAsset('surround-' + channels), buffer = pcm(2, channels, 0);
    buffer.channels[2].fill(.25); rows = [{ timestamp: 0, buffer }];
    const prepared = await prepareVideoAudio(asset);
    assert.equal(prepared.asset.buffer.numberOfChannels, 2);
    for (const output of prepared.asset.buffer.channels) assert.ok(output[100] > .17 && output[100] < .18);
  }
});

test('project validation rejects malformed separation markers and absent provenance targets', async () => {
  const asset = videoAsset(); await insertMediaAsset(asset.id); const doc = captureDocument(), records = savedRecords();
  for (const patch of [{ audioSeparated: 'yes' }, { sourceAudioAssetId: 'missing' }]) {
    const bad = structuredClone(doc); Object.assign(bad.clips[0], patch); assert.throws(() => validateDocument(bad, records));
  }
  const bad = structuredClone(doc); bad.tracks[0].sourceVideoAssetId = 'missing'; assert.throws(() => validateDocument(bad, records));
  const older = structuredClone(doc); delete older.clips[0].audioSeparated; delete older.clips[0].sourceAudioAssetId;
  restoreDocument(older); assert.equal(project.clips[0].audioSeparated, undefined);
});

// ── 연결(프리미어의 링크) ──────────────────────────────────────────────
// 영상과 그 원음이 타임라인에서 따로 움직이면 화면과 소리가 어긋납니다.
// 같은 linkId 를 붙여 함께 움직이게 하고, 우클릭 메뉴에서 풀 수 있게 했습니다.

test('separated video audio is linked to its clip and survives save, undo and validation', async () => {
  await insertMediaAsset(videoAsset().id, { time: 1 });
  const clip = project.clips[0], audio = project.audio.tracks[0];
  assert.ok(isLinkId(clip.linkId)); assert.equal(clip.linkId, audio.linkId);
  const doc = captureDocument();
  assert.equal(doc.clips[0].linkId, doc.tracks[0].linkId);
  assert.doesNotThrow(() => validateDocument(doc, savedRecords()));
  assert.deepEqual(linkedRefs({ type: 'clip', id: clip.id }, project),
    [{ type: 'clip', id: clip.id }, { type: 'audio', id: audio.id }]);
  assert.deepEqual(expandLinked([{ type: 'audio', id: audio.id }], project).map(ref => ref.type), ['audio', 'clip']);
  // 연결을 푼 문서로 되돌리면 런타임에 남은 linkId 도 함께 지워져야 합니다.
  const unlinked = structuredClone(doc); delete unlinked.clips[0].linkId; delete unlinked.tracks[0].linkId;
  restoreDocument(unlinked);
  assert.equal(project.clips[0].linkId, undefined); assert.equal(project.audio.tracks[0].linkId, undefined);
  assert.equal(linkedRefs({ type: 'clip', id: clip.id }, project).length, 1);
  restoreDocument(doc); assert.equal(project.clips[0].linkId, project.audio.tracks[0].linkId);
  const bad = structuredClone(doc); bad.clips[0].linkId = 'not a valid id';
  assert.throws(() => validateDocument(bad, savedRecords()), /연결 정보/);
});

test('a link left with a single member counts as no link and links only form from two or more', async () => {
  const sound = await audioAsset();
  project.audio.tracks = [makeAudio(sound.id, { start: 0, trackId: 'a1', linkId: 'solo' })];
  const only = { type: 'audio', id: project.audio.tracks[0].id };
  assert.equal(linkGroups(project).size, 0); assert.equal(activeLinkIds(project).size, 0);
  assert.deepEqual(linkedRefs(only, project), [only]);
  assert.equal(isLinkedSelection([only], project), false);
  assert.equal(planLink([only], project).ok, false);
  project.audio.tracks.push(makeAudio(sound.id, { start: 4, trackId: 'a1' }));
  const second = { type: 'audio', id: project.audio.tracks[1].id };
  const plan = planLink([only, second], project);
  assert.equal(plan.ok, true); assert.equal(applyLink(plan, project), 2);
  assert.equal(activeLinkIds(project).size, 1);
  assert.equal(planLink([only, second], project).ok, false, '이미 같은 묶음이면 다시 연결하지 않습니다');
  assert.equal(applyUnlink([only], project), 2, '절반만 풀면 남은 쪽이 계속 붙어 다닙니다');
  assert.equal(activeLinkIds(project).size, 0);
});

test('linked clip and audio trim together and stop at the most restrictive limit', async () => {
  nativeDuration = 4; rows = [{ timestamp: 0, buffer: pcm(4) }];
  await insertMediaAsset(videoAsset('trim', { duration: 4 }).id, { time: 0 });
  const clip = project.clips[0], audio = project.audio.tracks[0], ref = { type: 'clip', id: clip.id };
  const plan = planLinkedTrim(ref, 'end', 1.5);
  assert.equal(plan.linked, true); assert.equal(plan.ok, true); assert.equal(plan.plans.length, 2);
  applyLinkedTrim(plan);
  assert.equal(clip.trimEnd - clip.trimStart, 1.5);
  assert.equal(audio.trimEnd - audio.trimStart, 1.5);
  assert.equal(audio.start, clip.start);
  // 원음 트랙의 뒤 클립이 2.5초부터 있으면 소리가 먼저 막힙니다.
  // 영상도 같은 지점에서 멈춰야 화면과 소리가 어긋나지 않습니다.
  const sound = await audioAsset('blocker');
  project.audio.tracks.push(makeAudio(sound.id, { start: 2.5, trackId: audio.trackId }));
  const stretch = planLinkedTrim(ref, 'end', 3.5);
  assert.equal(stretch.ok, true);
  applyLinkedTrim(stretch);
  assert.ok(Math.abs((clip.trimEnd - clip.trimStart) - 2.5) < 1e-6);
  assert.equal(clip.trimEnd - clip.trimStart, audio.trimEnd - audio.trimStart);
});

test('splitting and duplicating a linked pair keeps the copies together but detached from the original', async () => {
  await insertMediaAsset(videoAsset('pair').id, { time: 0 });
  const refs = expandLinked([{ type: 'clip', id: project.clips[0].id }], project);
  const original = project.clips[0].linkId;
  const split = await applyBatchSplit(planBatchSplit(refs, 1));
  assert.equal(split.items.length, 2);
  const rightClip = project.clips.find(clip => clip.id !== refs[0].id);
  const rightAudio = project.audio.tracks.find(track => track.id !== refs[1].id);
  assert.equal(rightClip.linkId, rightAudio.linkId, '잘라낸 오른쪽끼리는 계속 연결됩니다');
  assert.notEqual(rightClip.linkId, original, '오른쪽 조각이 원본의 짝과 함께 움직이면 안 됩니다');
  assert.equal(project.clips[0].linkId, original);
  assert.equal(activeLinkIds(project).size, 2);
  const copies = await duplicateSelectedItems(expandLinked([{ type: 'clip', id: project.clips[0].id }], project));
  const copyClip = project.clips.find(clip => clip.id === copies.find(item => item.type === 'clip').id);
  const copyAudio = project.audio.tracks.find(track => track.id === copies.find(item => item.type === 'audio').id);
  assert.equal(copyClip.linkId, copyAudio.linkId);
  assert.notEqual(copyClip.linkId, original);
  assert.doesNotThrow(() => validateDocument(captureDocument(), savedRecords()));
});

test('a linked pair moves together across rows and keeps the gap between them', async () => {
  await insertMediaAsset(videoAsset('move').id, { time: 2 });
  const refs = expandLinked([{ type: 'clip', id: project.clips[0].id }], project);
  const plan = planBatchMove(refs, 3);
  assert.equal(plan.ok, true); assert.equal(plan.moves.length, 2);
  assert.equal(applyBatchMove(plan), true);
  assert.equal(project.clips[0].start, 5); assert.equal(project.audio.tracks[0].start, 5);
});

test('a linked video changes visual row while its original sound stays on the audio row', async () => {
  await insertMediaAsset(videoAsset('row').id, { time: 1 });
  const clip = project.clips[0], audio = project.audio.tracks[0], soundRow = audio.trackId;
  const refs = expandLinked([{ type: 'clip', id: clip.id }], project);
  const plan = planBatchMove(refs, 2, undefined, { retarget: { type: 'clip', id: clip.id, trackId: 'v2' } });
  assert.equal(plan.ok, true); assert.equal(plan.retargeted, true);
  assert.equal(applyBatchMove(plan), true);
  assert.equal(clip.trackId, 'v2'); assert.equal(clip.start, 3);
  assert.equal(audio.trackId, soundRow); assert.equal(audio.start, 3);
  // 자리를 옮기기만 하고 시각은 그대로여도 실제 편집으로 기록해야 합니다.
  const back = planBatchMove(refs, 0, undefined, { retarget: { type: 'clip', id: clip.id, trackId: 'v1' } });
  assert.equal(applyBatchMove(back), true); assert.equal(clip.trackId, 'v1'); assert.equal(clip.start, 3);
  // 소리를 영상 트랙에 놓을 수는 없습니다.
  assert.equal(planBatchMove(refs, 0, undefined, { retarget: { type: 'audio', id: audio.id, trackId: 'v1' } }).ok, false);
  assert.doesNotThrow(() => validateDocument(captureDocument(), savedRecords()));
});

test('a hand-linked pair trims by the same amount and keeps the offset between their edges', async () => {
  const sound = await audioAsset();
  project.audio.tracks = [makeAudio(sound.id, { start: 0, trimStart: 0, trimEnd: 2, trackId: 'a1' }),
    makeAudio(sound.id, { start: .5, trimStart: 0, trimEnd: 1, trackId: 'a2' })];
  const [first, second] = project.audio.tracks;
  const refs = project.audio.tracks.map(track => ({ type: 'audio', id: track.id }));
  assert.equal(applyLink(planLink(refs, project), project), 2);
  const ends = () => project.audio.tracks.map(track => track.start + track.trimEnd - track.trimStart);
  assert.deepEqual(ends(), [2, 1.5]);
  const plan = planLinkedTrim(refs[0], 'end', 1.5);
  assert.equal(plan.ok, true); assert.equal(plan.linked, true);
  applyLinkedTrim(plan);
  // 절대 시각이 아니라 이동량을 맞추므로 두 끝의 0.5초 간격이 그대로 남습니다.
  assert.deepEqual(ends(), [1.5, 1]);
  assert.equal(first.trimEnd - first.trimStart, 1.5); assert.equal(second.trimEnd - second.trimStart, .5);
});

// ── 소재 라이브러리에서 지우기 ────────────────────────────────────────
// 삭제 버튼이 기대는 안전장치입니다. 타임라인에서 쓰는 소재를 지우면
// 클립이 소재를 잃어 프로젝트가 깨집니다.

test('an asset in use is never removed while an unused one is disposed', async () => {
  const asset = videoAsset('keep');
  await insertMediaAsset(asset.id, { time: 0 });
  const sound = await audioAsset('spare');
  assert.equal(assets.size, 3, '영상·분리한 원음·여분 오디오');
  // 타임라인의 영상 클립과 분리된 원음이 쓰는 소재는 그대로 남아야 합니다.
  discardStagedAsset(asset.id);
  discardStagedAsset(project.audio.tracks[0].assetId);
  assert.equal(assets.has(asset.id), true);
  assert.equal(assets.has(project.audio.tracks[0].assetId), true);
  assert.equal(project.clips.length, 1);
  // 어디에도 놓지 않은 소재만 사라집니다.
  discardStagedAsset(sound.id);
  assert.equal(assets.has(sound.id), false);
  assert.equal(assets.size, 2);
  assert.doesNotThrow(() => validateDocument(captureDocument(), savedRecords()));
  // 클립을 지우고 나면 그때는 소재도 지울 수 있습니다.
  project.clips = []; project.audio.tracks = [];
  discardStagedAsset(asset.id);
  assert.equal(assets.has(asset.id), false);
});
