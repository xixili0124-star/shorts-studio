// 원본 파일은 승인한 이 PC에만 전송하고, 실제 추적 시각을 그대로 사용합니다.
import { pcTransportContext } from './pc-connection.js';

export const PC_TRACKING_MODEL = 'sam2.1-hiera-small';
const abortError = () => new DOMException('PC 추적을 취소했습니다.', 'AbortError');
const check = signal => { if (signal?.aborted) throw abortError(); };

async function request(path, { method='GET', body, trackingOptions, signal, location=globalThis.location, fetchImpl=globalThis.fetch, timeout=15000 }={}) {
  if (!['/status','/track','/cancel'].includes(path) && !/^\/jobs\/[a-f0-9]{32}$/.test(path)) throw new Error('지원하지 않는 PC 추적 요청입니다.');
  const transport=pcTransportContext(location),ctrl=new AbortController();check(signal);
  const abort=()=>ctrl.abort();signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(abort,timeout);
  try {
    const headers={...transport.headers,'X-Studio-PC-Tracking':'1'};
    if(method==='POST')Object.assign(headers,{'X-Studio-Consent':'video-to-local-tracking','Content-Type':path==='/track'?'application/octet-stream':'application/json'});
    if(trackingOptions)headers['X-Studio-Tracking-Options']=JSON.stringify(trackingOptions);
    const response=await fetchImpl(transport.base+'/api/pc-tracking'+path,{...transport.options,method,headers,body,signal:ctrl.signal,credentials:'omit',cache:'no-store',redirect:'error'});
    if(!/^application\/json(?:;|$)/i.test(response.headers.get('Content-Type')||''))throw new Error('PC 연결 프로그램을 최신 버전으로 설치해 주세요.');
    const max=2*1024*1024,announced=Number(response.headers.get('Content-Length')||0);
    if(!Number.isFinite(announced)||announced<0||announced>max)throw new Error('PC 추적 응답이 너무 큽니다.');
    let bytes;
    if(response.body?.getReader){
      const reader=response.body.getReader(),parts=[];let size=0;
      try{while(true){check(ctrl.signal);const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>max){await reader.cancel();throw new Error('PC 추적 응답이 너무 큽니다.');}parts.push(value);}}
      finally{reader.releaseLock();}
      bytes=new Uint8Array(size);let at=0;for(const part of parts){bytes.set(part,at);at+=part.byteLength;}
    }else{bytes=new Uint8Array(await response.arrayBuffer());if(bytes.byteLength>max)throw new Error('PC 추적 응답이 너무 큽니다.');}
    check(ctrl.signal);const data=JSON.parse(new TextDecoder().decode(bytes));
    if(!response.ok){const error=new Error(typeof data?.error?.message==='string'?data.error.message.slice(0,1000):'PC 추적을 완료하지 못했습니다.');error.code=data?.error?.code;throw error;}
    return data;
  }catch(error){
    check(signal);if(error.name==='AbortError')throw new Error('PC 추적 연결 시간이 초과됐습니다. 도움말에서 PC 연결을 확인해 주세요.');
    if(error instanceof TypeError)throw new Error('PC 연결이 끊겼습니다. 기존 추적 결과는 유지합니다.');throw error;
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}

export async function pcTrackingStatus(options){
  const status=await request('/status',options);
  if(status?.localServer!==true||status.provider!=='sam2'||status.model!==PC_TRACKING_MODEL||typeof status.available!=='boolean'||typeof status.configured!=='boolean')throw new Error('정밀 추적 기능의 준비 상태를 확인하지 못했습니다.');
  return status;
}

export function pcTrackingResult(result,clip,seedTime){
  const duration=clip.trimEnd-clip.trimStart;
  const fail=()=>{throw new Error('PC 추적 결과의 위치·시각이 올바르지 않습니다. 기존 결과는 유지합니다.');};
  if(!result||result.model!==PC_TRACKING_MODEL||result.device!=='cuda'||result.computeType!=='bfloat16'||!Number.isFinite(result.duration)||!Number.isFinite(result.seedTime)||Math.abs(result.duration-duration)>.00001||Math.abs(result.seedTime-(seedTime-clip.trimStart))>.00001||!Array.isArray(result.points)||!result.points.length||result.points.length>2701)fail();
  let previous=-1;
  const keyframes=result.points.map(row=>{
    if(!row||!['t','x','y','w','h','confidence'].every(k=>Number.isFinite(row[k]))||typeof row.lost!=='boolean'||row.t<=previous||row.t<0||row.t>=duration||row.x<0||row.y<0||row.w<=0||row.h<=0||row.x+row.w>1.000001||row.y+row.h>1.000001||row.confidence<0||row.confidence>1)fail();
    previous=row.t;return {t:clip.trimStart+row.t,x:row.x,y:row.y,w:row.w,h:row.h,lost:row.lost,confidence:row.confidence};
  });
  if(keyframes.every(row=>row.lost))fail();
  return {keyframes,width:clip.natW,height:clip.natH,model:PC_TRACKING_MODEL,engine:'pc',warnings:Array.isArray(result.warnings)?result.warnings.filter(x=>typeof x==='string').slice(0,8):[]};
}

