// 허용한 사이트만 고정 루프백 서비스에 연결합니다. 포트·디스크를 검색하지 않습니다.
export const PC_BRIDGE_URL = 'http://127.0.0.1:8792';
export const PC_CONNECTION_KEY = 'shorts-studio.pc-connection.v1';
export const PC_SETUP_DOWNLOAD = '/downloads/Shorts-Studio-PC-Setup.cmd';
export const PC_VOICE_SETUP_DOWNLOAD = '/downloads/Shorts-Studio-Voice-Setup.cmd';
export const PC_VOICE_SETUP_REQUEST_KEY = 'shorts-studio.pc-voice-setup-request.v1';
const SITES = new Set(['https://shorts-studio-75p.pages.dev', 'https://codex-studio-lab.shorts-studio-75p.pages.dev']);
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
let sessionConnection = null;
const abortError = () => new DOMException('기기 확인을 취소했습니다.', 'AbortError');
const storageDefault = () => { try { return globalThis.localStorage; } catch { return null; } };

function approvedTransport(token, location) {
  if (!SITES.has(location?.origin) || !TOKEN.test(token || '')) throw new Error('이 기기의 사용 정보를 확인하지 못했습니다.');
  return { base:PC_BRIDGE_URL, headers:{Authorization:'Bearer ' + token}, options:{targetAddressSpace:'loopback'} };
}

export function isLoopbackEditor(location = globalThis.location) {
  return !!location && location.protocol === 'http:' && ['localhost','127.0.0.1'].includes(location.hostname);
}
export function isPcSupportedSite(location = globalThis.location) {
  return isLoopbackEditor(location) || SITES.has(location?.origin);
}
export function savedPcConnection(location = globalThis.location, storage = storageDefault()) {
  if (!SITES.has(location?.origin)) return null;
  let data;
  try { const raw = storage?.getItem(PC_CONNECTION_KEY);if (raw && raw.length < 2048) data = JSON.parse(raw); } catch {}
  data ||= sessionConnection;
  return data?.version === 1 && data.origin === location.origin && data.endpoint === PC_BRIDGE_URL && TOKEN.test(data.token || '') ? data : null;
}
export function canUsePcEngine(location = globalThis.location, storage = storageDefault()) {
  return isLoopbackEditor(location) || !!savedPcConnection(location, storage);
}
export function pcSetupPlatform(navigatorImpl = globalThis.navigator) {
  const platform=String(navigatorImpl?.userAgentData?.platform||navigatorImpl?.platform||'').toLowerCase();
  const agent=String(navigatorImpl?.userAgent||'').toLowerCase();
  const mobile=navigatorImpl?.userAgentData?.mobile===true||/android|iphone|ipad|ipod|mobile/.test(agent)||(platform==='macintel'&&Number(navigatorImpl?.maxTouchPoints)>1);
  if(mobile)return 'mobile';
  if(platform.includes('win')||agent.includes('windows'))return 'windows';
  if(platform.includes('mac')||agent.includes('macintosh')||agent.includes('mac os'))return 'macos';
  return 'other';
}
export function canDownloadPcVoiceSetup(navigatorImpl = globalThis.navigator) {
  return pcSetupPlatform(navigatorImpl)==='windows';
}
export function pcVoiceSetupRequested(storage = storageDefault(), now = Date.now()) {
  try {
    const requestedAt=Number(storage?.getItem(PC_VOICE_SETUP_REQUEST_KEY));
    return Number.isFinite(requestedAt)&&requestedAt>0&&now-requestedAt<7*24*60*60*1000;
  } catch { return false; }
}
export function rememberPcVoiceSetupRequest(storage = storageDefault(), now = Date.now()) {
  try { storage?.setItem(PC_VOICE_SETUP_REQUEST_KEY,String(now)); } catch {}
}
export function forgetPcVoiceSetupRequest(storage = storageDefault()) {
  try { storage?.removeItem(PC_VOICE_SETUP_REQUEST_KEY); } catch {}
}
export function pcTransportContext(location = globalThis.location, storage = storageDefault()) {
  if (isLoopbackEditor(location)) return { base:'', headers:{}, options:{} };
  const connection = savedPcConnection(location, storage);
  if (!connection) {
    const error = new Error('이 기기에서 추가 기능을 사용할 준비가 필요합니다.');
    error.code = 'PC_CONNECTION_REQUIRED';throw error;
  }
  return approvedTransport(connection.token, location);
}
function triggerSetupDownload(href, filename, documentImpl) {
  if (!documentImpl?.createElement || !documentImpl?.body?.append) throw new Error('이 브라우저에서는 준비 파일을 받을 수 없습니다.');
  const link = documentImpl.createElement('a');
  link.href = href;link.download = filename;link.hidden = true;
  link.rel = 'noopener';documentImpl.body.append(link);
  try { link.click(); } finally { link.remove?.(); }
  return true;
}
export function downloadPcSetup(documentImpl = globalThis.document) {
  return triggerSetupDownload(PC_SETUP_DOWNLOAD,'Shorts-Studio-Setup.cmd',documentImpl);
}
export function downloadPcVoiceSetup(documentImpl = globalThis.document, navigatorImpl = globalThis.navigator) {
  if(!canDownloadPcVoiceSetup(navigatorImpl))return false;
  return triggerSetupDownload(PC_VOICE_SETUP_DOWNLOAD,'Shorts-Studio-Voice-Setup.cmd',documentImpl);
}
export function rememberPcConnection(token, location = globalThis.location, storage = storageDefault()) {
  if (!SITES.has(location?.origin) || !TOKEN.test(token || '')) throw new Error('이 기기의 사용 정보를 확인하지 못했습니다.');
  const data = {version:1, origin:location.origin, endpoint:PC_BRIDGE_URL, token};
  try { storage?.setItem(PC_CONNECTION_KEY, JSON.stringify(data)); } catch {}
  sessionConnection = data;
  globalThis.window?.dispatchEvent?.(new CustomEvent('studio-pc-connection'));
}

