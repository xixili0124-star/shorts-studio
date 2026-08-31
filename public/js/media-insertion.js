// 영상과 실제 원음을 한 번에 추가합니다. 추가 후에는 선택한 클립만 독립 편집합니다.
import { project, clipDuration, timelineTracks, trackItems, trackIdFor, addTimelineTrack, MAX_TRACKS_PER_KIND } from './state.js';
import { assets, addDecodedAudioAsset, makeClip, makeAudio, captureDocument, restoreDocument, discardStagedInstance, discardStagedAsset } from './project-store.js';
import { planPlacement, placeTimelineItem } from './timeline-edits.js';
import { extractClipAudio } from './audio.js';
import { probeVideoAudio } from './media.js';
import { uid } from './util.js';

const EPS = 1e-6;
export const MAX_SEPARATED_AUDIO_BYTES = 128 * 1024 * 1024;
const checkAbort = signal => { if (signal?.aborted) throw new DOMException('취소됨', 'AbortError'); };
const nextTurn = () => new Promise(resolve => {
  const channel = new MessageChannel();
  channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
  channel.port2.postMessage(null);
});

/** 원래 시각에 빈 오디오 행을 찾습니다. 기존 오디오나 자막은 밀지 않습니다. */
export function planAudioTrack(start, duration, doc = project) {
  if (!Number.isFinite(start) || start < 0 || !Number.isFinite(duration) || duration <= 0 || start + duration > 86400) throw new Error('원음의 타임라인 구간이 올바르지 않습니다.');
  const rows = timelineTracks(doc).filter(track => track.kind === 'audio');
  const candidates = rows.filter(track => track.role === 'audio');
  const free = candidates.find(track => trackItems(track.id, doc).every(item => start >= item.end - EPS || start + duration <= item.start + EPS));
  if (free) return { trackId: free.id, create: false };
  if (rows.length >= MAX_TRACKS_PER_KIND) throw new Error('같은 시각에 원음을 놓을 빈 오디오 트랙이 없습니다. 오디오 트랙은 최대 24개입니다.');
  return { trackId: null, create: true };
}

async function stereoBuffer(buffer, signal) {
  if (buffer.numberOfChannels <= 2) return buffer;
  if (![4, 6].includes(buffer.numberOfChannels)) {
    // Web Audio의 기본 다운믹스에 없는 채널 수는 센터를 버리지 않고 직접 합칩니다.
    const channels = buffer.numberOfChannels, inputs = Array.from({ length: channels }, (_, index) => buffer.getChannelData(index));
    const out = new AudioBuffer({ length: buffer.length, sampleRate: buffer.sampleRate, numberOfChannels: 2 });
    const left = out.getChannelData(0), right = out.getChannelData(1);
    for (let start = 0; start < buffer.length; start += 131072) {
      checkAbort(signal);
      for (let i = start; i < Math.min(buffer.length, start + 131072); i++) {
        if ([3, 5, 8].includes(channels)) {
          left[i] = inputs[0][i] + inputs[2][i] * Math.SQRT1_2;
          right[i] = inputs[1][i] + inputs[2][i] * Math.SQRT1_2;
          if (channels === 5) { left[i] += inputs[3][i] * Math.SQRT1_2; right[i] += inputs[4][i] * Math.SQRT1_2; }
          // 7.1의 저역 전용 채널은 제외하고 양쪽 측면/후면을 함께 반영합니다.
          if (channels === 8) { left[i] += (inputs[4][i] + inputs[6][i]) * .5; right[i] += (inputs[5][i] + inputs[7][i]) * .5; }
        } else {
          // 배치를 알 수 없는 다채널은 일부 채널을 버리는 대신 모노 평균으로 보존합니다.
          let total = 0; for (let c = 0; c < channels; c++) total += inputs[c][i] / channels;
          left[i] = right[i] = total;
        }
      }
      if (start + 131072 < buffer.length) await nextTurn();
    }
    return out;
  }
  const Context = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Context) throw new Error('이 브라우저에서 다채널 원음을 변환할 수 없습니다.');
  // 센터/서라운드 채널의 말소리를 버리지 않도록 Web Audio의 스피커 다운믹스를 사용합니다.
  const context = new Context(2, buffer.length, buffer.sampleRate);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.channelInterpretation = 'speakers';
  source.connect(context.destination);
  source.start(0);
  const result = await context.startRendering();
  checkAbort(signal);
  return result;
}

