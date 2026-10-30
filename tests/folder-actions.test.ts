import { afterEach, describe, expect, it } from 'vitest';
import { EmailsRepo } from '../src/main/db/repositories/emails-repo';
import { FoldersRepo } from '../src/main/db/repositories/folders-repo';
import { createTestDb, insertAccount, insertEmail, type TestDb } from './helpers/test-db';

let context: TestDb | null = null;

afterEach(() => {
  context?.cleanup();
  context = null;
});

function setup(): { emails: EmailsRepo; folders: FoldersRepo } {
  context = createTestDb();
  insertAccount(context.db, 'acc-1');
  insertAccount(context.db, 'acc-2');
  return { emails: new EmailsRepo(context.db), folders: new FoldersRepo(context.db) };
}

describe('文件夹右键「全部标为已读」的数据层', () => {
  it('只把该文件夹的未读清零，其他文件夹不受影响', () => {
    const { emails } = setup();
    insertEmail(context!.db, { id: 'a1', accountId: 'acc-1', uid: 1, unread: 1 });
    insertEmail(context!.db, { id: 'a2', accountId: 'acc-1', uid: 2, unread: 1 });
    insertEmail(context!.db, { id: 'a3', accountId: 'acc-1', uid: 3, unread: 0 });
    insertEmail(context!.db, {
      id: 'b1',
      accountId: 'acc-1',
      uid: 1,
      folder: 'Archive',
      unread: 1,
    });

    expect(emails.markFolderRead('acc-1', 'INBOX')).toBe(2);
    expect(emails.list('acc-1', 'INBOX', 0, 10, Date.now(), 'unread')).toEqual([]);
    expect(emails.total('acc-1', 'INBOX', Date.now(), 'unread')).toBe(0);
    // 其他文件夹原样
    expect(emails.total('acc-1', 'Archive', Date.now(), 'unread')).toBe(1);
  });

  it('没有未读时返回 0，不会误报改动', () => {
    const { emails } = setup();
    insertEmail(context!.db, { id: 'r1', accountId: 'acc-1', uid: 1, unread: 0 });
    expect(emails.markFolderRead('acc-1', 'INBOX')).toBe(0);
  });

  it('不跨账户', () => {
    const { emails } = setup();
    insertEmail(context!.db, { id: 'x1', accountId: 'acc-1', uid: 1, unread: 1 });
    insertEmail(context!.db, { id: 'x2', accountId: 'acc-2', uid: 1, unread: 1 });
    expect(emails.markFolderRead('acc-1', 'INBOX')).toBe(1);
    expect(emails.total('acc-2', 'INBOX', Date.now(), 'unread')).toBe(1);
  });
});

describe('文件夹属性（folders.list + getState）', () => {
  it('列出文件夹时带上路径/名称/未读与总数', () => {
    const { folders } = setup();
    folders.upsertFolder('acc-1', { path: 'INBOX', name: 'INBOX', delimiter: '/' });
    folders.upsertFolder('acc-1', { path: 'Work/2026', name: '2026', delimiter: '/' });
    insertEmail(context!.db, { id: 'w1', accountId: 'acc-1', uid: 1, folder: 'Work/2026', unread: 1 });

    const list = folders.list('acc-1');
    const work = list.find((item) => item.path === 'Work/2026');
    expect(work).toBeDefined();
    expect(work?.name).toBe('2026');
    expect(work?.delimiter).toBe('/');
    expect(work?.unread).toBe(1);
    expect(work?.total).toBe(1);
    expect(list.find((item) => item.path === 'INBOX')?.name).toBe('收件箱');
  });

  it('同步状态：没同步过时 UIDVALIDITY 为 0', () => {
    const { folders } = setup();
    folders.upsertFolder('acc-1', { path: 'INBOX', name: 'INBOX', delimiter: '/' });
    expect(folders.getState('acc-1', 'INBOX')?.uidValidity).toBe(0);

    folders.updateAfterSync('acc-1', 'INBOX', {
      uidValidity: 9001,
      capabilityLevel: 'L1_CHANGEDSINCE',
      lastSyncAt: 1700000000000,
    });
    const state = folders.getState('acc-1', 'INBOX');
    expect(state?.uidValidity).toBe(9001);
    expect(state?.lastSyncAt).toBe(1700000000000);
    expect(state?.needsFullResync).toBe(false);
  });
});

