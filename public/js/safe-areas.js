// 광고 가이드 기반 편집 참고값입니다. 실제 앱 UI의 모든 상황을 보장하지 않습니다.
export const SAFE_AREAS = [
  {id:'shorts',name:'YouTube Shorts',color:'#ff6d82',margins:{top:192/1920,right:108/1080,bottom:480/1920,left:65/1080},
    note:'Google 공식 광고 가이드: 위 10% · 아래 25% · 오른쪽 10%. 왼쪽은 편집 여유를 추가했습니다.',
    source:'https://business.google.com/us/ad-solutions/youtube-ads/shorts-ads/'},
  {id:'reels',name:'Instagram Reels',color:'#c59cff',margins:{top:270/1920,right:230/1080,bottom:672/1920,left:65/1080},
    note:'Meta 2023 Safe Zone Checker를 보수적인 사각형으로 환산했습니다. 최신 UI와 다를 수 있습니다.',
    source:'https://www.facebook.com/gms_hub/share/safe-zone-checker-2023-08-24.pptx'},
  {id:'tiktok',name:'TikTok',color:'#61ede5',margins:{top:252/1920,right:240/1080,bottom:640/1920,left:120/1080},
    note:'TikTok Creative Center 세로 LTR 도해를 보수적으로 환산했습니다. 설명문·버튼·기기에 따라 달라집니다.',
    source:'https://ads.tiktok.com/business/creativecenter/quicktok/online/tiktok_creative_accelerator/pc/en'},
  {id:'common',name:'세 플랫폼 공통 · 보수적',color:'#c2ed87',margins:{top:270/1920,right:240/1080,bottom:672/1920,left:120/1080},
    note:'세 참고 사각형의 교집합입니다. 앱 UI와 광고 형식이 바뀌면 여백을 더 늘려 주세요.',
    source:'https://ads.tiktok.com/resources/help/article/tiktok-auction-in-feed-ads?lang=en-GB'},
];
export function safeAreaConfig(id='shorts') {
  const preset=SAFE_AREAS.find(p=>p.id===id)||SAFE_AREAS[0];
  return {...preset,margins:{...preset.margins}};
}
export function safeAreaRect(config,W,H) {
  const p=config===true?safeAreaConfig():config;
  const m=p.margins;
  return {x:W*m.left,y:H*m.top,w:W*(1-m.left-m.right),h:H*(1-m.top-m.bottom)};
}
