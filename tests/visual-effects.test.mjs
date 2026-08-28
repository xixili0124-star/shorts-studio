// 실제 캔버스 픽셀로 전환·텍스트·그래픽을 확인합니다. 외부 미디어나 GPU는 사용하지 않습니다.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {paintTransition} from '../public/js/transition-effects.js';
import {TEXT_EFFECTS,effectSettings,textAnimationAt,visibleText,withTextAnimation} from '../public/js/text-effects.js';
import {GRAPHICS,CAPTIONS,TRANSITIONS} from '../public/js/presets.js';
import {project,setLegacyEditorMode} from '../public/js/state.js';
import {drawTextBlock,renderFrame,renderCaptionPreview,renderGraphicPreview,measureVisual} from '../public/js/render.js';

const require=createRequire(import.meta.url);
let nativeCanvas;
try{nativeCanvas=require(process.env.STUDIO_CANVAS_MODULE||'@napi-rs/canvas');}catch{}
const canvasTest=(name,run)=>test(name,{skip:!nativeCanvas},run);
const makeCanvas=(width=320,height=180)=>nativeCanvas.createCanvas(width,height);
const pixels=canvas=>canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
const signature=canvas=>createHash('sha256').update(pixels(canvas)).digest('hex');
const defaults=structuredClone(project);
function resetProject(){setLegacyEditorMode(false);Object.assign(project,structuredClone(defaults));}
function withCanvasDocument(run){
  const previous=globalThis.document;
  globalThis.document={createElement(tag){assert.equal(tag,'canvas');return makeCanvas(1,1);}};
  try{return run();}finally{globalThis.document=previous;resetProject();}
}
function expectPixels(canvas,expected,label){
  const actual=pixels(canvas),first=actual.findIndex((value,index)=>value!==expected[index]);
  const at=Math.max(0,Math.floor(first/4)*4);
  assert.equal(first,-1,label+' at pixel '+Math.floor(at/4)+': '+[...actual.slice(at,at+4)]+' / '+[...expected.slice(at,at+4)]);
}
function countPixels(canvas,predicate){
  const data=pixels(canvas);let count=0;
  for(let offset=0;offset<data.length;offset+=4)if(predicate(data[offset],data[offset+1],data[offset+2],data[offset+3]))count++;
  return count;
}
function boundsOf(canvas,predicate){
  const data=pixels(canvas);let x0=Infinity,y0=Infinity,x1=-1,y1=-1;
  for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++){
    const offset=(y*canvas.width+x)*4;
    if(predicate(...data.slice(offset,offset+4))){x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);}
  }
  return {x:x0,y:y0,w:x1<0?0:x1-x0+1,h:y1<0?0:y1-y0+1};
}

const directions=['left','right','up','down'];
for(const mode of ['push','wipe'])for(const direction of directions){
  canvasTest(mode+'-'+direction+' preserves transparent endpoints and the exact midpoint direction',()=>{
    const W=64,H=48,left=makeCanvas(W,H),right=makeCanvas(W,H),result=makeCanvas(W,H);
    const a=left.getContext('2d'),b=right.getContext('2d');
    a.fillStyle='rgba(255,0,0,.5)';a.fillRect(0,0,W,H);a.clearRect(0,0,W/2,H/2);
    b.fillStyle='rgba(0,0,255,.5)';b.fillRect(0,0,W,H);b.clearRect(W/2,H/2,W/2,H/2);
    const type=mode+'-'+direction,ctx=result.getContext('2d'),leftPixels=pixels(left),rightPixels=pixels(right);
    paintTransition(ctx,left,right,0,type);expectPixels(result,leftPixels,type+' start');
    paintTransition(ctx,left,right,1,type);expectPixels(result,rightPixels,type+' end');
    paintTransition(ctx,left,right,.5,type);
    const expected=new Uint8ClampedArray(W*H*4);
    for(let y=0;y<H;y++)for(let x=0;x<W;x++){
      let fromRight=false,sx=x,sy=y;
      if(mode==='push'){
        if(direction==='left'){fromRight=x>=W/2;sx=fromRight?x-W/2:x+W/2;}
        if(direction==='right'){fromRight=x<W/2;sx=fromRight?x+W/2:x-W/2;}
        if(direction==='up'){fromRight=y>=H/2;sy=fromRight?y-H/2:y+H/2;}
        if(direction==='down'){fromRight=y<H/2;sy=fromRight?y+H/2:y-H/2;}
      }else fromRight=direction==='left'?x>=W/2:direction==='right'?x<W/2:direction==='up'?y>=H/2:y<H/2;
      const input=fromRight?rightPixels:leftPixels,offset=(sy*W+sx)*4;
      expected.set(input.slice(offset,offset+4),(y*W+x)*4);
    }
    expectPixels(result,expected,type+' middle');
    const composite=makeCanvas(W,H),base=composite.getContext('2d');
    base.fillStyle='#00ff00';base.fillRect(0,0,W,H);base.drawImage(result,0,0);
    assert.equal(countPixels(composite,(r,g,blue,alpha)=>g>=126&&alpha===255),W*H,type+' exposes the lower green layer');
  });
}

