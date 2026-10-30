import { describe, expect, it } from 'vitest';
import {
  computeActiveDescendant,
  nextIndexForKey,
} from '../src/renderer/lib/virtual-a11y';

describe('aria-activedescendant 渲染时序（§9.3）', () => {
  const rendered = [{ index: 3 }, { index: 4 }, { index: 5 }];

  it('目标行已渲染时发布 id', () => {
    expect(computeActiveDescendant(4, rendered)).toBe('mail-row-4');
  });

  it('目标行在视口外时不发布 id（避免指向不存在的元素）', () => {
    expect(computeActiveDescendant(40, rendered)).toBeUndefined();
  });

  it('无选中项时不发布', () => {
    expect(computeActiveDescendant(null, rendered)).toBeUndefined();
    expect(computeActiveDescendant(-1, rendered)).toBeUndefined();
  });

  it('滚动导致新行渲染后可以发布新 id', () => {
    const afterScroll = [{ index: 39 }, { index: 40 }, { index: 41 }];
    expect(computeActiveDescendant(40, afterScroll)).toBe('mail-row-40');
  });
});

describe('列表键盘导航', () => {
  it('方向键与 Home/End 收敛在边界内', () => {
    expect(nextIndexForKey('ArrowDown', 0, 10)).toBe(1);
    expect(nextIndexForKey('ArrowUp', 0, 10)).toBe(0);
    expect(nextIndexForKey('ArrowUp', 5, 10)).toBe(4);
    expect(nextIndexForKey('Home', 5, 10)).toBe(0);
    expect(nextIndexForKey('End', 5, 10)).toBe(9);
    expect(nextIndexForKey('ArrowDown', 9, 10)).toBe(9);
  });

  it('空列表返回 null', () => {
    expect(nextIndexForKey('ArrowDown', 0, 0)).toBeNull();
  });

  it('首次按键从第一项开始', () => {
    expect(nextIndexForKey('ArrowDown', -1, 10)).toBe(0);
    expect(nextIndexForKey('ArrowUp', -1, 10)).toBe(0);
  });

  it('非导航键不改变选择', () => {
    expect(nextIndexForKey('Enter', 3, 10)).toBeNull();
    expect(nextIndexForKey('a', 3, 10)).toBeNull();
  });
});
