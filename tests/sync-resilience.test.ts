import { describe, expect, it } from 'vitest';
import { AccountManager } from '../src/main/mail/account-manager';
import type { Account } from '../src/shared/types';

/**
 * 手动刷新会遍历账户下所有文件夹。任何单个文件夹失败（服务器回 NO、网络抖动、
 * 容器目录不可选）都不应中断整轮刷新——否则后面的文件夹永远不会同步，
 * 用户只看到第一处错误。
 *
 * 这里把网络层替换成桩，只验证调度逻辑：失败的文件夹被记录，其余照常同步。
 */

const ACCOUNT = {
  id: 'acc-1',
  displayName: 'acc',
  email: 'me@example.com',
  protocol: 'imap-smtp',
  auth: { type: 'password', secretRef: 'ref' },
  settings: {},
  enabled: true,
  order: 0,
  lastSyncAt: 0,
  authState: 'ok',
  createdAt: 0,
} as unknown as Account;

function buildManager(
  folderPaths: string[],
  sync: (folder: string) => Promise<void>,
): { manager: AccountManager; calls: string[] } {
  const calls: string[] = [];
  const manager = new AccountManager({
    db: {} as never,
    accounts: {} as never,
    folders: {
      list: () => folderPaths.map((path) => ({ path })),
      getState: () => undefined,
    } as never,
    emails: {} as never,
    secrets: {} as never,
    emitSyncState: () => {},
  });

  // 假句柄：让 refreshAccount 不去 spawn 真实 worker
  (manager as unknown as { handles: Map<string, unknown> }).handles.set(ACCOUNT.id, {});
  (manager as unknown as { refreshFolders: () => Promise<void> }).refreshFolders = async () => {};
  (
    manager as unknown as { syncFolder: (a: Account, f: string) => Promise<void> }
  ).syncFolder = async (_account, folder) => {
    calls.push(folder);
    await sync(folder);
  };

  return { manager, calls };
}

describe('手动刷新的容错（AccountManager.refreshAccount）', () => {
  it('单个文件夹失败不中断整轮：其余文件夹照常同步', async () => {
    const { manager, calls } = buildManager(['INBOX', '其他文件夹', 'Sent Messages'], (folder) =>
      folder === '其他文件夹' ? Promise.reject(new Error('Command failed（NO: Mailbox is not selectable）')) : Promise.resolve(),
    );

    await expect(manager.refreshAccount(ACCOUNT)).rejects.toThrow(/其他文件夹/);
    expect(calls).toEqual(['INBOX', '其他文件夹', 'Sent Messages']);
  });

  it('失败信息里带文件夹名，方便定位是哪一个', async () => {
    const { manager } = buildManager(['INBOX', '其他文件夹'], (folder) =>
      folder === '其他文件夹' ? Promise.reject(new Error('Command failed')) : Promise.resolve(),
    );

    await expect(manager.refreshAccount(ACCOUNT)).rejects.toThrow(
      '其他文件夹：Command failed',
    );
  });

  it('多个文件夹失败时给出汇总', async () => {
    const { manager } = buildManager(['A', 'B', 'C'], () => Promise.reject(new Error('boom')));

    await expect(manager.refreshAccount(ACCOUNT)).rejects.toThrow(/3 个文件夹同步失败/);
  });

  it('全部成功时不抛错', async () => {
    const { manager, calls } = buildManager(['INBOX', 'Sent Messages'], () => Promise.resolve());

    await expect(manager.refreshAccount(ACCOUNT)).resolves.toBeUndefined();
    expect(calls).toEqual(['INBOX', 'Sent Messages']);
  });

  it('演示账户直接返回，不发起连接（§演示模式）', async () => {
    const demo = { ...ACCOUNT, settings: { demoMode: true } } as unknown as Account;
    const { manager, calls } = buildManager(['INBOX'], () => Promise.resolve());

    await expect(manager.refreshAccount(demo)).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });
});
