import {SOUND_CATALOG} from './sound-catalog.js';

// 사용자가 제공한 정적 MP3만 읽습니다. 실행 중 음원을 합성하거나 외부 API를 호출하지 않습니다.
export const SOUND_EFFECTS = SOUND_CATALOG;

/** 같은 이름의 이전 음원을 새 음원으로 잘못 재사용하지 않도록 원본 해시로 구분합니다. */
export function soundEffectAssetId(id) {
  const effect = SOUND_EFFECTS.find(item => item.id === id);
  if (!effect) throw new Error('효과음을 찾지 못했습니다.');
  return 'builtin-sfx-' + effect.sha256;
}

function hasMp3Frame(bytes) {
  let start=0;
  if(bytes[0]===0x49&&bytes[1]===0x44&&bytes[2]===0x33&&bytes.length>=10){
    const size=((bytes[6]&0x7f)<<21)|((bytes[7]&0x7f)<<14)|((bytes[8]&0x7f)<<7)|(bytes[9]&0x7f);
    start=Math.min(bytes.length,10+size+((bytes[5]&0x10)?10:0));
  }
  const end=Math.min(bytes.length-3,start+65536);
  for(let offset=start;offset<end;offset+=1){
    if(bytes[offset]!==0xff||(bytes[offset+1]&0xe0)!==0xe0)continue;
    const version=(bytes[offset+1]>>3)&0x03;
    const layer=(bytes[offset+1]>>1)&0x03;
    const bitrate=(bytes[offset+2]>>4)&0x0f;
    const sampleRate=(bytes[offset+2]>>2)&0x03;
    if(version!==0x01&&layer!==0&&bitrate!==0&&bitrate!==0x0f&&sampleRate!==0x03)return true;
  }
  return false;
}

// 미리보기와 타임라인 추가가 같은 원본 파일을 사용합니다.
export async function createSoundEffect(id,{signal}={}) {
  const effect=SOUND_EFFECTS.find(item=>item.id===id);
  if(!effect)throw new Error('효과음을 찾지 못했습니다.');
  const check=()=>{if(signal?.aborted)throw new DOMException('효과음 불러오기를 취소했습니다.','AbortError');};
  check();
  const url=new URL(effect.file,import.meta.url);
  url.searchParams.set('v',effect.sha256.slice(0,12));
  const response=await fetch(url,{signal,credentials:'omit',mode:'same-origin',redirect:'error',cache:'force-cache'});
  if(!response.ok)throw new Error('효과음을 불러오지 못했습니다. 편집기를 새로고침한 뒤 다시 시도해 주세요.');
  const announced=response.headers?.get('Content-Length');
  if(announced!==null&&announced!==undefined&&(!Number.isFinite(Number(announced))||Number(announced)<0||Number(announced)>effect.bytes)){
    throw new Error('효과음 파일의 크기가 올바르지 않습니다.');
  }
  let bytes;
  if(response.body?.getReader){
    const reader=response.body.getReader(),chunks=[];
    let length=0;
    try{
      while(true){
        check();
        const {done,value}=await reader.read();
        if(done)break;
        length+=value.byteLength;
        if(length>effect.bytes){await reader.cancel();throw new Error('효과음 파일의 크기가 올바르지 않습니다.');}
        chunks.push(value);
      }
    }finally{reader.releaseLock();}
    bytes=new Uint8Array(length);
    let offset=0;
    for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  }else bytes=new Uint8Array(await response.arrayBuffer());
  check();
  if(bytes.byteLength!==effect.bytes||bytes.byteLength<4)throw new Error('효과음 파일이 완전하지 않습니다. 편집기를 새로고침해 주세요.');
  if(!hasMp3Frame(bytes))throw new Error('효과음 파일의 오디오 형식이 올바르지 않습니다.');
  if(globalThis.crypto?.subtle){
    const digest=await crypto.subtle.digest('SHA-256',bytes);
    const actual=[...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('');
    if(actual!==effect.sha256)throw new Error('효과음 파일을 확인하지 못했습니다. 편집기를 새로고침해 주세요.');
  }
  check();
  return new File([bytes],effect.name+'.mp3',{type:effect.mime});
}
