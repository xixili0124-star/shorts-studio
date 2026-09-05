// 외부 네트워크 없이 동봉한 원본 고지·메타데이터·정적 음원 파일을 검증합니다.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {FONTS,ensureFont,ensureFontPreview} from '../public/js/font-catalog.js';
import * as soundEffectModule from '../public/js/sound-effects.js';
import {addDecodedAudioAsset,assets} from '../public/js/project-store.js';

const {SOUND_EFFECTS,createSoundEffect,soundEffectAssetId}=soundEffectModule;

const fontRoot=new URL('../public/licenses/google-fonts/',import.meta.url);
const soundRoot=new URL('../public/sounds/',import.meta.url);
const fontSources=JSON.parse(readFileSync(new URL('catalog-sources.json',fontRoot),'utf8'));
const soundSources=JSON.parse(readFileSync(new URL('manifest.json',soundRoot),'utf8'));
const credits=readFileSync(new URL('../CREDITS.md',import.meta.url),'utf8');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fontSource=font=>fontSources.fonts.find(item=>item.family===font.family);
const soundSource=effect=>soundSources.sounds.find(item=>item.id===effect.id);
const soundBytes=effect=>readFileSync(new URL(soundSource(effect).file,soundRoot));

test('font catalog preserves old families and adds verified Korean and Latin previews',()=>{
  assert.ok(FONTS.length>=50&&FONTS.length<=70);
  assert.equal(new Set(FONTS.map(font=>font.family)).size,FONTS.length);
  assert.equal(new Set(FONTS.map(font=>font.css)).size,FONTS.length);
  assert.equal(fontSources.errors.length,0);
  assert.equal(fontSources.fonts.length,FONTS.length);
  for(const family of ['Noto Sans KR','Nanum Gothic','Gothic A1','IBM Plex Sans KR','Hahmlet','Black Han Sans','Jua','Dongle','Gaegu','East Sea Dokdo']){
    assert.ok(FONTS.some(font=>font.family===family));
  }
  assert.ok(FONTS.filter(font=>font.language==='ko').length>=35);
  assert.ok(FONTS.filter(font=>font.language==='en').length>=20);
  for(const font of FONTS){
    assert.equal(font.css,JSON.stringify(font.family));
    assert.ok(font.label&&font.group&&font.previewText);
    assert.ok(font.previewText.includes(font.label));
    assert.ok(['ko','en'].includes(font.language));
    assert.equal(font.license,'SIL OFL 1.1');
  }
});

test('every font weight and character subset is supported by its pinned official metadata',()=>{
  for(const font of FONTS){
    const proof=fontSource(font);
    assert.ok(proof,font.family);
    const metadata=readFileSync(new URL(proof.slug+'/METADATA.pb',fontRoot));
    const license=readFileSync(new URL(proof.slug+'/OFL.txt',fontRoot));
    assert.equal(hash(metadata),proof.metadataSha256,font.family);
    assert.equal(hash(license),proof.licenseSha256,font.family);
    assert.match(license.toString(),/SIL OPEN FONT LICENSE Version 1\.1|SIL Open Font License/);
    const text=metadata.toString();
    assert.equal(/^name: "([^"]+)"/m.exec(text)[1],font.family);
    assert.ok(text.includes('subsets: "'+(font.language==='ko'?'korean':'latin')+'"'));
    const blocks=[...text.matchAll(/fonts \{(.*?)\n\}/gs)].map(match=>match[1]);
    const normalWeights=blocks.filter(block=>block.includes('style: "normal"')).map(block=>Number(/weight: (\d+)/.exec(block)[1]));
    const weightAxis=[...text.matchAll(/axes \{(.*?)\n\}/gs)].find(match=>match[1].includes('tag: "wght"'));
    const min=weightAxis?Number(/min_value: ([\d.-]+)/.exec(weightAxis[1])[1]):Infinity;
    const max=weightAxis?Number(/max_value: ([\d.-]+)/.exec(weightAxis[1])[1]):-Infinity;
    assert.ok(normalWeights.includes(font.weight)||(font.weight>=min&&font.weight<=max),font.family+' '+font.weight);
    assert.equal(font.licenseUrl,proof.licenseUrl);
    assert.equal(new URL(font.licenseUrl).origin,'https://raw.githubusercontent.com');
    assert.ok(font.licenseUrl.includes('/google/fonts/'+fontSources.revision+'/ofl/'));
  }
});

function fontDocument(){
  const links=[],loads=[];
  return {links,loads,document:{
    fonts:{load(descriptor,text){loads.push({descriptor,text});return Promise.resolve([{}]);}},
    createElement(){return {remove(){this.removed=true;}};},
    head:{append(link){links.push(link);queueMicrotask(()=>link.onload());}},
  }};
}

