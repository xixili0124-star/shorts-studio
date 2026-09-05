import test from 'node:test';
import assert from 'node:assert/strict';
import { addDecodedAudioAsset, assets, captureDocument, History, makeClip, packProject, removeAssetFromLibrary, restoreDocument, unusedLibraryAssetIds } from '../public/js/project-store.js';
import { project } from '../public/js/state.js';

const defaults=structuredClone(project);
const reset=()=>{assets.clear();Object.assign(project,structuredClone(defaults));};
const file=(name,type='image/png')=>new File(['library payload'],name,{type});
const asset=(id,extra={})=>({id,kind:'image',file:file(id+'.png'),...extra});
const packedMetadata=async()=>{
  const packed=packProject(),head=await packed.slice(0,12).arrayBuffer();
  const length=new DataView(head).getUint32(8,true);
  return JSON.parse(await packed.slice(12,12+length).text());
};

test('unused library files are physically removed and their object URL is released',()=>{
  reset();const original=URL.revokeObjectURL,revoked=[];
  URL.revokeObjectURL=value=>revoked.push(value);
  try{
    assets.set('unused',{id:'unused',kind:'audio',file:file('unused.wav','audio/wav'),url:'blob:unused'});
    const result=removeAssetFromLibrary('unused');
    assert.deepEqual(result,{ok:true,hidden:false,removed:true,instances:0,dependents:0,removedIds:['unused']});
    assert.equal(assets.has('unused'),false);assert.deepEqual(revoked,['blob:unused']);
  }finally{URL.revokeObjectURL=original;}
});

test('removing an unused file frees one of the 200 library slots',()=>{
  reset();for(let index=0;index<200;index++)assets.set('asset-'+index,asset('asset-'+index));
  removeAssetFromLibrary('asset-0');
  const pcm={length:1,sampleRate:48000,numberOfChannels:1,getChannelData:()=>Float32Array.of(0)};
  addDecodedAudioAsset(file('replacement.wav','audio/wav'),pcm,{id:'replacement'});
  assert.equal(assets.size,200);assert.ok(assets.has('replacement'));
});

test('undo-retained hidden files count toward the save-compatible 200 file limit',()=>{
  reset();for(let index=0;index<200;index++)assets.set('hidden-'+index,asset('hidden-'+index,{libraryHidden:true}));
  const history=new History();history.past=[{label:'이전 편집',doc:{clips:[],tracks:[...assets.keys()].map((assetId,index)=>({id:'old-'+index,assetId}))}}];
  const pcm={length:1,sampleRate:48000,numberOfChannels:1,getChannelData:()=>Float32Array.of(0)};
  assert.throws(()=>addDecodedAudioAsset(file('overflow.wav','audio/wav'),pcm,{id:'overflow'}),/실행 취소 기록.*200개/);
  assert.equal(assets.size,200);assert.equal(assets.has('overflow'),false);
});

test('clearing history releases hidden files that no remaining document can restore',()=>{
  reset();const original=URL.revokeObjectURL,revoked=[];URL.revokeObjectURL=value=>revoked.push(value);
  try{
    assets.set('history-only',{id:'history-only',kind:'audio',file:file('history.wav','audio/wav'),url:'blob:history',libraryHidden:true});
    const history=new History();history.past=[{label:'old clip',doc:{clips:[],tracks:[{assetId:'history-only'}]}}];
    history.clear();assert.equal(assets.has('history-only'),false);assert.deepEqual(revoked,['blob:history']);
  }finally{URL.revokeObjectURL=original;}
});

test('files used directly or indirectly by the timeline are hidden without breaking clips',()=>{
  reset();
  const video=asset('video',{kind:'video'}),audio=asset('audio',{kind:'audio',sourceVideoAudio:true,sourceVideoAssetId:'video'});
  assets.set(video.id,video);assets.set(audio.id,audio);
  project.clips=[{id:'clip',assetId:'video',sourceAudioAssetId:'audio'}];
  const audioResult=removeAssetFromLibrary('audio');
  assert.equal(audioResult.hidden,true);assert.equal(audioResult.instances,1);assert.equal(assets.get('audio'),audio);
  assert.equal(project.clips[0].sourceAudioAssetId,'audio');
  const videoResult=removeAssetFromLibrary('video');
  assert.equal(videoResult.hidden,true);assert.equal(videoResult.instances,1);assert.equal(assets.get('video'),video);
});

