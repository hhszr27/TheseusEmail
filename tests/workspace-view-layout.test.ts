import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 设置 / 主题 / 插件视图的栅格落位（纯 CSS 契约）。
 *
 * 事故背景：`.workspace` 的邮件视图用 `grid-template-areas: "sidebar list reader"`
 * 给 `.sidebar { grid-area: sidebar }` 提供了同名区域；而 `.workspace-view` 只写了
 * 列宽、没写 areas，于是 `grid-area: sidebar` 找不到同名线，浏览器把侧栏排到隐式
 * 栅格末尾，主视图被挤进侧栏那一列 —— 界面上就是「点设置后一片空白」。
 *
 * jsdom 不做布局，量不到坐标，所以在源码层面锁住两条不变量：
 *  1) `.workspace-view` 必须声明 `grid-template-areas: "sidebar main"`；
 *  2) `.main-view` 必须显式落在 `main` 区域。
 * 另外禁止再把列宽硬编码成 220px（那样拖宽侧栏后设置页不跟随）。
 */
const css = readFileSync(path.resolve('src/renderer/styles.css'), 'utf8');

function ruleBodies(selector: string): string[] {
  const escaped = selector
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
  const re = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g');
  const bodies: string[] = [];
  for (let match = re.exec(css); match; match = re.exec(css)) {
    bodies.push(match[1] ?? '');
  }
  return bodies;
}

describe('设置/主题/插件视图的栅格落位', () => {
  it('.workspace-view 必须定义 grid-template-areas: "sidebar main"', () => {
    const bodies = ruleBodies('.workspace-view');
    expect(bodies.length).toBeGreaterThan(0);
    const hasAreas = bodies.some((body) =>
      /grid-template-areas\s*:\s*["']sidebar\s+main["']/.test(body),
    );
    expect(hasAreas).toBe(true);
  });

  it('.main-view 必须显式落在 main 区域', () => {
    const bodies = ruleBodies('.workspace-view > .main-view');
    expect(bodies.some((body) => /grid-area\s*:\s*main\b/.test(body))).toBe(true);
  });

  it('列宽跟随 --mf-sidebar-width，不再硬编码 220px', () => {
    for (const body of ruleBodies('.workspace-view')) {
      expect(body).not.toMatch(/grid-template-columns\s*:\s*220px/);
    }
  });
});