test('font previews load only requested families and reuse CSS without sending sample text in URLs',async()=>{
  const previous=globalThis.document,fixture=fontDocument();globalThis.document=fixture.document;
  try{
    assert.equal(fixture.links.length,0);
    const font=await ensureFontPreview('Inter');
    assert.equal(font.family,'Inter');
    await ensureFontPreview(font.css);
    assert.equal(fixture.links.length,1);
    assert.equal(fixture.loads.length,2);
    assert.ok(fixture.loads.every(call=>call.text===font.previewText&&call.descriptor.startsWith(font.weight+' ')));
    await ensureFont(font.css,'PRIVATE CAPTION NOT FOR A URL');
    assert.equal(fixture.links.length,1);
    assert.ok(fixture.links.every(link=>!link.href.includes('PRIVATE')&&!link.href.includes('text=')));
    assert.ok(fixture.loads.some(call=>call.text==='PRIVATE CAPTION NOT FOR A URL'));
  }finally{globalThis.document=previous;}
});

test('unknown and already cancelled font previews make no network request',async()=>{
  const previous=globalThis.document,fixture=fontDocument();globalThis.document=fixture.document;
  try{
    await assert.rejects(()=>ensureFontPreview('missing font'),/찾지/);
    const controller=new AbortController();controller.abort();
    await assert.rejects(()=>ensureFontPreview('Caveat',{signal:controller.signal}),error=>error.name==='AbortError');
    assert.equal(fixture.links.length,0);
  }finally{globalThis.document=previous;}
});

