// 원본 촬영 영상의 권리·변환 기록은 public/demo/manifest.json에 보관합니다.
export const DEMO_MEDIA = Object.freeze([
  {
    "id": "demo-video-portrait-v1",
    "name": "말하는 인물.mp4",
    "file": "../demo/portrait.mp4",
    "mime": "video/mp4",
    "duration": 12,
    "width": 848,
    "height": 480,
    "bytes": 513552,
    "sha256": "c7d54cfd3dae8e57e2aae6114e6d609d97fbdf0d4bb30cc5df3e18effc84749c"
  },
  {
    "id": "demo-video-cat-v2",
    "name": "산책하는 고양이.mp4",
    "file": "../demo/cat-walking.mp4",
    "mime": "video/mp4",
    "duration": 10,
    "width": 960,
    "height": 540,
    "bytes": 3677084,
    "sha256": "c42551865f36f16f3bf96da1db913b6ac8157de0e4aa48b6cb92db023b38ab69"
  },
  {
    "id": "demo-video-waves-v1",
    "name": "물결과 바람.mp4",
    "file": "../demo/waves.mp4",
    "mime": "video/mp4",
    "duration": 10,
    "width": 960,
    "height": 540,
    "bytes": 2145284,
    "sha256": "8be759c596f86c8469763e713dcf2ef1a9bbcf3a3c9d87122f60c5e251442fe7"
  }
].map(Object.freeze));

/** 앱과 같은 주소의 짧은 예시 파일만 가져옵니다. 사용자 미디어는 전송하지 않습니다. */
export async function createDemoMediaFile(id,{signal}={}) {
  const media=DEMO_MEDIA.find(item=>item.id===id);
  if(!media)throw new Error('예시 영상을 찾지 못했습니다.');
  const check=()=>{if(signal?.aborted)throw new DOMException('예시 불러오기를 취소했습니다.','AbortError');};
  check();
  const url=new URL(media.file,import.meta.url);
  url.searchParams.set('v',media.sha256.slice(0,12));
  const response=await fetch(url,{signal,credentials:'omit',mode:'same-origin',redirect:'error',cache:'force-cache'});
  if(!response.ok)throw new Error('예시 영상을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
  const announced=response.headers?.get('Content-Length');
  if(announced!=null&&(!Number.isFinite(Number(announced))||Number(announced)>media.bytes||Number(announced)<0))throw new Error('예시 영상의 파일 크기가 올바르지 않습니다.');
  const bytes=new Uint8Array(await response.arrayBuffer());
  check();
  if(bytes.byteLength!==media.bytes||String.fromCharCode(...bytes.slice(4,8))!=='ftyp')throw new Error('예시 영상이 완전하지 않습니다. 편집기를 새로고침해 주세요.');
  if(globalThis.crypto?.subtle){
    const digest=await crypto.subtle.digest('SHA-256',bytes);
    const actual=[...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('');
    if(actual!==media.sha256)throw new Error('예시 영상 파일을 확인하지 못했습니다. 편집기를 새로고침해 주세요.');
  }
  check();
  return new File([bytes],media.name,{type:media.mime});
}
