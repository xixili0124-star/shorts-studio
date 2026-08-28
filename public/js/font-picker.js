import { FONTS, ensureFontPreview } from './font-catalog.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
let observer;
const fontStyle=font=>'font-family:'+esc(font.css)+',sans-serif;font-weight:'+font.weight;
export function fontField(prop,value) {
  const selected=FONTS.find(font=>font.css===value)||FONTS[0];
  return '<div class="font-picker"><span class="field-label">폰트</span><input type="hidden" data-prop="'+esc(prop)+'" value="'+esc(value)+'">'+
    '<button type="button" class="font-trigger" data-font-trigger aria-haspopup="listbox" aria-expanded="false" aria-label="폰트 선택"><span style="'+fontStyle(selected)+'">'+esc(selected.label)+'</span><span aria-hidden="true">⌄</span></button>'+
    '<div class="font-popup" hidden><input class="font-search" type="search" placeholder="폰트 이름 검색" aria-label="폰트 이름 검색">'+
    '<div class="font-filters"><button type="button" data-font-filter="all" aria-pressed="true">전체</button><button type="button" data-font-filter="ko" aria-pressed="false">한글</button><button type="button" data-font-filter="en" aria-pressed="false">영문</button></div>'+
    '<div class="font-options" role="listbox" aria-label="폰트 목록">'+FONTS.map(font=>'<button type="button" class="font-option" role="option" aria-selected="'+(font.css===value)+'" data-font-choice="'+esc(font.css)+'" data-font-language="'+font.language+'" data-font-search="'+esc((font.label+' '+font.family+' '+font.group).toLowerCase())+'">'+
      '<span class="font-option-name" style="'+fontStyle(font)+'">'+esc(font.label)+'</span><small>'+esc(font.group)+' · '+(font.language==='en'?'영문':'한글')+'</small><span class="font-load-state" aria-live="polite"></span></button>').join('')+'</div><p class="font-empty" hidden>검색 결과가 없어요.</p><small class="font-picker-note">보이는 글꼴부터 불러옵니다 · SIL OFL</small></div></div>';
}
function observeOptions(picker) {
  for(const option of picker.querySelectorAll('[data-font-choice]'))if(!option.hidden&&option.dataset.fontReady!=='true')observer?.observe(option);
}
function filterOptions(picker) {
  const query=picker.querySelector('.font-search').value.trim().toLowerCase();
  const language=picker.querySelector('[data-font-filter][aria-pressed="true"]')?.dataset.fontFilter||'all';
  let count=0;
  for(const option of picker.querySelectorAll('[data-font-choice]')){
    option.hidden=!(option.dataset.fontSearch.includes(query)&&(language==='all'||option.dataset.fontLanguage===language));
    if(!option.hidden)count++;
  }
  picker.querySelector('.font-empty').hidden=count>0;observeOptions(picker);
}
function closePicker(picker,focus=false) {
  picker.querySelector('.font-popup').hidden=true;
  picker.querySelector('[data-font-trigger]').setAttribute('aria-expanded','false');
  if(focus)picker.querySelector('[data-font-trigger]').focus();
}
export function refreshFontPickers(host) {
  observer?.disconnect();
  if(typeof IntersectionObserver==='function')observer=new IntersectionObserver(entries=>{
    for(const entry of entries){if(!entry.isIntersecting)continue;const option=entry.target;observer.unobserve(option);
      const status=option.querySelector('.font-load-state');status.textContent='불러오는 중';
      ensureFontPreview(option.dataset.fontChoice).then(()=>{if(option.isConnected){option.dataset.fontReady='true';status.textContent='';}})
        .catch(()=>{if(option.isConnected)status.textContent='연결 실패 · 다시 열어 주세요';});
    }
  },{root:null,rootMargin:'40px'});
  for(const picker of host.querySelectorAll('.font-picker')){
    const value=picker.querySelector('[data-prop]').value;
    ensureFontPreview(value).catch(()=>{});
  }
}
export function wireFontPickers(host) {
  host.addEventListener('click',event=>{
    const picker=event.target.closest('.font-picker');if(!picker)return;
    const trigger=event.target.closest('[data-font-trigger]');
    if(trigger){const panel=picker.querySelector('.font-popup'),opening=panel.hidden;
      for(const other of host.querySelectorAll('.font-picker'))closePicker(other);
      panel.hidden=!opening;trigger.setAttribute('aria-expanded',String(opening));
      if(opening){filterOptions(picker);picker.querySelector('.font-search').focus();}return;
    }
    const filter=event.target.closest('[data-font-filter]');
    if(filter){picker.querySelectorAll('[data-font-filter]').forEach(button=>button.setAttribute('aria-pressed',String(button===filter)));filterOptions(picker);return;}
    const choice=event.target.closest('[data-font-choice]');
    if(choice){const input=picker.querySelector('[data-prop]');input.value=choice.dataset.fontChoice;closePicker(picker);
      input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));
      host.querySelector('[data-font-trigger]')?.focus();
    }
  });
  host.addEventListener('input',event=>{if(event.target.matches('.font-search'))filterOptions(event.target.closest('.font-picker'));});
  host.addEventListener('keydown',event=>{
    const picker=event.target.closest('.font-picker');if(!picker)return;
    const opened=!picker.querySelector('.font-popup').hidden;
    if(event.key==='Escape'&&opened){event.preventDefault();event.stopPropagation();closePicker(picker,true);return;}
    if(!opened||!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
    event.preventDefault();event.stopPropagation();const options=[...picker.querySelectorAll('[data-font-choice]')].filter(option=>!option.hidden);
    const index=options.indexOf(document.activeElement),next=event.key==='Home'?0:event.key==='End'?options.length-1:Math.max(0,Math.min(options.length-1,index+(event.key==='ArrowDown'?1:-1)));
    options[next]?.focus();
  });
  document.addEventListener('pointerdown',event=>{for(const picker of host.querySelectorAll('.font-picker'))if(!picker.contains(event.target))closePicker(picker);});
}
