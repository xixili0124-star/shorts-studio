// 프리셋은 화면용 그림이 아니라 실제 편집 속성입니다.
export const GRAPHICS = [
  {id:'kinetic',name:'임팩트 타이틀',hint:'팝업 · 키네틱',art:'pop',label:'MAKE IT',text:'지금, 이 순간',size:90,x:.5,y:.43,font:'"Black Han Sans"',color:'#b8ee63',subtitle:''},
  {id:'lower',name:'로어 서드',hint:'슬라이드 · 정보',art:'lower',label:'CREATOR',text:'나만의 시선으로',size:70,x:.5,y:.69,font:'"Noto Sans KR"',color:'#b8ee63',subtitle:'A SHORT STORY'},
  {id:'swipe',name:'스와이프 배너',hint:'스피드 · 강조',art:'slide',label:'LET’S GO',text:'놓치지 마세요',size:80,x:.5,y:.32,font:'"Black Han Sans"',color:'#b8ee63'},
  {id:'focus',name:'포커스 프레임',hint:'프레임 · 주목',art:'focus',label:'FOCUS',text:'여기를 주목',size:83,x:.5,y:.45,font:'"Noto Sans KR"',color:'#b8ee63'},
  {id:'count',name:'카운트다운',hint:'숫자 · 인트로',art:'count',label:'3',text:'곧 시작합니다',size:120,x:.5,y:.43,font:'"Black Han Sans"',color:'#b8ee63'},
  {id:'quote',name:'에디토리얼',hint:'페이드 · 시네마틱',art:'quote',label:'A little story',text:'오늘을 기록하다',size:82,x:.5,y:.43,font:'"Noto Serif KR"',color:'#b8ee63'},
];
export const CAPTIONS = [
  {id:'clean',name:'클린',art:'outline',label:'오늘을 기록해요',style:{font:'"Noto Sans KR"',size:56,color:'#fff',stroke:'#101112',strokeW:8,box:'none',bottom:.17,anim:'none',glow:null}},
  {id:'bold',name:'볼드 임팩트',art:'bold',label:'지금 이 순간!',style:{font:'"Black Han Sans"',size:73,color:'#ffe56d',stroke:'#131610',strokeW:10,box:'none',bottom:.20,anim:'pop',glow:null}},
  {id:'accent',name:'라임 하이라이트',art:'accent',label:'나만의 이야기',style:{font:'"Noto Sans KR"',size:55,color:'#142008',strokeW:0,box:'accent',boxColor:'#b8ee63',bottom:.18,anim:'pop',glow:null}},
  {id:'pill',name:'다크 캡션',art:'pill',label:'편안하게, 자연스럽게',style:{font:'"Noto Sans KR"',size:50,color:'#fff',strokeW:0,box:'dark',bottom:.17,anim:'fade',glow:null}},
  {id:'editorial',name:'시네마틱',art:'editorial',label:'기억하고 싶은 밤',style:{font:'"Noto Serif KR"',size:50,color:'#f2f0e8',strokeW:2,stroke:'#101112',box:'none',bottom:.20,anim:'fade',glow:null}},
  {id:'neon',name:'소프트 네온',art:'neon',label:'AFTER HOURS',style:{font:'"Noto Sans KR"',size:58,color:'#ecdcff',stroke:'#362647',strokeW:3,box:'none',bottom:.20,anim:'fade',glow:'#bc86ff'}},
  {id:'white',name:'화이트 카드',art:'pill',label:'알아두면 좋은 것',style:{font:'"Noto Sans KR"',size:51,color:'#161b19',strokeW:0,box:'white',bottom:.18,anim:'none',glow:null}},
  {id:'hand',name:'손글씨 노트',art:'editorial',label:'우리의 작은 순간',style:{font:'"Nanum Pen Script"',size:83,color:'#fff1ce',stroke:'#262416',strokeW:3,box:'none',bottom:.19,anim:'fade',glow:null}},
];
export const TRANSITIONS = [
  {id:'cut',name:'바로 연결',hint:'전환 없음',duration:0},
  {id:'dissolve',name:'크로스 디졸브',hint:'두 장면을 부드럽게',duration:.5},
  {id:'fade',name:'블랙 페이드',hint:'어두워졌다가 밝게',duration:.6},
  {id:'flash',name:'화이트 플래시',hint:'짧고 선명한 포인트',duration:.3},
];