canvasTest('other transition styles preserve transparent endpoints and never create an opaque backdrop',()=>{
  const left=makeCanvas(96,64),right=makeCanvas(96,64),out=makeCanvas(96,64);
  left.getContext('2d').fillStyle='rgba(255,0,0,.5)';left.getContext('2d').fillRect(24,16,48,32);
  right.getContext('2d').fillStyle='rgba(0,0,255,.5)';right.getContext('2d').fillRect(24,16,48,32);
  for(const type of ['dissolve','fade','flash','zoom-in','zoom-out','blur']){
    assert.ok(TRANSITIONS.some(item=>item.id===type));
    paintTransition(out.getContext('2d'),left,right,0,type);expectPixels(out,pixels(left),type+' start');
    paintTransition(out.getContext('2d'),left,right,1,type);expectPixels(out,pixels(right),type+' end');
    paintTransition(out.getContext('2d'),left,right,.5,type);
    assert.ok(countPixels(out,(r,g,b,a)=>a>0)>0,type);
    assert.equal(countPixels(out,(r,g,b,a)=>a>140),0,type+' remains translucent');
  }
});

test('text effect settings keep independent entrances and exits and preserve grapheme clusters',()=>{
  assert.equal(effectSettings({anim:'up'},true).inEffect,'slide-up');
  assert.equal(effectSettings({anim:'up',outEffect:'none'},true).outEffect,'none');
  assert.equal(effectSettings({inEffect:'missing',outEffect:'missing'}).inEffect,'none');
  assert.equal(visibleText('가👨‍👩‍👧‍👦나',2/3),'가👨‍👩‍👧‍👦');
  const entry={inEffect:'slide-left',inDuration:.5,outEffect:'fade',outDuration:.6};
  assert.deepEqual(textAnimationAt(entry,.25,3),textAnimationAt({...entry,outEffect:'rotate',outDuration:1},.25,3));
  assert.deepEqual(textAnimationAt(entry,2.7,3),textAnimationAt({...entry,inEffect:'bounce',inDuration:1},2.7,3));
  assert.equal(textAnimationAt({...entry,outEffect:'none'},3,3).alpha,1);
  assert.equal(textAnimationAt({...entry,inEffect:'none'},0,3).alpha,1);
});

canvasTest('independent text entrance and exit settings produce independent canvas motion',()=>{
  const W=400,H=200,bounds={x:140,y:80,w:120,h:40};
  const paint=(style,time)=>{
    const canvas=makeCanvas(W,H),ctx=canvas.getContext('2d');
    withTextAnimation(ctx,textAnimationAt(style,time,3),bounds,W,H,()=>{ctx.fillStyle='#fff';ctx.fillRect(bounds.x,bounds.y,bounds.w,bounds.h);});
    return canvas;
  };
  const style={inEffect:'slide-left',inDuration:.5,outEffect:'fade',outDuration:.6};
  const entering=paint(style,.25),exiting=paint(style,2.7),middle=paint(style,1.5);
  expectPixels(entering,pixels(paint({...style,outEffect:'zoom',outDuration:1},.25)),'exit does not change entrance');
  expectPixels(exiting,pixels(paint({...style,inEffect:'rotate',inDuration:1},2.7)),'entrance does not change exit');
  const startBounds=boundsOf(entering,(r,g,b,a)=>a>0),endBounds=boundsOf(exiting,(r,g,b,a)=>a>0);
  assert.ok(startBounds.x>endBounds.x);assert.equal(endBounds.x,bounds.x);
  assert.equal(countPixels(paint(style,0),(r,g,b,a)=>a>0),0);
  assert.equal(countPixels(paint(style,3),(r,g,b,a)=>a>0),0);
  assert.equal(countPixels(middle,(r,g,b,a)=>a===255),bounds.w*bounds.h);
  assert.ok(countPixels(exiting,(r,g,b,a)=>a>=126&&a<=129)>0);
});