test('user sound catalog maps all 37 supplied MP3 files without claiming a license',()=>{
  assert.equal(SOUND_EFFECTS.length,37);
  assert.equal(soundSources.version,3);
  assert.equal(soundSources.origin,'user-supplied');
  assert.equal(soundSources.license,'not-declared');
  assert.equal(soundSources.sounds.length,SOUND_EFFECTS.length);
  assert.equal(new Set(SOUND_EFFECTS.map(effect=>effect.id)).size,SOUND_EFFECTS.length);
  assert.equal(new Set(SOUND_EFFECTS.map(effect=>effect.sha256)).size,SOUND_EFFECTS.length);
  for(const id of ['entrance','delivery-ding','dudung-tak','clear-ding','punch','mouse-click','sparkle','explosion','check-chime','eight-bit-rise','ticking','drum-roll','gta-death','energy-whoosh','complete','gunshot','wow']){
    assert.ok(SOUND_EFFECTS.some(effect=>effect.id===id));
  }
  for(const effect of SOUND_EFFECTS){
    const proof=soundSource(effect);
    assert.ok(proof,effect.id);
    assert.equal(effect.file,'../sounds/'+proof.file);
    assert.match(proof.file,/^user\/[a-z0-9-]+\.mp3$/);
    assert.equal(effect.mime,'audio/mpeg');assert.equal(proof.mime,'audio/mpeg');
    assert.equal(effect.license,'not-declared');assert.equal(proof.license,'not-declared');
    assert.match(proof.sourceName,/\.mp3$/i);
    assert.match(proof.sha256,/^[a-f0-9]{64}$/);
    assert.ok(Number.isInteger(proof.bytes)&&proof.bytes>0);
    assert.ok(Number.isFinite(effect.duration)&&effect.duration>0);
    assert.equal('kind' in effect,false);assert.equal('freq' in effect,false);
  }
  const declared=soundSources.sounds.map(item=>item.file.replace(/^user\//,'')).sort();
  const shipped=readdirSync(new URL('user/',soundRoot)).filter(name=>name.endsWith('.mp3')).sort();
  assert.deepEqual(shipped,declared);
  for(const removed of ['cc0/','kenney/','licenses/'])assert.equal(existsSync(new URL(removed,soundRoot)),false);
  assert.match(soundSources.notice,/권리/);assert.match(credits,/CC0나 무료 상업용 음원으로 표시하지 않습니다/);
});

test('sound library exposes static files only and has no synthesis fallback',()=>{
  assert.equal('synthesizeEffect' in soundEffectModule,false);
  assert.deepEqual(Object.keys(soundEffectModule).sort(),['SOUND_EFFECTS','createSoundEffect','soundEffectAssetId']);
});

test('replacement sounds cannot reuse a legacy asset with the same catalog name',()=>{
  const pcm={length:1,sampleRate:48000,numberOfChannels:1,getChannelData:()=>Float32Array.of(.1)};
  const before=new Map(assets);assets.clear();
  try{
    for(const id of ['shutter','sparkle','pop']){
      const legacy=addDecodedAudioAsset(new File(['old'],id+'.wav',{type:'audio/wav'}),pcm,{id:'builtin-sfx-'+id});
      const key=soundEffectAssetId(id);
      const current=addDecodedAudioAsset(new File(['new'],id+'.mp3',{type:'audio/mpeg'}),pcm,{id:key});
      assert.notEqual(current,legacy);assert.equal(current.file.name,id+'.mp3');
      assert.equal(assets.get(legacy.id),legacy,'이전 타임라인이 사용하던 원본은 그대로 둡니다');
      assert.equal(addDecodedAudioAsset(current.file,pcm,{id:key}),current,'새 음원끼리는 자원을 재사용합니다');
      assert.match(key,/^builtin-sfx-[a-f0-9]{64}$/);assert.ok(key.length<=80);
    }
    assert.throws(()=>soundEffectAssetId('missing'),/찾지/);
  }finally{
    for(const asset of assets.values())if(asset.url)URL.revokeObjectURL(asset.url);
    assets.clear();for(const [id,asset] of before)assets.set(id,asset);
  }
});

function hasMp3Frame(bytes){
  let start=0;
  if(bytes[0]===0x49&&bytes[1]===0x44&&bytes[2]===0x33&&bytes.length>=10){
    const size=((bytes[6]&0x7f)<<21)|((bytes[7]&0x7f)<<14)|((bytes[8]&0x7f)<<7)|(bytes[9]&0x7f);
    start=Math.min(bytes.length,10+size+((bytes[5]&0x10)?10:0));
  }
  const end=Math.min(bytes.length-3,start+65536);
  for(let offset=start;offset<end;offset+=1){
    if(bytes[offset]!==0xff||(bytes[offset+1]&0xe0)!==0xe0)continue;
    const version=(bytes[offset+1]>>3)&3,layer=(bytes[offset+1]>>1)&3,bitrate=(bytes[offset+2]>>4)&15,sampleRate=(bytes[offset+2]>>2)&3;
    if(version!==1&&layer!==0&&bitrate!==0&&bitrate!==15&&sampleRate!==3)return true;
  }
  return false;
}

test('all supplied MP3 samples have exact sizes, hashes, signatures, and durations',()=>{
  for(const effect of SOUND_EFFECTS){
    const bytes=soundBytes(effect),proof=soundSource(effect);
    assert.equal(bytes.length,effect.bytes);assert.equal(hash(bytes),effect.sha256);
    assert.equal(effect.duration,proof.duration);
    assert.ok(effect.duration>=.3&&effect.duration<=8.1,effect.id);
    assert.equal(hasMp3Frame(bytes),true,effect.id);
  }
});

async function withFetch(fetcher,run){
  const previous=globalThis.fetch;globalThis.fetch=fetcher;
  try{return await run();}finally{globalThis.fetch=previous;}
}

test('createSoundEffect returns the supplied MP3 and never regenerates a substitute',async()=>{
  const requested=[];
  await withFetch(async(url,options)=>{
    const effect=SOUND_EFFECTS.find(item=>url.pathname.endsWith('/user/'+item.id+'.mp3'));
    assert.ok(effect);assert.equal(url.searchParams.get('v'),effect.sha256.slice(0,12));
    assert.equal(options.mode,'same-origin');assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');
    requested.push(effect.id);
    return new Response(soundBytes(effect),{headers:{'Content-Length':String(effect.bytes)}});
  },async()=>{
    for(const effect of SOUND_EFFECTS){
      const file=await createSoundEffect(effect.id);
      assert.ok(file instanceof File);assert.equal(file.type,'audio/mpeg');assert.equal(file.name,effect.name+'.mp3');
      assert.deepEqual(Buffer.from(await file.arrayBuffer()),soundBytes(effect));
    }
  });
  assert.equal(requested.length,SOUND_EFFECTS.length);
});

test('sound loading rejects absent files, oversized bodies, corruption, and cancellation',async()=>{
  const effect=SOUND_EFFECTS[0],original=soundBytes(effect);
  await withFetch(async()=>{throw new Error('must not fetch');},async()=>{
    await assert.rejects(()=>createSoundEffect('missing'),/찾지/);
    const controller=new AbortController();controller.abort();
    await assert.rejects(()=>createSoundEffect(effect.id,{signal:controller.signal}),error=>error.name==='AbortError');
  });
  await withFetch(async()=>new Response('',{status:404}),()=>assert.rejects(()=>createSoundEffect(effect.id),/불러오지/));
  await withFetch(async()=>new Response(original,{headers:{'Content-Length':String(effect.bytes+1)}}),()=>assert.rejects(()=>createSoundEffect(effect.id),/크기/));
  await withFetch(async()=>new Response(Buffer.alloc(effect.bytes+1)),()=>assert.rejects(()=>createSoundEffect(effect.id),/크기/));
  await withFetch(async()=>new Response(original.subarray(0,100)),()=>assert.rejects(()=>createSoundEffect(effect.id),/완전하지/));
  const wrongHeader=Buffer.alloc(effect.bytes);
  await withFetch(async()=>new Response(wrongHeader),()=>assert.rejects(()=>createSoundEffect(effect.id),/형식/));
  if(globalThis.crypto?.subtle){
    const corrupt=Buffer.from(original);corrupt[100]^=1;
    await withFetch(async()=>new Response(corrupt),()=>assert.rejects(()=>createSoundEffect(effect.id),/확인하지/));
  }
});
