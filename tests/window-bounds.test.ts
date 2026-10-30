import { describe, expect, it } from 'vitest';
import {
  normalizeWindowBounds,
  type DisplayLike,
  type SavedWindowState,
} from '../src/main/app/window-bounds';

const displays: DisplayLike[] = [
  { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
  { bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, workArea: { x: 1920, y: 0, width: 1920, height: 1040 } },
];

function state(partial: Partial<SavedWindowState>): SavedWindowState {
  return { x: 0, y: 0, width: 1360, height: 860, isMaximized: false, ...partial };
}

describe('窗口状态多显示器安全（§31.2）', () => {
  it('可见的第二显示器位置保持不变', () => {
    const result = normalizeWindowBounds(state({ x: 2000, y: 100 }), displays, 0);
    expect(result.relocated).toBe(false);
    expect(result.bounds.x).toBe(2000);
    expect(result.bounds.width).toBe(1360);
  });

  it('显示器被拔掉后拉回主显示器居中', () => {
    const result = normalizeWindowBounds(state({ x: 9000, y: 300 }), displays, 0);
    expect(result.relocated).toBe(true);
    expect(result.bounds.x).toBe(Math.round((1920 - 1360) / 2));
    expect(result.bounds.y).toBe(Math.round((1040 - 860) / 2));
  });

  it('窗口尺寸超过工作区时收敛', () => {
    const result = normalizeWindowBounds(state({ width: 4000, height: 3000 }), displays, 0);
    expect(result.bounds.width).toBe(1920);
    expect(result.bounds.height).toBe(1040);
  });

  it('小于最小尺寸时提升到下限', () => {
    const result = normalizeWindowBounds(state({ width: 200, height: 200 }), displays, 0);
    expect(result.bounds.width).toBeGreaterThanOrEqual(960);
    expect(result.bounds.height).toBeGreaterThanOrEqual(640);
  });

  it('最大化状态被保留', () => {
    const result = normalizeWindowBounds(state({ x: 2000, y: 100, isMaximized: true }), displays, 0);
    expect(result.isMaximized).toBe(true);
  });
});
