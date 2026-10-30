import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandDefinition } from '../src/shared/types';
import {
  isPluginEnabledForAccount,
  withoutAccount,
} from '../src/shared/plugin-access';
import {
  collectMenuItems,
  evaluateWhen,
  missingPermissionFor,
  type MenuSourcePlugin,
} from '../src/main/plugins/menu-registry';
import { normalizeDraftContext, normalizeDraftPatch } from '../src/main/plugins/draft';
import { parseOverrides, PluginsRepo } from '../src/main/db/repositories/plugins-repo';
import { purgeAccountData } from '../src/main/accounts/purge';
import { createTestDb, insertAccount, type TestDb } from './helpers/test-db';

describe('when 表达式求值（§13.3.1）', () => {
  const ctx = { readerView: true, hasSelection: false, accountDisabled: true };

  it('支持布尔变量与取反', () => {
    expect(evaluateWhen('readerView', ctx)).toBe(true);
    expect(evaluateWhen('hasSelection', ctx)).toBe(false);
    expect(evaluateWhen('!hasSelection', ctx)).toBe(true);
    expect(evaluateWhen('!readerView', ctx)).toBe(false);
  });

  it('支持 && 与 || 及优先级', () => {
    expect(evaluateWhen('readerView && hasSelection', ctx)).toBe(false);
    expect(evaluateWhen('readerView || hasSelection', ctx)).toBe(true);
    expect(evaluateWhen('hasSelection || readerView && accountDisabled', ctx)).toBe(true);
    expect(evaluateWhen('(hasSelection || readerView) && accountDisabled', ctx)).toBe(true);
    expect(evaluateWhen('hasSelection && !accountDisabled', ctx)).toBe(false);
  });

  it('未知变量与语法错误一律不满足', () => {
    expect(evaluateWhen('unknownFlag', ctx)).toBe(false);
    expect(evaluateWhen('readerView && unknownFlag', ctx)).toBe(false);
    expect(evaluateWhen('readerView &&', ctx)).toBe(false);
    expect(evaluateWhen('&& readerView', ctx)).toBe(false);
    expect(evaluateWhen('readerView & hasSelection', ctx)).toBe(false);
    expect(evaluateWhen('readerView;alert(1)', ctx)).toBe(false);
    expect(evaluateWhen('readerView hasSelection', ctx)).toBe(false);
    expect(evaluateWhen('', ctx)).toBe(false);
  });

  it('缺省 when 视为满足', () => {
    expect(evaluateWhen(undefined, ctx)).toBe(true);
  });
});

describe('账户级插件启用（§7.8.4）', () => {
  it('无覆盖时继承全局状态', () => {
    expect(isPluginEnabledForAccount(true, undefined, 'acc-1')).toBe(true);
    expect(isPluginEnabledForAccount(false, {}, 'acc-1')).toBe(false);
  });

  it('账户级覆盖只能进一步禁用；全局禁用是硬开关', () => {
    expect(isPluginEnabledForAccount(true, { 'acc-1': false }, 'acc-1')).toBe(false);
    // 全局已禁用：账户级 true 不能重新启用（硬开关）
    expect(isPluginEnabledForAccount(false, { 'acc-1': true }, 'acc-1')).toBe(false);
    expect(isPluginEnabledForAccount(false, { 'acc-1': true }, 'acc-2')).toBe(false);
  });

  it('没有账户上下文时按全局状态', () => {
    expect(isPluginEnabledForAccount(true, { 'acc-1': false }, null)).toBe(true);
  });

  it('删除账户时只移除该账户的覆盖', () => {
    expect(withoutAccount({ 'acc-1': false, 'acc-2': true }, 'acc-1')).toEqual({ 'acc-2': true });
  });
});

function plugin(overrides: Partial<MenuSourcePlugin> = {}): MenuSourcePlugin {
  return {
    id: 'demo',
    name: 'Demo',
    enabled: true,
    permissions: ['read:email-meta'],
    commands: [],
    ...overrides,
  };
}

