import type { EmailAddress, EmailSummary } from '../../../shared/types';
import type { ListFilter, ListSort } from '../../../shared/ipc';
import type { Db } from '../open';
import type { RawEmailSummary } from '../../mail/sync/protocol';
import { filterCondition, sortOrderSql } from '../list-query';

export interface EmailRow {
  id: string;
  account_id: string;
  folder: string;
  uid: number;
  uidvalidity: number;
  message_id: string | null;
  subject: string;
  from_json: string;
  to_json: string;
  date: number;
  snippet: string;
  has_attachments: number;
  unread: number;
  starred: number;
  pinned: number;
  snoozed_until: number | null;
  body_fetched: number;
}

function parseAddresses(json: string): EmailAddress[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is EmailAddress => {
        return Boolean(item) && typeof item === 'object' && typeof (item as EmailAddress).address === 'string';
      })
      .map((item) => ({ ...(item.name ? { name: item.name } : {}), address: item.address }));
  } catch {
    return [];
  }
}

export function toSummary(row: EmailRow): EmailSummary {
  return {
    id: row.id,
    uid: row.uid,
    folder: row.folder,
    accountId: row.account_id,
    subject: row.subject,
    from: parseAddresses(row.from_json),
    to: parseAddresses(row.to_json),
    date: new Date(row.date).toISOString(),
    snippet: row.snippet,
    hasAttachments: row.has_attachments === 1,
    unread: row.unread === 1,
    starred: row.starred === 1,
    pinned: row.pinned === 1,
    ...(row.snoozed_until ? { snoozedUntil: row.snoozed_until } : {}),
  };
}

export function emailIdFor(accountId: string, folder: string, uid: number): string {
  return `${accountId}|${folder}|${uid}`;
}

export class EmailsRepo {
  constructor(private readonly db: Db) {}

  upsertMany(
    accountId: string,
    folder: string,
    uidValidity: number,
    emails: RawEmailSummary[],
  ): number {
    const statement = this.db.prepare(
      `INSERT INTO emails
         (id, account_id, folder, uid, uidvalidity, message_id, subject, from_json, to_json,
          date, snippet, has_attachments, unread, starred)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         uidvalidity = excluded.uidvalidity,
         message_id = excluded.message_id,
         subject = excluded.subject,
         from_json = excluded.from_json,
         to_json = excluded.to_json,
         date = excluded.date,
         snippet = excluded.snippet,
         has_attachments = excluded.has_attachments,
         unread = excluded.unread,
         starred = excluded.starred`,
    );

    const runAll = this.db.transaction((items: RawEmailSummary[]) => {
      for (const item of items) {
        statement.run(
          emailIdFor(accountId, folder, item.uid),
          accountId,
          folder,
          item.uid,
          uidValidity,
          item.messageId,
          item.subject,
          JSON.stringify(item.from),
          JSON.stringify(item.to),
          item.dateMs,
          item.snippet,
          item.hasAttachments ? 1 : 0,
          item.unread ? 1 : 0,
          item.starred ? 1 : 0,
        );
      }
      return items.length;
    });

    return runAll(emails);
  }

  /**
   * 文件夹邮件列表（§7.8.2）：filter 决定筛选口径，sort 决定排列方式。
   * Snooze 未到期的邮件同样不出现（§23.3）。
   */
  list(
    accountId: string,
    folder: string,
    offset: number,
    limit: number,
    now = Date.now(),
    filter: ListFilter = 'all',
    sort: ListSort = 'date',
  ): EmailSummary[] {
    const condition = filterCondition(filter);
    const rows = this.db
      .prepare(
        `SELECT * FROM emails
          WHERE account_id = ? AND folder = ?
            AND (snoozed_until IS NULL OR snoozed_until <= ?)
            ${condition ? `AND ${condition}` : ''}
          ORDER BY ${sortOrderSql(sort)}
          LIMIT ? OFFSET ?`,
      )
      .all(accountId, folder, now, limit, offset) as EmailRow[];
    return rows.map(toSummary);
  }

