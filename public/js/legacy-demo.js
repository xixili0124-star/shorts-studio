// 과거에 기본으로 열던 서울 사진 예시만 식별합니다. 라이브러리의 사용자 파일은 교체·삭제하지 않습니다.
const LEGACY_DEMO_NAME = '서울의 밤, 짧은 기록';
const LEGACY_MEDIA = Object.freeze([
  Object.freeze({id:'sample-image-1',name:'서울의 밤 01.jpg',type:'image/jpeg',size:405563,kind:'image'}),
  Object.freeze({id:'sample-image-2',name:'서울의 밤 02.jpg',type:'image/jpeg',size:282494,kind:'image'}),
  Object.freeze({id:'sample-image-3',name:'서울의 밤 03.jpg',type:'image/jpeg',size:342127,kind:'image'}),
  Object.freeze({id:'sample-sound',name:'Night pulse · 샘플 사운드.wav',type:'audio/wav',size:576044,kind:'audio'}),
]);

export const LEGACY_DEMO_ASSET_IDS = Object.freeze(LEGACY_MEDIA.map(item=>item.id));

/**
 * 복구된 문서와 전체 라이브러리를 확인하는 순수 함수입니다.
 * 자막·그래픽·퀵포맷만 바꾼 기본 예시는 교체하되, 이름을 바꾸거나 사용자 파일을 배치한 작업은 보존합니다.
 * 라이브러리에만 있는 사용자 파일은 예시 교체 후에도 남겨 둡니다. 이 함수는 어떤 파일도 삭제하지 않습니다.
 * records에는 숨긴 항목을 제외하지 않은 전체 자산 배열 또는 저장된 파일 레코드 배열을 넘깁니다.
 */
export function isLegacyDemoDraft(doc,records) {
  if(!doc||doc.name!==LEGACY_DEMO_NAME||!Array.isArray(records)||!records.length)return false;
  if(!['clips','tracks','captions','overlays'].every(key=>Array.isArray(doc[key])))return false;
  const ids=new Set(),seen=new Set();
  let hasPhoto=false;
  for(const record of records){
    if(!record||typeof record.id!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(record.id)||seen.has(record.id))return false;
    seen.add(record.id);
    const known=LEGACY_MEDIA.find(item=>item.id===record.id);
    if(!known)continue;
    // 메모리 자산·IndexedDB File 레코드·.shorts 파일 헤더 모두 같은 메타데이터를 검사합니다.
    const file=record.file??record;
    if(!file||file.name!==known.name||file.type!==known.type||file.size!==known.size)return false;
    if(record.kind!==undefined&&record.kind!==known.kind)return false;
    if(record.aiGenerated===true||record.sourceVideoAudio===true||record.sourceVideoAssetId!==undefined)return false;
    ids.add(record.id);hasPhoto ||= known.kind==='image';
  }
  if(!hasPhoto)return false;
  for(const clip of doc.clips){
    if(!clip||clip.type!=='image'||!ids.has(clip.assetId)||clip.assetId==='sample-sound')return false;
    if(clip.sourceAudioAssetId!==undefined||clip.audioSeparated===true)return false;
  }
  for(const track of doc.tracks){
    if(!track||track.assetId!=='sample-sound'||!ids.has(track.assetId))return false;
    if(track.sourceVideoAssetId!==undefined||track.sourceVideoAudio===true||track.aiGenerated===true)return false;
  }
  // 현재 자막과 그래픽은 글자·도형뿐입니다. 향후 미디어 참조가 추가되더라도 사용자 파일을 보호합니다.
  for(const item of [...doc.captions,...doc.overlays]){
    if(!item||item.assetId!==undefined||item.sourceVideoAssetId!==undefined)return false;
  }
  return true;
}
