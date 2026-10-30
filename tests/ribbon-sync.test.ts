import { describe, it, expect } from 'vitest';
import { subscribeRibbonChanges } from '../src/renderer/lib/ribbon-sync';

/**
 * 跨窗口同步的接线测试。
 *
 * 守的是「脏数据不能把工具栏搞空」：主进程广播过来的 JSON 必须先过
 * parseRibbonOverrides，坏值一律回退成 null（= 用内置默认）。
 */

function fakeApi() {
  let listener: ((json: string) => void) | null = null;
  let unsubscribed = 0;
  return {
    api: {
      onRibbonChanged(callback: (json: string) => void) {
        listener = callback;
        return () => {
          unsubscribed += 1;
          listener = null;
        };
      },
    },
    emit(json: string) {
      if (!listener) throw new Error('还没有订阅');
      listener(json);
    },
    get unsubscribed() {
      return unsubscribed;
    },
  };
}

describe('subscribeRibbonChanges', () => {
  it('合法广播被解析成覆盖配置', () => {
    const fake = fakeApi();
    const seen: Array<unknown> = [];
    subscribeRibbonChanges(fake.api, (overrides) => seen.push(overrides));

    fake.emit(JSON.stringify({ hiddenTabs: ['view'], tabLabels: { mail: '邮件操作' } }));

    expect(seen.length).toBe(1);
    const value = seen[0] as { hiddenTabs?: string[]; tabLabels?: Record<string, string> };
    expect(value.hiddenTabs).toEqual(['view']);
    expect(value.tabLabels).toEqual({ mail: '邮件操作' });
  });

  it('坏 JSON 回退成 null（内置默认），不抛异常', () => {
    const fake = fakeApi();
    const seen: Array<unknown> = [];
    subscribeRibbonChanges(fake.api, (overrides) => seen.push(overrides));

    fake.emit('这不是 json');
    fake.emit('');

    expect(seen).toEqual([null, null]);
  });

  it('返回取消订阅函数并原样透传', () => {
    const fake = fakeApi();
    const unsubscribe = subscribeRibbonChanges(fake.api, () => undefined);
    expect(typeof unsubscribe).toBe('function');
    unsubscribe();
    expect(fake.unsubscribed).toBe(1);
  });
});
