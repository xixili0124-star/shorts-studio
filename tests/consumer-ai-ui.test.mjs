import test from 'node:test';
import assert from 'node:assert/strict';
import {StudioTools} from '../public/js/studio-tools.js';
import {downloadPcSetup,downloadPcVoiceSetup,pcSetupPlatform,pcVoiceSetupRequested,rememberPcVoiceSetupRequest,forgetPcVoiceSetupRequest,PC_SETUP_DOWNLOAD,PC_VOICE_SETUP_DOWNLOAD} from '../public/js/pc-connection.js';

const loopback={protocol:'http:',hostname:'127.0.0.1',origin:'http://127.0.0.1:8791'};
const unsupported={protocol:'https:',hostname:'example.com',origin:'https://example.com'};
const site={protocol:'https:',hostname:'shorts-studio-75p.pages.dev',origin:'https://shorts-studio-75p.pages.dev'};
const memoryStorage=()=>{const values=new Map();return{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key)};};

test('the setup download uses one fixed same-origin file and cleans up its temporary link',()=>{
  const calls=[];
  const link={href:'',download:'',hidden:false,rel:'',click(){calls.push(['click',this.href,this.download]);},remove(){calls.push(['remove']);}};
  const documentImpl={createElement(tag){assert.equal(tag,'a');return link;},body:{append(value){assert.equal(value,link);calls.push(['append']);}}};
  assert.equal(downloadPcSetup(documentImpl),true);
  assert.equal(link.href,PC_SETUP_DOWNLOAD);assert.equal(link.download,'Shorts-Studio-Setup.cmd');assert.equal(link.rel,'noopener');assert.equal(link.hidden,true);
  assert.deepEqual(calls,[['append'],['click',PC_SETUP_DOWNLOAD,'Shorts-Studio-Setup.cmd'],['remove']]);
});