async function bridgeRequest(path, {body, signal, location = globalThis.location, fetchImpl = globalThis.fetch, paired = true, storage, approvalToken, pairStartTimeoutMs = 60000} = {}) {
  if (!['/status','/pair/start','/pair/result','/revoke'].includes(path)) throw new Error('지원하지 않는 기기 요청입니다.');
  if (signal?.aborted) throw abortError();
  if (!isPcSupportedSite(location)) throw new Error('이 주소에서는 추가 기능을 지원하지 않습니다.');
  const transport = paired
    ? (approvalToken === undefined ? pcTransportContext(location, storage) : approvedTransport(approvalToken, location))
    : {base:PC_BRIDGE_URL, headers:{}, options:{targetAddressSpace:'loopback'}};
  const ctrl = new AbortController(), cancel = () => ctrl.abort();
  signal?.addEventListener('abort', cancel, {once:true});
  // 최초 연결만 브라우저의 권한 선택을 기다립니다. 상태 확인과 결과 조회는 짧게 유지합니다.
  const initialPairRequest = path === '/pair/start';
  let timedOut = false;
  const pairTimeout=Number.isFinite(pairStartTimeoutMs)?Math.max(3000,Math.min(60000,pairStartTimeoutMs)):60000;
  const timer = setTimeout(() => { timedOut = true;ctrl.abort(); }, initialPairRequest ? pairTimeout : 5000);
  try {
    const response = await fetchImpl(transport.base + '/api/pc-bridge' + path, {
      ...transport.options, method:body === undefined ? 'GET':'POST',
      headers:{...transport.headers,'X-Studio-PC-Bridge':'1',...(body === undefined ? {}:{'Content-Type':'application/json'})},
      ...(body === undefined ? {}:{body:JSON.stringify(body)}), signal:ctrl.signal, cache:'no-store', credentials:'omit', redirect:'error'
    });
    if (ctrl.signal.aborted) throw abortError();
    if (!/^application\/json(?:;|$)/i.test(response.headers.get('Content-Type') || '')) throw new Error('준비 프로그램을 최신 버전으로 설치해 주세요.');
    const raw = await response.text();if (ctrl.signal.aborted) throw abortError();if (raw.length > 65536) throw new Error('기기 응답이 올바르지 않습니다.');
    const data = JSON.parse(raw);
    if (!response.ok) {const error=new Error(typeof data.error?.message === 'string' ? data.error.message.slice(0,1000) : '이 기기의 준비 상태를 확인하지 못했습니다.');error.code=data.error?.code;throw error;}
    return data;
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (initialPairRequest && timedOut) {
      const timeout = new Error('기기의 응답을 받지 못했습니다. 브라우저의 로컬 네트워크 허용 요청을 확인한 뒤 다시 시도해 주세요.');
      timeout.code = 'PC_PAIR_START_TIMEOUT';throw timeout;
    }
    if (error instanceof TypeError || error.name === 'AbortError') throw new Error('추가 기능이 실행되지 않았거나 브라우저의 로컬 네트워크 권한이 필요합니다.');
    throw error;
  } finally { clearTimeout(timer);signal?.removeEventListener('abort', cancel); }
}

