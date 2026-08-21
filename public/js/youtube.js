// 유튜브 숏츠 업로드 — 브라우저에서 바로 올린다.
//
// OAuth 는 구글 아이덴티티 서비스(GIS)의 토큰 클라이언트를 쓴다. 팝업으로 처리되므로
// 편집 중이던 클립(메모리 안의 File 객체)이 날아가지 않는다. 리디렉션 방식이었다면
// 페이지가 새로 뜨면서 작업이 통째로 사라진다.
//
// ⚠️ 감사(compliance audit)를 통과하지 않은 API 프로젝트로 올린 영상은
//    서버에서 비공개로 잠긴다. 나중에 공개로 바꿀 수도 없다.
//    https://developers.google.com/youtube/v3/revision_history
//    감사 신청에는 동작하는 앱의 OAuth 흐름 데모가 필요하므로, 이 기능이 그 전제조건이다.

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const SCOPES = 'https://www.googleapis.com/auth/youtube.upload email profile';
const UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const STORE_KEY = 'shorts-studio.yt-client-id';

const SHORTS_MAX_SEC = 180;   // 이보다 길면 숏츠가 아니라 일반 영상으로 올라간다
const TITLE_MAX = 100;
const DESC_MAX = 5000;

let tokenClient = null;
let accessToken = null;
let tokenExpiresAt = 0;
let account = null;

// ── 클라이언트 ID 보관 (이 브라우저에만) ───────────────
export function savedClientId() {
  try { return localStorage.getItem(STORE_KEY) || ''; } catch { return ''; }
}
export function saveClientId(id) {
  try { localStorage.setItem(STORE_KEY, id.trim()); } catch { /* 사생활 모드 등 */ }
}

export const isSignedIn = () => Boolean(accessToken) && Date.now() < tokenExpiresAt;
export const currentAccount = () => account;

// ── 로그인 ─────────────────────────────────────────────
function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = GIS_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('구글 로그인 스크립트를 불러오지 못했습니다. (네트워크 차단 여부를 확인해 주세요)'));
    document.head.appendChild(s);
  });
}

export async function signIn(clientId) {
  if (!clientId) throw new Error('OAuth 클라이언트 ID 를 먼저 넣어 주세요.');
  await loadGis();

  const token = await new Promise((resolve, reject) => {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPES,
      callback: r => {
        if (r?.access_token) resolve(r);
        else reject(new Error(r?.error_description || r?.error || '토큰을 받지 못했습니다.'));
      },
      error_callback: e => reject(new Error(explainAuthError(e))),
    });
    tokenClient.requestAccessToken({ prompt: '' });
  });

  accessToken = token.access_token;
  tokenExpiresAt = Date.now() + (Number(token.expires_in || 3600) - 60) * 1000;
  account = await fetchAccount().catch(() => null);
  return account;
}

function explainAuthError(e) {
  const t = e?.type || '';
  if (t === 'popup_closed') return '로그인 창이 닫혔습니다.';
  if (t === 'popup_failed_to_open') return '팝업이 차단됐습니다. 브라우저의 팝업 차단을 풀어 주세요.';
  return e?.message || '로그인에 실패했습니다.';
}

async function fetchAccount() {
  const r = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) return null;
  const d = await r.json();
  return { email: d.email || '', name: d.name || '' };
}

export function signOut() {
  const t = accessToken;
  accessToken = null;
  tokenExpiresAt = 0;
  account = null;
  try { if (t) window.google?.accounts?.oauth2?.revoke(t, () => {}); } catch { /* noop */ }
}

// ── 업로드 ─────────────────────────────────────────────
/**
 * @param {Blob} blob  내보낸 영상
 * @param {{title:string, description?:string, tags?:string[], privacyStatus?:string,
 *          madeForKids?:boolean, durationSec?:number}} meta
 */
