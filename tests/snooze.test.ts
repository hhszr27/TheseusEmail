import { afterEach, describe, expect, it } from 'vitest';
import { EmailsRepo } from '../src/main/db/repositories/emails-repo';
import { createTestDb, insertAccount, insertEmail, type TestDb } from './helpers/test-db';

let context: TestDb | null = null;

afterEach(() => {
  context?.cleanup();
  context = null;
});

function setup(): EmailsRepo {
  context = createTestDb();
  insertAccount(context.db, 'acc-1');
  insertAccount(context.db, 'acc-2');
  return new EmailsRepo(context.db);
}

describe('统一收件箱（§23.1）', () => {
  it('跨账户按时间倒序合并', () => {
    const repo = setup();
    insertEmail(context!.db, { id: 'a1', accountId: 'acc-1', uid: 1, date: 1000, subject: 'a1' });
    insertEmail(context!.db, { id: 'b1', accountId: 'acc-2', uid: 1, date: 3000, subject: 'b1' });
    insertEmail(context!.db, { id: 'a2', accountId: 'acc-1', uid: 2, date: 2000, subject: 'a2' });

    const listed = repo.listUnified(0, 10);
    expect(listed.map((email) => email.id)).toEqual(['b1', 'a2', 'a1']);
    expect(repo.totalUnified()).toBe(3);
  });

  it('只合并收件箱文件夹', () => {
    const repo = setup();
    insertEmail(context!.db, { id: 'a1', accountId: 'acc-1', uid: 1 });
    insertEmail(context!.db, { id: 'a2', accountId: 'acc-1', uid: 2, folder: 'Archive' });
    expect(repo.listUnified(0, 10).map((email) => email.id)).toEqual(['a1']);
    expect(repo.totalUnified()).toBe(1);
  });
});

describe('Snooze（§23.3）', () => {
  it('未到期不出现，到期自动重现', () => {
    const repo = setup();
    const now = 10_000;
    insertEmail(context!.db, {
      id: 'future',
      accountId: 'acc-1',
      uid: 1,
      date: now - 1000,
      snoozedUntil: now + 60_000,
    });
    insertEmail(context!.db, {
      id: 'due',
      accountId: 'acc-1',
      uid: 2,
      date: now - 2000,
      snoozedUntil: now - 1,
    });
    insertEmail(context!.db, { id: 'plain', accountId: 'acc-1', uid: 3, date: now - 3000 });

    expect(repo.listUnified(0, 10, 'INBOX', now).map((email) => email.id)).toEqual(['due', 'plain']);
    expect(repo.totalUnified('INBOX', now)).toBe(2);
    // 单账户列表也必须过滤未到期的 Snooze
    expect(repo.list('acc-1', 'INBOX', 0, 10, now).map((email) => email.id)).toEqual(['due', 'plain']);
    expect(repo.total('acc-1', 'INBOX', now)).toBe(2);

    // 时间推进后，原来看不到的邮件重新出现
    expect(repo.listUnified(0, 10, 'INBOX', now + 61_000).map((email) => email.id)).toContain('future');
  });

  it('单账户列表同样遵循 Snooze', () => {
    const repo = setup();
    const now = 20_000;
    insertEmail(context!.db, {
      id: 's1',
      accountId: 'acc-1',
      uid: 1,
      snoozedUntil: now + 5000,
    });
    expect(repo.total('acc-1', 'INBOX', now)).toBe(0);
    expect(repo.total('acc-1', 'INBOX', now + 6000)).toBe(1);
  });

  it('设置与取消 Snooze', () => {
    const repo = setup();
    insertEmail(context!.db, { id: 'a1', accountId: 'acc-1', uid: 1 });

    expect(repo.setSnoozed('a1', 5000)).toBe(true);
    const row = context!.db
      .prepare('SELECT snoozed_until FROM emails WHERE id = ?')
      .get('a1') as { snoozed_until: number | null };
    expect(row.snoozed_until).toBe(5000);

    expect(repo.setSnoozed('a1', null)).toBe(true);
    expect(repo.total('acc-1', 'INBOX', 1)).toBe(1);
    expect(repo.setSnoozed('missing', 1000)).toBe(false);
  });
});