export async function pcConnectionStatus(options) {
  const data = await bridgeRequest('/status', options);
  if (data.app !== 'shorts-studio-pc' || data.version !== 1 || !data.engines || typeof data.engines !== 'object') throw new Error('Shorts Studio 준비 프로그램의 응답이 아닙니다.');
  return data;
}

export async function connectPc({signal, location = globalThis.location, fetchImpl = globalThis.fetch, storage = storageDefault(), windowImpl = globalThis.window, onProgress = () => {}, pairStartTimeoutMs = 60000} = {}) {
  if (signal?.aborted) throw abortError();
  if (isLoopbackEditor(location)) return pcConnectionStatus({signal,location,fetchImpl,storage});
  if (!SITES.has(location?.origin)) throw new Error('정식 Shorts Studio 주소에서 연결해 주세요.');
  // 클릭 이벤트 안에서 먼저 창을 열어 팝업 차단을 피합니다. 브라우저 권한은 우회하지 않습니다.
  const popup = windowImpl?.open('about:blank', 'shorts-studio-pc-approval', 'width=620,height=600');
  if (!popup) throw new Error('기기 사용 확인 창이 차단됐습니다. 이 사이트의 팝업을 허용한 뒤 다시 눌러 주세요.');
  try {
    // 새 창이 원래 편집기의 브라우저 권한 안내를 가리지 않도록 정적인 설명을 남깁니다.
    try {
      const doc = popup.document;
      if (doc?.body) {
        doc.title = '기기 사용 확인';
        doc.body.textContent = '원래 편집기 창으로 돌아가 브라우저가 요청하는 로컬 네트워크 접근을 허용해 주세요. 준비가 되면 이 창에서 기기 사용을 승인할 수 있습니다.';
        if (doc.body.style) doc.body.style.cssText = 'margin:32px;font-family:system-ui,sans-serif;line-height:1.7';
      }
    } catch {}
    try { windowImpl?.focus?.(); } catch {}
    onProgress('이 기기의 추가 기능을 찾는 중… 브라우저가 로컬 네트워크 접근을 요청하면 허용해 주세요.');
    const pending = await bridgeRequest('/pair/start', {body:{},signal,location,fetchImpl,paired:false,pairStartTimeoutMs});
    if (signal?.aborted) throw abortError();
    if (!/^[a-f0-9]{32}$/.test(pending.requestId || '') || !TOKEN.test(pending.requestSecret || '') || pending.approvalPath !== '/pc-connect.html?request=' + pending.requestId) throw new Error('기기 사용 확인 정보를 읽지 못했습니다.');
    popup.location = PC_BRIDGE_URL + pending.approvalPath;
    try { popup.focus?.(); } catch {}
    onProgress('열린 확인 창에서 이 편집기의 기기 사용을 허용해 주세요.');
    const deadline = Date.now() + 175000;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw abortError();
      const result = await bridgeRequest('/pair/result', {body:{requestId:pending.requestId,requestSecret:pending.requestSecret},signal,location,fetchImpl,paired:false});
      if (result.state === 'approved') {
        if (signal?.aborted) throw abortError();
        if (!TOKEN.test(result.token || '')) throw new Error('기기 사용 정보를 확인하지 못했습니다.');
        // 마지막 상태 확인 중 취소되면 승인 토큰을 저장소나 세션에 남기지 않습니다.
        const status = await pcConnectionStatus({signal,location,fetchImpl,storage,approvalToken:result.token});
        if (signal?.aborted) throw abortError();
        rememberPcConnection(result.token,location,storage);
        return status;
      }
      if (result.state !== 'pending') throw new Error('기기 사용 상태를 확인하지 못했습니다.');
      await new Promise((resolve,reject) => {
        const cancelled = () => {clearTimeout(timer);signal?.removeEventListener('abort',cancelled);reject(abortError());};
        const timer = setTimeout(() => {signal?.removeEventListener('abort',cancelled);resolve();},700);
        signal?.addEventListener('abort',cancelled,{once:true});
        if (signal?.aborted) cancelled();
      });
    }
    throw new Error('기기 사용 확인 시간이 지났습니다. 다시 시도해 주세요.');
  } finally { try { popup.close(); } catch {} }
}

export async function disconnectPc(options = {}) {
  const location = options.location || globalThis.location, storage = options.storage || storageDefault();
  if (savedPcConnection(location, storage)) await bridgeRequest('/revoke', {...options,body:{}});
  try { storage?.removeItem(PC_CONNECTION_KEY); } catch {}
  sessionConnection = null;
  globalThis.window?.dispatchEvent?.(new CustomEvent('studio-pc-connection'));
}
