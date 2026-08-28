// 허용한 사이트만 고정 루프백 서비스에 연결합니다. 포트·디스크를 검색하지 않습니다.
export const PC_BRIDGE_URL = 'http://127.0.0.1:8792';
export const PC_CONNECTION_KEY = 'shorts-studio.pc-connection.v1';
export const PC_SETUP_DOWNLOAD = '/downloads/Shorts-Studio-PC-Setup.cmd';
const SITES = new Set(['https://shorts-studio-75p.pages.dev', 'https://codex-studio-lab.shorts-studio-75p.pages.dev']);
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
let sessionConnection = null;
const abortError = () => new DOMException('PC 연결을 취소했습니다.', 'AbortError');
const storageDefault = () => { try { return globalThis.localStorage; } catch { return null; } };

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
export function pcTransportContext(location = globalThis.location, storage = storageDefault()) {
  if (isLoopbackEditor(location)) return { base:'', headers:{}, options:{} };
  const connection = savedPcConnection(location, storage);
  if (!connection) {
    const error = new Error('도움말의 PC 연결에서 설치 확인을 눌러 이 편집기를 연결해 주세요. 프로젝트를 옮길 필요는 없습니다.');
    error.code = 'PC_CONNECTION_REQUIRED';throw error;
  }
  return { base:PC_BRIDGE_URL, headers:{Authorization:'Bearer ' + connection.token}, options:{targetAddressSpace:'loopback'} };
}
export function rememberPcConnection(token, location = globalThis.location, storage = storageDefault()) {
  if (!SITES.has(location?.origin) || !TOKEN.test(token || '')) throw new Error('PC 연결 정보를 확인하지 못했습니다.');
  const data = {version:1, origin:location.origin, endpoint:PC_BRIDGE_URL, token};
  try { storage?.setItem(PC_CONNECTION_KEY, JSON.stringify(data)); } catch {}
  sessionConnection = data;
  globalThis.window?.dispatchEvent(new CustomEvent('studio-pc-connection'));
}

async function bridgeRequest(path, {body, signal, location = globalThis.location, fetchImpl = globalThis.fetch, paired = true, storage} = {}) {
  if (!['/status','/pair/start','/pair/result','/revoke'].includes(path)) throw new Error('지원하지 않는 PC 연결 요청입니다.');
  if (signal?.aborted) throw abortError();
  const transport = paired ? pcTransportContext(location, storage) : {base:PC_BRIDGE_URL, headers:{}, options:{targetAddressSpace:'loopback'}};
  if (!isPcSupportedSite(location)) throw new Error('이 주소에서는 PC 연결을 지원하지 않습니다.');
  const ctrl = new AbortController(), cancel = () => ctrl.abort();
  signal?.addEventListener('abort', cancel, {once:true});
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const response = await fetchImpl(transport.base + '/api/pc-bridge' + path, {
      ...transport.options, method:body === undefined ? 'GET':'POST',
      headers:{...transport.headers,'X-Studio-PC-Bridge':'1',...(body === undefined ? {}:{'Content-Type':'application/json'})},
      ...(body === undefined ? {}:{body:JSON.stringify(body)}), signal:ctrl.signal, cache:'no-store', credentials:'omit', redirect:'error'
    });
    if (ctrl.signal.aborted) throw abortError();
    if (!/^application\/json(?:;|$)/i.test(response.headers.get('Content-Type') || '')) throw new Error('PC 연결 프로그램을 최신 버전으로 설치해 주세요.');
    const raw = await response.text();if (ctrl.signal.aborted) throw abortError();if (raw.length > 65536) throw new Error('PC 연결 응답이 올바르지 않습니다.');
    const data = JSON.parse(raw);
    if (!response.ok) {const error=new Error(typeof data.error?.message === 'string' ? data.error.message.slice(0,1000) : 'PC 연결을 확인하지 못했습니다.');error.code=data.error?.code;throw error;}
    return data;
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (error instanceof TypeError || error.name === 'AbortError') throw new Error('PC 연결 프로그램이 꺼져 있거나 브라우저의 로컬 네트워크 권한이 필요합니다. 도움말에서 실행한 뒤 설치 확인을 눌러 주세요.');
    throw error;
  } finally { clearTimeout(timer);signal?.removeEventListener('abort', cancel); }
}

export async function pcConnectionStatus(options) {
  const data = await bridgeRequest('/status', options);
  if (data.app !== 'shorts-studio-pc' || data.version !== 1 || !data.engines || typeof data.engines !== 'object') throw new Error('Shorts Studio PC 연결 프로그램의 응답이 아닙니다.');
  return data;
}

export async function connectPc({signal, location = globalThis.location, fetchImpl = globalThis.fetch, storage = storageDefault(), windowImpl = globalThis.window, onProgress = () => {}} = {}) {
  if (signal?.aborted) throw abortError();
  if (isLoopbackEditor(location)) return pcConnectionStatus({signal,location,fetchImpl,storage});
  if (!SITES.has(location?.origin)) throw new Error('정식 Shorts Studio 주소에서 연결해 주세요.');
  // 클릭 이벤트 안에서 먼저 창을 열어 팝업 차단을 피합니다. 브라우저 권한은 우회하지 않습니다.
  const popup = windowImpl?.open('about:blank', 'shorts-studio-pc-approval', 'width=620,height=600');
  if (!popup) throw new Error('PC 연결 확인 창이 차단됐습니다. 이 사이트의 팝업을 허용한 뒤 다시 눌러 주세요.');
  try {
    onProgress('PC 연결 프로그램을 찾는 중…');
    const pending = await bridgeRequest('/pair/start', {body:{},signal,location,fetchImpl,paired:false});
    if (!/^[a-f0-9]{32}$/.test(pending.requestId || '') || !TOKEN.test(pending.requestSecret || '') || pending.approvalPath !== '/pc-connect.html?request=' + pending.requestId) throw new Error('PC 연결 확인 정보를 읽지 못했습니다.');
    popup.location = PC_BRIDGE_URL + pending.approvalPath;
    onProgress('열린 PC 확인 창에서 이 편집기에 연결을 허용해 주세요.');
    const deadline = Date.now() + 175000;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw abortError();
      const result = await bridgeRequest('/pair/result', {body:{requestId:pending.requestId,requestSecret:pending.requestSecret},signal,location,fetchImpl,paired:false});
      if (result.state === 'approved') {
        if (signal?.aborted) throw abortError();
        rememberPcConnection(result.token,location,storage);
        return pcConnectionStatus({signal,location,fetchImpl,storage});
      }
      if (result.state !== 'pending') throw new Error('PC 연결 상태를 확인하지 못했습니다.');
      await new Promise((resolve,reject) => {
        const cancelled = () => {clearTimeout(timer);signal?.removeEventListener('abort',cancelled);reject(abortError());};
        const timer = setTimeout(() => {signal?.removeEventListener('abort',cancelled);resolve();},700);
        signal?.addEventListener('abort',cancelled,{once:true});
        if (signal?.aborted) cancelled();
      });
    }
    throw new Error('PC 연결 확인 시간이 지났습니다. 다시 설치 확인을 눌러 주세요.');
  } finally { try { popup.close(); } catch {} }
}

export async function disconnectPc(options = {}) {
  const location = options.location || globalThis.location, storage = options.storage || storageDefault();
  if (savedPcConnection(location, storage)) await bridgeRequest('/revoke', {...options,body:{}});
  try { storage?.removeItem(PC_CONNECTION_KEY); } catch {}
  sessionConnection = null;
  globalThis.window?.dispatchEvent(new CustomEvent('studio-pc-connection'));
}
