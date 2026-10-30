/**
 * 虚拟列表的 aria-activedescendant 时序（§9.3）。
 *
 * 只有当目标行已经真正渲染到 DOM 后才可以发布 active descendant；
 * 否则它会指向一个不存在的元素，屏幕阅读器无法播报。
 */
export interface VirtualItemLike {
  index: number;
}

export function computeActiveDescendant(
  selectedIndex: number | null,
  renderedItems: readonly VirtualItemLike[],
  idPrefix = 'mail-row-',
): string | undefined {
  if (selectedIndex === null || selectedIndex < 0) return undefined;
  const rendered = renderedItems.some((item) => item.index === selectedIndex);
  return rendered ? `${idPrefix}${selectedIndex}` : undefined;
}

/** 键盘移动后的目标索引（边界收敛）。 */
export function clampIndex(index: number, count: number): number {
  if (count <= 0) return -1;
  if (index < 0) return 0;
  if (index >= count) return count - 1;
  return index;
}

export function nextIndexForKey(
  key: string,
  current: number,
  count: number,
  pageSize = 10,
): number | null {
  if (count <= 0) return null;

  const isNavigationKey =
    key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End' ||
    key === 'PageDown' || key === 'PageUp';
  if (!isNavigationKey) return null;

  // 首次按键直接落到第一项
  if (current < 0) return 0;

  const base = current;
  switch (key) {
    case 'ArrowDown':
      return clampIndex(base + 1, count);
    case 'ArrowUp':
      return clampIndex(base - 1, count);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    case 'PageDown':
      return clampIndex(base + pageSize, count);
    case 'PageUp':
      return clampIndex(base - pageSize, count);
    default:
      return null;
  }
}