  /** 与 list() 同口径的总数（供分页与「N 封」展示）。 */
  total(
    accountId: string,
    folder: string,
    now = Date.now(),
    filter: ListFilter = 'all',
  ): number {
    const condition = filterCondition(filter);
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM emails
          WHERE account_id = ? AND folder = ?
            AND (snoozed_until IS NULL OR snoozed_until <= ?)
            ${condition ? `AND ${condition}` : ''}`,
      )
      .get(accountId, folder, now) as { c: number } | undefined;
    return row?.c ?? 0;
  }

  /**
   * 统一收件箱（§23.1）：跨账户合并收件箱邮件。
   * 只聚合启用账户（§7.8.2）：禁用账户的邮件仍可在单账户视图查看。
   * Snooze 未到期的邮件不出现（§23.3），到期后自动重新出现。
   */
  listUnified(
    offset: number,
    limit: number,
    folder = 'INBOX',
    now = Date.now(),
    filter: ListFilter = 'all',
    sort: ListSort = 'date',
  ): EmailSummary[] {
    const condition = filterCondition(filter, 'e');
    const rows = this.db
      .prepare(
        `SELECT * FROM emails e
          WHERE e.folder = ?
            AND (e.snoozed_until IS NULL OR e.snoozed_until <= ?)
            ${condition ? `AND ${condition}` : ''}
            AND EXISTS (SELECT 1 FROM accounts a WHERE a.id = e.account_id AND a.enabled = 1)
          ORDER BY ${sortOrderSql(sort, 'e')}
          LIMIT ? OFFSET ?`,
      )
      .all(folder, now, limit, offset) as EmailRow[];
    return rows.map(toSummary);
  }

  totalUnified(folder = 'INBOX', now = Date.now(), filter: ListFilter = 'all'): number {
    const condition = filterCondition(filter, 'e');
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM emails e
          WHERE e.folder = ?
            AND (e.snoozed_until IS NULL OR e.snoozed_until <= ?)
            ${condition ? `AND ${condition}` : ''}
            AND EXISTS (SELECT 1 FROM accounts a WHERE a.id = e.account_id AND a.enabled = 1)`,
      )
      .get(folder, now) as { c: number } | undefined;
    return row?.c ?? 0;
  }

  /** 各账户收件箱未读数（§7.8.2 侧边栏）。 */
  unreadInboxByAccount(): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT account_id, SUM(CASE WHEN unread = 1 THEN 1 ELSE 0 END) AS unread
           FROM emails
          WHERE folder = 'INBOX'
          GROUP BY account_id`,
      )
      .all() as Array<{ account_id: string; unread: number }>;
    const result: Record<string, number> = {};
    for (const row of rows) result[row.account_id] = row.unread;
    return result;
  }

  /**
   * 启用账户的收件箱未读总数（托盘徽标）。
   * 口径与统一收件箱一致（§7.8.2）：只算启用账户，排除 snooze 中的邮件。
   */
  totalUnreadInbox(now: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM emails e
          WHERE e.folder = 'INBOX' AND e.unread = 1
            AND (e.snoozed_until IS NULL OR e.snoozed_until <= ?)
            AND EXISTS (SELECT 1 FROM accounts a WHERE a.id = e.account_id AND a.enabled = 1)`,
      )
      .get(now) as { c: number } | undefined;
    return row?.c ?? 0;
  }

  /**
   * 把整个文件夹标为已读（右键「全部标为已读」）。
   * 只动本地：调用方随后会尽力把 \Seen 推到服务端；返回本次改动的封数。
   */
  markFolderRead(accountId: string, folder: string): number {
    const info = this.db
      .prepare('UPDATE emails SET unread = 0 WHERE account_id = ? AND folder = ? AND unread = 1')
      .run(accountId, folder);
    return Number(info.changes ?? 0);
  }

  /** 这封邮件是否已经处理过通知（弹过 / 启动时登记过）。 */
  isNotified(emailId: string): boolean {
    const row = this.db
      .prepare('SELECT notified_at FROM emails WHERE id = ?')
      .get(emailId) as { notified_at: number | null } | undefined;
    return row?.notified_at != null;
  }

  /** 登记「这封邮件的通知已处理」，之后不再重复弹窗。 */
  markNotified(emailId: string, at: number): void {
    this.db
      .prepare('UPDATE emails SET notified_at = ? WHERE id = ? AND notified_at IS NULL')
      .run(at, emailId);
  }

  /** 清空文件夹里的邮件（保留文件夹本身），连同搜索索引一起删。 */
  clearFolder(accountId: string, folder: string): number {
    const dropIndex = this.db.prepare(
      'DELETE FROM emails_fts WHERE email_id IN (SELECT id FROM emails WHERE account_id = ? AND folder = ?)',
    );
    const dropEmails = this.db.prepare('DELETE FROM emails WHERE account_id = ? AND folder = ?');
    let removed = 0;
    this.db.transaction(() => {
      dropIndex.run(accountId, folder);
      removed = Number(dropEmails.run(accountId, folder).changes ?? 0);
    })();
    return removed;
  }

  /** 按 id 批量删除邮件（去重清理用）；SQLite 参数上限 999，分块处理。 */
  deleteByIds(accountId: string, ids: readonly string[]): number {
    if (ids.length === 0) return 0;
    const chunkSize = 400;
    let removed = 0;
    this.db.transaction(() => {
      for (let index = 0; index < ids.length; index += chunkSize) {
        const chunk = ids.slice(index, index + chunkSize);
        const placeholders = chunk.map(() => '?').join(',');
        this.db.prepare(`DELETE FROM emails_fts WHERE email_id IN (${placeholders})`).run(...chunk);
        removed += Number(
          this.db
            .prepare(`DELETE FROM emails WHERE account_id = ? AND id IN (${placeholders})`)
            .run(accountId, ...chunk).changes ?? 0,
        );
      }
    })();
    return removed;
  }

  /**
   * 找出同一文件夹里 Message-ID 相同的重复邮件：按日期倒序，保留最新一封，
   * 其余返回给调用方去清理（右键「清理文件夹」）。
   */
  findDuplicates(accountId: string, folder: string): Array<{ id: string; uid: number }> {
    const rows = this.db
      .prepare(
        `SELECT id, uid, message_id FROM emails
          WHERE account_id = ? AND folder = ?
            AND message_id IS NOT NULL AND message_id != ''
          ORDER BY date DESC, uid DESC`,
      )
      .all(accountId, folder) as Array<{ id: string; uid: number; message_id: string }>;

    const seen = new Set<string>();
    const duplicates: Array<{ id: string; uid: number }> = [];
    for (const row of rows) {
      const key = row.message_id.trim().toLowerCase();
      if (!key) continue;
      if (seen.has(key)) duplicates.push({ id: row.id, uid: row.uid });
      else seen.add(key);
    }
    return duplicates;
  }

  /** 本地标志同步（服务端已写入成功后再调用，避免界面与服务端不一致）。 */
  updateFlags(emailId: string, flags: { unread?: boolean; starred?: boolean }): boolean {
    const assignments: string[] = [];
    const params: Array<string | number> = [];
    if (flags.unread !== undefined) {
      assignments.push('unread = ?');
      params.push(flags.unread ? 1 : 0);
    }
    if (flags.starred !== undefined) {
      assignments.push('starred = ?');
      params.push(flags.starred ? 1 : 0);
    }
    if (assignments.length === 0) return false;
    const result = this.db
      .prepare(`UPDATE emails SET ${assignments.join(', ')} WHERE id = ?`)
      .run(...params, emailId);
    return result.changes > 0;
  }

  /** 删除本地行；正文与附件记录由外键级联清理。 */
  remove(emailId: string): boolean {
    const result = this.db.prepare('DELETE FROM emails WHERE id = ?').run(emailId);
    return result.changes > 0;
  }

  setSnoozed(emailId: string, until: number | null): boolean {    const result = this.db
      .prepare('UPDATE emails SET snoozed_until = ? WHERE id = ?')
      .run(until, emailId);
    return result.changes > 0;
  }

  maxUid(accountId: string, folder: string): number {
    const row = this.db
      .prepare('SELECT MAX(uid) AS u FROM emails WHERE account_id = ? AND folder = ?')
      .get(accountId, folder) as { u: number | null } | undefined;
    return row?.u ?? 0;
  }

  get(id: string): EmailSummary | null {
    const row = this.db.prepare('SELECT * FROM emails WHERE id = ?').get(id) as
      | EmailRow
      | undefined;
    return row ? toSummary(row) : null;
  }

  getBody(id: string): { html: string | null; text: string | null } | null {
    const row = this.db
      .prepare('SELECT html, text FROM email_bodies WHERE email_id = ?')
      .get(id) as { html: string | null; text: string | null } | undefined;
    return row ? { html: row.html, text: row.text } : null;
  }

  /**
   * 还没有本地正文的邮件（离线和 OST 一样要能看历史，所以要提前把正文抓下来）。
   * 按日期倒序：先补最近的，用户最可能点开。
   */
  missingBodies(
    accountId: string,
    folder: string,
    limit: number,
  ): Array<{ id: string; uid: number }> {
    if (limit <= 0) return [];
    return this.db
      .prepare(
        `SELECT id, uid FROM emails
          WHERE account_id = ? AND folder = ? AND body_fetched = 0
          ORDER BY date DESC LIMIT ?`,
      )
      .all(accountId, folder, limit) as Array<{ id: string; uid: number }>;
  }

  saveBody(id: string, html: string | null, text: string | null): void {
    this.db
      .prepare(
        `INSERT INTO email_bodies (email_id, html, text, fetched_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(email_id) DO UPDATE SET
           html = excluded.html, text = excluded.text, fetched_at = excluded.fetched_at`,
      )
      .run(id, html, text, Date.now());
    this.db.prepare('UPDATE emails SET body_fetched = 1 WHERE id = ?').run(id);
  }

  /**
   * UIDVALIDITY 级联失效（§8.2）：
   * emails → email_bodies → emails_fts → flags/最高 MODSEQ → 能力级别。
   * 整个操作在事务内完成；失败时调用方负责标记 needsFullResync。
   */
  cascadeInvalidateFolder(accountId: string, folder: string, newUidValidity: number): number {
    const tx = this.db.transaction(() => {
      const ids = this.db
        .prepare('SELECT id FROM emails WHERE account_id = ? AND folder = ?')
        .all(accountId, folder) as Array<{ id: string }>;

      const findFtsRows = this.db.prepare('SELECT rowid FROM emails_fts WHERE email_id = ?');
      const deleteFtsRow = this.db.prepare('DELETE FROM emails_fts WHERE rowid = ?');
      for (const { id } of ids) {
        const rows = findFtsRows.all(id) as Array<{ rowid: number }>;
        for (const row of rows) deleteFtsRow.run(row.rowid);
      }

      this.db
        .prepare(
          `DELETE FROM email_bodies
            WHERE email_id IN (SELECT id FROM emails WHERE account_id = ? AND folder = ?)`,
        )
        .run(accountId, folder);

      this.db
        .prepare('DELETE FROM emails WHERE account_id = ? AND folder = ?')
        .run(accountId, folder);

      this.db
        .prepare(
          `UPDATE folder_sync_state
              SET uidvalidity = ?,
                  highest_modseq = NULL,
                  uidnext = NULL,
                  capability_level = 'L1_CHANGEDSINCE',
                  last_sync_at = 0,
                  needs_full_resync = 0
            WHERE account_id = ? AND folder = ?`,
        )
        .run(newUidValidity, accountId, folder);

      return ids.length;
    });

    return tx();
  }

  counts(): { emails: number; accounts: number; folders: number } {
    const emails = (this.db.prepare('SELECT COUNT(*) AS c FROM emails').get() as { c: number }).c;
    const accounts = (this.db.prepare('SELECT COUNT(*) AS c FROM accounts').get() as { c: number }).c;
    const folders = (
      this.db.prepare('SELECT COUNT(*) AS c FROM folder_sync_state').get() as { c: number }
    ).c;
    return { emails, accounts, folders };
  }
}
