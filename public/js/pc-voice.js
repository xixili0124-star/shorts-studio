// Only the same-origin PC adapter is contacted. Public/mobile pages never probe localhost.
import { encodeWav } from './ai-client.js';
import { monoPcm } from './silence.js';

const PREFIX='/api/voice-clone';
const abortError=()=>new DOMException('결과 받기를 취소했습니다.','AbortError');
const check=signal=>{if(signal?.aborted)throw abortError();};
export function isPcVoiceOrigin(location=globalThis.location){
  return !!location&&location.protocol==='http:'&&['localhost','127.0.0.1'].includes(location.hostname);
}

async function readBounded(response,maximum){
  const announced=Number(response.headers.get('Content-Length')||0);
  if(announced>maximum)throw new Error('PC 음성 응답이 너무 큽니다. 원고를 나누어 주세요.');
  if(!response.body?.getReader){const bytes=await response.arrayBuffer();if(bytes.byteLength>maximum)throw new Error('PC 음성 응답이 너무 큽니다.');return new Uint8Array(bytes);}
  const reader=response.body.getReader(),parts=[];let length=0;
  try{while(true){const {value,done}=await reader.read();if(done)break;length+=value.length;if(length>maximum){await reader.cancel();throw new Error('PC 음성 응답이 너무 큽니다.');}parts.push(value);}}
  finally{reader.releaseLock();}
  const out=new Uint8Array(length);let at=0;for(const part of parts){out.set(part,at);at+=part.length;}return out;
}

