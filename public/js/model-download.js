// 고정 버전 공개 모델만 내려받습니다. 원고나 사용자 파일은 요청에 포함하지 않습니다.
const CACHE_NAME = 'shorts-local-models-v1';
export async function cachedModel(url, expected, onProgress = () => {}) {
  if (!url.startsWith('https://huggingface.co/Supertone/supertonic-2/resolve/75e6727618a02f323c720cba9478152d4bc16ca4/')) throw new Error('허용되지 않은 모델 주소입니다.');
  let cache;
  try { cache = await caches.open(CACHE_NAME); } catch {}
  let found;
  try { found = await cache?.match(url); } catch { cache = null; }
  if (found) {
    const bytes = new Uint8Array(await found.arrayBuffer());
    if (!expected || bytes.length === expected) { onProgress(1); return bytes; }
    try { await cache.delete(url); } catch {}
  }
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 5 * 60 * 1000);
  try {
    const response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctrl.signal });
    if (!response.ok) throw new Error('모델을 내려받지 못했습니다 (' + response.status + '). 연결을 확인하고 다시 시도해 주세요.');
    let data;
    if (response.body && expected) {
      data = new Uint8Array(expected);
      const reader = response.body.getReader();let offset = 0, last = 0;
      while (true) {
        const { value, done } = await reader.read();if (done) break;
        if (offset + value.length > expected) { await reader.cancel();throw new Error('모델 파일 크기가 일치하지 않습니다.'); }
        data.set(value, offset);offset += value.length;
        if (Date.now() - last > 150) { onProgress(offset / expected);last = Date.now(); }
      }
      if (offset !== expected) throw new Error('모델 다운로드가 중간에 끊겼습니다. 다시 시도해 주세요.');
    } else data = new Uint8Array(await response.arrayBuffer());
    if (expected && data.length !== expected) throw new Error('모델 다운로드가 중간에 끊겼습니다. 다시 시도해 주세요.');
    try { await cache?.put(url, new Response(data, { headers: { 'Content-Type': 'application/octet-stream' } })); } catch {}
    onProgress(1);return data;
  } catch (error) { if (error.name === 'AbortError') throw new Error('모델 다운로드 시간이 초과됐습니다. 연결을 확인해 주세요.');throw error; }
  finally { clearTimeout(timer); }
}