export async function uploadVideo(blob, meta, { onProgress = () => {}, signal } = {}) {
  if (!isSignedIn()) throw new Error('구글 계정을 먼저 연결해 주세요.');
  const title = (meta.title || '').trim().slice(0, TITLE_MAX);
  if (!title) throw new Error('제목을 입력해 주세요.');

  const body = {
    snippet: {
      title,
      description: (meta.description || '').slice(0, DESC_MAX),
      tags: (meta.tags || []).filter(Boolean).slice(0, 30),
      categoryId: '22',           // People & Blogs
    },
    status: {
      privacyStatus: meta.privacyStatus || 'private',
      // 이 값은 선택이 아니라 필수다. 빠지면 업로드가 거부된다.
      selfDeclaredMadeForKids: Boolean(meta.madeForKids),
    },
  };

  onProgress(0, '업로드 세션 여는 중…');
  const start = await fetch(UPLOAD_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Length': String(blob.size),
      'X-Upload-Content-Type': blob.type || 'video/mp4',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!start.ok) throw new Error(await explainApiError(start));

  const session = start.headers.get('Location') || start.headers.get('location');
  if (!session) {
    throw new Error('업로드 주소를 받지 못했습니다. (브라우저가 Location 헤더를 못 읽는 상황입니다)');
  }

  const result = await putWithProgress(session, blob, onProgress, signal);
  return {
    id: result.id,
    url: `https://www.youtube.com/watch?v=${result.id}`,
    shortsUrl: `https://www.youtube.com/shorts/${result.id}`,
    privacyStatus: result.status?.privacyStatus || body.status.privacyStatus,
    // 감사 전 프로젝트면 요청한 공개 범위와 무관하게 private 로 잠긴다
    lockedPrivate: result.status?.privacyStatus === 'private' && body.status.privacyStatus !== 'private',
  };
}

/** fetch 는 업로드 진행률을 못 준다. 이 부분만 XHR 을 쓴다. */
function putWithProgress(sessionUrl, blob, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', sessionUrl, true);
    xhr.setRequestHeader('Content-Type', blob.type || 'video/mp4');

    xhr.upload.onprogress = e => {
      if (!e.lengthComputable) return;
      const p = e.loaded / e.total;
      onProgress(p, `업로드 중… ${(e.loaded / 1048576).toFixed(1)} / ${(e.total / 1048576).toFixed(1)}MB`);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); }
        catch { reject(new Error('업로드는 끝났는데 응답을 읽지 못했습니다.')); }
      } else {
        let msg = `업로드 실패 (${xhr.status})`;
        try { msg += `: ${JSON.parse(xhr.responseText).error?.message || ''}`; } catch { /* noop */ }
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error('네트워크 오류로 업로드가 끊겼습니다.'));
    xhr.onabort = () => reject(new DOMException('사용자가 취소했습니다.', 'AbortError'));

    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    onProgress(0.01, '업로드 시작…');
    xhr.send(blob);
  });
}

async function explainApiError(res) {
  let detail = '';
  try { detail = (await res.json()).error?.message || ''; } catch { /* noop */ }
  if (res.status === 401) return '인증이 만료됐습니다. 계정을 다시 연결해 주세요.';
  if (res.status === 403) {
    return `권한 또는 할당량 문제입니다. ${detail}\n`
      + '(유튜브 API 기본 할당량으로는 하루 6건 정도만 올릴 수 있습니다. 업로드 1건에 1600 유닛을 씁니다)';
  }
  return `업로드를 시작하지 못했습니다 (${res.status}). ${detail}`;
}

// ── 사전 점검 ──────────────────────────────────────────
export function preflight(durationSec, blob) {
  const notes = [];
  if (durationSec > SHORTS_MAX_SEC) {
    notes.push(`${Math.round(durationSec)}초라 숏츠 기준(${SHORTS_MAX_SEC}초)을 넘습니다. 일반 영상으로 올라갑니다.`);
  }
  if (durationSec < 1) notes.push('영상이 너무 짧습니다.');
  if (blob && blob.size > 256 * 1024 * 1024) {
    notes.push(`${(blob.size / 1048576).toFixed(0)}MB 라 업로드에 시간이 꽤 걸립니다.`);
  }
  return notes;
}
