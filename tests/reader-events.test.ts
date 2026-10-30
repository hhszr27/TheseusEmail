import { describe, expect, it } from 'vitest';
import { elementFromEvent } from '../src/renderer/lib/reader-events';

/**
 * 正文 iframe 的 DOM 属于另一个 realm：`target instanceof Element` 在宿主里恒为 false。
 * 这里用「假对象」模拟跨 realm 的元素——它没有宿主的 Element 原型，
 * 但一样有 closest，监听器就必须认。
 */
describe('正文事件取元素（elementFromEvent）', () => {
  it('跨 realm 的元素（只有 closest）也要被接受', () => {
    const foreign = { closest: () => null, getAttribute: () => null };
    expect(elementFromEvent({ target: foreign } as unknown as Event)).toBe(foreign);
  });

  it('没有 closest 的目标（文本节点、Window 等）返回 null', () => {
    expect(elementFromEvent({ target: { nodeType: 3 } } as unknown as Event)).toBeNull();
    expect(elementFromEvent({ target: null } as unknown as Event)).toBeNull();
    expect(elementFromEvent({} as unknown as Event)).toBeNull();
    expect(elementFromEvent(null)).toBeNull();
    expect(elementFromEvent(undefined)).toBeNull();
  });
});
