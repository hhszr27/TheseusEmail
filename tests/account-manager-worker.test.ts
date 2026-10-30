import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountManager } from '../src/main/mail/account-manager';
import type { Account } from '../src/shared/types';

/**
 * AccountManager 的 worker 生命周期（§7.6 每账户一个 worker）：
 *
 * 这两条都是「不重启应用就好不了」的问题，只有真跑调度逻辑才测得出：
 *  1. 并发 start() 会各建一个 worker——secrets.get 是异步的，
 *     handles.has 守卫在 await 之前就跑了，后写的覆盖 map，前一个 worker
 *     连同 socket/IDLE 永驻内存（表现为内存缓慢增长、连接数超标）。
 *  2. worker 崩溃后 handles 不清理——hasWorker() 一直为真，账户状态显示
 *     active，60 秒轮询每分钟静默失败一次，所有操作报「账户 worker 已终止」。
 *
 * 用注入的假 handle 观察：创建次数、退出回调、退避重连。
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

/** 假 worker 句柄：connect/close 立即成功，其余命令永远挂起（模拟启动到一半卡住）。 */
class FakeWorkerHandle {
  onMailboxChanged: ((folder: string) => void) | null = null;
  onExit: ((code: number) => void) | null = null;
  terminated = false;
  readonly requests: string[] = [];

  constructor(readonly accountId: string) {}

  async request(command: { type: string }): Promise<never> {
    this.requests.push(command.type);
    if (command.type === 'connect' || command.type === 'close') {
      return { type: 'ok' } as never;
    }
    // 永远不 resolve：让 runStart 停在 refreshFolders，handle 保持已注册
    return new Promise<never>(() => {});
  }

  async terminate(): Promise<void> {
    this.terminated = true;
  }

  emitExit(code: number): void {
    this.onExit?.(code);
  }
}

let created: FakeWorkerHandle[];
let manager: AccountManager;
let enqueued: string[];

function buildManager(): AccountManager {
  created = [];
  enqueued = [];
  return new AccountManager({
    db: {} as never,
    accounts: {
      get: (id: string) => (id === ACCOUNT.id ? ACCOUNT : null),
      setLastError: () => {},
      setAuthState: () => {},
      setDiscovery: () => {},
      setLastSync: () => {},
    } as never,
    folders: {
      list: () => [],
      getState: () => undefined,
      upsertFolder: () => {},
    } as never,
    emails: {} as never,
    secrets: { get: async () => 'secret' } as never,
    emitSyncState: () => {},
    createWorkerHandle: (accountId: string) => {
      const handle = new FakeWorkerHandle(accountId);
      created.push(handle);
      return handle as never;
    },
  });
}

/** 把重连路径的 enqueue 换成记录器：只想验证「重新入队了」，不想再跑一遍启动。 */
function recordEnqueue(target: AccountManager): void {
  (target as unknown as { enqueue: (a: Account) => void }).enqueue = (account: Account) => {
    enqueued.push(account.id);
  };
}

/** 让出事件循环，等注入的假 handle 被创建并注册进 handles。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  manager = buildManager();
});

afterEach(() => {
  vi.useRealTimers();
  for (const handle of created) handle.terminated = true;
});

describe('AccountManager worker 生命周期', () => {
  it('并发 start() 只创建一个 worker（不会泄漏第二个）', async () => {
    void manager.start(ACCOUNT);
    void manager.start(ACCOUNT);
    void manager.start(ACCOUNT);
    await flush();

    expect(created).toHaveLength(1);
    expect(manager.hasWorker(ACCOUNT.id)).toBe(true);
  });

  it('worker 退出后立刻清理 handle：账户不再假活跃', async () => {
    void manager.start(ACCOUNT);
    await flush();
    expect(manager.hasWorker(ACCOUNT.id)).toBe(true);

    recordEnqueue(manager);
    created[0]?.emitExit(1);

    expect(manager.hasWorker(ACCOUNT.id)).toBe(false);
  });

  it('worker 退出后按退避重新入队（首次 5 秒）', async () => {
    void manager.start(ACCOUNT);
    await flush();
    recordEnqueue(manager);

    created[0]?.emitExit(1);
    expect(enqueued).toEqual([]);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(enqueued).toEqual([]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(enqueued).toEqual([ACCOUNT.id]);
  });

  it('连续崩溃按指数退避：第二次要等 10 秒', async () => {
    void manager.start(ACCOUNT);
    await flush();
    recordEnqueue(manager);

    created[0]?.emitExit(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(enqueued).toEqual([ACCOUNT.id]);

    // 模拟重连后又崩：重新放一个 handle 进去再触发退出
    enqueued.length = 0;
    (manager as unknown as { handles: Map<string, unknown> }).handles.set(ACCOUNT.id, created[0]);
    created[0]?.emitExit(1);

    await vi.advanceTimersByTimeAsync(9_000);
    expect(enqueued).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(enqueued).toEqual([ACCOUNT.id]);
  });

  it('反复崩溃超过上限后放弃，并把错误写到账户上', async () => {
    const setLastError = vi.fn();
    const local = new AccountManager({
      db: {} as never,
      accounts: {
        get: (id: string) => (id === ACCOUNT.id ? ACCOUNT : null),
        setLastError,
        setAuthState: () => {},
        setDiscovery: () => {},
        setLastSync: () => {},
      } as never,
      folders: { list: () => [], getState: () => undefined } as never,
      emails: {} as never,
      secrets: { get: async () => 'secret' } as never,
      emitSyncState: () => {},
      createWorkerHandle: (accountId: string) => new FakeWorkerHandle(accountId) as never,
    });

    void local.start(ACCOUNT);
    await flush();
    const handle = (local as unknown as { handles: Map<string, FakeWorkerHandle> }).handles.get(
      ACCOUNT.id,
    );
    recordEnqueue(local);

    // 前 6 次崩溃：每次都退避重连（5s/10s/20s/40s/80s/160s，共 315s）。
    // 每次先把 handle 放回 handles，模拟「重连成功后又崩」。
    for (let i = 0; i < 6; i += 1) {
      (local as unknown as { handles: Map<string, FakeWorkerHandle> }).handles.set(
        ACCOUNT.id,
        handle as FakeWorkerHandle,
      );
      handle?.emitExit(1);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    }
    expect(enqueued).toHaveLength(6);

    // 第 7 次崩溃：超过 MAX_WORKER_RESTARTS，放弃并写错误
    (local as unknown as { handles: Map<string, FakeWorkerHandle> }).handles.set(
      ACCOUNT.id,
      handle as FakeWorkerHandle,
    );
    handle?.emitExit(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(enqueued).toHaveLength(6);
    expect(setLastError).toHaveBeenCalledWith(
      ACCOUNT.id,
      expect.objectContaining({ code: 'WORKER_EXITED' }),
    );
  });

  it('账户被删除后不再重连（disposeAccount 取消待触发的重试）', async () => {
    void manager.start(ACCOUNT);
    await flush();
    recordEnqueue(manager);
    created[0]?.emitExit(1);

    // 账户删除会走 disposeAccount：取消定时器
    await manager.disposeAccount(ACCOUNT.id);
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(enqueued).toEqual([]);
  });
});