async function request(path,payload,{signal,timeout=10000,location=globalThis.location,fetchImpl=globalThis.fetch}={}){
  if(!isPcVoiceOrigin(location))throw new Error('내 목소리 TTS는 PC용 로컬 편집기에서 사용할 수 있어요. 이 화면에서는 기존 브라우저 TTS를 사용할 수 있습니다.');
  if(!['/status','/references','/delete','/synthesize'].includes(path))throw new Error('지원하지 않는 PC 음성 요청입니다.');
  check(signal);const ctrl=new AbortController();let expired=false;
  const cancel=()=>ctrl.abort();signal?.addEventListener('abort',cancel,{once:true});
  const timer=setTimeout(()=>{expired=true;ctrl.abort();},timeout);
  try{
    const response=await fetchImpl(PREFIX+path,{method:payload===undefined?'GET':'POST',
      headers:{'X-Studio-PC-Voice':'1',...(payload===undefined?{}:{'Content-Type':'application/json','X-Studio-Consent':'voice-clone-local'})},
      ...(payload===undefined?{}:{body:JSON.stringify(payload)}),signal:ctrl.signal,credentials:'omit',cache:'no-store',redirect:'error'});
    check(signal);
    if(!response.ok){let message='PC 음성 기능에 연결하지 못했습니다. PC용 편집기를 다시 실행해 주세요.';
      try{const raw=await readBounded(response,65536),error=JSON.parse(new TextDecoder().decode(raw));if(typeof error.error?.message==='string')message=error.error.message;}catch{}
      throw new Error(message);
    }
    const audio=path==='/synthesize',mime=response.headers.get('Content-Type')||'';
    if(!mime.startsWith(audio?'audio/wav':'application/json'))throw new Error('PC 음성 서버를 찾지 못했습니다. 최신 PC용 편집기로 다시 실행해 주세요.');
    const raw=await readBounded(response,audio?32*1024*1024:65536);check(signal);
    if(!audio){try{return JSON.parse(new TextDecoder().decode(raw));}catch{throw new Error('PC 음성 서버 응답을 읽지 못했습니다.');}}
    const sampleRate=Number(response.headers.get('X-Studio-Audio-Rate')),duration=Number(response.headers.get('X-Studio-Audio-Duration'));
    if(raw.length<44||new TextDecoder().decode(raw.subarray(0,4))!=='RIFF'||new TextDecoder().decode(raw.subarray(8,12))!=='WAVE'||!Number.isFinite(duration)||duration<=0||duration>300||!Number.isInteger(sampleRate)||sampleRate<16000||sampleRate>96000)throw new Error('PC 엔진에서 정상적인 음성 파일을 받지 못했습니다.');
    return {wav:new Blob([raw],{type:'audio/wav'}),duration,sampleRate};
  }catch(error){
    if(signal?.aborted)throw abortError();
    if(expired)throw new Error(path==='/synthesize'?'결과 받기 시간이 초과되었습니다. 엔진 작업이 남아 있을 수 있으니 연결 상태를 확인해 주세요.':'PC 연결을 확인하지 못했습니다. 음성 엔진이 준비된 뒤 다시 확인해 주세요.');
    if(error instanceof TypeError)throw new Error('PC 음성 연결이 끊겼습니다. 원고는 유지됩니다. PC용 편집기와 음성 엔진을 확인해 주세요.');
    throw error;
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
}

export const pcVoiceStatus=options=>request('/status',undefined,options);
export const deleteVoiceReference=(profileId,options)=>request('/delete',{profileId,consent:true},options);
export const generatePcVoice=(payload,options={})=>request('/synthesize',payload,{timeout:330000,...options});

export async function saveVoiceReference({name,promptText,wav,consent},options={}){
  check(options.signal);
  if(!(wav instanceof Blob)||wav.size>1024*1024)throw new Error('참고 음성 파일을 다시 준비해 주세요.');
  const bytes=new Uint8Array(await wav.arrayBuffer());check(options.signal);
  let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return request('/references',{name,promptText,consent,audio:btoa(binary)},options);
}

export function referenceFromPcm(buffer){
  const duration=buffer?.length/buffer?.sampleRate;
  if(!Number.isFinite(duration)||duration<3||duration>10)throw new Error('참고 음성은 3~10초로 준비해 주세요. 배경음악 없이 한 사람의 목소리만 담아 주세요.');
  const pcm=monoPcm(buffer,32000);let peak=0;
  for(const sample of pcm){if(!Number.isFinite(sample))throw new Error('참고 음성을 읽지 못했습니다.');peak=Math.max(peak,Math.abs(sample));}
  if(peak<.001)throw new Error('녹음 소리가 너무 작거나 무음입니다. 마이크를 확인해 주세요.');
  const wav=encodeWav({length:pcm.length,sampleRate:32000,numberOfChannels:1,getChannelData:()=>pcm});
  return {wav,duration:pcm.length/32000,sampleRate:32000};
}

export async function decodeVoiceReference(file,{signal}={}){
  check(signal);if(!(file instanceof Blob)||file.size<=0||file.size>10*1024*1024)throw new Error('10MB 이하의 짧은 음성 파일을 선택해 주세요.');
  const Audio=globalThis.AudioContext||globalThis.webkitAudioContext;if(!Audio)throw new Error('이 브라우저에서 음성 파일을 읽을 수 없습니다. 최신 Chrome 또는 Edge를 사용해 주세요.');
  const context=new Audio();
  try{const bytes=await file.arrayBuffer();check(signal);const buffer=await context.decodeAudioData(bytes);check(signal);return referenceFromPcm(buffer);}
  finally{await context.close();}
}

export function recordVoiceReference({signal,onTick=()=>{},onStarted=()=>{}}={}){
  let recorder,stream,timer,settled=false,started=0,rejectPromise,resolvePromise;
  const promise=new Promise((resolve,reject)=>{resolvePromise=resolve;rejectPromise=reject;});
  const cleanup=()=>{clearInterval(timer);stream?.getTracks().forEach(track=>track.stop());signal?.removeEventListener('abort',cancel);};
  const finish=(error,blob)=>{if(settled)return;settled=true;cleanup();if(error)rejectPromise(error);else resolvePromise(blob);};
  const stop=()=>{if(recorder?.state==='recording')recorder.stop();};
  const cancel=()=>{finish(abortError());stop();};
  signal?.addEventListener('abort',cancel,{once:true});
  (async()=>{
    check(signal);
    if(!globalThis.navigator?.mediaDevices?.getUserMedia||!globalThis.MediaRecorder)throw new Error('마이크 녹음을 지원하지 않습니다. 짧은 음성 파일을 선택해 주세요.');
    stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false}});
    if(settled||signal?.aborted){cleanup();if(!settled)finish(abortError());return;}
    const mime=['audio/webm;codecs=opus','audio/mp4','audio/webm','audio/ogg;codecs=opus'].find(type=>MediaRecorder.isTypeSupported(type));
    recorder=new MediaRecorder(stream,mime?{mimeType:mime}:{});const chunks=[];
    recorder.ondataavailable=event=>{if(event.data.size)chunks.push(event.data);};
    recorder.onerror=()=>finish(new Error('마이크 녹음이 중단됐습니다. 마이크 권한과 연결을 확인해 주세요.'));
    recorder.onstop=()=>finish(null,new Blob(chunks,{type:recorder.mimeType||'audio/webm'}));
    started=performance.now();recorder.start();onStarted();
    timer=setInterval(()=>{const elapsed=(performance.now()-started)/1000;onTick(elapsed);if(elapsed>=9)stop();},100);
  })().catch(error=>finish(error.name==='AbortError'?error:new Error(error.name==='NotAllowedError'?'마이크 권한이 필요합니다. 허용하거나 음성 파일을 선택해 주세요.':error.message)));
  return {promise,stop,cancel};
}
