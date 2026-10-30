import { Worker } from 'node:worker_threads';
import path from 'node:path';
import type { Account, FolderView } from '../../shared/types';
import type { ComposeDraft, SyncStateView } from '../../shared/ipc';
import { buildDraftMessage } from './draft-message';
import { DEFAULT_PAGE_SIZE } from '../../shared/constants';
import type { Db } from '../db/open';
import type { AccountsRepo } from '../db/repositories/accounts-repo';
import type { FoldersRepo } from '../db/repositories/folders-repo';
import { emailIdFor, type EmailsRepo } from '../db/repositories/emails-repo';
import type { SecretStore } from './auth/token-store';
import { log } from '../observability/logger';
import { recordMetric } from '../observability/metrics';
import type { ImapAccountConfig, RawEmailSummary, WorkerCommand, WorkerResponse } from './sync/protocol';
import type { AttachmentStore } from '../attachments/store';

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

export class WorkerRequestError extends Error {
  readonly code: string;
  readonly transient: boolean;
  readonly authFailed: boolean;
  readonly fatal: boolean;

  constructor(info: { code: string; message: string; transient: boolean; authFailed: boolean; fatal: boolean }) {
    super(info.message);
    this.name = 'WorkerRequestError';
    this.code = info.code;
    this.transient = info.transient;
    this.authFailed = info.authFailed;
    this.fatal = info.fatal;
  }
}