describe('清空 / 去重 / 批量删除（右键菜单的数据层）', () => {
  it('清空文件夹只删本文件夹的邮件，文件夹行还在', () => {
    const { emails, folders } = setup();
    folders.upsertFolder('acc-1', { path: 'INBOX', name: 'INBOX', delimiter: '/' });
    folders.upsertFolder('acc-1', { path: 'Archive', name: 'Archive', delimiter: '/' });
    insertEmail(context!.db, { id: 'c1', accountId: 'acc-1', uid: 1 });
    insertEmail(context!.db, { id: 'c2', accountId: 'acc-1', uid: 2 });
    insertEmail(context!.db, { id: 'c3', accountId: 'acc-1', uid: 1, folder: 'Archive' });
    context!.db
      .prepare('INSERT INTO emails_fts (email_id, subject, body) VALUES (?, ?, ?)')
      .run('c1', '主题', '正文');

    expect(emails.clearFolder('acc-1', 'INBOX')).toBe(2);
    expect(emails.total('acc-1', 'INBOX', Date.now())).toBe(0);
    expect(emails.total('acc-1', 'Archive', Date.now())).toBe(1);
    expect(folders.list('acc-1').map((item) => item.path)).toContain('INBOX');
    const left = context!.db
      .prepare('SELECT COUNT(*) AS c FROM emails_fts WHERE email_id = ?')
      .get('c1') as { c: number };
    expect(left.c).toBe(0);
  });

  it('重复邮件按 Message-ID 归组，保留最新一封', () => {
    const { emails } = setup();
    insertEmail(context!.db, { id: 'd1', accountId: 'acc-1', uid: 1 });
    insertEmail(context!.db, { id: 'd2', accountId: 'acc-1', uid: 2 });
    insertEmail(context!.db, { id: 'd3', accountId: 'acc-1', uid: 3 });
    const setMid = (id: string, mid: string, date: number): void => {
      context!.db
        .prepare('UPDATE emails SET message_id = ?, date = ? WHERE id = ?')
        .run(mid, date, id);
    };
    setMid('d1', '<a@x>', 1000);
    setMid('d2', '<A@X>', 3000);
    setMid('d3', '<b@x>', 2000);

    const duplicates = emails.findDuplicates('acc-1', 'INBOX');
    // d1 与 d2 同 Message-ID（大小写不同也算），保留更新的 d2
    expect(duplicates.map((item) => item.id)).toEqual(['d1']);
    expect(duplicates[0]?.uid).toBe(1);
  });

  it('deleteByIds 连搜索索引一起删，且不越界删别的账户', () => {
    const { emails } = setup();
    insertEmail(context!.db, { id: 'e1', accountId: 'acc-1', uid: 1 });
    insertEmail(context!.db, { id: 'e2', accountId: 'acc-1', uid: 2 });
    insertEmail(context!.db, { id: 'e3', accountId: 'acc-2', uid: 1 });
    context!.db
      .prepare('INSERT INTO emails_fts (email_id, subject, body) VALUES (?, ?, ?)')
      .run('e1', '主题', '正文');

    expect(emails.deleteByIds('acc-1', ['e1'])).toBe(1);
    expect(emails.total('acc-1', 'INBOX', Date.now())).toBe(1);
    expect(emails.total('acc-2', 'INBOX', Date.now())).toBe(1);
    const left = context!.db
      .prepare('SELECT COUNT(*) AS c FROM emails_fts WHERE email_id = ?')
      .get('e1') as { c: number };
    expect(left.c).toBe(0);
  });

  it('deleteByIds 空数组是 no-op', () => {
    const { emails } = setup();
    insertEmail(context!.db, { id: 'n1', accountId: 'acc-1', uid: 1 });
    expect(emails.deleteByIds('acc-1', [])).toBe(0);
    expect(emails.total('acc-1', 'INBOX', Date.now())).toBe(1);
  });
});
