// 파일 -> 클립 만들기 (메타데이터 읽기 + 썸네일)
//
// 영상은 두 가지 경로가 있다.
//   1) <video> 엘리먼트  — 기본. 미리보기에서 소리도 같이 나온다.
//   2) mediabunny 디코더 — <video> 가 못 여는 파일(MKV, 일부 MOV, moov 가 끝에 있는 초대형 파일 등)
//      을 위한 폴백. 미리보기 소리는 안 나오지만 편집·내보내기는 똑같이 된다.
import { Input, BlobSource, ALL_FORMATS, CanvasSink } from '../vendor/mediabunny.min.js';
import { newClipDefaults } from './state.js';
import { uid } from './util.js';

const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|ts|m2ts)$/i;
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;

const CODEC_LABEL = {
  avc: 'H.264 (AVC)', hevc: 'H.265 (HEVC)', av1: 'AV1',
  vp8: 'VP8', vp9: 'VP9', prores: 'ProRes',
};

export async function createClip(file, onStatus = () => {}) {
  const isVideo = file.type.startsWith('video/') || (!file.type && VIDEO_EXT.test(file.name));
  const isImage = file.type.startsWith('image/') || (!file.type && IMAGE_EXT.test(file.name));
  if (isVideo) return videoClip(file, onStatus);
  if (isImage) return imageClip(file);
  throw new Error(`${file.name}: 영상이나 이미지 파일이 아닙니다.`);
}

async function videoClip(file, onStatus) {
  onStatus(`${file.name} 읽는 중…`);
  let clip;
  try {
    clip = await viaVideoElement(file);
  } catch (err) {
    // <video> 가 실패했다고 끝이 아니다. 디코더로 직접 열어 본다.
    onStatus(`${file.name} 다시 시도하는 중…`);
    clip = await viaDecoder(file, err);
  }
  try {
    const audio = await probeVideoAudio(file);
    clip.hasAudio = audio.hasAudio;
    clip.audioCodec = audio.codec;
  } catch (error) {
    // 재생 가능한 영상도 컨테이너 검사가 실패할 수 있습니다. 이를 무음으로 간주하지 않습니다.
    clip.hasAudio = null;
    clip.audioProbeError = error.message;
  }
  return clip;
}

/** 오디오 스트림의 존재만 확인합니다. 무음 파형과 트랙이 없는 파일은 구분합니다. */
export async function probeVideoAudio(file, signal) {
  if (signal?.aborted) throw new DOMException('취소됨', 'AbortError');
  let input;
  const cancel = () => { try { input?.dispose(); } catch {} };
  try {
    input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
    signal?.addEventListener('abort', cancel, { once: true });
    const track = await input.getPrimaryAudioTrack();
    if (signal?.aborted) throw new DOMException('취소됨', 'AbortError');
    return { hasAudio: !!track, codec: track?.codec || null };
  } catch (error) {
    if (signal?.aborted) throw new DOMException('취소됨', 'AbortError');
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    try { input?.dispose(); } catch {}
  }
}

// ── 1) 브라우저 기본 재생기 ────────────────────────────
async function viaVideoElement(file) {
  const url = URL.createObjectURL(file);
  const el = document.createElement('video');
  el.src = url;
  el.preload = 'auto';
  el.playsInline = true;

  try {
    // 용량이 크고 인덱스(moov)가 파일 끝에 있으면 여기서 오래 걸린다.
    await waitEvent(el, 'loadedmetadata', 45000);
    if (!el.videoWidth) throw new Error('no-video-track');
  } catch (e) {
    URL.revokeObjectURL(url);
    el.src = '';
    throw e;
  }

  let dur = el.duration;
  if (!isFinite(dur) || dur <= 0) dur = await probeDuration(el);

  const clip = {
    ...newClipDefaults('video'),
    id: uid(),
    name: file.name,
    file, url, el,
    natW: el.videoWidth,
    natH: el.videoHeight,
    srcDuration: dur,
    trimStart: 0,
    trimEnd: dur,
    muted: false,
    hasAudio: null,
  };
  clip.thumb = await grabThumb(el, Math.min(0.1, dur / 2));
  return clip;
}

