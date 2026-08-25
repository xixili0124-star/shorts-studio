// 쇼핑 쇼츠 자동 구성.
//
// 상품 소개 영상은 구조가 거의 정해져 있다.
//   상품명 걸고 -> 특징을 한 장면에 하나씩 넘기고 -> 가격 보여주고 -> 링크로 유도.
// 그 반복을 사람이 매번 손으로 짜니까 꾸준히 못 하는 것이라, 그 배치를 대신 해 준다.
//
// 여기서는 project 를 직접 채우지 않고 "무엇을 만들지" 만 계산해서 돌려준다.
// 실제 클립 생성은 파일을 다뤄야 해서 main.js 쪽에 남겨 뒀다.

import { uid } from './util.js';

const INTRO = 1.0;      // 상품명만 보여주는 도입 여유
const OUTRO = 2.6;      // 가격 + 링크 유도

/**
 * 장면 구성표를 짠다.
 * @param {{features:string[], imageCount:number, perScene:number}} input
 * @returns {{scenes:Array<{start:number,end:number,imageIndex:number,text:string,kind:string}>, total:number}}
 */
export function planScenes({ features, imageCount, perScene = 2.5 }) {
  const feats = features.filter(f => f.trim());
  const scenes = [];
  let t = 0;

  // 도입 — 첫 이미지에 상품명만
  scenes.push({ start: 0, end: INTRO + perScene, imageIndex: 0, text: '', kind: 'intro' });
  t = INTRO + perScene;

  // 특징 — 한 줄에 한 장면. 이미지가 모자라면 돌려 쓴다.
  feats.forEach((text, i) => {
    scenes.push({
      start: t,
      end: t + perScene,
      imageIndex: imageCount ? (i + 1) % imageCount : 0,
      text: text.trim(),
      kind: 'feature',
    });
    t += perScene;
  });

  // 마무리 — 가격과 링크 유도
  scenes.push({ start: t, end: t + OUTRO, imageIndex: 0, text: '', kind: 'outro' });
  t += OUTRO;

  return { scenes, total: t };
}

/**
 * 장면표를 텍스트 오버레이 목록으로 바꾼다.
 * 특징은 영상 밴드 아래, 가격은 크게 가운데 아래쪽에 둔다.
 */
export function buildOverlays({ scenes, price, was, cta }) {
  const out = [];

  for (const s of scenes) {
    if (s.kind !== 'feature' || !s.text) continue;
    out.push({
      id: uid(),
      text: s.text,
      start: s.start,
      end: s.end,
      font: '"Noto Sans KR"',
      size: 60,
      color: '#ffffff',
      stroke: '#000000',
      strokeW: 8,
      box: 'dark',
      align: 'center',
      x: 0.5,
      y: 0.76,
      anim: 'up',
    });
  }

  const outro = scenes[scenes.length - 1];
  if (price) {
    // 정가가 있으면 위에 흐리게 얹어 대비를 준다
    if (was) {
      out.push({
        id: uid(),
        text: was,
        start: outro.start,
        end: outro.end,
        font: '"Noto Sans KR"',
        size: 42,
        color: '#b9c0cc',
        stroke: '#000000',
        strokeW: 6,
        box: 'none',
        align: 'center',
        x: 0.5,
        y: 0.70,
        anim: 'fade',
      });
    }
    out.push({
      id: uid(),
      text: price,
      start: outro.start + 0.15,
      end: outro.end,
      font: '"Black Han Sans"',
      size: 108,
      color: '#ffe14d',
      stroke: '#000000',
      strokeW: 12,
      box: 'none',
      align: 'center',
      x: 0.5,
      y: 0.78,
      anim: 'pop',
    });
  }

  if (cta) {
    out.push({
      id: uid(),
      text: cta,
      start: outro.start + 0.5,
      end: outro.end,
      font: '"Noto Sans KR"',
      size: 44,
      color: '#ffffff',
      stroke: '#000000',
      strokeW: 6,
      box: 'accent',
      align: 'center',
      x: 0.5,
      y: 0.88,
      anim: 'up',
    });
  }

  return out;
}

/** 공정위 지침상 빼면 안 되는 문구. 상수로 박아 두고 지우지 못하게 한다. */
export const DISCLOSURE =
  '이 영상은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.';

export function buildCaption({ name, price, was, features, link }) {
  const lines = [];
  if (name) lines.push(name);

  const feats = features.filter(f => f.trim());
  if (feats.length) {
    lines.push('');
    for (const f of feats) lines.push(`· ${f.trim()}`);
  }

  if (price) {
    lines.push('');
    lines.push(was ? `${was} → ${price}` : price);
  }

  if (link) {
    lines.push('');
    lines.push('구매 링크');
    lines.push(link);
  }

  lines.push('');
  lines.push(DISCLOSURE);
  return lines.join('\n');
}
