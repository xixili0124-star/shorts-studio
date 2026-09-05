// PC의 열 너비는 각각 저장합니다. 타임라인 높이와 모바일 배치는 이 설정을 사용하지 않습니다.
export const DESKTOP_PREVIEW_STORAGE_KEY = 'shorts-studio.desktop-preview.v1';
export const DESKTOP_INSPECTOR_STORAGE_KEY = 'shorts-studio.desktop-inspector.v1';
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const dimension = (value, fallback) => Number.isFinite(value) && value > 0 ? value : fallback;

export function desktopPreviewMetrics(width, height) {
  width = dimension(width, 1280);height = dimension(height, 800);
  const min = 220, max = Math.max(min, Math.min(480, Math.floor(width - 500)));
  const lower = clamp(width * .28, min, max), upper = clamp(width * .34, lower, max);
  const portraitWidth = Math.max(0, height - 112) * 9 / 16 + 32;
  return { min, max, compact:200, defaultWidth:Math.round(clamp(portraitWidth, lower, upper)) };
}

export function readDesktopPreviewSettings(raw) {
  const empty = { width:null, compact:false };
  if (!raw) return empty;
  try {
    const value = JSON.parse(raw);
    if (!value || Array.isArray(value) || value.version !== 1) return empty;
    const width = Number.isFinite(value.width) && value.width >= 220 && value.width <= 480 ? value.width : null;
    return { width, compact:value.compact === true };
  } catch { return empty; }
}

export function desktopPreviewWidth(width, height, preferences = {}) {
  const metrics = desktopPreviewMetrics(width, height);
  if (preferences.compact) return metrics.compact;
  const requested = Number.isFinite(preferences.width) ? preferences.width : metrics.defaultWidth;
  return Math.round(clamp(requested, metrics.min, metrics.max));
}

export function desktopInspectorMetrics(leftAvailable) {
  const left=dimension(leftAvailable,800),min=240,max=Math.max(min,Math.min(480,Math.floor(left-240)));
  return {min,max,defaultWidth:Math.round(clamp(left*.46,min,Math.min(300,max)))};
}

export function readDesktopInspectorSettings(raw) {
  try {
    const value=JSON.parse(raw);
    if(value&&!Array.isArray(value)&&value.version===1&&Number.isFinite(value.width)&&value.width>=240&&value.width<=480)return {width:value.width};
  }catch{}
  return {width:null};
}

export function desktopInspectorWidth(leftAvailable,preferences={}) {
  const metrics=desktopInspectorMetrics(leftAvailable),width=Number.isFinite(preferences.width)?preferences.width:metrics.defaultWidth;
  return Math.round(clamp(width,metrics.min,metrics.max));
}