// ── 2) mediabunny 디코더 폴백 (+ 실패 원인 진단) ───────
async function viaDecoder(file, prevError) {
  let input, track;
  try {
    input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
    track = await input.getPrimaryVideoTrack();
  } catch (e) {
    throw new Error(explainOpenFailure(file, prevError, e));
  }
  if (!track) {
    throw new Error(`${file.name}: 영상 트랙이 없습니다. (소리만 있는 파일이거나 파일이 손상됐을 수 있어요)`);
  }

  const codec = track.codec;
  let decodable = true;
  try { decodable = track.canDecode ? await track.canDecode() : true; } catch { decodable = false; }
  if (!decodable) {
    throw new Error(
      `${file.name}: 이 브라우저가 디코딩할 수 없는 코덱입니다 — ${CODEC_LABEL[codec] || codec || '알 수 없음'}.\n` +
      (codec === 'hevc'
        ? 'H.265(HEVC)는 윈도우에 "HEVC 비디오 확장" 이 설치돼 있어야 열립니다. 아니면 H.264 MP4 로 변환해 주세요.'
        : 'H.264 MP4 로 변환한 뒤 다시 올려 주세요.'));
  }

  const dur = await input.computeDuration();
  const sink = new CanvasSink(track);

  const clip = {
    ...newClipDefaults('video'),
    id: uid(),
    name: file.name,
    file,
    input, sink,             // el 없이 디코더로 미리보기
    decoderOnly: true,
    natW: track.displayWidth,
    natH: track.displayHeight,
    srcDuration: dur,
    trimStart: 0,
    trimEnd: dur,
    muted: false,
    hasAudio: null,
  };

  try {
    const first = await sink.getCanvas(Math.min(0.1, dur / 2));
    if (first) clip.thumb = thumbFromSource(first.canvas, clip.natW, clip.natH);
  } catch { /* 썸네일은 없어도 그만 */ }

  return clip;
}

function explainOpenFailure(file, prevError, openError) {
  const big = file.size > 800 * 1024 * 1024;
  if (prevError?.message === 'timeout') {
    return `${file.name}: 파일을 읽는 데 시간이 너무 오래 걸립니다.` +
      (big ? ` (${(file.size / 1024 / 1024 / 1024).toFixed(1)}GB — 숏츠용으로는 먼저 필요한 구간만 잘라서 올리는 편이 좋습니다)` : '');
  }
  return `${file.name}: 파일을 열지 못했습니다. 형식이 지원되지 않거나 파일이 손상됐을 수 있어요.` +
    (openError?.message ? `\n(${openError.message})` : '');
}

// ── 이미지 ─────────────────────────────────────────────
async function imageClip(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      throw new Error(`${file.name}: 이미지를 열지 못했습니다.`);
    }
  }
  const clip = {
    ...newClipDefaults('image'),
    id: uid(),
    name: file.name,
    file,
    bitmap,
    natW: bitmap.width,
    natH: bitmap.height,
    imgDuration: 3,
    ken: 'in',
    muted: true,
    hasAudio: false,
  };
  clip.thumb = thumbFromSource(bitmap, bitmap.width, bitmap.height);
  return clip;
}

// ── 도우미 ─────────────────────────────────────────────
function waitEvent(el, ev, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, ms);
    const ok = () => { cleanup(); resolve(); };
    const bad = () => {
      cleanup();
      const code = el.error?.code;
      reject(new Error(code === 4 ? 'unsupported' : `media-error-${code ?? '?'}`));
    };
    function cleanup() {
      clearTimeout(t);
      el.removeEventListener(ev, ok);
      el.removeEventListener('error', bad);
    }
    el.addEventListener(ev, ok, { once: true });
    el.addEventListener('error', bad, { once: true });
  });
}

/** duration 이 Infinity 로 오는 파일(일부 WebM) 대응 */
async function probeDuration(el) {
  return new Promise(resolve => {
    const onSeek = () => {
      el.removeEventListener('timeupdate', onSeek);
      const d = el.duration;
      el.currentTime = 0;
      resolve(isFinite(d) && d > 0 ? d : 5);
    };
    el.addEventListener('timeupdate', onSeek);
    el.currentTime = 1e6;
    setTimeout(() => resolve(isFinite(el.duration) ? el.duration : 5), 3000);
  });
}

export async function seekTo(el, time) {
  if (Math.abs(el.currentTime - time) < 0.001) return;
  el.currentTime = time;
  try { await waitEvent(el, 'seeked', 5000); } catch { /* 그냥 진행 */ }
}

async function grabThumb(el, at) {
  try {
    await seekTo(el, at);
    return thumbFromSource(el, el.videoWidth, el.videoHeight);
  } catch {
    return null;
  }
}

function thumbFromSource(src, w, h) {
  const c = document.createElement('canvas');
  c.width = 68; c.height = 120;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, c.width, c.height);
  const s = Math.max(c.width / w, c.height / h);
  const dw = w * s, dh = h * s;
  try {
    ctx.drawImage(src, (c.width - dw) / 2, (c.height - dh) / 2, dw, dh);
  } catch { /* noop */ }
  return c.toDataURL('image/jpeg', 0.7);
}

export function disposeClip(clip) {
  try { clip.el?.pause(); } catch { /* noop */ }
  if (clip.el) clip.el.src = '';
  if (clip.url) URL.revokeObjectURL(clip.url);
  clip.bitmap?.close?.();
  try { clip.input?.dispose?.(); } catch { /* noop */ }
}
