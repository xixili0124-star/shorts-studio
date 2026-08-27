// 영상 픽셀의 지역 탐색만 수행합니다. 모델 다운로드나 외부 요청은 없습니다.
import { grayscale, trackingTemplate, trackRectangle } from './mosaic.js';
let template;
self.onmessage = event => {
  const { id, type, pixels, width, height, rect } = event.data;
  try {
    const gray = grayscale(pixels);
    if (type === 'reset') { template = trackingTemplate(gray, width, height, rect); self.postMessage({ id, result: true }); }
    else self.postMessage({ id, result: trackRectangle(gray, width, height, template, rect) });
  } catch (error) { self.postMessage({ id, error: error.message }); }
};
