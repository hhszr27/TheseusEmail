import { describe, expect, it } from 'vitest';
import {
  explicitOverride,
  isPluginEnabledForAccount,
  withoutAccount,
  type AccountOverrides,
} from '../src/shared/plugin-access';

/**
 * 账户级插件启用边界（§7.8.4、§30.5）的不变量。
 * 这里是「账户级启用唯一来源」，主进程与渲染进程共用同一份语义，
 * 任何一处判定漂移都会让被禁用的插件在账户上下文里重新生效（或反之）。
 */

describe('isPluginEnabledForAccount', () => {
  it('无账户上下文（null/undefined/空串）回落全局启用状态', () => {
    expect(isPluginEnabledForAccount(true, {}, null)).toBe(true);
    expect(isPluginEnabledForAccount(false, {}, null)).toBe(false);
    expect(isPluginEnabledForAccount(true, {}, undefined)).toBe(true);
    expect(isPluginEnabledForAccount(true, {}, '')).toBe(true);
    expect(isPluginEnabledForAccount(false, {}, '')).toBe(false);
  });

  it('无覆盖表时继承全局', () => {
    expect(isPluginEnabledForAccount(true, undefined, 'acc-1')).toBe(true);
    expect(isPluginEnabledForAccount(false, undefined, 'acc-1')).toBe(false);
  });

  it('该账户无覆盖时继承全局', () => {
    expect(isPluginEnabledForAccount(true, { 'acc-2': false }, 'acc-1')).toBe(true);
    expect(isPluginEnabledForAccount(false, { 'acc-2': true }, 'acc-1')).toBe(false);
  });

  it('全局禁用是硬开关：账户级覆盖只能进一步禁用，不能重新启用', () => {
    // 全局关、账户开 → 仍然禁用（硬开关不可被覆盖复活）
    expect(isPluginEnabledForAccount(false, { 'acc-1': true }, 'acc-1')).toBe(false);
    // 全局开、账户关 → 该账户禁用
    expect(isPluginEnabledForAccount(true, { 'acc-1': false }, 'acc-1')).toBe(false);
    // 全局开、账户开 → 生效
    expect(isPluginEnabledForAccount(true, { 'acc-1': true }, 'acc-1')).toBe(true);
  });

  it('多个账户的 true 覆盖都无法复活全局已禁用的插件', () => {
    const allOn = { 'acc-1': true, 'acc-2': true } as AccountOverrides;
    expect(isPluginEnabledForAccount(false, allOn, 'acc-1')).toBe(false);
    expect(isPluginEnabledForAccount(false, allOn, 'acc-2')).toBe(false);
  });

  it('脏数据覆盖（非布尔）安全回落全局，不把非布尔值当真', () => {
    const dirty = { 'acc-1': true } as AccountOverrides;
    const dirtyAny = dirty as Record<string, unknown>;
    // 模拟被损坏 JSON 写入的数字 / 字符串覆盖
    dirtyAny['acc-2'] = 1;
    expect(isPluginEnabledForAccount(false, dirty, 'acc-2')).toBe(false);
    dirtyAny['acc-3'] = 'true';
    expect(isPluginEnabledForAccount(false, dirty, 'acc-3')).toBe(false);
    // 合法布尔覆盖仍然生效；但全局禁用仍是硬开关
    expect(isPluginEnabledForAccount(true, dirty, 'acc-1')).toBe(true);
    expect(isPluginEnabledForAccount(false, dirty, 'acc-1')).toBe(false);
  });
});

describe('explicitOverride', () => {
  it('返回显式布尔覆盖', () => {
    expect(explicitOverride({ 'acc-1': true }, 'acc-1')).toBe(true);
    expect(explicitOverride({ 'acc-1': false }, 'acc-1')).toBe(false);
  });

  it('无覆盖或覆盖表为空时返回 null（表示继承全局）', () => {
    expect(explicitOverride({}, 'acc-1')).toBe(null);
    expect(explicitOverride(undefined, 'acc-1')).toBe(null);
  });

  it('脏数据覆盖（非布尔）返回 null 而非泄漏原值', () => {
    const dirty = { 'acc-1': 1 } as unknown as AccountOverrides;
    expect(explicitOverride(dirty, 'acc-1')).toBe(null);
  });
});

describe('withoutAccount', () => {
  it('删除指定账户的覆盖，保留其余账户', () => {
    expect(withoutAccount({ 'acc-1': false, 'acc-2': true }, 'acc-1')).toEqual({ 'acc-2': true });
    expect(withoutAccount({ 'acc-1': false, 'acc-2': true }, 'acc-2')).toEqual({ 'acc-1': false });
  });

  it('账户不存在时返回未改变的副本', () => {
    expect(withoutAccount({ 'acc-1': true }, 'acc-9')).toEqual({ 'acc-1': true });
  });

  it('空覆盖表返回空对象', () => {
    expect(withoutAccount({}, 'acc-1')).toEqual({});
  });

  it('不修改入参（返回新对象）', () => {
    const input: AccountOverrides = { 'acc-1': true, 'acc-2': false };
    const result = withoutAccount(input, 'acc-1');
    expect(input).toEqual({ 'acc-1': true, 'acc-2': false });
    expect(result).not.toBe(input);
  });

  it('账户不存在时也不修改入参', () => {
    const input: AccountOverrides = { 'acc-1': true };
    const result = withoutAccount(input, 'acc-9');
    expect(input).toEqual({ 'acc-1': true });
    expect(result).not.toBe(input);
  });
});
