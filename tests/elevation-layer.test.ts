/**
 * 抬升与动效令牌「应用层」（src/renderer/theme/elevation.css）— §美化。
 *
 * 为什么需要它：
 *  - 契约（contract.css）补了 --mf-shadow-1/2/3 与 --mf-duration-* /
 *    --mf-easing-standard / --mf-motion，但 styles.css 里的高频组件仍硬编码
 *    120ms ease、0.12s、--mf-shadow-panel；
 *  - 这里用一份冷样式层把这三类选择器（.dialog-card / .btn / .mail-item）统一到
 *    契约令牌，且不碰 styles.css 这个并发热区；
 *  - 直接读文件断言：令牌确实被引用、且本层不出现硬编码阴影/时长（守住契约纪律）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const css = readFileSync(
  path.resolve(__dirname, '../src/renderer/theme/elevation.css'),
  'utf-8',
);

/** 抽取某个选择器对应的规则块（选择器 + 其后的 { … }，括号配平）。 */
function ruleBlock(text: string, selector: string): string {
  const marker = `${selector} {`;
  const start = text.indexOf(marker);
  if (start < 0) throw new Error(`找不到规则：${selector}`);
  const open = text.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  throw new Error(`规则块未闭合：${selector}`);
}

const DIALOG = ruleBlock(css, '.dialog-card');
const BTN = ruleBlock(css, '.btn');
const MAIL = ruleBlock(css, '.mail-item');

describe('抬升与动效应用层 — 高频组件引用契约令牌', () => {
  it('.dialog-card 用三级抬升阴影并纳入统一过渡', () => {
    expect(DIALOG).toContain('box-shadow');
    expect(DIALOG).toContain('var(--mf-shadow-3)');
    expect(DIALOG).toContain('transition');
    expect(DIALOG).toContain('var(--mf-motion)');
  });

  it('.btn 过渡统一到快速时长 + 标准缓动', () => {
    expect(BTN).toContain('var(--mf-duration-fast)');
    expect(BTN).toContain('var(--mf-easing-standard)');
  });

  it('.mail-item 过渡统一到快速时长 + 标准缓动', () => {
    expect(MAIL).toContain('var(--mf-duration-fast)');
    expect(MAIL).toContain('var(--mf-easing-standard)');
  });
});

describe('抬升与动效应用层 — 守住契约纪律（无硬编码）', () => {
  /** 应用层规则块内不得出现硬编码阴影（rgba）或硬编码时长（<数字>ms）。 */
  function assertNoHardcoded(blockText: string, where: string): void {
    expect(blockText, `${where} 不应出现硬编码 rgba 阴影`).not.toContain('rgba(');
    expect(blockText, `${where} 不应出现硬编码 <数字>ms 时长`).not.toMatch(/\d+ms/);
  }

  it('三个规则块均无硬编码阴影/时长', () => {
    assertNoHardcoded(DIALOG, '.dialog-card');
    assertNoHardcoded(BTN, '.btn');
    assertNoHardcoded(MAIL, '.mail-item');
  });

  it('整份文件只声明这三个选择器（结构不变量）', () => {
    const selectors = ['.dialog-card', '.btn', '.mail-item'];
    for (const sel of selectors) {
      const count = css.split(`${sel} {`).length - 1;
      expect(count, `${sel} 应恰好声明一次`).toBe(1);
    }
  });
});
