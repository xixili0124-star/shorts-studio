// 모니터와 타임라인의 높이 배분입니다.
//
// 세로 영상(9:16)은 가로가 아무리 넓어도 높이가 곧 크기입니다. 타임라인 높이가
// 고정이면 화면이 낮은 노트북에서 미리보기가 손톱만 해집니다. 실제로 1366×768
// 에서 타임라인 366px · 모니터 344px 로 타임라인이 더 컸고, 미리보기 캔버스는
// 가로 772px 자리에서 130×231px 이었습니다.
//
// 그래서 경계를 사용자가 끌 수 있게 하고, 고른 높이를 기억합니다.

/** 타임라인이 제구실을 하는 최소 높이입니다. 도구 모음 45 + 눈금 27 + 트랙 두 줄 + 상태줄 22. */
export const MIN_TIMELINE = 168;
/** 화면이 아무리 커도 타임라인이 작업 공간을 다 먹지 않게 합니다. */
export const MAX_TIMELINE_RATIO = .72;
export const STORAGE_KEY = 'shorts-studio-timeline-height';

export function maxTimelineHeight(workbench) {
  if (!Number.isFinite(workbench) || workbench <= 0) return MIN_TIMELINE;
  return Math.max(MIN_TIMELINE, Math.round(workbench * MAX_TIMELINE_RATIO));
}

/** 끌어서 놓은 높이를 실제로 쓸 수 있는 값으로 다듬습니다. */
export function clampTimelineHeight(height, workbench) {
  if (!Number.isFinite(height)) return null;
  return Math.round(Math.min(maxTimelineHeight(workbench), Math.max(MIN_TIMELINE, height)));
}

/** 저장된 값은 남이 고쳐 놓았을 수도 있으므로 숫자인지부터 봅니다. */
export function readStoredHeight(raw, workbench) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return clampTimelineHeight(value, workbench);
}
