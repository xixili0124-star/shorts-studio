import {canUsePcEngine,isLoopbackEditor,isPcSupportedSite,savedPcConnection,pcConnectionStatus,connectPc,disconnectPc,PC_SETUP_DOWNLOAD} from './pc-connection.js';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export class PcHelpController {
  constructor({onChange=()=>{},toast=()=>{}}={}){
    this.onChange=onChange;this.toast=toast;this.status=null;this.message='';this.busy=false;
    this.host=document.getElementById('pcHelp');
    this.host?.addEventListener?.('click',event=>{
      const action=event.target.closest('[data-pc-help]')?.dataset.pcHelp;if(!action)return;
      if(action==='check')this.check();
      if(action==='disconnect')this.disconnect();
      if(action==='cancel'){this.controller?.abort();}
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
    const engines=this.status?.engines,paired=!!savedPcConnection(),local=isLoopbackEditor();
    const row=(title,value)=>{const ready=value?.available===true||value?.state==='ready';return '<div class="pc-install-row"><span>'+title+'</span><strong data-ready="'+ready+'">'+(ready?'준비됨':value?.state==='starting'?'시작 중':value?.busy?'사용 중':value?.configured?'설치됨 · 확인 필요':'설치 필요')+'</strong></div>';};
    this.host.innerHTML='<div class="pc-help-heading"><span class="local-badge">PC 확장</span><h3>한 번 설치하고, 이 화면에서 계속.</h3></div>'
      +'<p class="note">Windows PC에 설치하면 공개 사이트에서도 내 목소리·고정밀 자막·SAM 추적을 사용할 수 있어요. 원고와 영상은 외부 AI 서버로 보내지 않습니다.</p>'
      +'<ol class="pc-install-steps"><li><strong>설치 파일 받기</strong><p>기존 모델과 등록한 목소리는 다시 받거나 지우지 않습니다.</p><a class="button secondary" href="'+PC_SETUP_DOWNLOAD+'" download="Shorts-Studio-PC-Setup.cmd">Windows PC 설치 파일 다운로드</a></li>'
      +'<li><strong>받은 파일을 한 번 실행</strong><p>필요한 엔진과 모델을 설치하고 PC 연결 프로그램을 켭니다. 첫 다운로드는 수 GB이며 시간이 걸릴 수 있어요. Windows 로그인 때 자동 실행은 설치 중 직접 선택합니다.</p></li>'
      +'<li><strong>설치 확인</strong><p>처음에는 브라우저의 로컬 네트워크 권한과 PC 확인 창에서 연결을 허용하세요. 이후 새로고침·브라우저 재시작에도 연결과 설치 위치를 기억합니다.</p><button class="button primary" data-pc-help="check" '+(this.busy?'disabled':'')+'>'+(this.busy?'연결 확인 중…':'설치 확인 · PC 연결')+'</button>'+(this.busy?'<button class="button subtle" data-pc-help="cancel">취소</button>':'')+'</li></ol>'
      +'<div class="pc-help-status" role="status" aria-live="polite">'+esc(this.message||(engines?'PC 연결됨'+(local?' · 로컬 편집기':' · 이 사이트 승인됨'):'아직 설치 상태를 확인하지 않았습니다.'))+'</div>'
      +(engines?'<div class="pc-install-engines">'+row('VoxCPM2 · 내 목소리',engines.voice)+row('Whisper large-v3-turbo · 자막',engines.asr)+row('SAM 2.1 Small · 추적',engines.tracking)+'</div>':'')
      +(paired?'<button class="button subtle" data-pc-help="disconnect" '+(this.busy?'disabled':'')+'>이 사이트의 PC 연결 해제</button>':'')
      +'<p class="inspector-note">브라우저는 설치 파일을 자동 실행하거나 PC 폴더를 임의로 검색하지 않습니다. 설치한 연결 프로그램이 등록 경로를 확인합니다. PC 재부팅 뒤 연결이 꺼져 있으면 Windows 시작 메뉴의 Shorts Studio PC를 실행하세요. 모바일은 브라우저 모델을 사용합니다.</p>'
      +'<details class="smart-details"><summary>엔진별 설치·문제 해결 안내</summary><p><a href="/pc-voice-setup.html" target="_blank" rel="noopener">내 목소리</a> · <a href="/pc-asr-setup.html" target="_blank" rel="noopener">고정밀 자동 자막</a> · <a href="/pc-tracking-setup.html" target="_blank" rel="noopener">SAM 추적</a></p></details>';
  }
  async check(explicit=true){
    if(this.busy)return;
    if(!isPcSupportedSite()){this.message='정식 Shorts Studio 사이트 또는 로컬 PC 편집기에서 연결해 주세요.';this.render();return;}
    this.busy=true;this.controller=new AbortController();this.message='설치된 PC 연결 프로그램을 확인하는 중…';this.render();
    try{
      if(canUsePcEngine()){
        try{this.status=await pcConnectionStatus({signal:this.controller.signal});}
        catch(error){if(!explicit||!savedPcConnection()||error.code!=='PC_CONNECTION_REQUIRED')throw error;this.status=await this.connect();}
      }else if(explicit)this.status=await this.connect();else return;
      this.message='PC 연결됨 · 설치 위치와 이 브라우저의 승인을 기억합니다.';
      this.onChange(this.status);
    }catch(error){this.status=null;this.message=error.name==='AbortError'?'연결 확인을 취소했습니다.':error.message;}
    finally{this.busy=false;this.controller=null;this.render();}
  }
  connect(){return connectPc({signal:this.controller.signal,onProgress:message=>{this.message=message;this.render();}});}
  async disconnect(){
    if(this.busy)return;this.busy=true;this.render();
    try{await disconnectPc();this.status=null;this.message='이 사이트의 PC 연결을 해제했습니다. 설치된 모델과 목소리는 유지합니다.';this.onChange(null);}
    catch(error){this.message=error.message;}finally{this.busy=false;this.render();}
  }
}
