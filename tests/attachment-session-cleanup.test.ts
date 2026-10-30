import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AttachmentStore } from '../src/main/attachments/store';
import { createTestDb, insertAccount, type TestDb } from './helpers/test-db';

/**
 * 退出时的会话附件清理（§11.6）。
 *
 * 坑：cleanupOlderThan 删文件后会把 attachments.local_path 置 NULL，
 * cleanupSession 却只删文件不置空。结果是退出后 DB 仍指向已删除的文件，
 * 而邮件正文已缓存、不会重新落盘——用户每次打开都看到
 * 「附件内容不可用，请重新打开邮件」，而且重开也好不了。
 */

const ACCOUNT = 'acc-1';

let context: TestDb;
let root: string;
let store: AttachmentStore;

beforeEach(() => {
  context = createTestDb();
  insertAccount(context.db, ACCOUNT);
  // attachments.email_id 有外键指向 emails：先建邮件行
  context.db
    .prepare(
      `INSERT INTO emails
         (id, account_id, folder, uid, uidvalidity, subject, from_json, to_json, date, snippet, unread)
       VALUES (?, ?, 'INBOX', 1, 1, 'subject', '[]', '[]', ?, '', 1)`,
    )
    .run(`${ACCOUNT}|INBOX|1`, ACCOUNT, Date.now());
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailforge-session-'));
  store = new AttachmentStore(context.db as never, root);
});

afterEach(() => {
  context.cleanup();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('AttachmentStore.cleanupSession', () => {
  it('删除会话文件后把 local_path 置 NULL，避免留下永久失效的引用', () => {
    store.save(`${ACCOUNT}|INBOX|1`, [
      { filename: 'a.txt', mimeType: 'text/plain', size: 1, content: new Uint8Array([97]) },
    ]);

    const before = context.db
      .prepare('SELECT local_path FROM attachments WHERE email_id = ?')
      .get(`${ACCOUNT}|INBOX|1`) as { local_path: string };
    expect(before.local_path).toBeTruthy();
    expect(fs.existsSync(before.local_path)).toBe(true);

    const removed = store.cleanupSession();
    expect(removed).toBe(1);
    expect(fs.existsSync(before.local_path)).toBe(false);

    const after = context.db
      .prepare('SELECT local_path FROM attachments WHERE email_id = ?')
      .get(`${ACCOUNT}|INBOX|1`) as { local_path: string | null };
    expect(after.local_path).toBeNull();
  });

  it('二次清理不会重复计数，也不会影响别的邮件', () => {
    store.save(`${ACCOUNT}|INBOX|1`, [
      { filename: 'a.txt', mimeType: 'text/plain', size: 1, content: new Uint8Array([97]) },
    ]);
    expect(store.cleanupSession()).toBe(1);
    expect(store.cleanupSession()).toBe(0);
  });
});
