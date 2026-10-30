import { randomUUID } from 'node:crypto';
import type { Account } from '../../shared/types';
import type { Db } from '../db/open';
import type { AccountsRepo } from '../db/repositories/accounts-repo';
import { log } from '../observability/logger';
import { PermanentSendError } from './smtp-sender';

/**
 * 定时发送与 Undo Send（§19）。
 * 邮件先入本地队列，send_at 之前可以撤销；到点由主进程按序发送。
 */

export interface OutgoingAttachment {
  filename: string;
  /** 暂存目录里的绝对路径（发送后由队列回调清理）。 */
  path: string;
  /**
   * 内嵌图片的 CID。存在时该 part 以 `Content-ID: <cid>` + inline 发送，
   * 正文通过 `cid:` 引用它（收件人客户端才会把图显示出来）。
   */
  cid?: string;
  /** 内嵌图片的 MIME，显式给出以免依赖扩展名推断。 */
  contentType?: string;
}

export interface OutgoingMessage {
  to: string[];
  cc?: string[];
  /** 密送：只用于 SMTP 信封，不进消息头。 */
  bcc?: string[];
  subject: string;
  text: string;
  /** 富文本正文（HTML）；存在且非空时发送 multipart/alternative。 */
  html?: string;
  attachments?: OutgoingAttachment[];
}

export interface MailSender {
  send(account: Account, message: OutgoingMessage): Promise<void>;
}

export type ScheduledStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled';

/** 终态结果：onTerminal 回调的第二个参数（通知与附件清理共用）。 */
export interface SendOutcome {
  status: Extract<ScheduledStatus, 'sent' | 'failed' | 'cancelled'>;
  error?: string;
}

export interface ScheduledSendView {
  id: string;
  accountId: string;
  sendAt: number;
  status: ScheduledStatus;
  subject: string;
  to: string[];
  retryCount: number;
  lastError: string | null;
}

interface ScheduledRow {
  id: string;
  account_id: string;
  send_at: number;
  payload_json: string;
  status: ScheduledStatus;
  retry_count: number;
  next_retry_at: number;
  last_error: string | null;
  created_at: number;
}

function parsePayload(raw: string): OutgoingMessage {
  try {
    const parsed = JSON.parse(raw) as { message?: OutgoingMessage };
    if (parsed.message) return parsed.message;
  } catch {
    // ignore
  }
  return { to: [], subject: '', text: '' };
}