/** 채널과 원본 시각을 유지하는 PCM16 WAV입니다. ASR용 모노 인코더와 분리합니다. */
export async function separatedAudioFile(buffer, name, { signal } = {}) {
  checkAbort(signal);
  const channels = buffer.numberOfChannels, rate = buffer.sampleRate, frames = buffer.length;
  const bytes = frames * channels * 2;
  if (![1, 2].includes(channels) || !Number.isInteger(rate) || rate <= 0 || !Number.isSafeInteger(frames)
    || frames <= 0 || bytes > MAX_SEPARATED_AUDIO_BYTES || bytes > 0xffffffff - 36) throw new Error('분리할 오디오 크기나 형식이 올바르지 않습니다.');
  const header = new ArrayBuffer(44), view = new DataView(header);
  const text = (at, value) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, 36 + bytes, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * channels * 2, true);
  view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, bytes, true);
  const parts = [header], pcm = Array.from({ length: channels }, (_, channel) => buffer.getChannelData(channel));
  for (let start = 0; start < frames; start += 131072) {
    checkAbort(signal);
    const count = Math.min(131072, frames - start), chunk = new ArrayBuffer(count * channels * 2), output = new DataView(chunk);
    for (let frame = 0; frame < count; frame++) for (let channel = 0; channel < channels; channel++) {
      const raw = pcm[channel][start + frame];
      if (!Number.isFinite(raw)) throw new Error('원음에 읽을 수 없는 샘플이 있습니다.');
      const value = Math.max(-1, Math.min(1, raw));
      output.setInt16((frame * channels + channel) * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
    }
    parts.push(chunk);
    if (start + count < frames) await nextTurn();
  }
  checkAbort(signal);
  return new File(parts, String(name).replace(/\.[^.]+$/, '') + ' · 원음.wav', { type: 'audio/wav' });
}

const sourceAudioAsset = sourceId => [...assets.values()].find(asset => asset.kind === 'audio'
  && asset.sourceVideoAudio === true && asset.sourceVideoAssetId === sourceId);

/** 하나의 영상 소재를 여러 번 놓아도 파생 파일은 한 개만 저장합니다. */
export async function prepareVideoAudio(asset, { signal, onStatus = () => {} } = {}) {
  checkAbort(signal);
  if (!asset || asset.kind !== 'video' || assets.get(asset.id) !== asset) throw new Error('원본 영상 소재를 다시 선택해 주세요.');
  const cached = sourceAudioAsset(asset.id);
  if (cached) return { asset: cached, created: false };
  if (asset.base.hasAudio === false) return { asset: null, created: false };
  if (asset.base.hasAudio !== true) {
    const probe = await probeVideoAudio(asset.file, signal);
    asset.base.hasAudio = probe.hasAudio;
    asset.base.audioCodec = probe.codec;
    if (!probe.hasAudio) return { asset: null, created: false };
  }
  onStatus('영상 원음을 분리하는 중…');
  const decoded = await extractClipAudio({ ...asset.base, file: asset.file, trimStart: 0, trimEnd: asset.duration }, signal,
    { ignoreMute: true, strict: true, allChannels: true, allowBoundaryGaps: true, maxBytes: MAX_SEPARATED_AUDIO_BYTES });
  if (!decoded) throw new Error('영상에 오디오 트랙은 있지만 소리를 읽지 못했습니다.');
  const buffer = await stereoBuffer(decoded, signal);
  checkAbort(signal);
  const file = await separatedAudioFile(buffer, asset.file.name, { signal });
  checkAbort(signal);
  if (assets.get(asset.id) !== asset) throw new Error('소리 분리 중 원본 소재가 변경되었습니다. 다시 추가해 주세요.');
  const existing = sourceAudioAsset(asset.id);
  if (existing) return { asset: existing, created: false };
  const result = addDecodedAudioAsset(file, buffer, { sourceVideoAudio: true, sourceVideoAssetId: asset.id });
  return { asset: result, created: true };
}

const placementFields = plan => JSON.stringify({ start: plan.start, end: plan.end, duration: plan.duration,
  trackId: plan.trackId, shifts: plan.shifts, breakAfterId: plan.breakAfterId ?? null, mode: plan.mode });

