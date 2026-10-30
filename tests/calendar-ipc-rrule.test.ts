import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 日历事件的两个 IPC handler 必须把 `rrule` 透传给 service。
 *
 * 曾经踩过：handler 里是**手工逐字段重建对象**（不是 `...input`），加「重复」时
 * 漏了 rrule —— 界面选了「每周」、service 也支持、库也能存，
 * 但保存后再打开永远是「不重复」，因为字段在边界上就被丢了。
 *
 * service 层测试（传对象进去）永远抓不到这种"边界丢字段"，只能靠源码契约钉住。
 */
const source = readFileSync(path.join(process.cwd(), 'src/main/ipc/index.ts'), 'utf8');

describe('日历 IPC 的 rrule 透传', () => {
  it('createEvent 与 updateEvent 两处都传 rrule', () => {
    const passes = source.match(/\.\.\.\(rrule \? \{ rrule \} : \{\}\)/g) ?? [];
    expect(passes).toHaveLength(2);
  });

  it('rrule 在边界上被归一化（频率白名单）', () => {
    expect(source).toContain('normalizeRecurrence');
    expect(source).toContain("['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']");
  });
});
