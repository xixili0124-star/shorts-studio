// Kenney의 CC0 배포 샘플을 WAV로 준비했습니다. 라이브러리는 합성 함수를 사용하지 않습니다.
export const SOUND_EFFECTS = [
  {"id":"whoosh","name":"스우시","category":"전환","duration":0.5995416666666666,"kind":"noise","freq":700,"file":"../sounds/kenney/whoosh.wav","bytes":57600,"sha256":"a566958b3d56d4e7e1d15b7ebe500249c90e60ebffae8bc93c807c1daed9eab2","sourceUrl":"https://kenney.nl/assets/rpg-audio","license":"CC0-1.0","author":"Kenney"},
  {"id":"swish","name":"짧은 휙","category":"전환","duration":0.5687916666666667,"kind":"noise","freq":1800,"file":"../sounds/kenney/swish.wav","bytes":54648,"sha256":"93c2c459a410ce22271814ccb0becc18058b294ac96954827cd5be00b4b75064","sourceUrl":"https://kenney.nl/assets/rpg-audio","license":"CC0-1.0","author":"Kenney"},
  {"id":"air","name":"옷감 스윕","category":"전환","duration":0.6610416666666666,"kind":"noise","freq":350,"file":"../sounds/kenney/air.wav","bytes":63504,"sha256":"412c845df87eb19489bc0f84d837fda822ca1e6b96035a0f0a4627997a7bb08f","sourceUrl":"https://kenney.nl/assets/rpg-audio","license":"CC0-1.0","author":"Kenney"},
  {"id":"riser","name":"상승 전환","category":"전환","duration":1.2016458333333333,"kind":"riser","freq":180,"file":"../sounds/kenney/riser.wav","bytes":115402,"sha256":"d3bb75eb812446d33f9c4dac6e6be936a36a2c592b15d10fce6d34b2f2f7e1a4","sourceUrl":"https://kenney.nl/assets/digital-audio","license":"CC0-1.0","author":"Kenney"},
  {"id":"rewind","name":"하강 전환","category":"전환","duration":0.5181041666666667,"kind":"rewind","freq":900,"file":"../sounds/kenney/rewind.wav","bytes":49782,"sha256":"21474f42e972fd1c7c094ea30087ded5c8700e8e90ba17521b075953c6fdb3e3","sourceUrl":"https://kenney.nl/assets/digital-audio","license":"CC0-1.0","author":"Kenney"},
  {"id":"click","name":"딸깍","category":"클릭","duration":0.12,"kind":"click","freq":1800,"file":"../sounds/kenney/click.wav","bytes":11564,"sha256":"7c04f3d381006171bcd0865561b50e8d9e362ba44124bed336e90fe49f295d62","sourceUrl":"https://kenney.nl/assets/ui-audio","license":"CC0-1.0","author":"Kenney"},
  {"id":"tick","name":"가벼운 틱","category":"클릭","duration":0.12,"kind":"click","freq":2800,"file":"../sounds/kenney/tick.wav","bytes":11564,"sha256":"e0cbcb6d4060c2298e102cf065822655c0a95624290b5ab7130fca2f3a770022","sourceUrl":"https://kenney.nl/assets/interface-sounds","license":"CC0-1.0","author":"Kenney"},
  {"id":"switch","name":"스위치","category":"클릭","duration":0.4971041666666667,"kind":"click","freq":700,"file":"../sounds/kenney/switch.wav","bytes":47766,"sha256":"4eb27b734612e47523048daffac882902407f34a5e7dd18dad91a15c1b242d86","sourceUrl":"https://kenney.nl/assets/interface-sounds","license":"CC0-1.0","author":"Kenney"},
  {"id":"shutter","name":"기계 찰칵","category":"클릭","duration":0.44583333333333336,"kind":"shutter","freq":1200,"file":"../sounds/kenney/shutter.wav","bytes":42844,"sha256":"b24f0a0954b3ca8ea2e592d467df632572fdac96a8ff0753a785b2e6f0cc73a5","sourceUrl":"https://kenney.nl/assets/rpg-audio","license":"CC0-1.0","author":"Kenney"},
  {"id":"type","name":"타이핑 클릭","category":"클릭","duration":0.12,"kind":"type","freq":1700,"file":"../sounds/kenney/type.wav","bytes":11564,"sha256":"02e3283792067988e3238bbb2d87ba5d2b896da187dea0e8e01f0dde5d7c4414","sourceUrl":"https://kenney.nl/assets/ui-audio","license":"CC0-1.0","author":"Kenney"},
  {"id":"ding","name":"띠링","category":"알림","duration":0.6922708333333333,"kind":"bell","freq":1046.5,"file":"../sounds/kenney/ding.wav","bytes":66502,"sha256":"b86f5fd367b7258a15ec6cdab092d638539d8a24a0cc264fb9de4946d1d14621","sourceUrl":"https://kenney.nl/assets/interface-sounds","license":"CC0-1.0","author":"Kenney"},
  {"id":"chime","name":"두 음 차임","category":"알림","duration":0.7209166666666667,"kind":"chime","freq":784,"file":"../sounds/kenney/chime.wav","bytes":69252,"sha256":"665b4d4e3f807d9a8dce13e857445743539e63a639005de4b2381671e07cdb7b","sourceUrl":"https://kenney.nl/assets/digital-audio","license":"CC0-1.0","author":"Kenney"},
  {"id":"success","name":"완료","category":"알림","duration":0.5390208333333333,"kind":"success","freq":659.25,"file":"../sounds/kenney/success.wav","bytes":51790,"sha256":"5f761549578809d210701ada009721a83a84bf1a35ff134161ef6e157aefa379","sourceUrl":"https://kenney.nl/assets/interface-sounds","license":"CC0-1.0","author":"Kenney"},
  {"id":"alert","name":"주의","category":"알림","duration":0.12,"kind":"alert","freq":740,"file":"../sounds/kenney/alert.wav","bytes":11564,"sha256":"9d2fca47dc6297abcf2653acadafcfd843fcd6379b669515683dd6e3c5e4cf4d","sourceUrl":"https://kenney.nl/assets/interface-sounds","license":"CC0-1.0","author":"Kenney"},
  {"id":"pop","name":"톡 팝","category":"강조","duration":0.1881875,"kind":"pop","freq":600,"file":"../sounds/kenney/pop.wav","bytes":18110,"sha256":"b54f4ae4e79c0f806be1df090504b733f936149c75cce903ceaf3cd752de85c0","sourceUrl":"https://kenney.nl/assets/interface-sounds","license":"CC0-1.0","author":"Kenney"},
  {"id":"bubble","name":"물방울","category":"강조","duration":0.28379166666666666,"kind":"pop","freq":1100,"file":"../sounds/kenney/bubble.wav","bytes":27288,"sha256":"5be91431297fddd4fe0dbf23030e9f36fb91d207e48a78e5bc6ea87cf249ea68","sourceUrl":"https://kenney.nl/assets/interface-sounds","license":"CC0-1.0","author":"Kenney"},
  {"id":"thump","name":"낮은 쿵","category":"강조","duration":0.5268125,"kind":"thump","freq":85,"file":"../sounds/kenney/thump.wav","bytes":50618,"sha256":"f12e4b1c1f578989014235f3e4b0af92378b9b28f960dc4cc3b1e4b7c63989d1","sourceUrl":"https://kenney.nl/assets/impact-sounds","license":"CC0-1.0","author":"Kenney"},
  {"id":"impact","name":"임팩트","category":"강조","duration":0.6490416666666666,"kind":"impact","freq":120,"file":"../sounds/kenney/impact.wav","bytes":62352,"sha256":"cda8c1b95c53908cba192df73d90da0ad4e750b2fd58c9b6e5e56d90858007ea","sourceUrl":"https://kenney.nl/assets/impact-sounds","license":"CC0-1.0","author":"Kenney"},
  {"id":"boing","name":"통통 바운스","category":"강조","duration":0.4673125,"kind":"boing","freq":260,"file":"../sounds/kenney/boing.wav","bytes":44906,"sha256":"9550ae12cb4584e1f2736805e84885dac831e996524758dedf76e33627296fd6","sourceUrl":"https://kenney.nl/assets/digital-audio","license":"CC0-1.0","author":"Kenney"},
  {"id":"sparkle","name":"반짝 상승","category":"알림","duration":0.5456875,"kind":"sparkle","freq":1300,"file":"../sounds/kenney/sparkle.wav","bytes":52430,"sha256":"9f72dce38bedf4d343acef7c6ca2f9ae0148c84b864a5f05c08e6724dc75d042","sourceUrl":"https://kenney.nl/assets/digital-audio","license":"CC0-1.0","author":"Kenney"},
  {"id":"paper","name":"책장 넘김","category":"전환","duration":0.7686458333333334,"kind":"shutter","freq":950,"file":"../sounds/kenney/paper.wav","bytes":73834,"sha256":"60c2b52d09e05241de5a128c410836ff3fb5f236eaa61c804f24e557529060ee","sourceUrl":"https://kenney.nl/assets/rpg-audio","license":"CC0-1.0","author":"Kenney"},
  {"id":"wood","name":"나무 톡","category":"강조","duration":0.32979166666666665,"kind":"impact","freq":220,"file":"../sounds/kenney/wood.wav","bytes":31704,"sha256":"3ad1f0e0ba06971fc82f5e1b69ace6c413387ff11049d49a54d6721008c42d29","sourceUrl":"https://kenney.nl/assets/impact-sounds","license":"CC0-1.0","author":"Kenney"},
  {"id":"metal","name":"금속 탕","category":"강조","duration":0.16477083333333334,"kind":"bell","freq":430,"file":"../sounds/kenney/metal.wav","bytes":15862,"sha256":"b895d41fbc66d261c6c733a2609d0f034b14ed3e3a15daea1b2b3b671067b5f9","sourceUrl":"https://kenney.nl/assets/impact-sounds","license":"CC0-1.0","author":"Kenney"},
  {"id":"bell","name":"종 울림","category":"알림","duration":1.4801875,"kind":"bell","freq":680,"file":"../sounds/kenney/bell.wav","bytes":142142,"sha256":"2e84f8ce89ca8ef16f8392e177812836a4902f4fce3a05a36cab7e98a4aa1403","sourceUrl":"https://kenney.nl/assets/impact-sounds","license":"CC0-1.0","author":"Kenney"}
];
// 이전 합성 API를 쓰는 코드의 호환용입니다. 기존 프로젝트의 내장 WAV는 바꾸지 않습니다.
export function synthesizeEffect(id,rate=48000) {
  const effect=SOUND_EFFECTS.find(e=>e.id===id);
  if(!effect)throw new Error('효과음을 찾지 못했습니다.');
  if(!Number.isInteger(rate)||rate<8000||rate>96000)throw new Error('샘플 레이트가 올바르지 않습니다.');
  const samples=new Float32Array(Math.round(effect.duration*rate));
  let seed=[...id].reduce((n,c)=>(n*31+c.charCodeAt(0))>>>0,12345),low=0,phase=0,peak=0;
  const tau=2*Math.PI,f=effect.freq,d=effect.duration;
  for(let i=0;i<samples.length;i++){
    const t=i/rate,u=t/d;
    seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;
    const noise=(seed>>>0)/2147483648-1;
    const cutoff=effect.kind==='riser'?300+5500*u:effect.freq+4500*Math.sin(Math.PI*u)**2;
    const coeff=1-Math.exp(-tau*cutoff/rate);low+=coeff*(noise-low);
    const hiss=noise-low;
    let v=0;
    if(effect.kind==='noise')v=(low*.75+hiss*.25)*Math.sin(Math.PI*u)**2;
    else if(effect.kind==='riser'){
      phase+=tau*(f+1300*u*u)/rate;v=(Math.sin(phase)*.25+low*.7)*u*u;
    }else if(effect.kind==='rewind'){
      phase+=tau*(f*(1-u)+100)/rate;v=(Math.sin(phase)*.6+hiss*.18)*Math.sin(Math.PI*u)*(.5+.5*Math.sin(tau*22*t));
    }else if(effect.kind==='click')v=(hiss*.65+Math.sin(tau*f*t)*.35)*Math.exp(-t*65);
    else if(effect.kind==='shutter'){
      const pulse=Math.exp(-t*65)+(t>.075?Math.exp(-(t-.075)*55)*.8:0);
      v=(hiss*.8+Math.sin(tau*f*t)*.2)*pulse;
    }else if(effect.kind==='type'){
      const local=t%.09;v=(hiss*.7+Math.sin(tau*(f+200*Math.floor(t/.09))*local)*.3)*Math.exp(-local*95)*(u<.85?1:0);
    }else if(effect.kind==='bell')v=(Math.sin(tau*f*t)*Math.exp(-t*5)+.35*Math.sin(tau*f*2.76*t)*Math.exp(-t*9));
    else if(effect.kind==='chime'){
      v=Math.sin(tau*f*t)*Math.exp(-t*4);
      if(t>.18)v+=.65*Math.sin(tau*f*1.5*(t-.18))*Math.exp(-(t-.18)*4);
    }else if(effect.kind==='success'){
      const local=t<.18?t:t-.18,freq=t<.18?f:f*1.5;v=Math.sin(tau*freq*local)*Math.exp(-local*7);
    }else if(effect.kind==='alert'){
      const local=t%.2;v=Math.sin(tau*f*t)*Math.exp(-local*18)*(u<.92?1:0);
    }else if(effect.kind==='pop'){
      phase+=tau*(f*Math.exp(-t*16)+90)/rate;v=Math.sin(phase)*Math.exp(-t*18);
    }else if(effect.kind==='thump'||effect.kind==='impact'){
      phase+=tau*(f*Math.exp(-t*10)+38)/rate;v=Math.sin(phase)*Math.exp(-t*7)+noise*Math.exp(-t*30)*(effect.kind==='impact'?.6:.07);
    }else if(effect.kind==='boing'){
      phase+=tau*(f+75*Math.sin(tau*12*t)*Math.exp(-t*4))/rate;v=Math.sin(phase)*Math.exp(-t*5);
    }else if(effect.kind==='sparkle'){
      for(let n=0;n<5;n++){const local=t-n*.13;if(local>=0)v+=Math.sin(tau*f*(1+n*.25)*local)*Math.exp(-local*11)*.5;}
    }
    const edge=Math.min(1,t/.002,(d-t)/.015);
    samples[i]=v*Math.max(0,edge);peak=Math.max(peak,Math.abs(samples[i]));
  }
  const gain=peak>.001?.82/peak:0;
  for(let i=0;i<samples.length;i++)samples[i]*=gain;
  return samples;
}

// 정적 샘플만 읽어 File로 돌려줍니다. 미리보기와 타임라인 추가가 같은 파일을 사용합니다.
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
  if(bytes.byteLength!==effect.bytes||bytes.byteLength<44)throw new Error('효과음 파일이 완전하지 않습니다. 편집기를 새로고침해 주세요.');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(view.getUint32(0)!==0x52494646||view.getUint32(8)!==0x57415645||view.getUint16(20,true)!==1||view.getUint16(22,true)!==1||view.getUint32(24,true)!==48000||view.getUint16(34,true)!==16){
    throw new Error('효과음 파일의 오디오 형식이 올바르지 않습니다.');
  }
  if(globalThis.crypto?.subtle){
    const digest=await crypto.subtle.digest('SHA-256',bytes);
    const actual=[...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('');
    if(actual!==effect.sha256)throw new Error('효과음 파일을 확인하지 못했습니다. 편집기를 새로고침해 주세요.');
  }
  check();
  return new File([bytes],effect.name+' · Kenney SFX.wav',{type:'audio/wav'});
}
