/**
 * 窗口状态持久化与多显示器安全（§31.2）。
 * 纯函数：把保存的 bounds 投影到当前显示器布局上。
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DisplayLike {
  workArea: Rect;
  bounds: Rect;
}

export interface SavedWindowState extends Rect {
  isMaximized: boolean;
}

export const MIN_WINDOW_WIDTH = 960;
export const MIN_WINDOW_HEIGHT = 640;

function area(rect: Rect): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

export function intersectionArea(a: Rect, b: Rect): number {
  const left = Math.max(a.x, b.x);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const top = Math.max(a.y, b.y);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) return 0;
  return (right - left) * (bottom - top);
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

export interface NormalizeResult {
  bounds: Rect;
  isMaximized: boolean;
  /** 是否因为不在可见区域而被重新定位。 */
  relocated: boolean;
}

/**
 * 若窗口与任一显示器工作区重叠不足 50%，则回到主显示器居中。
 * 同时把尺寸限制在该显示器工作区内。
 */
export function normalizeWindowBounds(
  saved: SavedWindowState,
  displays: DisplayLike[],
  primaryIndex = 0,
): NormalizeResult {
  const fallbackDisplay: DisplayLike = {
    bounds: { x: 0, y: 0, width: 1280, height: 800 },
    workArea: { x: 0, y: 0, width: 1280, height: 800 },
  };
  const primary = displays[primaryIndex] ?? displays[0] ?? fallbackDisplay;

  const safeWidth = Math.max(MIN_WINDOW_WIDTH, Math.round(saved.width) || MIN_WINDOW_WIDTH);
  const safeHeight = Math.max(MIN_WINDOW_HEIGHT, Math.round(saved.height) || MIN_WINDOW_HEIGHT);

  const candidate: Rect = {
    x: Math.round(saved.x),
    y: Math.round(saved.y),
    width: safeWidth,
    height: safeHeight,
  };

  let bestIndex = -1;
  let bestArea = 0;
  displays.forEach((display, index) => {
    const overlap = intersectionArea(candidate, display.workArea);
    if (overlap > bestArea) {
      bestArea = overlap;
      bestIndex = index;
    }
  });

  const visibleEnough = bestArea >= area(candidate) * 0.5 && bestIndex >= 0;

  if (!visibleEnough) {
    const width = Math.min(safeWidth, primary.workArea.width);
    const height = Math.min(safeHeight, primary.workArea.height);
    return {
      bounds: {
        width,
        height,
        x: Math.round(primary.workArea.x + (primary.workArea.width - width) / 2),
        y: Math.round(primary.workArea.y + (primary.workArea.height - height) / 2),
      },
      isMaximized: saved.isMaximized,
      relocated: true,
    };
  }

  const display = displays[bestIndex] ?? primary;
  const width = Math.min(safeWidth, display.workArea.width);
  const height = Math.min(safeHeight, display.workArea.height);

  // 保持位置，但确保标题栏区域落在工作区内
  const x = clamp(candidate.x, display.workArea.x - width + 80, display.workArea.x + display.workArea.width - 80);
  const y = clamp(candidate.y, display.workArea.y, display.workArea.y + display.workArea.height - 40);

  return {
    bounds: { x, y, width, height },
    isMaximized: saved.isMaximized,
    relocated: x !== candidate.x || y !== candidate.y,
  };
}

export function defaultWindowState(): SavedWindowState {
  return { x: 0, y: 0, width: 1360, height: 860, isMaximized: false };
}
