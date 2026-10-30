import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, insertAccount, insertEmail, type TestDb } from './helpers/test-db';
import { EmailsRepo } from '../src/main/db/repositories/emails-repo';

/**
 * 离线可读历史：正文必须落到 email_bodies（OST 式缓存），
 * 这里锁的是「还缺哪些正文」的挑选规则——补错对象等于白下载。
 */

let context: TestDb | null = null;
let emails: EmailsRepo;

beforeEach(() => {
  context = createTestDb();
  insertAccount(context.db, 'acc-1');
  insertAccount(context.db, 'acc-2');
  emails = new EmailsRepo(context.db);
});

afterEach(() => {
  context?.cleanup();
  context = null;
});

function seed(id: string, uid: number, date: number, folder = 'INBOX', accountId = 'acc-1'): void {
  insertEmail(context!.db, { id, accountId, uid, folder });
  context!.db.prepare('UPDATE emails SET date = ? WHERE id = ?').run(date, id);
}

describe('正文预取候选（missingBodies）', () => {
  it('只挑还没有正文的邮件，按日期从新到旧', () => {
    seed('e-old', 1, 1000);
    seed('e-mid', 2, 3000);
    seed('e-new', 3, 5000);
    emails.saveBody('e-mid', '<p>已有正文</p>', '已有正文');

    const missing = emails.missingBodies('acc-1', 'INBOX', 10);
    expect(missing.map((item) => item.id)).toEqual(['e-new', 'e-old']);
  });

  it('limit 生效，只取最近的 N 封', () => {
    for (let index = 0; index < 5; index += 1) {
      seed(`e-${index}`, index + 1, 1000 + index);
    }
    const missing = emails.missingBodies('acc-1', 'INBOX', 2);
    expect(missing.map((item) => item.id)).toEqual(['e-4', 'e-3']);
  });

  it('不跨账户、不跨文件夹', () => {
    seed('mine', 1, 1000);
    seed('other-account', 1, 2000, 'INBOX', 'acc-2');
    seed('other-folder', 1, 3000, 'Archive');
    const missing = emails.missingBodies('acc-1', 'INBOX', 10);
    expect(missing.map((item) => item.id)).toEqual(['mine']);
  });

  it('limit 为 0 时直接返回空（不查库也不算错）', () => {
    seed('e-1', 1, 1000);
    expect(emails.missingBodies('acc-1', 'INBOX', 0)).toEqual([]);
  });

  it('正文存了之后就不再是候选（body_fetched 被打上）', () => {
    seed('e-1', 1, 1000);
    expect(emails.missingBodies('acc-1', 'INBOX', 10)).toHaveLength(1);
    emails.saveBody('e-1', '<p>x</p>', 'x');
    expect(emails.missingBodies('acc-1', 'INBOX', 10)).toHaveLength(0);
  });
});
