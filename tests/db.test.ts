import Database from 'better-sqlite3-multiple-ciphers';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createVerifiedBackup, isPlaintextSqlite, verifyBackupFile } from '../src/main/db/backup';
import { EmailsRepo } from '../src/main/db/repositories/emails-repo';
import { FoldersRepo } from '../src/main/db/repositories/folders-repo';
import type { RawEmailSummary } from '../src/main/mail/sync/protocol';

/**
 * 数据库级集成测试（真实 SQLCipher + FTS5）。
 * 覆盖：加密文件头、迁移 SQL、UIDVALIDITY 级联失效、备份完整性验证。
 */

const KEY_HEX = 'ab'.repeat(32);
const ACCOUNT = 'acc-1';
const FOLDER = 'INBOX';
const MIGRATION_SQL = fs.readFileSync(path.resolve('migrations/V001__initial.sql'), 'utf8');

let dir = '';
let dbPath = '';
let db: Database.Database;

function sampleEmail(uid: number): RawEmailSummary {
  return {
    uid,
    messageId: `<${uid}@example.com>`,
    subject: `subject ${uid}`,
    from: [{ name: 'Sender', address: 'sender@example.com' }],
    to: [{ address: 'me@example.com' }],
    dateMs: Date.UTC(2026, 8, 1, 10, 0, 0),
    snippet: 'hello',
    hasAttachments: false,
    unread: true,
    starred: false,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailforge-db-'));
  dbPath = path.join(dir, 'mailforge.db');
  db = new Database(dbPath);
  db.pragma(`key = "x'${KEY_HEX}'"`);
  db.pragma('kdf_iter = 256000');
  db.pragma('cipher_page_size = 4096');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(MIGRATION_SQL);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // ignore
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('SQLCipher 加密数据库（§6）', () => {
  it('落盘文件不是明文 SQLite 头', () => {
    db.prepare('INSERT INTO accounts (id, display_name, email, protocol, auth_type, created_at) VALUES (?,?,?,?,?,?)')
      .run(ACCOUNT, 'Test', 'me@example.com', 'imap-smtp', 'password', Date.now());

    expect(isPlaintextSqlite(dbPath)).toBe(false);
    const header = fs.readFileSync(dbPath).subarray(0, 16).toString('latin1');
    expect(header).not.toBe('SQLite format 3\0');
  });

  it('错误密钥无法读取', () => {
    db.prepare('INSERT INTO accounts (id, display_name, email, protocol, auth_type, created_at) VALUES (?,?,?,?,?,?)')
      .run(ACCOUNT, 'Test', 'me@example.com', 'imap-smtp', 'password', Date.now());

    const wrong = new Database(dbPath, { readonly: true });
    wrong.pragma(`key = "x'${'cd'.repeat(32)}'"`);
    expect(() => wrong.prepare('SELECT COUNT(*) FROM accounts').get()).toThrow();
    wrong.close();
  });
});

describe('UIDVALIDITY 级联失效（§8.2）', () => {
  it('同时清空 emails / email_bodies / emails_fts / flag / MODSEQ，并重置能力级别', () => {
    const emailsRepo = new EmailsRepo(db);
    const foldersRepo = new FoldersRepo(db);

    foldersRepo.upsertFolder(ACCOUNT, {
      path: FOLDER,
      name: 'INBOX',
      delimiter: '/',
      specialUse: undefined,
      specialUseSource: undefined,
    });
    foldersRepo.updateAfterSync(ACCOUNT, FOLDER, {
      uidValidity: 111,
      highestModseq: 999,
      uidNext: 50,
      capabilityLevel: 'L2_SEARCH_SINCE',
      lastSyncAt: Date.now(),
    });

    emailsRepo.upsertMany(ACCOUNT, FOLDER, 111, [sampleEmail(1), sampleEmail(2)]);
    const firstId = 'acc-1|INBOX|1';
    emailsRepo.saveBody(firstId, '<p>body</p>', 'body');
    db.prepare('INSERT INTO emails_fts (email_id, subject, body) VALUES (?, ?, ?)').run(
      firstId,
      'subject 1',
      'body one',
    );

    expect(emailsRepo.total(ACCOUNT, FOLDER)).toBe(2);
    expect(
      (db.prepare('SELECT COUNT(*) AS c FROM emails_fts').get() as { c: number }).c,
    ).toBe(1);

    const removed = emailsRepo.cascadeInvalidateFolder(ACCOUNT, FOLDER, 222);
    expect(removed).toBe(2);

    expect(emailsRepo.total(ACCOUNT, FOLDER)).toBe(0);
    expect(
      (db.prepare('SELECT COUNT(*) AS c FROM email_bodies').get() as { c: number }).c,
    ).toBe(0);
    expect(
      (db.prepare('SELECT COUNT(*) AS c FROM emails_fts').get() as { c: number }).c,
    ).toBe(0);

    const state = foldersRepo.getState(ACCOUNT, FOLDER);
    expect(state?.uidValidity).toBe(222);
    expect(state?.highestModseq).toBeNull();
    expect(state?.capabilityLevel).toBe('L1_CHANGEDSINCE');
    expect(state?.needsFullResync).toBe(false);
  });

  it('能力降级与 needsFullResync 持久化，重连后保持', () => {
    const foldersRepo = new FoldersRepo(db);
    foldersRepo.upsertFolder(ACCOUNT, {
      path: FOLDER,
      name: 'INBOX',
      delimiter: '/',
    });

    foldersRepo.updateAfterSync(ACCOUNT, FOLDER, {
      uidValidity: 7,
      highestModseq: 100,
      uidNext: 9,
      capabilityLevel: 'L3_UIDNEXT',
      lastSyncAt: 1700000000000,
    });

    // 模拟进程重启后重新读取
    const reloaded = new FoldersRepo(db);
    const state = reloaded.getState(ACCOUNT, FOLDER);
    expect(state?.capabilityLevel).toBe('L3_UIDNEXT');
    expect(state?.highestModseq).toBe(100);
    expect(state?.uidValidity).toBe(7);

    reloaded.setNeedsFullResync(ACCOUNT, FOLDER, true);
    expect(new FoldersRepo(db).getState(ACCOUNT, FOLDER)?.needsFullResync).toBe(true);
  });

  it('级联失效在事务中执行，失败不会留下半清空状态', () => {
    const emailsRepo = new EmailsRepo(db);
    emailsRepo.upsertMany(ACCOUNT, FOLDER, 111, [sampleEmail(1)]);
    emailsRepo.saveBody('acc-1|INBOX|1', '<p>x</p>', 'x');

    // 人为制造失败：删除 emails 表后调用级联，事务应整体回滚
    db.exec('ALTER TABLE emails RENAME TO emails_backup');

    expect(() => emailsRepo.cascadeInvalidateFolder(ACCOUNT, FOLDER, 222)).toThrow();

    const bodies = db.prepare('SELECT COUNT(*) AS c FROM email_bodies').get() as { c: number };
    expect(bodies.c).toBe(1);

    db.exec('ALTER TABLE emails_backup RENAME TO emails');
  });
});

describe('备份完整性验证（§5.2）', () => {
  it('online backup 生成加密副本并通过 integrity_check 与计数校验', async () => {
    const emailsRepo = new EmailsRepo(db);
    emailsRepo.upsertMany(ACCOUNT, FOLDER, 1, [sampleEmail(1), sampleEmail(2)]);
    db.prepare('INSERT INTO accounts (id, display_name, email, protocol, auth_type, created_at) VALUES (?,?,?,?,?,?)')
      .run(ACCOUNT, 'Test', 'me@example.com', 'imap-smtp', 'password', Date.now());

    const backupPath = path.join(dir, 'backup.db');
    const result = await createVerifiedBackup(db, backupPath, KEY_HEX, {
      emails: 2,
      accounts: 1,
      folders: 0,
    });

    expect(result.ok).toBe(true);
    expect(result.integrity).toBe('ok');
    expect(result.counts.emails).toBe(2);
    expect(isPlaintextSqlite(backupPath)).toBe(false);
  });

  it('错误的密钥或计数不一致会判定失败', async () => {
    const emailsRepo = new EmailsRepo(db);
    emailsRepo.upsertMany(ACCOUNT, FOLDER, 1, [sampleEmail(1)]);

    const backupPath = path.join(dir, 'backup-wrong.db');
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);

    const wrongKey = verifyBackupFile(backupPath, 'cd'.repeat(32));
    expect(wrongKey.ok).toBe(false);

    const wrongCount = verifyBackupFile(backupPath, KEY_HEX, { emails: 99 });
    expect(wrongCount.ok).toBe(false);
    expect(wrongCount.errors.join(' ')).toContain('emails');
  });

  it('备份产物保持加密', async () => {
    const emailsRepo = new EmailsRepo(db);
    emailsRepo.upsertMany(ACCOUNT, FOLDER, 1, [sampleEmail(1)]);

    const backupPath = path.join(dir, 'encrypted-copy.db');
    const result = await createVerifiedBackup(db, backupPath, KEY_HEX, {
      emails: 1,
      accounts: 0,
      folders: 0,
    });

    expect(result.ok).toBe(true);
    expect(isPlaintextSqlite(backupPath)).toBe(false);
    expect(result.encryptedHeader).toBe(true);
  });
});