export class ScheduledSendService {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Db,
    private readonly accounts: AccountsRepo,
    private readonly sender: MailSender,
    /** 终态回调（已发送/永久失败/已取消）：释放附件暂存 + 桌面通知。 */
    private readonly onTerminal?: (message: OutgoingMessage, outcome: SendOutcome) => void,
  ) {}

  schedule(accountId: string, message: OutgoingMessage, undoDelayMs = 10_000): { id: string; sendAt: number } {
    return this.scheduleAt(accountId, message, Date.now() + Math.max(0, undoDelayMs));
  }

  /** 指定绝对时间的入队（AI 指令使用显式 sendAt，不再叠加 Undo 延迟）。 */
  scheduleAt(accountId: string, message: OutgoingMessage, sendAt: number): { id: string; sendAt: number } {
    const id = randomUUID();
    const target = Math.max(Date.now(), Math.round(sendAt));
    this.db
      .prepare(
        `INSERT INTO scheduled_sends (id, account_id, send_at, payload_json, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
      )
      .run(id, accountId, target, JSON.stringify({ message }), Date.now());
    log.info('send', '邮件进入发送队列', { id, accountId, sendAt: target });
    return { id, sendAt: target };
  }

  cancel(id: string): boolean {
    const row = this.db
      .prepare('SELECT payload_json FROM scheduled_sends WHERE id = ? AND status = \'pending\'')
      .get(id) as { payload_json: string } | undefined;
    const result = this.db
      .prepare("UPDATE scheduled_sends SET status = 'cancelled' WHERE id = ? AND status = 'pending'")
      .run(id);
    if (result.changes > 0) {
      log.info('send', '已撤销发送', { id });
      if (row) this.releaseAttachments(parsePayload(row.payload_json), { status: 'cancelled' });
      return true;
    }
    return false;
  }

  private releaseAttachments(message: OutgoingMessage, outcome: SendOutcome): void {
    try {
      this.onTerminal?.(message, outcome);
    } catch {
      // 清理/通知失败不影响发送结果
    }
  }

  /** 仍在队列中的任务所引用的附件路径（启动时用于清理孤儿文件）。 */
  attachmentPathsInUse(): Set<string> {
    const rows = this.db
      .prepare("SELECT payload_json FROM scheduled_sends WHERE status IN ('pending', 'sending')")
      .all() as Array<{ payload_json: string }>;
    const paths = new Set<string>();
    for (const row of rows) {
      const message = parsePayload(row.payload_json);
      for (const attachment of message.attachments ?? []) paths.add(attachment.path);
    }
    return paths;
  }

  list(): ScheduledSendView[] {
    // 发件箱是一个长期可见的出站记录视图：按时间倒序取最近 300 条，
    // 避免历史越攒越多把 IPC 负载和渲染成本拖大。
    const rows = this.db
      .prepare('SELECT * FROM scheduled_sends ORDER BY send_at DESC LIMIT 300')
      .all() as ScheduledRow[];
    return rows.map((row) => {
      const message = parsePayload(row.payload_json);
      return {
        id: row.id,
        accountId: row.account_id,
        sendAt: row.send_at,
        status: row.status,
        subject: message.subject,
        to: message.to,
        retryCount: row.retry_count,
        lastError: row.last_error,
      };
    });
  }

  async tick(now = Date.now()): Promise<{ sent: number; failed: number; retried: number }> {
    const due = this.db
      .prepare(
        `SELECT * FROM scheduled_sends
          WHERE status = 'pending' AND send_at <= ? AND next_retry_at <= ?
          ORDER BY send_at ASC LIMIT 10`,
      )
      .all(now, now) as ScheduledRow[];

    let sent = 0;
    let failed = 0;
    let retried = 0;

    for (const row of due) {
      const claimed = this.db
        .prepare("UPDATE scheduled_sends SET status = 'sending' WHERE id = ? AND status = 'pending'")
        .run(row.id);
      if (claimed.changes === 0) continue;

      const account = this.accounts.get(row.account_id);
      if (!account) {
        this.markFailed(row.id, '账户不存在');
        failed += 1;
        continue;
      }

      const message = parsePayload(row.payload_json);
      try {
        await this.sender.send(account, message);
        this.db.prepare("UPDATE scheduled_sends SET status = 'sent' WHERE id = ?").run(row.id);
        this.releaseAttachments(message, { status: 'sent' });
        sent += 1;
        log.info('send', '邮件已发送', { id: row.id, accountId: row.account_id });
      } catch (error) {
        const permanent = error instanceof PermanentSendError;
        if (permanent) {
          this.markFailed(row.id, (error as Error).message);
          failed += 1;
        } else {
          const retryCount = row.retry_count + 1;
          if (retryCount >= 5) {
            this.markFailed(row.id, (error as Error).message);
            failed += 1;
          } else {
            const backoff = Math.min(5 * 60_000, 1000 * 2 ** retryCount);
            this.db
              .prepare(
                `UPDATE scheduled_sends
                    SET status = 'pending', retry_count = ?, next_retry_at = ?, last_error = ?
                  WHERE id = ?`,
              )
              .run(retryCount, now + backoff, (error as Error).message, row.id);
            retried += 1;
            log.warn('send', '发送失败，将重试', {
              id: row.id,
              retryCount,
              message: (error as Error).message,
            });
          }
        }
      }
    }

    return { sent, failed, retried };
  }

  private markFailed(id: string, message: string): void {
    const row = this.db
      .prepare('SELECT payload_json FROM scheduled_sends WHERE id = ?')
      .get(id) as { payload_json: string } | undefined;
    this.db
      .prepare("UPDATE scheduled_sends SET status = 'failed', last_error = ? WHERE id = ?")
      .run(message, id);
    if (row) this.releaseAttachments(parsePayload(row.payload_json), { status: 'failed', error: message });
    log.error('send', '邮件发送永久失败', { id, message });
  }

  start(intervalMs = 1000): void {
    // 进程重启时把中断的 sending 状态恢复为待发送
    this.db.prepare("UPDATE scheduled_sends SET status = 'pending' WHERE status = 'sending'").run();
    this.timer = setInterval(() => {
      void this.tick().catch((error: Error) => {
        log.warn('send', '发送队列 tick 失败', { message: error.message });
      });
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