interface PendingRequest {
  resolve: (value: WorkerResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function workerScriptPath(): string {
  // 主进程 bundle 位于 out/main/index.js，worker 与之同目录
  return path.join(__dirname, 'account-worker.js');
}

/** 单个账户的 worker 句柄：请求/响应 + 超时 + 崩溃清理。 */
class AccountWorkerHandle {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingRequest>();
  private sequence = 1;
  private terminated = false;

  /** IDLE 推送：服务器说收件箱有新邮件（worker 主动上报，不是请求响应）。 */
  onMailboxChanged: ((folder: string) => void) | null = null;
  /**
   * worker 进程退出（崩溃或被外部杀掉）时回调。
   * AccountManager 靠它清理 handles：否则 hasWorker() 一直为真，
   * 账户状态显示 active、每分钟的收件箱轮询静默失败，
   * 所有邮件操作报「账户 worker 已终止」，直到用户重启应用。
   */
  onExit: ((code: number) => void) | null = null;

  constructor(private readonly accountId: string) {
    this.worker = new Worker(workerScriptPath());
    this.worker.on('message', (message: unknown) => this.onMessage(message));
    this.worker.on('error', (error) => this.failAll(error));
    this.worker.on('exit', (code) => {
      this.terminated = true;
      this.failAll(new Error(`账户 worker 已退出（code=${code}）`));
      this.onExit?.(code);
    });
  }

  private onMessage(message: unknown): void {
    if (!message || typeof message !== 'object') return;
    const record = message as { id?: number; type?: string; level?: string; message?: string };

    if (record.id === 0) {
      if (record.type === 'worker-log' && record.message) {
        const level = record.level === 'warn' ? 'warn' : record.level === 'error' ? 'error' : 'info';
        log[level]('account-worker', record.message, { accountId: this.accountId });
      }
      if (record.type === 'mailbox-changed') {
        const folder = (record as { folder?: string }).folder ?? 'INBOX';
        this.onMailboxChanged?.(folder);
      }
      return;
    }

    if (typeof record.id !== 'number') return;
    const pending = this.pending.get(record.id);
    if (!pending) return;
    this.pending.delete(record.id);
    clearTimeout(pending.timer);

    if (record.type === 'error') {
      const errorRecord = record as unknown as {
        code: string;
        message: string;
        transient: boolean;
        authFailed: boolean;
        fatal: boolean;
      };
      pending.reject(
        new WorkerRequestError({
          code: errorRecord.code ?? 'unknown',
          message: errorRecord.message ?? '未知错误',
          transient: Boolean(errorRecord.transient),
          authFailed: Boolean(errorRecord.authFailed),
          fatal: Boolean(errorRecord.fatal),
        }),
      );
      return;
    }

    pending.resolve(message as WorkerResponse);
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  request<T extends WorkerResponse>(
    command: WithoutId<WorkerCommand>,
    timeoutMs: number,
  ): Promise<T> {
    if (this.terminated) {
      return Promise.reject(new Error('账户 worker 已终止'));
    }
    const id = this.sequence;
    this.sequence += 1;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`账户 worker 请求超时（${command.type}）`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });

      try {
        this.worker.postMessage({ ...command, id } as WorkerCommand);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }

  async terminate(): Promise<void> {
    this.terminated = true;
    this.failAll(new Error('账户 worker 被主动终止'));
    try {
      await this.worker.terminate();
    } catch {
      // ignore
    }
  }
}

export interface AccountManagerDeps {
  db: Db;
  accounts: AccountsRepo;
  folders: FoldersRepo;
  emails: EmailsRepo;
  secrets: SecretStore;
  emitSyncState: (state: SyncStateView) => void;
  /**
   * 正文抓取顺带拿回附件的落库入口。
   * 预取回路也必须一并写入：附件过去只在 getBody 首次抓取时才入库，
   * 于是被预取过的邮件会变成「列表标记了有附件，打开却一个都没有」。
   */
  attachments?: Pick<AttachmentStore, 'save'>;
  /** 新邮件落库后的本地处理管道（规则、联系人、通知）。 */
  onNewEmails?: (
    account: Account,
    folder: string,
    emails: RawEmailSummary[],
    options: { suppressNotifications?: boolean },
  ) => void;
  /**
   * 依赖注入：替换 AccountWorkerHandle 的创建。测试用它塞假 worker，
   * 免得真去 spawn 一个 account-worker.js（也避免在单测里连真服务器）。
   */
  createWorkerHandle?: (accountId: string) => AccountWorkerHandle;
}

/**
 * 启动后预取多少封「最近但还没有本地正文」的收件箱邮件。
 * 目的：断网也能翻历史（类似 Outlook 的 OST 缓存）；再多就变成全量下载了，先保守取值。
 */
const OFFLINE_BODY_LIMIT = 60;

/**
 * 「下载整个项目」时的正文预取上限：等同全量（受正文队列串行抓取约束，实际会分批进行）。
 */
const ENTIRE_BODY_LIMIT = 100_000;

/** 连接握手耗时超过该值即视为「低速连接」（用于 headers-only-slow 判定）。 */
const SLOW_CONNECT_MS = 4000;

/** worker 崩溃重连：首次退避 5 秒，每次翻倍，封顶 5 分钟。 */
const WORKER_RESTART_BASE_MS = 5_000;
const WORKER_RESTART_MAX_MS = 5 * 60_000;
/** 连续这么多次还起不来就放弃，把错误写到账户上让用户看到。 */
const MAX_WORKER_RESTARTS = 6;

/**
 * 账户调度器（§7.6）：每账户一个 worker，慢网络不影响其他账户与主界面。
 */
export class AccountManager {
  private readonly handles = new Map<string, AccountWorkerHandle>();
  /** 正在启动中的账户：并发 start() 搭同一趟，避免重复建 worker（见 start 注释）。 */
  private readonly starting = new Map<string, Promise<void>>();
  /** worker 崩溃重试：连续次数 + 待触发的定时器（disposeAccount 时要取消）。 */
  private readonly workerRestarts = new Map<
    string,
    { attempts: number; timer: NodeJS.Timeout | null }
  >();
  private readonly syncing = new Set<string>();
  private queue: Account[] = [];
  private activeStarts = 0;
  /** 多账户连接并发上限（§7.8.3），避免触发服务商风控。 */
  private readonly startConcurrency = 3;
  /**
   * 服务器草稿列表缓存：打开草稿箱时不必每次都去 IMAP 重新同步并逐封拉正文。
   * 带 TTL，保存/删除服务器草稿或手动刷新时失效。
   */
  private readonly serverDraftsCache = new Map<string, { at: number; drafts: ComposeDraft[] }>();
  private static readonly SERVER_DRAFTS_TTL_MS = 120_000;
  /** 每个账户是否为「低速连接」（按连接握手耗时判定，供 headers-only-slow 使用）。 */
  private readonly slowLink = new Map<string, boolean>();

  constructor(private readonly deps: AccountManagerDeps) {}

  hasWorker(accountId: string): boolean {
    return this.handles.has(accountId);
  }

  /**
   * worker 崩溃后的重试：指数退避（5s → 10s → … 封顶 5 分钟），
   * 连续 MAX_WORKER_RESTARTS 次仍起不来就放弃并把错误写到账户上——
   * 否则「起来就崩」会把调度器和日志刷爆，用户也看不到原因。
   */
  private scheduleWorkerRestart(account: Account, code: number): void {
    const current = this.workerRestarts.get(account.id);
    const attempts = (current?.attempts ?? 0) + 1;
    if (current?.timer) clearTimeout(current.timer);

    if (attempts > MAX_WORKER_RESTARTS) {
      this.workerRestarts.delete(account.id);
      const message = `账户 worker 反复退出（code=${code}），已停止自动重试`;
      log.error('account-manager', message, { accountId: account.id });
      this.deps.accounts.setLastError(account.id, {
        code: 'WORKER_EXITED',
        message,
        at: Date.now(),
      });
      this.deps.emitSyncState({
        accountId: account.id,
        folder: 'INBOX',
        level: 'L1_CHANGEDSINCE',
        needsFullResync: false,
        lastSyncAt: 0,
        syncing: false,
        error: message,
      });
      return;
    }

    const delay = Math.min(
      WORKER_RESTART_BASE_MS * 2 ** (attempts - 1),
      WORKER_RESTART_MAX_MS,
    );
    log.warn('account-manager', '账户 worker 退出，将在退避后重连', {
      accountId: account.id,
      code,
      attempts,
      delayMs: delay,
    });

    const timer = setTimeout(() => {
      // 只清定时器、保留 attempts：重连还没成功，下次崩溃要继续往上退避，
      // 否则「连上又崩」的场景永远从 5 秒重来，退避就失效了。
      const entry = this.workerRestarts.get(account.id);
      if (entry) entry.timer = null;
      // 账户可能已被删除/禁用：重新读一遍再入队
      const latest = this.deps.accounts.get(account.id);
      if (
        !latest ||
        !latest.enabled ||
        latest.authState !== 'ok' ||
        latest.lastError?.code === 'delete_pending'
      ) {
        this.workerRestarts.delete(account.id);
        return;
      }
      this.enqueue(latest);
    }, delay);
    timer.unref?.();

    this.workerRestarts.set(account.id, { attempts, timer });
  }

  isSyncing(accountId: string): boolean {
    for (const key of this.syncing) {
      if (key.startsWith(`${accountId}|`)) return true;
    }
    return false;
  }

  /** 启动时的调度（§7.8.3）：最久未同步的优先，最多 3 个并发连接。 */
  startAll(accounts: Account[]): void {
    this.queue = accounts
      .filter(
        (account) =>
          account.enabled &&
          account.authState === 'ok' &&
          account.settings.demoMode !== true &&
          account.lastError?.code !== 'delete_pending',
      )
      .sort((a, b) => (a.lastSyncAt ?? 0) - (b.lastSyncAt ?? 0) || a.order - b.order);
    this.pump();
  }

  enqueue(account: Account, prioritize = false): void {
    if (this.handles.has(account.id)) return;
    this.queue = this.queue.filter((item) => item.id !== account.id);
    if (prioritize) this.queue.unshift(account);
    else this.queue.push(account);
    this.pump();
  }

  /** 用户点击账户时插队（交互优先于后台同步）。 */
  prioritize(account: Account): void {
    this.enqueue(account, true);
  }

  cancelPending(accountId: string): void {
    this.queue = this.queue.filter((item) => item.id !== accountId);
  }

  private pump(): void {
    while (this.activeStarts < this.startConcurrency && this.queue.length > 0) {
      const account = this.queue.shift();
      if (!account) break;
      if (this.handles.has(account.id)) continue;
      this.activeStarts += 1;
      void this.start(account)
        .catch((error: Error) => {
          log.error('account-manager', '账户调度启动异常', {
            accountId: account.id,
            message: error.message,
          });
        })
        .finally(() => {
          this.activeStarts -= 1;
          this.pump();
        });
    }
  }

  async start(account: Account): Promise<void> {
    if (this.handles.has(account.id)) return;

    // 并发去重：secrets.get 是异步的，两个并发的 start() 都会越过上面的
    // handles.has 检查、各建一个 worker，后写的覆盖 map，前一个 worker
    // 连同它的 socket/IDLE 永驻内存。用 in-flight 表让后者搭上前者的同一趟。
    const inFlight = this.starting.get(account.id);
    if (inFlight) return inFlight;

    const task = this.runStart(account).finally(() => {
      this.starting.delete(account.id);
    });
    this.starting.set(account.id, task);
    return task;
  }

  private async runStart(account: Account): Promise<void> {
    if (account.auth.type !== 'password') {
      log.warn('account-manager', 'OAuth 账户登录在后续 Phase 启用', { accountId: account.id });
      return;
    }

    const secret = await this.deps.secrets.get(account.auth.secretRef);
    if (!secret) {
      log.warn('account-manager', '未找到账户凭证，跳过启动', { accountId: account.id });
      return;
    }

    const handle = this.deps.createWorkerHandle
      ? this.deps.createWorkerHandle(account.id)
      : new AccountWorkerHandle(account.id);
    // IDLE 推送到达：立刻做一次静默增量同步（有新邮件才通知界面/弹通知）
    handle.onMailboxChanged = (folder) => {
      log.info('sync', 'IDLE 推送：收件箱有变化', { accountId: account.id, folder });
      void this.syncFolder(account, folder, { quiet: true }).catch((error: Error) => {
        log.warn('sync', 'IDLE 触发的同步失败', { accountId: account.id, message: error.message });
      });
    };
    // worker 崩溃：清掉 handle 让账户状态回到「未连接」，再按退避重新入队。
    // 少了这一步，账户会一直假活跃到用户重启应用。
    handle.onExit = (code) => {
      if (this.handles.get(account.id) !== handle) return; // 已被 disposeAccount 主动收掉
      this.handles.delete(account.id);
      this.scheduleWorkerRestart(account, code);
    };
    this.handles.set(account.id, handle);

    const config: ImapAccountConfig = {
      accountId: account.id,
      host: account.imap?.host ?? '',
      port: account.imap?.port ?? 993,
      secure: account.imap?.secure ?? true,
      user: account.email,
      pass: secret,
    };

    try {
      const connectStart = Date.now();
      await handle.request({ type: 'connect', config }, 30_000);
      // 连接握手耗时反映链路质量，作为「低速连接」判定依据
      this.slowLink.set(account.id, Date.now() - connectStart > SLOW_CONNECT_MS);
      await this.refreshFolders(account, handle);
      // 启动这一轮是「补拉」：这段时间到达的邮件只登记、不弹窗，
      // 否则每次打开应用都会被一堆未读再弹一遍（用户明确要求只弹到达的那一次）
      await this.syncFolder(account, 'INBOX', { suppressNotifications: true });
      // 首轮同步完，把最近 N 封还没有正文的收件箱邮件补下来（离线可读历史）
      // 范围受「下载首选项」控制：headers-only / 低速下的 headers-only-slow 不预取
      try {
        if (this.shouldPrefetchBodies(account)) {
          this.queueBodies(
            account,
            'INBOX',
            this.deps.emails.missingBodies(account.id, 'INBOX', this.bodyPrefetchLimit(account)),
          );
        }
      } catch (error) {
        log.warn('sync', '正文预取排入失败', {
          accountId: account.id,
          message: (error as Error).message,
        });
      }
      this.deps.accounts.setLastSync(account.id, Date.now());
      this.deps.accounts.setLastError(account.id, null);
      // 连上了：崩溃重连计数归零，下次崩溃再从 5 秒退避开始
      const restart = this.workerRestarts.get(account.id);
      if (restart?.timer) clearTimeout(restart.timer);
      this.workerRestarts.delete(account.id);
    } catch (error) {
      const requestError = error instanceof WorkerRequestError ? error : null;
      if (requestError?.authFailed) {
        this.deps.accounts.setAuthState(account.id, 'requires_reauth');
        log.warn('account-manager', '认证失败，标记 requires_reauth', { accountId: account.id });
      }
      this.deps.accounts.setLastError(account.id, {
        code: requestError?.authFailed ? 'AUTH_FAILED' : 'SYNC_FAILED',
        message: (error as Error).message,
        at: Date.now(),
      });
      log.error('account-manager', '账户启动失败', {
        accountId: account.id,
        message: (error as Error).message,
      });
      this.deps.emitSyncState({
        accountId: account.id,
        folder: 'INBOX',
        level: 'L1_CHANGEDSINCE',
        needsFullResync: false,
        lastSyncAt: 0,
        syncing: false,
        error: (error as Error).message,
      });
      await this.disposeAccount(account.id);
    }
  }

  private async refreshFolders(account: Account, handle: AccountWorkerHandle): Promise<void> {
    const response = await handle.request<Extract<WorkerResponse, { type: 'folders' }>>(
      { type: 'list-folders' },
      45_000,
    );

    this.deps.accounts.setDiscovery(
      account.id,
      response.namespacePrefix ?? null,
      response.delimiter ?? null,
    );

    for (const folder of response.folders) {
      this.deps.folders.upsertFolder(account.id, {
        path: folder.path,
        name: folder.name,
        delimiter: folder.delimiter,
        ...(folder.specialUse ? { specialUse: folder.specialUse } : {}),
        ...(folder.specialUseSource ? { specialUseSource: folder.specialUseSource } : {}),
      });
    }

    for (const warning of response.warnings) {
      log.warn('folder-discovery', warning, { accountId: account.id });
    }

    log.info('account-manager', '文件夹发现完成', {
      accountId: account.id,
      count: response.folders.length,
      warnings: response.warnings.length,
    });
  }

  /**
   * @param options.quiet 后台轮询用：没有新邮件就不发状态事件，
   *   避免每分钟把「正在同步」和列表重载刷一遍；有新邮件才通知界面刷新。
   */
  async syncFolder(
    account: Account,
    folder: string,
    options: { quiet?: boolean; suppressNotifications?: boolean } = {},
  ): Promise<void> {
    const key = `${account.id}|${folder}`;
    if (this.syncing.has(key)) return;

    const handle = this.handles.get(account.id);
    if (!handle) {
      throw new Error('账户尚未连接，无法同步');
    }

    this.syncing.add(key);
    if (!options.quiet) {
      this.deps.emitSyncState({
        accountId: account.id,
        folder,
        level: this.deps.folders.getState(account.id, folder)?.capabilityLevel ?? 'L1_CHANGEDSINCE',
        needsFullResync: false,
        lastSyncAt: Date.now(),
        syncing: true,
      });
    }

    try {
      let state = this.deps.folders.getState(account.id, folder);
      const maxUidBefore = this.deps.emails.maxUid(account.id, folder);

      if (state?.needsFullResync) {
        // 上次级联失效中断：先清理本地残留，再重新同步
        log.warn('sync', '检测到 needsFullResync，执行本地清理', {
          accountId: account.id,
          folder,
        });
        this.deps.emails.cascadeInvalidateFolder(account.id, folder, 0);
        state = this.deps.folders.getState(account.id, folder);
      }

      const response = await handle.request<
        Extract<WorkerResponse, { type: 'sync-result' | 'sync-skipped' }>
      >(
        {
          type: 'sync-folder',
          folder,
          uidValidity: state?.uidValidity ?? 0,
          ...(state?.highestModseq ? { highestModseq: state.highestModseq } : {}),
          highestUid: this.deps.emails.maxUid(account.id, folder),
          capabilityLevel: state?.capabilityLevel ?? 'L1_CHANGEDSINCE',
          lastSyncAt: state?.lastSyncAt ?? 0,
          limit: DEFAULT_PAGE_SIZE,
        },
        180_000,
      );

      // \Noselect 容器目录（或服务器上已删除的文件夹）：跳过，不当成账户错误
      if (response.type === 'sync-skipped') {
        const skipped = this.deps.folders.getState(account.id, folder);
        log.warn('sync', '文件夹不可选，跳过同步', {
          accountId: account.id,
          folder,
          reason: response.reason,
        });
        this.deps.emitSyncState({
          accountId: account.id,
          folder,
          level: skipped?.capabilityLevel ?? 'L1_CHANGEDSINCE',
          needsFullResync: skipped?.needsFullResync ?? false,
          lastSyncAt: skipped?.lastSyncAt ?? 0,
          syncing: false,
        });
        return;
      }

      if (response.reset && state && state.uidValidity > 0) {
        log.warn('sync', 'UIDVALIDITY 变更，执行全量级联失效', {
          accountId: account.id,
          folder,
          from: state.uidValidity,
          to: response.uidValidity,
        });
        try {
          this.deps.emails.cascadeInvalidateFolder(account.id, folder, response.uidValidity);
        } catch (error) {
          this.deps.folders.setNeedsFullResync(account.id, folder, true);
          log.error('sync', '级联失效失败，已标记 needsFullResync', {
            accountId: account.id,
            folder,
            message: (error as Error).message,
          });
          throw error;
        }
      }

      this.deps.emails.upsertMany(account.id, folder, response.uidValidity, response.emails);

      const baseline = response.reset ? 0 : maxUidBefore;
      const newEmails = response.emails.filter((email) => email.uid > baseline);
      if (newEmails.length > 0) {
        // 新邮件立刻排正文预取：断网后也能读（受「下载首选项」控制，headers-only 类不预取）
        if (this.shouldPrefetchBodies(account)) {
          this.queueBodies(
            account,
            folder,
            newEmails.map((email) => ({ id: emailIdFor(account.id, folder, email.uid), uid: email.uid })),
          );
        }
        try {
          this.deps.onNewEmails?.(account, folder, newEmails, {
            // reset 表示这把是整箱重读（UIDVALIDITY 变化等），里面全是旧邮件，一律不弹
            suppressNotifications: options.suppressNotifications === true || response.reset === true,
          });
        } catch (error) {
          log.warn('sync', '新邮件本地处理失败', { message: (error as Error).message });
        }
      }

      this.deps.folders.updateAfterSync(account.id, folder, {
        uidValidity: response.uidValidity,
        highestModseq: response.highestModseq ?? null,
        uidNext: response.uidNext ?? null,
        capabilityLevel: response.capabilityLevel,
        lastSyncAt: Date.now(),
        needsFullResync: false,
      });

      this.deps.accounts.setLastSync(account.id, Date.now());
      this.deps.accounts.setLastError(account.id, null);

      if (response.downgraded) {
        log.warn('sync', 'sync.capability_downgrade', {
          accountId: account.id,
          folder,
          from: response.downgraded.from,
          to: response.downgraded.to,
          reason: response.downgraded.reason,
        });
      }

      if (!options.quiet || newEmails.length > 0 || response.reset) {
        this.deps.emitSyncState({
          accountId: account.id,
          folder,
          level: response.capabilityLevel,
          needsFullResync: false,
          lastSyncAt: Date.now(),
          syncing: false,
        });
      }

      log.info('sync', '同步完成', {
        accountId: account.id,
        folder,
        fetched: response.emails.length,
        level: response.capabilityLevel,
        reset: response.reset,
      });

      try {
        const queue = this.deps.db
          .prepare("SELECT COUNT(*) AS c FROM outbox WHERE status = 'pending'")
          .get() as { c: number };
        recordMetric('sync_queue', {
          accountId: account.id,
          folder,
          pending: queue.c,
        });
      } catch {
        // 指标失败不影响同步
      }
    } catch (error) {
      const requestError = error instanceof WorkerRequestError ? error : null;
      if (requestError?.authFailed) {
        this.deps.accounts.setAuthState(account.id, 'requires_reauth');
      }
      // 文案里带文件夹名：一轮刷新会遍历十几个文件夹，光看「Command failed」定位不到是谁
      const message = `${folder}：${(error as Error).message}`;
      this.deps.accounts.setLastError(account.id, {
        code: requestError?.authFailed ? 'AUTH_FAILED' : 'SYNC_FAILED',
        message,
        at: Date.now(),
      });
      if (!options.quiet) {
        this.deps.emitSyncState({
          accountId: account.id,
          folder,
          level: this.deps.folders.getState(account.id, folder)?.capabilityLevel ?? 'L1_CHANGEDSINCE',
          needsFullResync: this.deps.folders.getState(account.id, folder)?.needsFullResync ?? false,
        lastSyncAt: this.deps.folders.getState(account.id, folder)?.lastSyncAt ?? 0,
          syncing: false,
          error: message,
        });
      }
      throw error;
    } finally {
      this.syncing.delete(key);
    }
  }

  // ---- 正文预取（离线也能读历史）----

  /**
   * 是否按「下载首选项」自动预取正文。
   * - headers-only：从不预取
   * - headers-only-slow：仅当链路不慢时预取
   * - entire / headers-then-item：预取
   */
  private shouldPrefetchBodies(account: Account): boolean {
    // 实时读取已持久化的设置：改「下载首选项」不必重启账户 worker 即生效
    const preference =
      this.deps.accounts.get(account.id)?.settings.downloadPreference ?? 'headers-then-item';
    if (preference === 'headers-only') return false;
    if (preference === 'headers-only-slow') return this.slowLink.get(account.id) !== true;
    return true;
  }

  /** 预取范围：下载整个项目=全量，其余=最近 N 封。 */
  private bodyPrefetchLimit(account: Account): number {
    const preference = this.deps.accounts.get(account.id)?.settings.downloadPreference;
    return preference === 'entire' ? ENTIRE_BODY_LIMIT : OFFLINE_BODY_LIMIT;
  }

  private bodyQueue: Array<{ account: Account; folder: string; uid: number; emailId: string }> = [];
  private bodyPumping = false;

  /** 把一批邮件排进正文预取队列；同一封只排一次。 */
  private queueBodies(
    account: Account,
    folder: string,
    items: Array<{ id: string; uid: number }>,
  ): void {
    for (const item of items) {
      if (this.bodyQueue.some((job) => job.emailId === item.id)) continue;
      this.bodyQueue.push({ account, folder, uid: item.uid, emailId: item.id });
    }
    void this.pumpBodies();
  }

  /** 串行抓正文：一节一节来，失败（离线/超时）就跳过，下次同步再排。 */
  private async pumpBodies(): Promise<void> {
    if (this.bodyPumping) return;
    this.bodyPumping = true;
    let fetched = 0;
    let failed = 0;
    try {
      while (this.bodyQueue.length > 0) {
        const job = this.bodyQueue.shift();
        if (!job) break;
        if (!this.handles.has(job.account.id)) {
          this.bodyQueue = [];
          break;
        }
        try {
          const body = await this.fetchBody(job.account.id, job.folder, job.uid);
          this.deps.emails.saveBody(job.emailId, body.html, body.text);
          // 预取回的同一份响应里也带着附件字节，这里不写就再没机会补：
          // 之后 getBody 命中缓存会跳过抓取，这些邮件的附件将永远进不了库。
          if (this.deps.attachments && body.attachments.length > 0) {
            try {
              this.deps.attachments.save(job.emailId, body.attachments);
            } catch (error) {
              log.warn('sync', '预取附件落库失败', {
                emailId: job.emailId,
                message: (error as Error).message,
              });
            }
          }
          fetched += 1;
        } catch {
          // 离线、超时、邮件已被删：都只是「这次没补上」，不打扰用户
          failed += 1;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    } finally {
      this.bodyPumping = false;
      if (fetched > 0 || failed > 0) {
        log.info('sync', '正文预取结束', { fetched, failed });
      }
    }
  }

  async fetchBody(
    accountId: string,
    folder: string,
    uid: number,
  ): Promise<{
    html: string | null;
    text: string | null;
    attachments: Array<{ filename: string; mimeType: string; size: number; content: Uint8Array }>;
  }> {
    const handle = this.handles.get(accountId);
    if (!handle) throw new Error('账户尚未连接，无法获取正文');
    const response = await handle.request<Extract<WorkerResponse, { type: 'body' }>>(
      { type: 'fetch-body', folder, uid },
      90_000,
    );
    return {
      html: response.html,
      text: response.text,
      attachments: response.attachments.map((item) => ({
        filename: item.filename,
        mimeType: item.mimeType,
        size: item.size,
        content: item.content ?? new Uint8Array(),
      })),
    };
  }

  /** 标志写入（§8）：\Seen（读/未读）、\Flagged（星标）。 */
  async setMessageFlags(
    account: Account,
    folder: string,
    uid: number,
    add: string[],
    remove: string[],
  ): Promise<void> {
    if (add.length === 0 && remove.length === 0) return;
    const handle = this.handles.get(account.id) ?? (await this.ensureHandle(account));
    await handle.request<Extract<WorkerResponse, { type: 'action-done' }>>(
      { type: 'set-flags', folder, uid, add, remove },
      30_000,
    );
  }

  /** 移动/归档一封邮件；服务端不支持 MOVE 时由 imapflow 退化处理。 */
  async moveMessage(
    account: Account,
    folder: string,
    uid: number,
    target: string,
  ): Promise<void> {
    const handle = this.handles.get(account.id) ?? (await this.ensureHandle(account));
    await handle.request<Extract<WorkerResponse, { type: 'action-done' }>>(
      { type: 'move', folder, uid, target },
      60_000,
    );
  }

  async deleteMessage(account: Account, folder: string, uid: number): Promise<void> {
    const handle = this.handles.get(account.id) ?? (await this.ensureHandle(account));
    await handle.request<Extract<WorkerResponse, { type: 'action-done' }>>(
      { type: 'delete', folder, uid },
      60_000,
    );
  }

  /** 在服务端新建文件夹，成功后立刻重发现文件夹，让侧栏马上出现。 */
  async createFolder(account: Account, path: string): Promise<void> {
    const handle = this.handles.get(account.id) ?? (await this.ensureHandle(account));
    await handle.request<Extract<WorkerResponse, { type: 'folder-done' }>>(
      { type: 'create-folder', path },
      30_000,
    );
    await this.refreshFolders(account, handle);
  }

  /**
   * 整文件夹标为已读（服务端）。本地已经先改好了，这里只做尽力同步：
   * 没连接就跳过，等下次同步以服务端为准。
   */
  async markFolderRead(account: Account, folder: string): Promise<void> {
    const handle = this.handles.get(account.id);
    if (!handle) return;
    await handle.request<Extract<WorkerResponse, { type: 'folder-done' }>>(
      { type: 'mark-folder-read', folder },
      60_000,
    );
  }

  /** 服务端改名/移动文件夹；成功后才做本地级联（含子文件夹的前缀迁移）。 */
  async renameFolder(account: Account, oldPath: string, newPath: string): Promise<void> {
    const handle = this.handles.get(account.id) ?? (await this.ensureHandle(account));
    await handle.request<Extract<WorkerResponse, { type: 'folder-done' }>>(
      { type: 'rename-folder', path: oldPath, newPath },
      60_000,
    );
    const delimiter = this.deps.folders.getState(account.id, oldPath)?.delimiter ?? '/';
    this.deps.folders.renameFolder(account.id, oldPath, newPath, delimiter);
    await this.refreshFolders(account, handle);
  }

  /** 服务端删除文件夹；成功后清本地邮件、索引与同步状态（含子文件夹）。 */
  async deleteFolder(
    account: Account,
    path: string,
  ): Promise<{ folders: number; emails: number }> {
    const handle = this.handles.get(account.id) ?? (await this.ensureHandle(account));
    await handle.request<Extract<WorkerResponse, { type: 'folder-done' }>>(
      { type: 'delete-folder', path },
      60_000,
    );
    const delimiter = this.deps.folders.getState(account.id, path)?.delimiter ?? '/';
    const removed = this.deps.folders.removeFolder(account.id, path, delimiter);
    await this.refreshFolders(account, handle);
    return removed;
  }

  /** 清空文件夹（uids 为空 = 整箱）。服务端先删，调用方随后清本地。 */
  async clearFolderMessages(account: Account, folder: string, uids?: number[]): Promise<number> {
    const handle = this.handles.get(account.id) ?? (await this.ensureHandle(account));
    const response = await handle.request<Extract<WorkerResponse, { type: 'folder-done' }>>(
      { type: 'clear-folder', folder, ...(uids && uids.length > 0 ? { uids } : {}) },
      180_000,
    );
    return response.removed ?? 0;
  }

  /** 复制文件夹（建目标 + 复制全部邮件），成功后重发现。 */
  async copyFolder(account: Account, from: string, to: string): Promise<number> {
    const handle = this.handles.get(account.id) ?? (await this.ensureHandle(account));
    const response = await handle.request<Extract<WorkerResponse, { type: 'folder-done' }>>(
      { type: 'copy-folder', from, to },
      300_000,
    );
    await this.refreshFolders(account, handle);
    return response.copied ?? 0;
  }

  async refreshAccount(account: Account): Promise<void> {
    // 演示账户没有真实凭证，不发起连接
    if (account.settings.demoMode === true) return;
    await this.refreshFolders(account, this.handles.get(account.id) ?? (await this.ensureHandle(account)));
    const folders = this.deps.folders.list(account.id);

    // 单个文件夹失败（服务器拒绝、网络抖动）不能中断整轮刷新，
    // 否则后面的文件夹再也不会有机会同步，用户只看到第一处报错。
    const failures: Array<{ folder: string; message: string }> = [];
    for (const folder of folders) {
      try {
        await this.syncFolder(account, folder.path);
      } catch (error) {
        failures.push({ folder: folder.path, message: (error as Error).message });
        log.warn('sync', '单个文件夹同步失败，继续其余文件夹', {
          accountId: account.id,
          folder: folder.path,
          message: (error as Error).message,
        });
      }
    }

    if (failures.length > 0) {
      const [first] = failures;
      throw new Error(
        failures.length === 1
          ? `${first?.folder}：${first?.message}`
          : `${failures.length} 个文件夹同步失败（首个 ${first?.folder}：${first?.message}）`,
      );
    }
  }

  private async ensureHandle(account: Account): Promise<AccountWorkerHandle> {
    const existing = this.handles.get(account.id);
    if (existing) return existing;
    await this.start(account);
    const created = this.handles.get(account.id);
    if (!created) throw new Error('账户无法连接');
    return created;
  }

  foldersFor(accountId: string): FolderView[] {
    return this.deps.folders.list(accountId);
  }

  /** 解析某账户的 Drafts 文件夹路径：specialUse==='drafts' 优先，否则按名称启发式兜底。 */
  findDraftsFolder(accountId: string): string | null {
    const folders = this.foldersFor(accountId);
    const bySpecial = folders.find((folder) => folder.specialUse === 'drafts');
    if (bySpecial) return bySpecial.path;
    const byName = folders.find((folder) => /^(drafts?|草稿)$/i.test(folder.name.trim()));
    return byName ? byName.path : null;
  }

  /**
   * 把本地草稿作为 RFC822 写入服务器 Drafts 文件夹，返回服务器 uid；
   * 无 Drafts 文件夹、无连接或写入失败均返回 -1（调用方忽略，本地草稿不受影响）。
   */
  async saveServerDraft(account: Account, draft: ComposeDraft): Promise<number> {
    const folder = this.findDraftsFolder(account.id);
    if (!folder) return -1;
    const handle = this.handles.get(account.id) ?? (await this.ensureHandle(account));
    if (!handle) return -1;

    const raw = buildDraftMessage({
      from: account.email,
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      subject: draft.subject,
      html: draft.html,
      text: draft.body,
    });

    try {
      const res = await handle.request<Extract<WorkerResponse, { type: 'append-done' }>>(
        { type: 'append-draft', folder, raw },
        60_000,
      );
      return res.uid > 0 ? res.uid : -1;
    } catch (error) {
      log.warn('account-manager', '写入服务器草稿失败', {
        accountId: account.id,
        message: (error as Error).message,
      });
      return -1;
    }
  }

  /** 删除服务器 Drafts 文件夹里的一封草稿（按 uid）。 */
  async deleteServerDraft(account: Account, uid: number): Promise<void> {
    const folder = this.findDraftsFolder(account.id);
    if (!folder || uid <= 0) return;
    const handle = this.handles.get(account.id) ?? (await this.ensureHandle(account));
    if (!handle) return;
    await handle.request<Extract<WorkerResponse, { type: 'action-done' }>>(
      { type: 'delete-draft', folder, uid },
      60_000,
    );
  }

  /**
   * 读取服务器 Drafts 文件夹里的草稿，映射为 ComposeDraft（含稳定 key 与 serverUid）。
   * 仅在已有 worker 连接时执行，避免无谓连接；无 Drafts 文件夹时返回空。
   * 结果按账户缓存（TTL），重复打开草稿箱时直接返回，避免每次联网重新同步并逐封拉正文。
   */
  async listServerDrafts(account: Account, opts: { force?: boolean } = {}): Promise<ComposeDraft[]> {
    const cached = this.serverDraftsCache.get(account.id);
    if (!opts.force && cached && Date.now() - cached.at < AccountManager.SERVER_DRAFTS_TTL_MS) {
      return cached.drafts;
    }
    const handle = this.handles.get(account.id);
    if (!handle) {
      this.serverDraftsCache.delete(account.id);
      return [];
    }
    const folder = this.findDraftsFolder(account.id);
    if (!folder) {
      this.serverDraftsCache.delete(account.id);
      return [];
    }

    let summaries: RawEmailSummary[] = [];
    try {
      const result = await handle.request<
        Extract<WorkerResponse, { type: 'sync-result' | 'sync-skipped' }>
      >(
        {
          type: 'sync-folder',
          folder,
          uidValidity: 0,
          highestModseq: undefined,
          highestUid: 0,
          capabilityLevel: 'L3_UIDNEXT',
          lastSyncAt: 0,
          limit: DEFAULT_PAGE_SIZE,
        },
        120_000,
      );
      summaries = result.type === 'sync-skipped' ? [] : result.emails;
    } catch (error) {
      log.warn('account-manager', '读取服务器草稿列表失败', {
        accountId: account.id,
        message: (error as Error).message,
      });
      return [];
    }

    const drafts: ComposeDraft[] = [];
    for (const summary of summaries) {
      try {
        const body = await handle.request<Extract<WorkerResponse, { type: 'body' }>>(
          { type: 'fetch-body', folder, uid: summary.uid },
          90_000,
        );
        drafts.push({
          accountId: account.id,
          to: summary.to.map((address) => address.address),
          cc: [],
          bcc: [],
          subject: summary.subject,
          body: body.text ?? '',
          html: body.html ?? '',
          attachments: [],
          updatedAt: summary.dateMs,
          serverUid: summary.uid,
          key: `${account.id}:${summary.uid}`,
        }        );
      } catch (error) {
        log.warn('account-manager', '读取单封服务器草稿正文失败', {
          accountId: account.id,
          uid: summary.uid,
          message: (error as Error).message,
        });
      }
    }
    this.serverDraftsCache.set(account.id, { at: Date.now(), drafts });
    return drafts;
  }

  /** 使服务器草稿缓存失效（保存/删除后或手动刷新时调用）。 */
  invalidateServerDrafts(accountId?: string): void {
    if (accountId) this.serverDraftsCache.delete(accountId);
    else this.serverDraftsCache.clear();
  }

  async disposeAccount(accountId: string): Promise<void> {
    // 崩溃重连的定时器必须无条件取消：崩溃后 handle 已经不在 handles 里了，
    // 若只在拿到 handle 时才清，账户刚被删除/禁用又会被定时器拉起来。
    const restart = this.workerRestarts.get(accountId);
    if (restart?.timer) clearTimeout(restart.timer);
    this.workerRestarts.delete(accountId);

    const handle = this.handles.get(accountId);
    if (!handle) return;
    this.handles.delete(accountId);
    try {
      await handle.request({ type: 'close' }, 3000);
    } catch {
      // 连接可能已断开
    }
    await handle.terminate();
  }

  async closeAll(): Promise<void> {
    const ids = [...this.handles.keys()];
    await Promise.all(ids.map((id) => this.disposeAccount(id)));
  }
}