canvasTest('every graphic renders its preview and a timed export frame without mutating its preset',()=>withCanvasDocument(()=>{
  const extra=['notification','chat','price','callout','checklist','stack','tape','score','stamp','progress','neon-frame','split-words'];
  const signatures=new Set();
  for(const id of extra)assert.ok(GRAPHICS.some(preset=>preset.id===id),id);
  for(const preset of GRAPHICS){
    const before=JSON.stringify(preset),preview=makeCanvas(320,180),second=makeCanvas(320,180);
    renderGraphicPreview(preview,preset,.65);renderGraphicPreview(second,preset,.65);
    expectPixels(preview,pixels(second),preset.id+' deterministic preview');
    assert.ok(countPixels(preview,(r,g,b)=>r!==32||g!==38||b!==44)>40,preset.id+' preview is not empty');
    signatures.add(signature(preview));
    if(extra.includes(preset.id)){
      const fallback=makeCanvas(320,180);renderGraphicPreview(fallback,{...preset,id:'unknown-graphic'},.65);
      assert.notEqual(signature(preview),signature(fallback),preset.id+' uses its own renderer');
    }
    resetProject();
    const duration=preset.duration||3;
    project.overlays=[{...preset,id:'graphic-fixture',graphic:preset.id,start:0,end:duration,align:'center',box:'none',strokeW:0}];
    const frame=makeCanvas(360,640),ctx=frame.getContext('2d');
    renderFrame(ctx,Math.min(.65,duration*.6));
    assert.ok(countPixels(frame,(r,g,b)=>r||g||b)>40,preset.id+' export frame is not empty');
    renderFrame(ctx,duration+.01);
    assert.equal(countPixels(frame,(r,g,b)=>r||g||b),0,preset.id+' is absent after its end');
    assert.equal(JSON.stringify(preset),before,preset.id+' preset is unchanged');
  }
  assert.equal(signatures.size,GRAPHICS.length);
}));

canvasTest('caption preview cards all render through the text painter',()=>{
  for(const preset of CAPTIONS){
    const canvas=makeCanvas(320,140),before=JSON.stringify(preset);
    renderCaptionPreview(canvas,preset);
    assert.ok(countPixels(canvas,(r,g,b)=>r!==32||g!==38||b!==44)>30,preset.id);
    assert.equal(JSON.stringify(preset),before);
  }
});

const textBase={text:'TEST',font:'Arial',size:48,color:'#ffffff',stroke:'#ff0000',strokeW:0,
  box:'none',shadowEnabled:false,glow:null,align:'center',x:320,y:180,maxWidth:560,anchor:'middle',alpha:1};
const paintText=overrides=>{
  const canvas=makeCanvas(640,360);drawTextBlock(canvas.getContext('2d'),{...textBase,...overrides});return canvas;
};
const green=(r,g,b,a)=>r<20&&g>200&&b<20&&a>0;
const red=(r,g,b,a)=>r>200&&g<30&&b<30&&a>0;
const blue=(r,g,b,a)=>r<30&&g<30&&b>200&&a>0;

canvasTest('caption box color, opacity, padding and radius change the actual pixels',()=>{
  const style={box:'dark',boxColor:'#00ff00',boxOpacity:1,boxPaddingX:20,boxPaddingY:10,boxRadius:0};
  const plain=paintText({}),small=paintText(style),large=paintText({...style,boxPaddingX:50,boxPaddingY:25});
  assert.equal(countPixels(plain,green),0);assert.ok(countPixels(small,green)>500);
  const a=boundsOf(small,green),b=boundsOf(large,green);
  assert.ok(Math.abs((b.w-a.w)-60)<=2);assert.ok(Math.abs((b.h-a.h)-30)<=2);
  expectPixels(paintText({...style,boxOpacity:0}),pixels(plain),'transparent box');
  const half=paintText({...style,boxOpacity:.5});
  assert.ok(countPixels(half,(r,g,b,a)=>green(r,g,b,a)&&a>=126&&a<=129)>500);
  const rounded=paintText({...style,boxRadius:25});
  assert.ok(countPixels(rounded,green)<countPixels(small,green));
  const corner=((a.y+1)*small.width+a.x+1)*4;
  assert.ok(pixels(small)[corner+3]>250);assert.equal(pixels(rounded)[corner+3],0);
});