test('a visible derived audio file retains its hidden source, then releases both after deletion',async()=>{
  reset();
  assets.set('video',asset('video',{kind:'video'}));
  assets.set('audio',asset('audio',{kind:'audio',sourceVideoAudio:true,sourceVideoAssetId:'video'}));
  const sourceResult=removeAssetFromLibrary('video');
  assert.equal(sourceResult.removed,false);assert.equal(sourceResult.hidden,true);assert.equal(sourceResult.dependents,1);
  assert.deepEqual((await packedMetadata()).assets.map(item=>item.id),['video','audio']);
  const derivedResult=removeAssetFromLibrary('audio');
  assert.equal(derivedResult.removed,true);
  assert.deepEqual(new Set(derivedResult.removedIds),new Set(['video','audio']));
  assert.equal(assets.size,0);
});

test('bulk clearing preserves indirect timeline sources and unrelated undo history',async()=>{
  reset();
  assets.set('video',asset('video',{kind:'video'}));
  assets.set('audio',asset('audio',{kind:'audio',sourceVideoAudio:true,sourceVideoAssetId:'video'}));
  assets.set('unused',asset('unused'));
  assets.set('already-hidden',asset('already-hidden',{libraryHidden:true}));
  project.audio.tracks=[{id:'sound',assetId:'audio'}];
  const history=new History();
  history.past=[{label:'원음 위치 조절',doc:{clips:[],tracks:[{assetId:'audio'}]}},
    {label:'지운 이미지 배치',doc:{clips:[{assetId:'unused'}],tracks:[]}}];
  assert.deepEqual(unusedLibraryAssetIds(),['unused']);
  for(const id of unusedLibraryAssetIds())history.forgetAssets(removeAssetFromLibrary(id).removedIds);
  assert.equal(assets.has('video'),true);assert.equal(assets.has('audio'),true);
  assert.deepEqual(history.past.map(item=>item.label),['원음 위치 조절']);
  assert.deepEqual(new Set((await packedMetadata()).assets.map(item=>item.id)),new Set(['video','audio']));
  assert.deepEqual(unusedLibraryAssetIds(),[]);
});

test('portable projects retain hidden in-use files and omit legacy hidden orphans',async()=>{
  reset();
  assets.set('used',{id:'used',kind:'audio',file:file('used.wav','audio/wav'),libraryHidden:true});
  assets.set('orphan',asset('orphan',{libraryHidden:true}));
  project.audio.tracks=[{id:'sound',assetId:'used',name:'used.wav',start:0,trimStart:0,trimEnd:1,volume:1,
    fadeIn:0,fadeOut:0,muted:false,lane:'music',role:'music',trackId:'a1'}];
  const metadata=await packedMetadata();
  assert.deepEqual(metadata.assets.map(item=>item.id),['used']);
  assert.equal(metadata.assets[0].libraryHidden,true);
});

test('history drops only states that reference files removed from runtime storage',()=>{
  reset();const history=new History();
  history.past=[
    {label:'before clip delete',doc:{clips:[{assetId:'gone'}],tracks:[]}},
    {label:'unrelated edit',doc:{clips:[{assetId:'kept'}],tracks:[]}},
  ];
  history.future=[{label:'future',doc:{clips:[],tracks:[{assetId:'gone'}]}}];
  history.forgetAssets(['gone']);
  assert.deepEqual(history.past.map(item=>item.label),['unrelated edit']);assert.equal(history.future.length,0);
});

test('removing a derived file keeps an older runtime state that never referenced it restorable',async()=>{
  reset();
  assets.set('visual',asset('visual',{base:{type:'image',natW:100,natH:100,scale:1,offX:0,offY:0,trimStart:0,trimEnd:0,imgDuration:3}}));
  assets.set('audio',asset('audio',{kind:'audio'}));
  const clip=await makeClip('visual',{id:'visual-instance'});project.clips=[clip];
  const beforeSeparation=captureDocument();
  clip.audioSeparated=true;clip.sourceAudioAssetId='audio';project.clips=[];
  const result=removeAssetFromLibrary('audio'),history=new History();
  history.past=[{label:'older state',doc:beforeSeparation}];history.forgetAssets(result.removedIds);
  assert.equal(history.past.length,1);assert.doesNotThrow(()=>restoreDocument(beforeSeparation));
  assert.equal(project.clips[0].id,'visual-instance');assert.equal(project.clips[0].sourceAudioAssetId,undefined);
});