/** 준비가 모두 끝난 뒤에만 두 클립을 추가합니다. 호출자가 이 결과 전체를 한 번의 Undo로 기록합니다. */
export async function insertMediaAsset(assetId, { time = 0, trackId, placement, signal, onStatus = () => {}, overrides = {} } = {}) {
  checkAbort(signal);
  const asset = assets.get(assetId);
  if (!asset || !['video', 'image'].includes(asset.kind)) throw new Error('영상이나 이미지 소재를 선택해 주세요.');
  if (project.clips.length >= 1000) throw new Error('영상·이미지 클립은 최대 1,000개입니다.');
  const before = captureDocument(), signature = JSON.stringify(before);
  const check = () => {
    checkAbort(signal);
    if (assets.get(assetId) !== asset || JSON.stringify(captureDocument()) !== signature) throw new Error('소재를 준비하는 동안 타임라인이 변경되었습니다. 다시 추가해 주세요.');
  };
  const target = trackId || placement?.trackId || trackIdFor('clip');
  if (!timelineTracks().some(track => track.id === target && track.kind === 'visual')) throw new Error('영상을 놓을 트랙을 다시 선택해 주세요.');
  const saved = {};
  for (const key of ['trimStart', 'trimEnd', 'imgDuration', 'bg', 'fit']) if (overrides[key] !== undefined) saved[key] = overrides[key];
  if (asset.kind === 'video') {
    saved.trimStart ??= 0; saved.trimEnd ??= asset.duration;
    if (!Number.isFinite(saved.trimStart) || !Number.isFinite(saved.trimEnd) || saved.trimStart < 0
      || saved.trimEnd <= saved.trimStart || saved.trimEnd > asset.duration + EPS) throw new Error('영상 원본 구간이 올바르지 않습니다.');
  } else saved.imgDuration ??= 3;
  const duration = clipDuration({ ...asset.base, ...saved });
  if (!Number.isFinite(time) || time < 0 || !Number.isFinite(duration) || duration <= 0) throw new Error('영상 위치나 길이가 올바르지 않습니다.');
  const videoPlan = planPlacement(placement?.start ?? time, duration, target);
  if (videoPlan.end > 86400) throw new Error('타임라인은 최대 24시간까지 지원합니다.');
  if (placement && (placement.ok === false || placementFields(placement) !== placementFields(videoPlan))) throw new Error('영상을 놓을 위치가 변경되었습니다. 다시 선택해 주세요.');
  saved.bg ??= target === timelineTracks().find(track => track.kind === 'visual')?.id ? 'blur' : 'transparent';
  let prepared, clip, audio, changed = false;
  try {
    prepared = asset.kind === 'video' ? await prepareVideoAudio(asset, { signal, onStatus }) : { asset: null, created: false };
    check();
    if (prepared.asset && project.audio.tracks.length >= 1000) throw new Error('오디오 클립은 최대 1,000개입니다.');
    const audioPlan = prepared.asset ? planAudioTrack(videoPlan.start, duration) : null;
    // 영상과 분리한 원음은 프리미어처럼 처음부터 연결해 둡니다. 우클릭 메뉴에서 풀 수 있습니다.
    const linkId = prepared.asset ? uid() : null;
    clip = await makeClip(assetId, { ...saved,
      ...(asset.kind === 'video' ? { audioSeparated: true, muted: true, sourceAudioAssetId: prepared.asset?.id,
        ...(linkId ? { linkId } : {}) } : {}) });
    check();
    if (clip.el && clip.audioSeparated) clip.el.muted = true;
    if (prepared.asset) audio = makeAudio(prepared.asset.id, { start: videoPlan.start, trimStart: clip.trimStart,
      trimEnd: clip.trimEnd, volume: clip.volume ?? 1, fadeIn: 0, fadeOut: 0, muted: false, lane: 'music', role: 'music', linkId });
    check();
    changed = true;
    const audioTrack = audioPlan?.create ? addTimelineTrack('audio', { role: 'audio' }).id : audioPlan?.trackId;
    const result = placeTimelineItem('clip', clip, videoPlan);
    let audioResult = null;
    if (audio) {
      const soundPlan = planPlacement(result.start, duration, audioTrack);
      if (Math.abs(soundPlan.start - result.start) > EPS || soundPlan.shifts.length) throw new Error('원음을 같은 시각에 놓을 빈 오디오 트랙이 없습니다.');
      audioResult = placeTimelineItem('audio', audio, soundPlan);
    }
    return { ...result, audioResult, audioStatus: asset.kind === 'video' ? (audio ? 'separated' : 'silent') : null };
  } catch (error) {
    if (changed) restoreDocument(before);
    if (clip) discardStagedInstance('clip', clip.id);
    if (audio) discardStagedInstance('audio', audio.id);
    if (prepared?.created) discardStagedAsset(prepared.asset.id);
    throw error;
  }
}
