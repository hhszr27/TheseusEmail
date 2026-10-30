import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { IPC } from '../src/shared/constants';

/**
 * preload 运行在沙箱里，不能 require 相对路径的额外 chunk，所以频道名是**内联**的
 * （src/preload/index.ts 顶部的 `const IPC = { ... }`）。
 *
 * 于是新增 IPC 时很容易只改了 shared/constants.ts 与主进程，忘了 preload 里那一份：
 * 运行时要么属性不存在（TypeError），要么 "No handler registered" —— 而且构建不会报错。
 * 这里把两份对齐固定下来。
 */
function channelsInPreload(): string[] {
  const file = path.resolve('src/preload/index.ts');
  const text = readFileSync(file, 'utf8');
  const start = text.indexOf('const IPC = {');
  expect(start).toBeGreaterThan(-1);
  // 结尾是 `} as const;`，不能只找 `};`——否则会一路吞到后面的 IPC_EVENTS
  const end = text.indexOf('} as const;', start);
  expect(end).toBeGreaterThan(start);
  const block = text.slice(start, end);
  return [...block.matchAll(/'([a-z0-9]+:[a-z0-9:-]+)'/gi)].map((match) => match[1] as string);
}

describe('preload 内联频道与 shared/constants 对齐', () => {
  it('preload 里的每个频道都在共享常量里定义（防止拼错或漏改）', () => {
    const known = new Set<string>(Object.values(IPC));
    const unknown = channelsInPreload().filter((channel) => !known.has(channel));
    expect(unknown).toEqual([]);
  });

  it('双击阅读窗口的两个频道两端都存在', () => {
    const channels = channelsInPreload();
    const known: string[] = Object.values(IPC);

    for (const channel of ['mail:get-email', 'window:open-reader']) {
      expect(channels).toContain(channel);
      expect(known).toContain(channel);
    }
  });
});
