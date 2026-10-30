/**
 * 从事件里取元素目标。
 *
 * 正文渲染在 `sandbox="allow-same-origin"` 的 iframe 里，它的 DOM 对象来自
 * **另一个 realm**：宿主侧的 `target instanceof Element` 恒为 false。
 * 用 instanceof 判断会导致监听器永远早退（右键菜单弹不出来、链接拦不住），
 * 只能用「有没有 closest 方法」做鸭子类型判断。
 */
export function elementFromEvent(event: Event | null | undefined): Element | null {
  const target = event?.target as Element | null | undefined;
  if (!target || typeof target.closest !== 'function') return null;
  return target;
}