test('the custom-voice download is Windows-only and uses its dedicated setup file',()=>{
  const calls=[];
  const link={href:'',download:'',hidden:false,rel:'',click(){calls.push(['click',this.href,this.download]);},remove(){calls.push(['remove']);}};
  const documentImpl={createElement(){calls.push(['create']);return link;},body:{append(){calls.push(['append']);}}};
  const windows={platform:'Win32',userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'};
  assert.equal(downloadPcVoiceSetup(documentImpl,windows),true);
  assert.equal(link.href,PC_VOICE_SETUP_DOWNLOAD);assert.equal(link.download,'Shorts-Studio-Voice-Setup.cmd');
  assert.deepEqual(calls,[['create'],['append'],['click',PC_VOICE_SETUP_DOWNLOAD,'Shorts-Studio-Voice-Setup.cmd'],['remove']]);
  for(const navigatorImpl of [
    {platform:'MacIntel',userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'},
    {platform:'Linux armv8l',userAgent:'Mozilla/5.0 (Linux; Android 15) Mobile'},
    {platform:'MacIntel',maxTouchPoints:5,userAgent:'Mozilla/5.0 (Macintosh)'},
  ])assert.equal(downloadPcVoiceSetup({createElement(){throw new Error('must not create a download');}},navigatorImpl),false);
  assert.equal(pcSetupPlatform(windows),'windows');
});

test('a missing custom-voice feature opens one generic consent dialog without implementation labels',async()=>{
  const saved=globalThis.location;globalThis.location=unsupported;
  const owner=Object.assign(Object.create(StudioTools.prototype),{
    navigator:{platform:'Win32',userAgent:'Windows'},
    pcVoice:{status:null,error:'',checking:false,profileId:'',accepted:false},
    open(title,html){this.opened={title,html};},
  });
  try{
    await owner.beginPcVoiceAction('register');
    assert.equal(owner.state.kind,'voice-setup');assert.equal(owner.state.next,'register');
    assert.match(owner.opened.html,/data-smart-action="confirm-voice-setup"[^>]*>동의/);
    assert.match(owner.opened.html,/data-smart-action="cancel"[^>]*>취소/);
    assert.doesNotMatch(owner.opened.html,/Vox|Whisper|GPT|모델|엔진|PC 연결|도움말/);
  }finally{globalThis.location=saved;}
});

test('agreeing to prepare custom voice starts the supported download without claiming installation',async()=>{
  const saved={location:globalThis.location,document:globalThis.document,localStorage:globalThis.localStorage};globalThis.location=unsupported;globalThis.localStorage=memoryStorage();
  const calls=[];const link={click(){calls.push('download');},remove(){calls.push('remove');}};
  globalThis.document={createElement(){return link;},body:{append(){calls.push('append');}}};
  const owner=Object.assign(Object.create(StudioTools.prototype),{
    navigator:{platform:'Win32',userAgent:'Windows'},
    state:{kind:'voice-setup',next:'register'},pcVoice:{status:null,error:'',checking:false},
    pcHelp:{async check(){throw new Error('must not pair before download');}},setBody(html){this.bodyHtml=html;},progress(){},
  });
  try{
    await owner.confirmPcVoiceSetup();
    assert.deepEqual(calls,['append','download','remove']);
    assert.equal(pcVoiceSetupRequested(globalThis.localStorage),true);
    assert.match(owner.bodyHtml,/준비 파일을 받기 시작/);assert.match(owner.bodyHtml,/자동으로 실행할 수 없/);
    assert.match(owner.bodyHtml,/Shorts-Studio-Voice-Setup\.cmd/);assert.doesNotMatch(owner.bodyHtml,/Shorts-Studio-PC-Setup\.cmd/);
    assert.doesNotMatch(owner.bodyHtml,/설치가 완료|자동 설치|Vox|모델|엔진|PC 연결/);
  }finally{Object.assign(globalThis,saved);}
});

test('a recent voice setup request reconnects only on the next explicit voice action',async()=>{
  const saved={location:globalThis.location,localStorage:globalThis.localStorage};globalThis.location=site;globalThis.localStorage=memoryStorage();
  rememberPcVoiceSetupRequest(globalThis.localStorage);
  const calls=[];const owner=Object.assign(Object.create(StudioTools.prototype),{
    navigator:{platform:'Win32',userAgent:'Windows'},pcVoice:{status:null,error:'',checking:false,profileId:'',accepted:false},
    open(){calls.push('open');},setBody(){},progress(){},close(){calls.push('close');},
    pcHelp:{async check(explicit,options){calls.push(['check',explicit,options.pairStartTimeoutMs]);return{};}},
    async refreshPcVoice(){this.pcVoice.status={localServer:true,configured:true,state:'ready',profiles:[]};},
    continuePcVoiceAction(next){calls.push(['continue',next]);},
  });
  try{
    await owner.beginPcVoiceAction('register');
    assert.deepEqual(calls,['open',['check',true,15000],'close',['continue','register']]);
    assert.equal(pcVoiceSetupRequested(globalThis.localStorage),false);
  }finally{Object.assign(globalThis,saved);}
});

test('voice setup request markers expire and can be cleared',()=>{
  const storage=memoryStorage(),week=7*24*60*60*1000;
  rememberPcVoiceSetupRequest(storage,1000);
  assert.equal(pcVoiceSetupRequested(storage,1001),true);
  assert.equal(pcVoiceSetupRequested(storage,1000+week),false);
  forgetPcVoiceSetupRequest(storage);assert.equal(pcVoiceSetupRequested(storage,1001),false);
});

test('mobile and Mac custom voice offers the basic voice without creating a cmd download',async()=>{
  for(const navigator of [{platform:'MacIntel',userAgent:'Macintosh'},{platform:'Linux armv8l',userAgent:'Android Mobile'}]){
    const owner=Object.assign(Object.create(StudioTools.prototype),{
      navigator,pcVoice:{status:null,error:'',checking:false,profileId:'',accepted:false},
      open(title,html){this.opened={title,html};},
    });
    await owner.beginPcVoiceAction('register');
    assert.equal(owner.state.kind,'voice-unavailable');assert.match(owner.opened.html,/기본 음성 사용/);
    assert.doesNotMatch(owner.opened.html,/\.cmd|다운로드|data-smart-action="confirm-voice-setup"/);
  }
});

test('an installed custom-voice feature is discovered and opens registration directly',async()=>{
  const saved=globalThis.location;globalThis.location=loopback;let opened=0;
  const owner=Object.assign(Object.create(StudioTools.prototype),{
    pcVoice:{status:{localServer:true,configured:true,state:'ready',profiles:[]},checking:false},
    openVoiceReference(){opened++;},
  });
  try{await owner.beginPcVoiceAction('register');assert.equal(opened,1);assert.equal(owner.state,undefined);}
  finally{globalThis.location=saved;}
});

test('an explicitly chosen PC caption path waits for readiness instead of switching modes',async()=>{
  const saved=globalThis.location;globalThis.location=loopback;
  const owner=Object.assign(Object.create(StudioTools.prototype),{
    captionScope:'selected',captionEngine:'pc',dialog:{open:false},
    pcAsr:{status:{available:false,busy:false},checking:false},
    audioRange:()=>({type:'audio',id:'voice',start:0,duration:1,item:{name:'말소리'}}),
    open(title,html){this.dialog.open=true;this.opened={title,html};},async run(){},async refreshPcAsr(){},
  });
  try{
    await assert.rejects(()=>owner.openCaptions(),/이 PC에서 지금 자막을 만들 수 없습니다/);assert.equal(owner.captionEngine,'pc');assert.equal(owner.dialog.open,false);
    owner.pcAsr.status={available:true,busy:false};await owner.openCaptions();assert.equal(owner.state.engine,'pc');assert.equal(owner.opened.title,'자동 자막 만들기');
    assert.doesNotMatch(owner.opened.html,/Whisper|Tiny|large-v3|GPU|CUDA|PC 연결|도움말/);
  }finally{globalThis.location=saved;}
});

test('PC caption failures remain visible without secretly starting a browser model',async()=>{
  const saved={location:globalThis.location,fetch:globalThis.fetch,Worker:globalThis.Worker};globalThis.location=loopback;
  const samples=new Float32Array(16000).fill(.1),buffer={sampleRate:16000,length:samples.length,numberOfChannels:1,getChannelData:()=>samples};
  let workerStarts=0;globalThis.fetch=async()=>{throw new TypeError('preferred path unavailable');};
  globalThis.Worker=class{constructor(){workerStarts++;throw new Error('must not start browser fallback');}};
  const owner=Object.assign(Object.create(StudioTools.prototype),{
    captionScope:'selected',captionEngine:'pc',dialog:{open:false},
    pcAsr:{status:{available:true,busy:false},checking:false},
    audioRange:()=>({type:'audio',id:'voice',start:2,duration:1,item:{name:'말소리',buffer,trimStart:0,trimEnd:1}}),
    open(){this.dialog.open=true;},setBody(html){this.review=html;},progress(){},
    async run(kind,work){return work(new AbortController().signal);},async refreshPcAsr(){},
  });
  try{
    await assert.rejects(()=>owner.openCaptions());assert.equal(owner.state.engine,'pc');assert.equal(workerStarts,0);assert.equal(owner.review,undefined);
  }finally{Object.assign(globalThis,saved);}
});

test('online captions send only after explicit consent and identify the returned result correctly',async()=>{
  const saved={location:globalThis.location,fetch:globalThis.fetch,confirm:globalThis.confirm,Worker:globalThis.Worker};globalThis.location=unsupported;
  const samples=new Float32Array(16000).fill(.1),buffer={sampleRate:16000,length:samples.length,numberOfChannels:1,getChannelData:()=>samples};
  let accepted=false,requests=0,confirmations=0,workerStarts=0;
  globalThis.confirm=message=>{confirmations++;assert.match(message,/선택한 구간의 소리만.*Cloudflare/);assert.match(message,/영상 파일은 보내지 않습니다/);return accepted;};
  globalThis.fetch=async(url,options)=>{requests++;assert.match(url,/workers\.dev/);assert.equal(options.body.get('audio').type,'audio/wav');return new Response(JSON.stringify({segments:[{start:.1,end:.8,text:'안녕하세요.'}],text:'안녕하세요.'}),{status:200});};
  globalThis.Worker=class{constructor(){workerStarts++;throw new Error('must not start browser fallback');}};
  const owner=Object.assign(Object.create(StudioTools.prototype),{
    captionScope:'selected',captionEngine:'server',dialog:{open:false},pcAsr:{status:null,checking:false},
    audioRange:()=>({type:'audio',id:'voice',start:2,duration:1,item:{name:'말소리',buffer,trimStart:0,trimEnd:1}}),
    open(title,html){this.dialog.open=true;this.opened={title,html};},setBody(html){this.review=html;},progress(){},
    async run(kind,work){return work(new AbortController().signal);},
  });
  try{
    await owner.openCaptions();assert.equal(confirmations,1);assert.equal(requests,0);assert.equal(owner.dialog.open,false);assert.equal(owner.state,undefined);
    accepted=true;await owner.openCaptions();assert.equal(confirmations,2);assert.equal(requests,1);assert.equal(owner.state.engine,'server');
    assert.equal(owner.state.captions[0].start,2.1);assert.equal(owner.state.captions[0].generated,'server-whisper');
    assert.match(owner.review,/온라인에서 처리한 자막/);assert.doesNotMatch(owner.review,/브라우저에서 처리한 자막|Whisper|Tiny|large-v3|GPU|CUDA/);
    globalThis.fetch=async()=>{throw new TypeError('server offline');};await assert.rejects(()=>owner.openCaptions(),/server offline/);assert.equal(workerStarts,0);assert.equal(owner.state.engine,'server');
  }finally{Object.assign(globalThis,saved);}
});
