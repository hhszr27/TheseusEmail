// @vitest-environment jsdom
/**
 * ThemeView（主题/外观面板）— 采用抬升与动效令牌（§美化）。
 *
 * 为什么需要它：
 *  - ThemeView 是用户调外观的入口，但卡片此前没有阴影、没有过渡，选中态只靠一条 inset 描边，
 *    整体「平」、切换没有反馈；
 *  - 现在每张卡片按 --mf-shadow-1/2 抬升、选中卡片保留强调环并轻微上浮、切换带 --mf-motion 过渡；
 *  - 这里真渲染并钉住：令牌确实被引用、选中态的强调环没有被内联 box-shadow 覆盖丢失、
 *    点击确实下发 applyTheme。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, createElement } from 'react';
import { ThemeView } from '../src/renderer/components/ThemeView';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const h = vi.hoisted(() => {
  const THEMES = [
    { id: 'builtin:light', name: '浅色', pluginId: null },
    { id: 'builtin:dark', name: '深色', pluginId: null },
    { id: 'plugin:acme', name: 'Acme', pluginId: 'acme' },
  ];
  const applyTheme = vi.fn();
  const setView = vi.fn();
  const makeState = () => ({
    themeId: 'builtin:light',
    applyTheme,
    setView,
    pluginSnapshot: { themes: THEMES },
  });
  return { THEMES, applyTheme, setView, makeState };
});

vi.mock('../src/renderer/stores/mail-store', () => ({
  useMailStore: (selector: (s: ReturnType<typeof h.makeState>) => unknown) =>
    selector(h.makeState()),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function cards(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('.theme-card'));
}

describe('ThemeView — 外观面板的抬升与动效（§美化）', () => {
  it('按插件快照渲染所有主题卡片', async () => {
    await act(async () => {
      root.render(createElement(ThemeView));
      await Promise.resolve();
    });
    expect(cards().length).toBe(h.THEMES.length);
  });

  it('当前主题卡片 aria-pressed=true 且标注「使用中」', async () => {
    await act(async () => {
      root.render(createElement(ThemeView));
      await Promise.resolve();
    });
    const active = cards().find((c) => c.getAttribute('aria-pressed') === 'true');
    expect(active).not.toBeNull();
    expect(active?.textContent).toContain('浅色');
    expect(active?.textContent).toContain('使用中');
  });

  it('每张卡片引用抬升阴影与统一过渡令牌', async () => {
    await act(async () => {
      root.render(createElement(ThemeView));
      await Promise.resolve();
    });
    for (const card of cards()) {
      expect(card.style.transition).toContain('var(--mf-motion)');
      expect(card.style.boxShadow).toContain('var(--mf-shadow-');
    }
  });

  it('选中卡片抬到二级阴影并保留强调环（inset），未选中用一级阴影', async () => {
    await act(async () => {
      root.render(createElement(ThemeView));
      await Promise.resolve();
    });
    const active = cards().find((c) => c.getAttribute('aria-pressed') === 'true')!;
    const inactive = cards().find((c) => c.getAttribute('aria-pressed') !== 'true')!;
    expect(active.style.boxShadow).toContain('var(--mf-shadow-2)');
    expect(active.style.boxShadow).toContain('inset');
    expect(active.style.transform).toBe('translateY(-2px)');
    expect(inactive.style.boxShadow).toContain('var(--mf-shadow-1)');
    expect(inactive.style.boxShadow).not.toContain('inset');
    expect(inactive.style.transform).toBe('none');
  });

  it('点击卡片下发 applyTheme(themeId)', async () => {
    await act(async () => {
      root.render(createElement(ThemeView));
      await Promise.resolve();
    });
    const dark = cards().find((c) => c.textContent?.includes('深色'))!;
    await act(async () => {
      dark.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(h.applyTheme).toHaveBeenCalledWith('builtin:dark');
  });
});
