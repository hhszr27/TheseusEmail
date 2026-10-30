import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/open';
import { PluginsRepo } from '../db/repositories/plugins-repo';
import { log } from '../observability/logger';

/**
 * 账户删除的数据清理（§7.8.5）。
 *
 * 顺序固定，账户行最后删：任何中间步骤失败都不会让用户看到
 * 「数据已删但账户还在」的状态。每步用 savepoint 隔离，单步失败
 * 只记录失败项，不回滚已完成的步骤。
 */

export interface PurgeOptions {
  /** 附件目录；测试可省略。 */
  attachmentsRoot?: string;
  /** 是否在最后一步删除 accounts 行（默认 true；服务层需要先清凭证时传 false）。 */
  deleteAccountRow?: boolean;
}

export interface PurgeResult {
  deletedEmails: number;
  deletedFiles: number;
  deletedContacts: number;
  failedSteps: string[];
}

interface AttachmentRef {
  sha256: string | null;
  local_path: string | null;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function collectAddresses(db: Db, accountId: string): Set<string> {
  const addresses = new Set<string>();
  const rows = db
    .prepare('SELECT from_json, to_json FROM emails WHERE account_id = ?')
    .iterate(accountId) as Iterable<{ from_json: string; to_json: string }>;

  for (const row of rows) {
    for (const json of [row.from_json, row.to_json]) {
      try {
        const parsed = JSON.parse(json) as unknown;
        if (!Array.isArray(parsed)) continue;
        for (const item of parsed) {
          const address = (item as { address?: unknown })?.address;
          if (typeof address === 'string' && address.includes('@')) {
            addresses.add(address.trim().toLowerCase());
          }
        }
      } catch {
        // 损坏的地址 JSON 跳过
      }
    }
  }
  return addresses;
}

export async function purgeAccountData(
  db: Db,
  accountId: string,
  options: PurgeOptions = {},
): Promise<PurgeResult> {
  const result: PurgeResult = {
    deletedEmails: 0,
    deletedFiles: 0,
    deletedContacts: 0,
    failedSteps: [],
  };

  if (!accountId) throw new Error('缺少账户 ID');

  // 在删除 emails 之前取附件引用与联系人地址，之后就无法回查
  const attachments = db
    .prepare(
      `SELECT DISTINCT a.sha256 AS sha256, a.local_path AS local_path
         FROM attachments a
         JOIN emails e ON e.id = a.email_id
        WHERE e.account_id = ?`,
    )
    .all(accountId) as AttachmentRef[];
  const addresses = collectAddresses(db, accountId);

  let savepoint = 0;
  const step = (name: string, run: () => void): void => {
    const id = `purge_${savepoint}`;
    savepoint += 1;
    try {
      db.exec(`SAVEPOINT ${id}`);
      run();
      db.exec(`RELEASE ${id}`);
    } catch (error) {
      try {
        db.exec(`ROLLBACK TO ${id}`);
        db.exec(`RELEASE ${id}`);
      } catch {
        // savepoint 已失效
      }
      result.failedSteps.push(name);
      log.warn('account-purge', '清理步骤失败', {
        accountId,
        step: name,
        message: (error as Error).message,
      });
    }
  };

  db.exec('BEGIN IMMEDIATE');
  try {
    step('物化邮件 ID', () => {
      db.exec('DROP TABLE IF EXISTS temp._purge_emails');
      db.exec('CREATE TEMP TABLE _purge_emails (email_id TEXT PRIMARY KEY)');
      db.prepare(
        'INSERT INTO _purge_emails (email_id) SELECT id FROM emails WHERE account_id = ?',
      ).run(accountId);
    });

    step('删除附件行', () => {
      db.prepare(
        `DELETE FROM attachments
          WHERE email_id IN (SELECT email_id FROM _purge_emails)`,
      ).run();
    });

    step('删除邮件', () => {
      const info = db.prepare('DELETE FROM emails WHERE account_id = ?').run(accountId);
      result.deletedEmails = info.changes;
    });

    step('删除正文与派生数据', () => {
      db.prepare(
        'DELETE FROM email_bodies WHERE email_id IN (SELECT email_id FROM _purge_emails)',
      ).run();
      db.prepare(
        'DELETE FROM ai_embeddings WHERE email_id IN (SELECT email_id FROM _purge_emails)',
      ).run();
      db.prepare(
        'DELETE FROM translation_cache WHERE email_id IN (SELECT email_id FROM _purge_emails)',
      ).run();
    });

    step('删除全文索引', () => {
      db.prepare(
        'DELETE FROM emails_fts WHERE email_id IN (SELECT email_id FROM _purge_emails)',
      ).run();
    });

    step('清理附件文件', () => {
      if (!options.attachmentsRoot) return;
      const root = path.resolve(options.attachmentsRoot);
      const stillReferenced = db.prepare(
        'SELECT 1 FROM attachments WHERE local_path = ? OR (sha256 IS NOT NULL AND sha256 = ?) LIMIT 1',
      );
      const seen = new Set<string>();
      for (const item of attachments) {
        if (!item.local_path || seen.has(item.local_path)) continue;
        seen.add(item.local_path);
        const resolved = path.resolve(item.local_path);
        if (!resolved.startsWith(root + path.sep)) continue;
        const referenced = stillReferenced.get(item.local_path, item.sha256) as unknown;
        if (referenced) continue;
        try {
          if (fs.existsSync(resolved)) {
            fs.unlinkSync(resolved);
            result.deletedFiles += 1;
          }
        } catch (error) {
          log.warn('account-purge', '附件文件删除失败', {
            accountId,
            path: resolved,
            message: (error as Error).message,
          });
        }
      }
    });

    step('删除文件夹同步状态', () => {
      db.prepare('DELETE FROM folder_sync_state WHERE account_id = ?').run(accountId);
    });

    step('删除发件队列', () => {
      db.prepare('DELETE FROM outbox WHERE account_id = ?').run(accountId);
    });

    step('删除定时发送', () => {
      db.prepare('DELETE FROM scheduled_sends WHERE account_id = ?').run(accountId);
    });

    step('删除本地草稿', () => {
      // 每账户一封本地草稿；漏了它，账户删掉之后草稿箱里仍留一封
      // 点进去就报错的孤儿草稿（draftList 不按账户过滤）。
      db.prepare('DELETE FROM drafts WHERE account_id = ?').run(accountId);
    });

    step('清理联系人', () => {
      const stillSeen = db.prepare(
        `SELECT 1 FROM emails
          WHERE account_id <> ?
            AND (from_json LIKE ? ESCAPE '\\' OR to_json LIKE ? ESCAPE '\\')
          LIMIT 1`,
      );
      const removeContact = db.prepare('DELETE FROM contacts WHERE email = ?');
      for (const address of addresses) {
        const pattern = `%"${escapeLike(address)}"%`;
        const found = stillSeen.get(accountId, pattern, pattern) as unknown;
        if (!found) {
          const info = removeContact.run(address);
          result.deletedContacts += info.changes;
        }
      }
      db.prepare('DELETE FROM contact_accounts WHERE account_id = ?').run(accountId);
    });

    step('清理扫描缓存', () => {
      const stillReferenced = db.prepare(
        'SELECT 1 FROM attachments WHERE sha256 = ? LIMIT 1',
      );
      const removeCache = db.prepare('DELETE FROM scan_cache WHERE key = ?');
      for (const item of attachments) {
        if (!item.sha256) continue;
        const referenced = stillReferenced.get(item.sha256) as unknown;
        if (!referenced) removeCache.run(`file:${item.sha256.toLowerCase()}`);
      }
    });

    step('清理插件账户覆盖', () => {
      // §7.8.5 第 12 步：移除该账户在所有插件里的启用覆盖
      new PluginsRepo(db).clearAccount(accountId);
    });

    step('删除账户行', () => {
      if (options.deleteAccountRow === false) return;
      db.prepare('DELETE FROM accounts WHERE id = ?').run(accountId);
    });

    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore
    }
    log.error('account-purge', '账户清理事务失败', {
      accountId,
      message: (error as Error).message,
    });
    throw error;
  } finally {
    try {
      db.exec('DROP TABLE IF EXISTS temp._purge_emails');
    } catch {
      // ignore
    }
  }

  return result;
}