describe('菜单项收集（§13.3.1）', () => {
  const commands: CommandDefinition[] = [
    { id: 'translate', label: '翻译选中内容', menu: 'context:reader', when: 'hasSelection' },
    { id: 'archive', label: '归档此账户', menu: 'context:account' },
    { id: 'panel', label: '打开面板', menu: 'main' },
    { id: 'export', label: '导出', menu: 'main', requires: 'write:draft' },
    { id: 'palette-only', label: '仅命令面板' },
  ];

  it('只返回目标区域且 when 满足的项', () => {
    const items = collectMenuItems([plugin({ commands })], 'context:reader', {
      context: { hasSelection: true },
    });
    expect(items.map((item) => item.commandId)).toEqual(['translate']);

    const hidden = collectMenuItems([plugin({ commands })], 'context:reader', {
      context: { hasSelection: false },
    });
    expect(hidden).toEqual([]);
  });

  it('缺少权限的项仍然返回并标记', () => {
    const items = collectMenuItems([plugin({ commands })], 'main', {
      revoked: new Map([['demo', new Set(['write:draft' as const])]]),
    });
    const exportItem = items.find((item) => item.commandId === 'export');
    expect(exportItem?.missingPermission).toBe('write:draft');

    const missing = missingPermissionFor(commands[3] as CommandDefinition, [], undefined);
    expect(missing).toBe('write:draft');
  });

  it('账户级禁用隐藏上下文菜单但保留主菜单项', () => {
    const overrides = new Map([['demo', { 'acc-1': false }]]);
    const account = collectMenuItems([plugin({ commands })], 'context:account', {
      accountId: 'acc-1',
      overrides,
    });
    expect(account).toEqual([]);

    const other = collectMenuItems([plugin({ commands })], 'context:account', {
      accountId: 'acc-2',
      overrides,
    });
    expect(other.map((item) => item.commandId)).toEqual(['archive']);

    const main = collectMenuItems([plugin({ commands })], 'main', {
      accountId: 'acc-1',
      overrides,
    });
    expect(main.map((item) => item.commandId)).toContain('panel');
  });

  it('禁用插件不产生菜单项', () => {
    expect(
      collectMenuItems([plugin({ enabled: false, commands })], 'main', {}),
    ).toEqual([]);
  });
});

describe('草稿补丁校验（§13.4）', () => {
  it('接受合法补丁', () => {
    const result = normalizeDraftPatch({
      subject: '你好',
      body: '正文',
      to: [{ address: 'a@example.com' }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.patch.to).toEqual([{ address: 'a@example.com' }]);
  });

  it('拒绝非法地址与空补丁', () => {
    expect(normalizeDraftPatch({ to: [{ address: 'not-an-address' }] }).ok).toBe(false);
    expect(normalizeDraftPatch({ to: 'a@example.com' }).ok).toBe(false);
    expect(normalizeDraftPatch({}).ok).toBe(false);
    expect(normalizeDraftPatch(null).ok).toBe(false);
  });

  it('拒绝超长正文', () => {
    expect(normalizeDraftPatch({ body: 'x'.repeat(500_001) }).ok).toBe(false);
  });

  it('草稿快照必须有账户且地址合法', () => {
    expect(
      normalizeDraftContext({
        accountId: 'acc-1',
        subject: 's',
        to: [{ address: 'a@example.com' }],
        cc: [],
        body: 'b',
      }),
    ).toMatchObject({ accountId: 'acc-1', subject: 's' });
    expect(normalizeDraftContext({ subject: 's', to: [], cc: [], body: '' })).toBeNull();
    expect(
      normalizeDraftContext({
        accountId: 'acc-1',
        to: [{ address: 'bad' }],
        cc: [],
        body: '',
      }),
    ).toBeNull();
  });
});

describe('账户覆盖持久化（§7.8.4）', () => {
  let context: TestDb;

  beforeEach(() => {
    context = createTestDb();
    insertAccount(context.db, 'acc-1');
    insertAccount(context.db, 'acc-2');
  });

  afterEach(() => {
    context.cleanup();
  });

  it('写入、读取与恢复继承', () => {
    const repo = new PluginsRepo(context.db);
    repo.setAccountOverride('demo', 'acc-1', false);
    repo.setAccountOverride('demo', 'acc-2', true);
    expect(repo.accountOverridesFor('demo')).toEqual({ 'acc-1': false, 'acc-2': true });

    repo.setAccountOverride('demo', 'acc-1', null);
    expect(repo.accountOverridesFor('demo')).toEqual({ 'acc-2': true });
    expect(repo.loadAccountOverrides().get('demo')).toEqual({ 'acc-2': true });
  });

  it('clearAccount 只清除目标账户', () => {
    const repo = new PluginsRepo(context.db);
    repo.setAccountOverride('demo', 'acc-1', false);
    repo.setAccountOverride('demo', 'acc-2', false);
    expect(repo.clearAccount('acc-1')).toBe(1);
    expect(repo.accountOverridesFor('demo')).toEqual({ 'acc-2': false });
  });

  it('损坏的 JSON 视为没有覆盖', () => {
    expect(parseOverrides('{bad')).toEqual({});
    expect(parseOverrides('[]')).toEqual({});
    expect(parseOverrides(null)).toEqual({});
  });

  it('删除账户时清理插件覆盖（§7.8.5 第 12 步）', async () => {
    const repo = new PluginsRepo(context.db);
    repo.setAccountOverride('demo', 'acc-1', false);
    repo.setAccountOverride('demo', 'acc-2', false);

    const result = await purgeAccountData(context.db, 'acc-1');
    expect(result.failedSteps).toEqual([]);
    expect(repo.accountOverridesFor('demo')).toEqual({ 'acc-2': false });
  });
});
