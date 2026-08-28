// 외부 음원·밈을 샘플링하지 않은 절차적 합성 효과음입니다. 네트워크/API가 필요 없습니다.
export const SOUND_EFFECTS = [
  {id:'whoosh',name:'스우시',category:'전환',duration:.65,kind:'noise',freq:700},
  {id:'swish',name:'짧은 휙',category:'전환',duration:.32,kind:'noise',freq:1800},
  {id:'air',name:'공기 스윕',category:'전환',duration:.9,kind:'noise',freq:350},
  {id:'riser',name:'긴장 상승',category:'전환',duration:1.4,kind:'riser',freq:180},
  {id:'rewind',name:'되감기',category:'전환',duration:.7,kind:'rewind',freq:900},
  {id:'click',name:'딸깍',category:'클릭',duration:.12,kind:'click',freq:1800},
  {id:'tick',name:'가벼운 틱',category:'클릭',duration:.1,kind:'click',freq:2800},
  {id:'switch',name:'스위치',category:'클릭',duration:.18,kind:'click',freq:700},
  {id:'shutter',name:'찰칵',category:'클릭',duration:.28,kind:'shutter',freq:1200},
  {id:'type',name:'타이핑',category:'클릭',duration:.52,kind:'type',freq:1700},
  {id:'ding',name:'띠링',category:'알림',duration:1.15,kind:'bell',freq:1046.5},
  {id:'chime',name:'맑은 차임',category:'알림',duration:1.6,kind:'chime',freq:784},
  {id:'success',name:'완료',category:'알림',duration:.8,kind:'success',freq:659.25},
  {id:'alert',name:'주의',category:'알림',duration:.6,kind:'alert',freq:740},
  {id:'pop',name:'톡 팝',category:'강조',duration:.24,kind:'pop',freq:600},
  {id:'bubble',name:'물방울',category:'강조',duration:.4,kind:'pop',freq:1100},
  {id:'thump',name:'낮은 쿵',category:'강조',duration:.55,kind:'thump',freq:85},
  {id:'impact',name:'임팩트',category:'강조',duration:.85,kind:'impact',freq:120},
  {id:'boing',name:'통통 바운스',category:'강조',duration:.9,kind:'boing',freq:260},
  {id:'sparkle',name:'반짝임',category:'알림',duration:1.25,kind:'sparkle',freq:1300},
];
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
export function createSoundEffect(id) {
  const effect=SOUND_EFFECTS.find(e=>e.id===id),rate=48000,samples=synthesizeEffect(id,rate);
  const bytes=new ArrayBuffer(44+samples.length*2),view=new DataView(bytes);
  const str=(at,s)=>[...s].forEach((c,i)=>view.setUint8(at+i,c.charCodeAt(0)));
  str(0,'RIFF');view.setUint32(4,36+samples.length*2,true);str(8,'WAVE');str(12,'fmt ');
  view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);
  view.setUint32(24,rate,true);view.setUint32(28,rate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);
  str(36,'data');view.setUint32(40,samples.length*2,true);
  for(let i=0;i<samples.length;i++)view.setInt16(44+i*2,Math.round(samples[i]*32767),true);
  return new File([bytes],effect.name+' · Studio SFX.wav',{type:'audio/wav'});
}