canvasTest('text outline color and width are rendered rather than stored only in the style',()=>{
  const plain=paintText({}),thin=paintText({strokeW:8}),thick=paintText({strokeW:20});
  assert.equal(countPixels(plain,red),0);assert.ok(countPixels(thin,red)>200);
  assert.ok(countPixels(thick,red)>countPixels(thin,red));
  assert.ok(boundsOf(thick,(r,g,b,a)=>a>0).w>boundsOf(plain,(r,g,b,a)=>a>0).w);
});

canvasTest('shadow enable, offsets, opacity and blur affect rendered text independently',()=>{
  const plain=paintText({}),style={shadowEnabled:true,shadowColor:'#0000ff',shadowOpacity:.8,shadowBlur:0,shadowX:90,shadowY:80};
  const shadow=paintText(style),disabled=paintText({...style,shadowEnabled:false});
  expectPixels(disabled,pixels(plain),'disabled shadow');
  expectPixels(paintText({...style,shadowOpacity:0}),pixels(plain),'zero-opacity shadow');
  assert.ok(countPixels(shadow,blue)>200);
  const baseBounds=boundsOf(plain,(r,g,b,a)=>a>0),shadowBounds=boundsOf(shadow,blue);
  assert.ok(Math.abs(shadowBounds.x-baseBounds.x-90)<=1);
  assert.ok(Math.abs(shadowBounds.y-baseBounds.y-80)<=1);
  const blurred=paintText({...style,shadowBlur:18}),blurBounds=boundsOf(blurred,(r,g,b,a)=>blue(r,g,b,a)&&a>2);
  assert.ok(blurBounds.w>shadowBounds.w);assert.ok(blurBounds.h>shadowBounds.h);
  const mass=canvas=>{const data=pixels(canvas);let total=0;for(let i=0;i<data.length;i+=4)if(blue(...data.slice(i,i+4)))total+=data[i+3];return total;};
  assert.ok(mass(shadow)>mass(paintText({...style,shadowOpacity:.2}))*2);
});

canvasTest('caption and plain overlay frames both honor independent entrance and exit settings',()=>withCanvasDocument(()=>{
  const base={font:'Arial',size:144,color:'#fff',stroke:'#000',strokeW:0,box:'none',shadowEnabled:false,glow:null,
    inEffect:'slide-left',inDuration:.5,outEffect:'fade',outDuration:.6};
  const paint=(kind,style,time)=>{
    resetProject();
    if(kind==='caption'){
      project.captionStyle={...project.captionStyle,...style,bottom:.3};
      project.captions=[{id:'caption-fixture',text:'TEST',start:0,end:3}];
    }else project.overlays=[{...style,id:'overlay-fixture',text:'TEST',start:0,end:3,x:.5,y:.5,align:'center'}];
    const canvas=makeCanvas(480,640);renderFrame(canvas.getContext('2d'),time);return canvas;
  };
  const brightness=canvas=>{const data=pixels(canvas);let total=0;for(let i=0;i<data.length;i+=4)total+=data[i]+data[i+1]+data[i+2];return total;};
  for(const kind of ['caption','overlay']){
    const entrance=paint(kind,base,.25),exit=paint(kind,base,2.7);
    assert.ok(brightness(entrance)>1000);assert.ok(brightness(exit)>1000);
    expectPixels(entrance,pixels(paint(kind,{...base,outEffect:'rotate',outDuration:1},.25)),kind+' entrance is independent');
    expectPixels(exit,pixels(paint(kind,{...base,inEffect:'zoom',inDuration:1},2.7)),kind+' exit is independent');
    assert.equal(brightness(paint(kind,base,0)),0);
    assert.ok(brightness(paint(kind,{...base,inEffect:'none'},0))>1000);
    assert.ok(brightness(paint(kind,{...base,outEffect:'none'},2.99))>brightness(paint(kind,base,2.99))*10);
    for(const [effect] of TEXT_EFFECTS){
      const frame=paint(kind,{...base,inEffect:effect},.25);
      assert.ok(brightness(frame)>10,kind+' '+effect+' renders during its entrance');
    }
  }
}));