export class DesktopPreviewLayout {
  constructor({ workbench, separator, compactButton, layout, busy, storageKey=DESKTOP_PREVIEW_STORAGE_KEY, readSettings=readDesktopPreviewSettings, cssProperty='--desktop-preview-width', resizingClass='desktop-preview-resizing', available=()=>true, onWidthChange }) {
    this.workbench=workbench;this.separator=separator;this.compactButton=compactButton;this.layout=layout;this.busy=busy;
    this.storageKey=storageKey;this.cssProperty=cssProperty;this.resizingClass=resizingClass;this.available=available;this.onWidthChange=onWidthChange;
    this.active=false;this.drag=null;this.frame=null;
    let saved=null;try{saved=localStorage.getItem(this.storageKey);}catch{}
    this.preferences=readSettings(saved);
    separator.addEventListener('pointerdown',event=>this.beginDrag(event));
    separator.addEventListener('keydown',event=>this.key(event));
    separator.addEventListener('lostpointercapture',event=>{if(this.drag?.id===event.pointerId)this.stopDrag(false);});
    compactButton?.addEventListener('click',()=>this.toggleCompact());
    window.addEventListener('pointermove',event=>this.moveDrag(event));
    window.addEventListener('pointerup',event=>{if(this.drag?.id===event.pointerId)this.stopDrag(true);});
    window.addEventListener('pointercancel',event=>{if(this.drag?.id===event.pointerId)this.stopDrag(false);});
    window.addEventListener('blur',()=>this.stopDrag(false));
    window.addEventListener('resize',()=>{if(this.enabled()){this.stopDrag(false);this.render();}});
  }
  enabled(){return this.active&&!document.body.classList.contains('mobile-ui')&&this.available();}
  dimensions(){const box=this.workbench.getBoundingClientRect();return {width:box.width||innerWidth,height:box.height||innerHeight};}
  metrics(){const size=this.dimensions();return desktopPreviewMetrics(size.width,size.height);}
  currentWidth(){const size=this.dimensions();return desktopPreviewWidth(size.width,size.height,this.preferences);}
  setActive(active){
    this.active=active;
    if(active){this.render();return;}
    this.stopDrag(false);
    if(this.frame!==null){cancelAnimationFrame(this.frame);this.frame=null;}
    this.workbench.style.removeProperty(this.cssProperty);
    document.body.classList.remove(this.resizingClass);
    if(this.compactButton)document.body.classList.remove('desktop-preview-compact');
    this.separator.classList.remove('dragging');
  }
  persist(){try{localStorage.setItem(this.storageKey,JSON.stringify({version:1,...this.preferences}));}catch{}}
  render(){
    if(!this.enabled())return;
    const width=this.currentWidth(),metrics=this.metrics(),compact=this.preferences.compact;
    this.workbench.style.setProperty('--desktop-preview-width',width+'px');
    document.body.classList.toggle('desktop-preview-compact',compact);
    this.separator.setAttribute('aria-valuemin',String(compact?metrics.compact:metrics.min));
    this.separator.setAttribute('aria-valuemax',String(metrics.max));
    this.separator.setAttribute('aria-valuenow',String(width));
    this.separator.setAttribute('aria-valuetext',`미리보기 너비 ${width}픽셀`);
    this.compactButton.setAttribute('aria-pressed',String(compact));
    const label=compact?'미리보기 원래 크기로':'미리보기 작게 보기';
    this.compactButton.setAttribute('aria-label',label);this.compactButton.title=label;
    this.compactButton.querySelector('span').textContent=compact?'원래 크기':'작게 보기';
    this.onWidthChange?.();
    if(this.frame===null)this.frame=requestAnimationFrame(()=>{this.frame=null;if(this.enabled())this.layout();});
  }
  setWidth(width,{persist=true}={}){
    if(!this.enabled()||!Number.isFinite(width))return;
    const metrics=this.metrics();
    this.preferences={...this.preferences,width:Math.round(clamp(width,metrics.min,metrics.max))};if(this.compactButton)this.preferences.compact=false;
    this.render();if(persist)this.persist();
  }
  toggleCompact(force){
    if(!this.enabled()||this.busy()||this.drag)return;
    this.preferences={...this.preferences,compact:force??!this.preferences.compact};
    this.render();this.persist();
  }
  resetWidth(){
    if(!this.enabled()||this.busy())return;
    this.preferences={...this.preferences,width:null};if(this.compactButton)this.preferences.compact=false;this.render();this.persist();
  }
  beginDrag(event){
    if(!this.enabled()||this.busy()||this.drag||event.button!==0||event.isPrimary===false)return;
    event.preventDefault();this.separator.focus({preventScroll:true});
    this.drag={id:event.pointerId,startX:event.clientX,startWidth:this.currentWidth(),before:{...this.preferences}};
    this.separator.classList.add('dragging');document.body.classList.add(this.resizingClass);
    try{this.separator.setPointerCapture(event.pointerId);}catch{}
  }
  moveDrag(event){
    if(!this.drag||this.drag.id!==event.pointerId)return;
    if(!this.enabled()||this.busy()){this.stopDrag(false);return;}
    event.preventDefault();
    // 오른쪽 열의 왼쪽 경계를 왼쪽으로 끌면 미리보기가 넓어집니다.
    this.setWidth(this.drag.startWidth+this.drag.startX-event.clientX,{persist:false});
  }
  stopDrag(commit){
    if(!this.drag)return;
    const previous=this.drag;this.drag=null;
    if(!commit)this.preferences=previous.before;
    this.separator.classList.remove('dragging');document.body.classList.remove(this.resizingClass);
    try{if(this.separator.hasPointerCapture(previous.id))this.separator.releasePointerCapture(previous.id);}catch{}
    if(this.enabled())this.render();if(commit)this.persist();
  }
  key(event){
    if(!this.enabled()||this.busy()||this.drag||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();event.stopPropagation();
    if(event.key==='Home'){this.resetWidth();return;}
    const metrics=this.metrics(),step=event.shiftKey?48:12;
    this.setWidth(event.key==='End'?metrics.max:this.currentWidth()+(event.key==='ArrowLeft'?step:-step));
  }
}

// 포인터 캡처·키보드·저장·취소는 같은 경계 컨트롤러를 사용하고 폭 계산만 구분합니다.
export class DesktopInspectorLayout extends DesktopPreviewLayout {
  constructor(options){
    super({...options,compactButton:null,storageKey:DESKTOP_INSPECTOR_STORAGE_KEY,readSettings:readDesktopInspectorSettings,cssProperty:'--desktop-inspector-width',resizingClass:'desktop-inspector-resizing'});
    this.previewWidth=options.previewWidth;
  }
  leftAvailable(){return this.dimensions().width-this.previewWidth();}
  metrics(){return desktopInspectorMetrics(this.leftAvailable());}
  currentWidth(){return desktopInspectorWidth(this.leftAvailable(),this.preferences);}
  setActive(active){super.setActive(active);this.refresh({notify:false});}
  refresh({notify=false}={}){
    if(!this.enabled()){
      this.stopDrag(false);if(this.frame!==null){cancelAnimationFrame(this.frame);this.frame=null;}
      this.separator.tabIndex=-1;this.separator.setAttribute('aria-disabled','true');return;
    }
    this.render({notify});
  }
  render({notify=true}={}){
    if(!this.enabled())return;
    const width=this.currentWidth(),metrics=this.metrics();
    this.workbench.style.setProperty(this.cssProperty,width+'px');this.separator.tabIndex=0;
    this.separator.setAttribute('aria-disabled',String(this.busy()));
    this.separator.setAttribute('aria-valuemin',String(metrics.min));this.separator.setAttribute('aria-valuemax',String(metrics.max));
    this.separator.setAttribute('aria-valuenow',String(width));this.separator.setAttribute('aria-valuetext',`속성 패널 너비 ${width}픽셀`);
    if(notify&&this.frame===null)this.frame=requestAnimationFrame(()=>{this.frame=null;if(this.enabled())this.layout();});
  }
}
