import {canUsePcEngine,isLoopbackEditor,isPcSupportedSite,savedPcConnection,pcConnectionStatus,connectPc,disconnectPc,pcSetupPlatform,PC_SETUP_DOWNLOAD} from './pc-connection.js';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export class PcHelpController {
  constructor({onChange=()=>{},toast=()=>{},navigatorImpl=globalThis.navigator}={}){
    this.onChange=onChange;this.toast=toast;this.navigator=navigatorImpl;this.status=null;this.message='';this.busy=false;
    this.host=document.getElementById('pcHelp');
    this.host?.addEventListener?.('click',event=>{
      const action=event.target.closest('[data-pc-help]')?.dataset.pcHelp;if(!action)return;
      if(action==='check')this.check();
      if(action==='disconnect')this.disconnect();
      if(action==='cancel')this.controller?.abort();
    });
    this.render();
  }
  show(){
    const dialog=document.getElementById('helpDialog');if(!dialog.open)dialog.showModal();
    dialog.scrollTop=0;
    if(canUsePcEngine()&&!this.busy)this.check(false);
  }
  render(){
    if(!this.host)return;
    const engines=this.status?.engines,paired=!!savedPcConnection(),local=isLoopbackEditor(),windows=pcSetupPlatform(this.navigator)==='windows';
    const row=(title,value)=>{const ready=value?.available===true||value?.state==='ready';return '<div class="pc-install-row"><span>'+title+'</span><strong data-ready="'+ready+'">'+(ready?'준비됨':value?.state==='starting'?'시작 중':value?.busy?'사용 중':value?.configured?'준비 중':'준비 필요')+'</strong></div>';};
    this.host.innerHTML='<div class="pc-help-heading"><h3>추가 기능 준비</h3></div>'
      +'<p class="note">내 목소리와 더 정밀한 편집 기능은 Windows에서 처음 한 번 준비하면 이후 자동으로 찾아 실행합니다.</p>'
      +(windows?'<div class="pc-voice-actions"><a class="button secondary" href="'+PC_SETUP_DOWNLOAD+'" download="Shorts-Studio-Setup.cmd">준비 파일 받기</a><button class="button primary" data-pc-help="check" '+(this.busy?'disabled':'')+'>'+(this.busy?'확인 중…':'준비 상태 확인')+'</button>'+(this.busy?'<button class="button subtle" data-pc-help="cancel">취소</button>':'')+'</div>':'')
      +'<div class="pc-help-status" role="status" aria-live="polite">'+esc(this.message||(engines?'이 기기에서 사용할 준비가 됐습니다'+(local?'':' · 사용 승인됨'):'필요할 때 기능 화면에서 바로 준비할 수도 있습니다.'))+'</div>'
      +(engines?'<div class="pc-install-engines">'+row('내 목소리',engines.voice)+row('자동 자막',engines.asr)+row('대상 추적',engines.tracking)+'</div>':'')
      +(paired?'<button class="button subtle" data-pc-help="disconnect" '+(this.busy?'disabled':'')+'>이 기기 사용 해제</button>':'')
      +'<p class="inspector-note">'+(windows?'브라우저 보안상 받은 파일은 자동으로 실행할 수 없습니다. 다운로드가 끝나면 파일을 한 번 실행해 주세요.':'Windows PC 전용 준비 파일은 이 기기에 내려받지 않습니다. 모바일과 Mac에서는 기본 기능을 사용해 주세요.')+'</p>';
  }
  async check(explicit=true,{pairStartTimeoutMs}={}){
    if(this.busy)return this.status;
    if(!isPcSupportedSite()){this.message='현재 기기에서는 이 기능을 준비할 수 없습니다.';this.render();return null;}
    this.busy=true;this.controller=new AbortController();this.message='이 기기의 준비 상태를 확인하는 중…';this.render();
    try{
      if(canUsePcEngine()){
        try{this.status=await pcConnectionStatus({signal:this.controller.signal});}
        catch(error){if(!explicit||!savedPcConnection()||error.code!=='PC_CONNECTION_REQUIRED')throw error;this.status=await this.connect(pairStartTimeoutMs);}
      }else if(explicit)this.status=await this.connect(pairStartTimeoutMs);else return null;
      this.message='준비가 끝났습니다. 다음부터 자동으로 확인합니다.';
      this.onChange(this.status);
    }catch(error){this.status=null;this.message=error.name==='AbortError'?'확인을 취소했습니다.':error.message;}
    finally{this.busy=false;this.controller=null;this.render();}
    return this.status;
  }
  connect(pairStartTimeoutMs){return connectPc({signal:this.controller.signal,pairStartTimeoutMs,onProgress:message=>{this.message=message;this.render();}});}
  async disconnect(){
    if(this.busy)return;this.busy=true;this.render();
    try{await disconnectPc();this.status=null;this.message='이 사이트의 기기 사용을 해제했습니다. 설치된 파일과 목소리는 유지합니다.';this.onChange(null);}
    catch(error){this.message=error.message;}finally{this.busy=false;this.render();}
  }
}