canvasTest('caption style box, outline and shadow settings reach both preview and export renderers',()=>withCanvasDocument(()=>{
  const base={font:'Arial',size:144,color:'#ffffff',stroke:'#ff0000',strokeW:18,
    box:'dark',boxColor:'#00ff00',boxOpacity:.6,boxPaddingX:30,boxPaddingY:24,boxRadius:12,
    shadowEnabled:true,shadowColor:'#0000ff',shadowOpacity:1,shadowBlur:0,shadowX:90,shadowY:80,
    inEffect:'none',outEffect:'none',bottom:.3,glow:null};
  const paint=(preview,overrides={})=>{
    resetProject();const style={...base,...overrides},canvas=makeCanvas(preview?320:480,preview?180:640);
    if(preview)renderCaptionPreview(canvas,{label:'TEST',style});
    else{
      project.captionStyle=style;project.captions=[{id:'styled-caption',text:'TEST',start:0,end:3}];
      renderFrame(canvas.getContext('2d'),1);
    }
    return canvas;
  };
  const boxGreen=(r,g,b)=>r<40&&g>90&&b<40;
  for(const preview of [false,true]){
    const styled=paint(preview),label=preview?'preview':'export';
    assert.ok(countPixels(styled,boxGreen)>100,label+' custom box');
    assert.ok(countPixels(styled,red)>50,label+' outline');
    assert.ok(countPixels(styled,blue)>50,label+' shadow');
    assert.equal(countPixels(paint(preview,{boxOpacity:0}),boxGreen),0,label+' hidden box');
    assert.equal(countPixels(paint(preview,{strokeW:0}),red),0,label+' hidden outline');
    assert.equal(countPixels(paint(preview,{shadowEnabled:false}),blue),0,label+' hidden shadow');
  }
}));

canvasTest('measured caption and plain text bounds expand with custom box padding and contain the painted box',()=>withCanvasDocument(()=>{
  const W=640,H=960,k=H/1920;
  const base={font:'Arial',size:96,color:'#ffffff',strokeW:0,box:'dark',boxColor:'#00ff00',boxOpacity:1,
    boxRadius:0,shadowEnabled:false,inEffect:'none',outEffect:'none',bottom:.35};
  const smallPadding={boxPaddingX:24,boxPaddingY:12},largePadding={boxPaddingX:104,boxPaddingY:64};
  for(const kind of ['caption','center','left','right']){
    const paint=padding=>{
      resetProject();
      const style={...base,...padding},canvas=makeCanvas(W,H),ctx=canvas.getContext('2d');
      const item={id:'padding-fixture',text:'PAD\nWIDE TEXT',start:0,end:3};
      if(kind==='caption'){
        item.style=style;project.captions=[item];
      }else{
        Object.assign(item,style,{align:kind,x:kind==='left'?.65:kind==='right'?.35:.5,y:.5});
        project.overlays=[item];
      }
      const measured=measureVisual(ctx,kind==='caption'?'caption':'graphic',item,W,H,1);
      renderFrame(ctx,1);
      const painted=boundsOf(canvas,green);
      assert.ok(painted.w>0&&painted.h>0,kind+' has a colored box');
      assert.ok(painted.x>=Math.floor(measured.x)&&painted.y>=Math.floor(measured.y),kind+' minimum bounds contain the box');
      assert.ok(painted.x+painted.w<=Math.ceil(measured.x+measured.w),kind+' maximum x contains the box');
      assert.ok(painted.y+painted.h<=Math.ceil(measured.y+measured.h),kind+' maximum y contains the box');
      return {measured,painted};
    };
    const small=paint(smallPadding),large=paint(largePadding);
    const dx=(largePadding.boxPaddingX-smallPadding.boxPaddingX)*k,dy=(largePadding.boxPaddingY-smallPadding.boxPaddingY)*k;
    for(const [property,delta] of [['x',-dx],['y',-dy],['w',dx*2],['h',dy*2]]){
      assert.ok(Math.abs(large.measured[property]-small.measured[property]-delta)<1e-7,kind+' measured '+property);
    }
    assert.ok(Math.abs(large.painted.w-small.painted.w-dx*2)<=2,kind+' painted horizontal padding');
    assert.ok(Math.abs(large.painted.h-small.painted.h-dy*2)<=2,kind+' painted vertical padding');
  }
}));

