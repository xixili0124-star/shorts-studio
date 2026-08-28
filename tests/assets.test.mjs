// 외부 네트워크 없이 동봉한 원본 고지·메타데이터·PCM 파일을 검증합니다.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {FONTS,ensureFont,ensureFontPreview} from '../public/js/font-catalog.js';
import {SOUND_EFFECTS,createSoundEffect} from '../public/js/sound-effects.js';

const fontRoot=new URL('../public/licenses/google-fonts/',import.meta.url);
const soundRoot=new URL('../public/sounds/',import.meta.url);
const fontSources=JSON.parse(readFileSync(new URL('catalog-sources.json',fontRoot),'utf8'));
const soundSources=JSON.parse(readFileSync(new URL('manifest.json',soundRoot),'utf8'));
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

test('CC0 sound catalog maps every sample to a real package and retained license',()=>{
  assert.ok(SOUND_EFFECTS.length>=15&&SOUND_EFFECTS.length<=25);
  assert.equal(new Set(SOUND_EFFECTS.map(effect=>effect.id)).size,SOUND_EFFECTS.length);
  assert.equal(new Set(SOUND_EFFECTS.map(effect=>effect.sha256)).size,SOUND_EFFECTS.length);
  for(const id of ['whoosh','swish','air','riser','rewind','click','tick','switch','shutter','type','ding','chime','success','alert','pop','bubble','thump','impact','boing','sparkle']){
    assert.ok(SOUND_EFFECTS.some(effect=>effect.id===id));
  }
  for(const pack of soundSources.packages){
    const license=readFileSync(new URL(pack.licenseFile,soundRoot));
    assert.equal(hash(license),pack.licenseSha256);
    assert.match(license.toString(),/CC0/);assert.match(license.toString(),/commercial projects/);
    assert.equal(new URL(pack.downloadUrl).origin,'https://kenney.nl');
    assert.match(pack.archiveSha256,/^[a-f0-9]{64}$/);
  }
  for(const effect of SOUND_EFFECTS){
    const proof=soundSource(effect),pack=soundSources.packages.find(item=>item.id===proof.pack);
    assert.ok(pack);assert.equal(effect.sourceUrl,pack.sourceUrl);
    assert.equal(effect.file,'../sounds/'+proof.file);
    assert.match(proof.file,/^kenney\/[a-z]+\.wav$/);
    assert.equal(effect.license,'CC0-1.0');assert.equal(effect.author,'Kenney');
    assert.match(proof.sourceFile,/^Audio\/.+\.ogg$/);
    assert.match(proof.sourceSha256,/^[a-f0-9]{64}$/);
  }
});

test('all shipped WAV samples decode to bounded non-silent mono PCM with exact durations and hashes',()=>{
  for(const effect of SOUND_EFFECTS){
    const bytes=soundBytes(effect),proof=soundSource(effect);
    assert.equal(bytes.length,effect.bytes);assert.equal(hash(bytes),effect.sha256);
    assert.equal(bytes.toString('ascii',0,4),'RIFF');assert.equal(bytes.readUInt32LE(4),bytes.length-8);
    assert.equal(bytes.toString('ascii',8,12),'WAVE');assert.equal(bytes.toString('ascii',12,16),'fmt ');
    assert.equal(bytes.readUInt32LE(16),16);assert.equal(bytes.readUInt16LE(20),1);
    assert.equal(bytes.readUInt16LE(22),1);assert.equal(bytes.readUInt32LE(24),48000);
    assert.equal(bytes.readUInt32LE(28),96000);assert.equal(bytes.readUInt16LE(32),2);assert.equal(bytes.readUInt16LE(34),16);
    assert.equal(bytes.toString('ascii',36,40),'data');assert.equal(bytes.readUInt32LE(40),bytes.length-44);
    const frames=(bytes.length-44)/2;
    assert.equal(frames,proof.frames);assert.equal(effect.duration,frames/48000);
    assert.ok(effect.duration>=.12&&effect.duration<=3);
    let peak=0,power=0;
    for(let offset=44;offset<bytes.length;offset+=2){const value=bytes.readInt16LE(offset)/32768;peak=Math.max(peak,Math.abs(value));power+=value*value;}
    assert.ok(peak>.05&&peak<.83,effect.id);assert.ok(power/frames>1e-6,effect.id);
    assert.ok(Math.abs(peak-proof.decodedPeak)<1e-8);
    assert.ok(Math.abs(Math.sqrt(power/frames)-proof.decodedRms)<1e-8);
  }
});

async function withFetch(fetcher,run){
  const previous=globalThis.fetch;globalThis.fetch=fetcher;
  try{return await run();}finally{globalThis.fetch=previous;}
}

test('createSoundEffect returns the shipped File and never regenerates a synthetic substitute',async()=>{
  const requested=[];
  await withFetch(async(url,options)=>{
    const effect=SOUND_EFFECTS.find(item=>url.pathname.endsWith('/'+item.id+'.wav'));
    assert.ok(effect);assert.equal(url.searchParams.get('v'),effect.sha256.slice(0,12));
    assert.equal(options.mode,'same-origin');assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');
    requested.push(effect.id);
    return new Response(soundBytes(effect),{headers:{'Content-Length':String(effect.bytes)}});
  },async()=>{
    for(const effect of SOUND_EFFECTS){
      const file=await createSoundEffect(effect.id);
      assert.ok(file instanceof File);assert.equal(file.type,'audio/wav');assert.match(file.name,/Kenney SFX\.wav$/);
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
  const wrongHeader=Buffer.from(original);wrongHeader.write('HTML',0);
  await withFetch(async()=>new Response(wrongHeader),()=>assert.rejects(()=>createSoundEffect(effect.id),/형식/));
  if(globalThis.crypto?.subtle){
    const corrupt=Buffer.from(original);corrupt[100]^=1;
    await withFetch(async()=>new Response(corrupt),()=>assert.rejects(()=>createSoundEffect(effect.id),/확인하지/));
  }
});
