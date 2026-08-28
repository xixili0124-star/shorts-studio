import { keyframeValue } from './keyframes.js';
export const volumeAt=(item,time)=>Math.max(0,Math.min(3,keyframeValue(item,'volume',time)));
export const hasAudibleVolume=item=>(item.volume??1)>0||item.keyframes?.tracks?.volume?.some(key=>key.value>0);

/** 음량과 페이드를 별도 노드로 곱해 키 사이 보간을 내보내기에도 그대로 적용합니다. */
export function automateVolume(param,item,start,duration,multiplier=1) {
  const keys=item.keyframes?.tracks?.volume;
  param.setValueAtTime(volumeAt(item,0)*multiplier,start);
  if(!keys?.length)return;
  let previous=keys[0];
  for(const key of keys){
    if(key.time<=0){previous=key;continue;}
    const at=Math.min(duration,key.time),value=volumeAt(item,at)*multiplier;
    if(previous.easing==='hold'){
      param.setValueAtTime(previous.value*multiplier,start+at);
      if(key.time<=duration)param.setValueAtTime(key.value*multiplier,start+key.time);
    }else param.linearRampToValueAtTime(value,start+at);
    previous=key;if(key.time>=duration)break;
  }
}

/** 미디어 요소의 volume 상한은 1이므로 실제 증폭은 GainNode가 담당합니다. */
export class PreviewAudioGain {
  constructor(onError=()=>{}){this.context=null;this.routes=new WeakMap();this.onError=onError;this.reported=false;}
  resume(){
    try{
      const Context=globalThis.AudioContext||globalThis.webkitAudioContext;
      if(!Context)return Promise.resolve();
      this.context??=new Context();
      return this.context.state==='suspended'?this.context.resume():Promise.resolve();
    }catch(error){this.report(error);return Promise.resolve();}
  }
  report(error){if(!this.reported){this.reported=true;this.onError('미리듣기 증폭을 시작하지 못했습니다. 재생을 다시 눌러 주세요. '+(error?.message||''));}}
  set(element,gain){
    const value=Number.isFinite(gain)?Math.max(0,Math.min(3,gain)):0;
    if(!this.context?.createMediaElementSource){element.volume=Math.min(1,value);return;}
    try{
      let route=this.routes.get(element);
      if(!route){
        const source=this.context.createMediaElementSource(element),node=this.context.createGain();
        source.connect(node);node.connect(this.context.destination);route={source,node,connected:true};this.routes.set(element,route);
      }else if(!route.connected){route.source.connect(route.node);route.node.connect(this.context.destination);route.connected=true;}
      element.volume=1;route.node.gain.value=value;
    }catch(error){element.volume=Math.min(1,value);this.report(error);}
  }
  disconnect(element){
    const route=this.routes.get(element);if(!route?.connected)return;
    route.source.disconnect();route.node.disconnect();route.connected=false;
  }
}