canvasTest('crop tracking uses the displayed source time while keyframe transforms use the timeline playhead',()=>withCanvasDocument(()=>{
  resetProject();
  const W=240,H=160,source=makeCanvas(W,H),sourceContext=source.getContext('2d');
  sourceContext.fillStyle='#ff0000';sourceContext.fillRect(0,0,W,H);
  sourceContext.fillStyle='#00ff00';sourceContext.fillRect(0,0,W/2,H/2);
  sourceContext.fillStyle='#0000ff';sourceContext.fillRect(W/2,H/2,W/2,H/2);
  const clip={id:'source-time-fixture',type:'video',start:4,trimStart:11,trimEnd:19,natW:W,natH:H,
    fit:'contain',scale:1,bg:'transparent',transitionOut:{type:'cut'},
    cropTracking:{version:1,enabled:true,zoom:2,anchorX:.5,anchorY:.5,keys:[
      {time:0,x:.1,y:.2,w:.2,h:.2,confidence:1,lost:false},
      {time:8,x:.7,y:.6,w:.2,h:.2,confidence:1,lost:false},
    ]},
    keyframes:{version:1,tracks:{
      offsetX:[{time:0,value:0},{time:8,value:.32}],offsetY:[{time:0,value:0},{time:8,value:-.16}],
      scaleX:[{time:0,value:1},{time:8,value:1.8}],scaleY:[{time:0,value:1},{time:8,value:.2}],
      rotation:[{time:0,value:0},{time:8,value:32}],
    }},
  };
  project.clips=[clip];
  const original=JSON.stringify(clip),signatures=new Set();
  // 두 공급 프레임 모두 재생 헤드의 클립 내부 시각 2.5초와 다릅니다.
  for(const [sourceTime,geometry] of [[17,[-192,-112,480,320]],[12,[-12,-32,480,320]]]){
    const frame=makeCanvas(W,H),calls=[],requests=[];
    renderFrame(frame.getContext('2d'),6.5,{source(item,local){
      requests.push({item,local});
      return {img:source,w:W,h:H,sourceTime,draw(ctx,...rect){
        const transform=ctx.getTransform();
        calls.push({rect,matrix:['a','b','c','d','e','f'].map(name=>transform[name])});
        ctx.drawImage(source,...rect);
      }};
    }});
    assert.equal(requests.length,1);assert.equal(requests[0].item,clip);assert.equal(requests[0].local,2.5);
    assert.equal(calls.length,1);
    geometry.forEach((value,index)=>assert.ok(Math.abs(calls[0].rect[index]-value)<1e-7,'source '+sourceTime+' geometry '+index));
    const [x,y,w,h]=geometry,cx=x+w/2,cy=y+h/2;
    // 2.5초의 키프레임 값: 이동 (.1,-.05), 확대 (1.25,.75), 회전 10도.
    const angle=10*Math.PI/180,a=Math.cos(angle)*1.25,b=Math.sin(angle)*1.25,c=-Math.sin(angle)*.75,d=Math.cos(angle)*.75;
    const expectedMatrix=[a,b,c,d,cx+W*.1-a*cx-c*cy,cy-H*.05-b*cx-d*cy];
    expectedMatrix.forEach((value,index)=>assert.ok(Math.abs(calls[0].matrix[index]-value)<1e-4,'source '+sourceTime+' playhead transform '+index));
    const expected=makeCanvas(W,H),ctx=expected.getContext('2d');
    ctx.fillStyle='#000';ctx.fillRect(0,0,W,H);
    ctx.translate(cx+W*.1,cy-H*.05);ctx.rotate(angle);ctx.scale(1.25,.75);ctx.translate(-cx,-cy);
    ctx.drawImage(source,...geometry);
    expectPixels(frame,pixels(expected),'source '+sourceTime+' pixels use the source geometry and playhead transform');
    signatures.add(signature(frame));
  }
  assert.equal(signatures.size,2,'different displayed source times produce different tracked views');
  assert.equal(JSON.stringify(clip),original,'rendering leaves tracking and keyframe data unchanged');
}));
