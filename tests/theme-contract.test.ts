/**
 * 视觉契约（src/renderer/theme/contract.css）— 抬升与动效令牌层（§美化基础）。
 *
 * 为什么需要它：
 *  - 美化之前，契约里只有一个 --mf-shadow-panel，卡片/浮层缺少统一的抬升与动效语言，
 *    组件要么硬编码阴影、要么完全没有层次；
 *  - 现在补上 --mf-shadow-1/2/3 与 --mf-duration-*、--mf-easing-standard、--mf-motion，
 *    并约定「深色阴影比浅色更实（alpha 更高）」——这条如果不钉住，深色界面会「浮不起来」；
 *  - 直接读契约文件断言，既测又锁，谁改坏令牌层立刻红灯。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const css = readFileSync(
  path.resolve(__dirname, '../src/renderer/theme/contract.css'),
  'utf-8',
);

function block(text: string, marker: string): string {
  const start = text.indexOf(marker);
  if (start < 0) throw new Error(`找不到标记：${marker}`);
  const open = text.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  throw new Error(`块未闭合：${marker}`);
}

function decls(blockText: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of blockText.split('\n')) {
    const m = /^\s*(--[\w-]+)\s*:\s*(.+?)\s*;?\s*$/.exec(line);
    if (m) map.set(m[1]!, m[2]!);
  }
  return map;
}

const light = decls(block(css, ':root {'));
const dark = decls(block(css, ":root[data-theme='dark'] {"));

const SHADOWS = ['--mf-shadow-1', '--mf-shadow-2', '--mf-shadow-3'];
const DURATIONS = ['--mf-duration-fast', '--mf-duration-base', '--mf-duration-slow'];

function maxAlpha(shadow: string): number {
  const alphas = [...shadow.matchAll(/rgba\([^)]*?,\s*([\d.]+)\)/g)].map((m) =>
    parseFloat(m[1]!),
  );
  return alphas.length ? Math.max(...alphas) : 0;
}

describe('视觉契约 — 抬升与动效令牌存在于浅色与深色两套主题', () => {
  const suites: Array<[string, Map<string, string>]> = [
    ['浅色 :root', light],
    ['深色 :root[data-theme=dark]', dark],
  ];

  for (const [name, d] of suites) {
    describe(name, () => {
      for (const token of SHADOWS) {
        it(`${token} 存在且为合法阴影（含 rgba）`, () => {
          const v = d.get(token);
          expect(v, `${token} 缺失`).toBeDefined();
          expect(v).toContain('rgba(');
        });
      }
      for (const token of DURATIONS) {
        it(`${token} 存在且为合法时长（<数字>ms）`, () => {
          const v = d.get(token);
          expect(v, `${token} 缺失`).toBeDefined();
          expect(v).toMatch(/^\d+ms$/);
        });
      }
      it('--mf-easing-standard 为 cubic-bezier', () => {
        expect(d.get('--mf-easing-standard')).toMatch(/cubic-bezier\(/);
      });
      it('--mf-motion 引用 base 时长与标准缓动（不硬编码）', () => {
        const v = d.get('--mf-motion') ?? '';
        expect(v).toContain('var(--mf-duration-base)');
        expect(v).toContain('var(--mf-easing-standard)');
      });
    });
  }

  it('深色阴影比浅色更实（alpha 更高），避免深色界面浮不起来', () => {
    for (const token of SHADOWS) {
      expect(maxAlpha(dark.get(token) ?? '')).toBeGreaterThan(
        maxAlpha(light.get(token) ?? ''),
      );
    }
  });
});
