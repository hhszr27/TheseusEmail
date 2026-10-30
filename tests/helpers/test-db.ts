import Database from 'better-sqlite3-multiple-ciphers';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 测试用数据库：按版本号执行 migrations/ 下的全部迁移，使用临时文件便于 SQLCipher 行为一致。
 *
 * 这里**不要去写死迁移文件清单**：新增一个 V0xx 后忘记同步，测试库就会少一列，
 * 然后在毫不相干的断言上炸（2026-10-22 加 notified_at 时踩过）。目录扫描 + 版本排序，
 * 和主进程的 loadMigrations 保持同一口径。
 */
function migrationFiles(): string[] {
  return fs
    .readdirSync(path.resolve('migrations'))
    .filter((name) => /^V\d+__.+\.sql$/i.test(name))
    .sort((a, b) => {
      const va = Number(/^V(\d+)__/i.exec(a)?.[1] ?? 0);
      const vb = Number(/^V(\d+)__/i.exec(b)?.[1] ?? 0);
      return va - vb;
    });
}

const MIGRATIONS = migrationFiles();

export interface TestDb {
  db: Database.Database;
  dir: string;
  cleanup(): void;
}

export function createTestDb(): TestDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailforge-phase3-'));
  const db = new Database(path.join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  for (const file of MIGRATIONS) {
    db.exec(fs.readFileSync(path.resolve('migrations', file), 'utf8'));
  }
  return {
    db,
    dir,
    cleanup() {
      try {
        db.close();
      } catch {
        // ignore
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function insertAccount(db: Database.Database, id: string, email = `${id}@example.com`): void {
  db.prepare(
    `INSERT INTO accounts (id, display_name, email, protocol, auth_type, created_at)
     VALUES (?, ?, ?, 'imap-smtp', 'password', ?)`,
  ).run(id, id, email, Date.now());
}

export function insertEmail(
  db: Database.Database,
  input: {
    id: string;
    accountId: string;
    folder?: string;
    uid: number;
    subject?: string;
    date?: number;
    pinned?: number;
    snoozedUntil?: number | null;
    unread?: number;
    starred?: number;
    hasAttachments?: number;
    /** 发件人列表，用于「按发件人」排序等断言；缺省为空数组。 */
    from?: Array<{ name?: string; address: string }>;
    /** 收件人列表，用于「按到」排序等断言；缺省为空数组。 */
    to?: Array<{ name?: string; address: string }>;
  },
): void {
  db.prepare(
    `INSERT INTO emails
       (id, account_id, folder, uid, uidvalidity, subject, from_json, to_json, date, snippet,
        pinned, snoozed_until, unread, starred, has_attachments)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, '', ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.accountId,
    input.folder ?? 'INBOX',
    input.uid,
    input.subject ?? `subject ${input.uid}`,
    input.from ? JSON.stringify(input.from) : '[]',
    input.to ? JSON.stringify(input.to) : '[]',
    input.date ?? Date.now(),
    input.pinned ?? 0,
    input.snoozedUntil ?? null,
    input.unread ?? 0,
    input.starred ?? 0,
    input.hasAttachments ?? 0,
  );
}