export async function trackPcVideo(clip,rect,{seedTime=clip.trimStart,signal,onProgress=()=>{},location=globalThis.location,fetchImpl=globalThis.fetch,pollInterval=500,timeout=16*60*1000,requestTimeout=60000}={}){
  pcTransportContext(location);check(signal);
  const duration=clip?.trimEnd-clip?.trimStart;
  if(clip?.type!=='video'||!(clip.file instanceof Blob)||clip.file.size<=0||clip.file.size>256*1024*1024)throw new Error('PC 추적은 256MB 이하 MP4·MOV·WebM 원본을 지원합니다. 더 큰 영상은 필요한 구간을 별도 파일로 준비해 주세요.');
  if(!Number.isFinite(duration)||duration<=0||duration>180||!Number.isFinite(seedTime)||seedTime<clip.trimStart||seedTime>=clip.trimEnd||!rect||!['x','y','w','h'].every(k=>Number.isFinite(rect[k]))||rect.x<0||rect.y<0||rect.w<.005||rect.h<.005||rect.x+rect.w>1.000001||rect.y+rect.h>1.000001)throw new Error('3분 이내 구간과 추적할 영역을 다시 지정해 주세요.');
  const options={start:clip.trimStart,duration,seedTime:seedTime-clip.trimStart,box:{x:rect.x,y:rect.y,w:rect.w,h:rect.h}};
  return new Promise((resolve,reject)=>{
    let settled=false,jobId='',cancelSent=false,pollTimer;
    const ctrl=new AbortController(),common={location,fetchImpl,timeout:requestTimeout};
    const cancelRemote=()=>{if(!jobId||cancelSent)return;cancelSent=true;request('/cancel',{...common,method:'POST',body:JSON.stringify({jobId}),timeout:5000}).catch(()=>{});};
    const finish=(fn,value,stop=false)=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(pollTimer);signal?.removeEventListener('abort',cancel);ctrl.abort();if(stop)cancelRemote();fn(value);};
    const cancel=()=>finish(reject,abortError(),true);
    const timer=setTimeout(()=>finish(reject,new Error('추적 시간이 초과됐습니다. 종료를 요청했으니 구간을 줄여 다시 실행해 주세요.'),true),timeout);
    signal?.addEventListener('abort',cancel,{once:true});
    const poll=async()=>{try{
      const job=await request('/jobs/'+jobId,{...common,signal:ctrl.signal});if(settled)return;
      if(job.state==='done'){finish(resolve,pcTrackingResult(job.result,clip,seedTime));return;}
      if(job.state==='failed')throw new Error(typeof job.error?.message==='string'?job.error.message.slice(0,1000):'PC 추적에 실패했습니다.');
      if(job.state==='cancelled'){finish(reject,abortError());return;}
      if(job.state!=='running')throw new Error('PC 추적 상태를 확인하지 못했습니다.');
      onProgress(Number.isFinite(job.progress)?Math.max(0,Math.min(1,job.progress)):null,'정밀하게 대상을 따라가는 중…');
      pollTimer=setTimeout(poll,pollInterval);
    }catch(error){finish(reject,error,true);}};
    onProgress(null,'선택한 원본을 이 PC의 추적 엔진으로 보내는 중…');
    // 생성 응답은 취소 후에도 회수해, 뒤늦게 생긴 작업을 즉시 취소합니다.
    request('/track',{...common,method:'POST',body:clip.file,trackingOptions:options}).then(created=>{
      if(!/^[a-f0-9]{32}$/.test(created?.jobId||''))throw new Error('PC 추적 작업 번호를 받지 못했습니다.');
      jobId=created.jobId;if(settled){cancelRemote();return;}poll();
    }).catch(error=>finish(reject,error,true));
  });
}
