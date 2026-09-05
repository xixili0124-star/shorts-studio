import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  Timeline, MIN_TIMELINE_ZOOM, MAX_TIMELINE_ZOOM, TIMELINE_OVERVIEW_ZOOM,
  normalizeTimelineZoom, isTimelineOverviewZoom, timelineBlockPixelWidth,
  timelineRulerIncrement,
} from '../public/js/timeline.js';

test('timeline zoom supports a whole three-minute short and frame-level detail',()=>{
  assert.equal(MIN_TIMELINE_ZOOM,3);
  assert.equal(MAX_TIMELINE_ZOOM,720);
  assert.equal(normalizeTimelineZoom(-20),3);
  assert.equal(normalizeTimelineZoom(2.99),3);
  assert.equal(normalizeTimelineZoom(70),70);
  assert.equal(normalizeTimelineZoom(9999),720);
});

test('overview zoom keeps every clip hit area inside its own timeline span',()=>{
  assert.equal(TIMELINE_OVERVIEW_ZOOM,18);
  assert.equal(isTimelineOverviewZoom(3),true);
  assert.equal(isTimelineOverviewZoom(17.99),true);
  assert.equal(isTimelineOverviewZoom(18),false);
  for(const duration of [3,1,.25,1/60]){
    const span=duration*MIN_TIMELINE_ZOOM,width=timelineBlockPixelWidth(duration,MIN_TIMELINE_ZOOM);
    assert.ok(width>0,`${duration}s clip remains visible`);
    assert.ok(width<=span,`${duration}s clip width ${width}px stays within ${span}px slot`);
  }
  assert.equal(timelineBlockPixelWidth(3,70),208);
  assert.equal(timelineBlockPixelWidth(.1,70),12);
});

test('overview clip markup removes the CSS minimum width and clips child hit areas',()=>{
  const html=Timeline.prototype.block.call({zoom:3,linkIds:new Set()},'graphic',{id:'g1',name:'그래픽'},0,3);
  assert.match(html,/timeline-overview-block/);
  assert.match(html,/width:7\.2(?:00000000000001)?px/);
  const css=readFileSync(new URL('../public/studio.css',import.meta.url),'utf8');
  assert.match(css,/\.timeline-block\.timeline-overview-block[^\{]*\{[^}]*min-width:0;overflow:hidden/);
  assert.match(css,/\.timeline-overview-block \.clip-settings[^\{]*\{display:none\}/);
});

test('transition chips are hidden only at overview zoom',()=>{
  const pair={
    type:'dissolve',duration:.5,start:2,center:2.25,
    left:{clip:{id:'left',name:'앞'}},right:{clip:{id:'right',name:'뒤'}},
  };
  const overview=Timeline.prototype.transitionButton.call({zoom:3},pair);
  assert.match(overview,/transition-band/);
  assert.doesNotMatch(overview,/transition-chip/);
  const detailed=Timeline.prototype.transitionButton.call({zoom:70},pair);
  assert.match(detailed,/transition-band/);
  assert.match(detailed,/transition-chip/);
});

test('ruler labels stay readable across the expanded zoom range',()=>{
  for(const zoom of [MIN_TIMELINE_ZOOM,10,18,35,70,180,MAX_TIMELINE_ZOOM]){
    const increment=timelineRulerIncrement(zoom);
    assert.ok(increment*zoom>=50,`${zoom}px/s uses only ${increment*zoom}px per label`);
  }
  assert.equal(timelineRulerIncrement(3),20);
  assert.equal(timelineRulerIncrement(720),1);
});
