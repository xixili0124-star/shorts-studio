// 실험판의 AI 요청은 로컬 프록시만 사용합니다. 운영 Worker와 API 키에 접근하지 않습니다.
import { uid } from './util.js';

export function encodeWav(buffer) {
  const frames=buffer.length,channels=buffer.numberOfChannels;
  const data=new ArrayBuffer(44+frames*2),v=new DataView(data);
  const put=(at,s)=>[...s].forEach((c,i)=>v.setUint8(at+i,c.charCodeAt(0)));
  put(0,'RIFF');v.setUint32(4,36+frames*2,true);put(8,'WAVE');put(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,buffer.sampleRate,true);v.setUint32(28,buffer.sampleRate*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);put(36,'data');v.setUint32(40,frames*2,true);
  const samples=Array.from({length:channels},(_,c)=>buffer.getChannelData(c));
  for(let i=0;i<frames;i++){let x=0;for(const channel of samples)x+=channel[i]/channels;x=Math.max(-1,Math.min(1,x));v.setInt16(44+i*2,x<0?x*32768:x*32767,true);}
  return new Blob([data],{type:'audio/wav'});
}

export function transcriptionCaptions(result) {
  if(!Array.isArray(result.words)||!result.words.length){
    return (result.segments||[]).filter(s=>typeof s.text==='string'&&Number.isFinite(s.start)&&Number.isFinite(s.end)&&s.end>s.start).map(s=>({id:uid(),text:s.text.trim(),start:Math.max(0,s.start),end:s.end}));
  }
  const caps=[];let current=null;
  for(const word of result.words){
    const text=String(word.word||'').trim();
    if(!text||!Number.isFinite(word.start)||!Number.isFinite(word.end)||word.end<=word.start)continue;
    if(current&&(current.text.length+text.length>22||word.end-current.start>4||word.start-current.end>.6)){caps.push(current);current=null;}
    if(!current)current={id:uid(),start:Math.max(0,word.start),end:word.end,text};
    else{current.text+=' '+text;current.end=word.end;}
    if(/[.!?。！？]$/.test(text)){caps.push(current);current=null;}
  }
  if(current)caps.push(current);
  return caps;
}

export async function apiError(response) {
  let message='AI 처리에 실패했습니다. 연결 상태를 확인해 주세요.';
  try{const data=await response.json();message=data.error?.message||data.message||message;}catch{}
  return new Error(message);
}
