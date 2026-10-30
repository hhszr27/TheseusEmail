import Database from 'better-sqlite3-multiple-ciphers';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EmailsRepo } from '../src/main/db/repositories/emails-repo';
import { applyRuleEffect } from '../src/main/rules/apply';
import type { RawEmailSummary } from '../src/main/mail/sync/protocol';

let dir = '';
let db: Database.Database;
let emails: EmailsRepo;

const raw: RawEmailSummary = {
  uid: 1,
  messageId: '<1@example.com>',
  subject: '测试邮件',
  from: [{ name: 'Alice', address: 'alice@example.com' }],
  to: [{ address: 'me@example.com' }],
  dateMs: Date.now(),
  snippet: 'snippet',
  hasAttachments: false,
  unread: true,
  starred: false,
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-rules-'));
  db = new Database(path.join(dir, 'db.sqlite'));
  db.pragma(`key = "x'${'bb'.repeat(32)}'"`);
  db.exec(fs.readFileSync(path.resolve('migrations/V001__initial.sql'), 'utf8'));
  emails = new EmailsRepo(db);
  emails.upsertMany('acc', 'INBOX', 1, [raw]);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('规则动作落库（§17）', () => {
  it('标记已读、星标、置顶并移动文件夹', () => {
    const before = emails.get('acc|INBOX|1');
    expect(before?.unread).toBe(true);

    const changed = applyRuleEffect(
      db,
      before!,
      {
        ruleId: 'rule-1',
        actions: { markRead: true, star: true, pin: true, moveTo: 'Archive' },
      },
      { notify: () => {} },
    );

    expect(changed).toBe(true);
    const after = emails.get('acc|INBOX|1');
    expect(after?.unread).toBe(false);
    expect(after?.starred).toBe(true);
    expect(after?.pinned).toBe(true);
    expect(after?.folder).toBe('Archive');
  });

  it('notify 动作触发通知钩子', () => {
    const notified: string[] = [];
    const email = emails.get('acc|INBOX|1')!;
    applyRuleEffect(
      db,
      email,
      { ruleId: 'rule-2', actions: { notify: true } },
      { notify: (item) => notified.push(item.id) },
    );
    expect(notified).toEqual(['acc|INBOX|1']);
  });
});
