import { afterEach, describe, expect, it } from 'vitest';
import type { ListFilter, ListSort } from '../src/shared/ipc';
import { EmailsRepo } from '../src/main/db/repositories/emails-repo';
import {
  filterCondition,
  normalizeListFilter,
  normalizeListSort,
  sortOrderSql,
} from '../src/main/db/list-query';
import { dropsFromFilteredList, needsFilteredReload } from '../src/renderer/lib/list-filter';
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

/** 固定「现在」，让 snooze 断言不受运行时刻影响。 */
const NOW = 1_700_000_000_000;

function ids(repo: EmailsRepo, filter: ListFilter, sort: ListSort = 'date'): string[] {
  return repo.list('acc-1', 'INBOX', 0, 20, NOW, filter, sort).map((email) => email.id);
}

describe('列表筛选：单账户（§7.8.2）', () => {
  it('三种口径的列表与 total 始终同口径', () => {
    const repo = setup();
    insertEmail(context!.db, { id: 'r1', accountId: 'acc-1', uid: 1, date: 4000 });
    insertEmail(context!.db, { id: 'u1', accountId: 'acc-1', uid: 2, date: 3000, unread: 1 });
    insertEmail(context!.db, { id: 's1', accountId: 'acc-1', uid: 3, date: 2000, starred: 1 });
    insertEmail(context!.db, {
      id: 'us',
      accountId: 'acc-1',
      uid: 4,
      date: 1000,
      unread: 1,
      starred: 1,
    });

    expect(ids(repo, 'all')).toEqual(['r1', 'u1', 's1', 'us']);
    expect(repo.total('acc-1', 'INBOX', NOW, 'all')).toBe(4);

    expect(ids(repo, 'unread')).toEqual(['u1', 'us']);
    expect(repo.total('acc-1', 'INBOX', NOW, 'unread')).toBe(2);

    expect(ids(repo, 'starred')).toEqual(['s1', 'us']);
    expect(repo.total('acc-1', 'INBOX', NOW, 'starred')).toBe(2);
  });

  it('筛选不影响其他文件夹；没有匹配时列表与总数都为 0', () => {
    const repo = setup();
    insertEmail(context!.db, { id: 'x1', accountId: 'acc-1', uid: 1, folder: 'Archive', unread: 1 });
    expect(
      repo.list('acc-1', 'Archive', 0, 20, NOW, 'unread').map((email) => email.id),
    ).toEqual(['x1']);
    expect(repo.total('acc-1', 'Archive', NOW, 'unread')).toBe(1);

    expect(
      repo.list('acc-1', 'Archive', 0, 20, NOW, 'starred').map((email) => email.id),
    ).toEqual([]);
    expect(repo.total('acc-1', 'Archive', NOW, 'starred')).toBe(0);
  });

  it('snooze 未到期的邮件在筛选列表里同样不出现（§23.3）', () => {
    const repo = setup();
    insertEmail(context!.db, {
      id: 'later',
      accountId: 'acc-1',
      uid: 1,
      unread: 1,
      starred: 1,
      snoozedUntil: NOW + 60_000,
    });
    expect(ids(repo, 'unread')).toEqual([]);
    expect(repo.total('acc-1', 'INBOX', NOW, 'unread')).toBe(0);
    expect(ids(repo, 'starred')).toEqual([]);
  });
});

describe('列表筛选：统一收件箱（§23.1）', () => {
  it('筛选只合并启用账户，排除禁用账户的邮件', () => {
    const repo = setup();
    insertEmail(context!.db, { id: 'a-u', accountId: 'acc-1', uid: 1, unread: 1, starred: 1 });
    insertEmail(context!.db, { id: 'b-u', accountId: 'acc-2', uid: 1, unread: 1, starred: 1 });
    context!.db.prepare('UPDATE accounts SET enabled = 0 WHERE id = ?').run('acc-2');

    expect(repo.listUnified(0, 20, 'INBOX', NOW, 'unread').map((email) => email.id)).toEqual([
      'a-u',
    ]);
    expect(repo.totalUnified('INBOX', NOW, 'unread')).toBe(1);
    expect(repo.listUnified(0, 20, 'INBOX', NOW, 'starred').map((email) => email.id)).toEqual([
      'a-u',
    ]);
    expect(repo.totalUnified('INBOX', NOW, 'starred')).toBe(1);
    // 不过滤时禁用账户仍被排除，与既有口径一致
    expect(repo.totalUnified('INBOX', NOW)).toBe(1);
  });

  it('按账户排列时用账户邮箱当排序键，而不是本机 uuid 顺序', () => {
    const repo = setup();
    // 故意让 uuid 顺序与邮箱顺序相反：acc-z 的邮箱更小
    insertAccount(context!.db, 'acc-z', 'aaa@example.com');
    insertAccount(context!.db, 'acc-a', 'zzz@example.com');
    insertEmail(context!.db, { id: 'z1', accountId: 'acc-z', uid: 1, date: 3000 });
    insertEmail(context!.db, { id: 'a1', accountId: 'acc-a', uid: 1, date: 4000 });

    expect(
      repo.listUnified(0, 20, 'INBOX', NOW, 'all', 'account').map((email) => email.id),
    ).toEqual(['z1', 'a1']);
    // 默认按日期倒序时 a1 在前，证明上面的差异确实来自排序键
    expect(repo.listUnified(0, 20, 'INBOX', NOW).map((email) => email.id)).toEqual(['a1', 'z1']);
  });
});

describe('列表排列方式', () => {
  function seed(): void {
    insertEmail(context!.db, {
      id: 'm1',
      accountId: 'acc-1',
      uid: 1,
      date: 3000,
      subject: 'beta',
      from: [{ address: 'bob@example.com' }],
    });
    insertEmail(context!.db, {
      id: 'm2',
      accountId: 'acc-1',
      uid: 2,
      date: 2000,
      subject: 'Alpha',
      from: [{ name: 'Zoe', address: 'zoe@example.com' }],
    });
    insertEmail(context!.db, {
      id: 'm3',
      accountId: 'acc-1',
      uid: 3,
      date: 1000,
      subject: 'gamma',
      from: [{ address: 'amy@example.com' }],
      hasAttachments: 1,
    });
  }

  it('日期（默认）按时间倒序', () => {
    const repo = setup();
    seed();
    expect(ids(repo, 'all', 'date')).toEqual(['m1', 'm2', 'm3']);
    expect(ids(repo, 'all')).toEqual(['m1', 'm2', 'm3']);
  });

  it('主题按字母升序（大小写不敏感），仍以日期兜底', () => {
    const repo = setup();
    seed();
    expect(ids(repo, 'all', 'subject')).toEqual(['m2', 'm1', 'm3']);
  });

  it('发件人按列表显示的字符串升序：有显示名用显示名，否则用地址', () => {
    const repo = setup();
    seed();
    // amy@ (地址) < bob@ (地址) < Zoe (显示名)：不能因为有无显示名而分堆
    expect(ids(repo, 'all', 'from')).toEqual(['m3', 'm1', 'm2']);
  });

  it('「到」按收件人的显示字符串升序，口径与发件人一致', () => {
    const repo = setup();
    insertEmail(context!.db, {
      id: 't1',
      accountId: 'acc-1',
      uid: 1,
      date: 3000,
      to: [{ address: 'bob@example.com' }],
    });
    insertEmail(context!.db, {
      id: 't2',
      accountId: 'acc-1',
      uid: 2,
      date: 2000,
      to: [{ name: 'Zoe', address: 'zoe@example.com' }],
    });
    insertEmail(context!.db, {
      id: 't3',
      accountId: 'acc-1',
      uid: 3,
      date: 1000,
      to: [{ address: 'amy@example.com' }],
    });
    expect(ids(repo, 'all', 'to')).toEqual(['t3', 't1', 't2']);
  });

  it('「标记状态」已标记的排前面，同组内按日期倒序', () => {
    const repo = setup();
    insertEmail(context!.db, { id: 'f1', accountId: 'acc-1', uid: 1, date: 3000 });
    insertEmail(context!.db, { id: 'f2', accountId: 'acc-1', uid: 2, date: 1000, starred: 1 });
    insertEmail(context!.db, { id: 'f3', accountId: 'acc-1', uid: 3, date: 2000, starred: 1 });
    expect(ids(repo, 'all', 'flagged')).toEqual(['f3', 'f2', 'f1']);
  });

  it('附件：有附件的排前面，同组内按日期倒序', () => {
    const repo = setup();
    seed();
    expect(ids(repo, 'all', 'attachments')).toEqual(['m3', 'm1', 'm2']);
  });

  it('同一排序值内部用日期+uid 兜底，分页不会漏行或重复', () => {
    const repo = setup();
    insertEmail(context!.db, { id: 'p1', accountId: 'acc-1', uid: 1, date: 100, subject: 'same' });
    insertEmail(context!.db, { id: 'p2', accountId: 'acc-1', uid: 2, date: 300, subject: 'same' });
    insertEmail(context!.db, { id: 'p3', accountId: 'acc-1', uid: 3, date: 200, subject: 'same' });

    const firstPage = repo.list('acc-1', 'INBOX', 0, 2, NOW, 'all', 'subject').map((e) => e.id);
    const secondPage = repo.list('acc-1', 'INBOX', 2, 2, NOW, 'all', 'subject').map((e) => e.id);
    expect([...firstPage, ...secondPage]).toEqual(['p2', 'p3', 'p1']);
  });
});

describe('IPC 边界归一化（§36）', () => {
  it('白名单之外的值一律回落默认，外部字符串进不了 SQL', () => {
    expect(normalizeListFilter('unread')).toBe('unread');
    expect(normalizeListFilter('starred')).toBe('starred');
    expect(normalizeListFilter('all')).toBe('all');
    expect(normalizeListFilter('unread; DROP TABLE emails')).toBe('all');
    expect(normalizeListFilter(undefined)).toBe('all');
    expect(normalizeListFilter(1)).toBe('all');

    expect(normalizeListSort('subject')).toBe('subject');
    expect(normalizeListSort('date')).toBe('date');
    expect(normalizeListSort('pinned; DROP TABLE emails')).toBe('date');
    expect(normalizeListSort(null)).toBe('date');
  });

  it('无筛选时条件为空串，避免拼出悬空 AND', () => {
    expect(filterCondition('all')).toBe('');
    expect(filterCondition('unread')).toBe('unread = 1');
    expect(filterCondition('starred', 'e')).toBe('e.starred = 1');
  });

  it('每种排列方式都带日期+uid 兜底，并接受表别名', () => {
    const sorts: ListSort[] = ['date', 'from', 'to', 'flagged', 'subject', 'attachments', 'account'];
    for (const sort of sorts) {
      expect(sortOrderSql(sort, 'e')).toContain('e.date DESC, e.uid DESC');
    }
    expect(sortOrderSql('date')).not.toContain('e.');
  });
});

describe('筛选态下的列表局部演化（lib/list-filter.ts）', () => {
  const base = { stillUnread: false, stillStarred: false, isSelected: false };

  it('未读筛选：标记已读且非选中 → 立即出列', () => {
    expect(dropsFromFilteredList({ ...base, filter: 'unread', patch: { read: true } })).toBe(true);
  });

  it('正在阅读的这封先留着，避免正文还在看列表把人抖掉', () => {
    expect(
      dropsFromFilteredList({
        ...base,
        filter: 'unread',
        patch: { read: true },
        isSelected: true,
      }),
    ).toBe(false);
  });

  it('服务端回传仍未读（写入被拒）时不离开列表', () => {
    expect(
      dropsFromFilteredList({
        ...base,
        filter: 'unread',
        patch: { read: true },
        stillUnread: true,
      }),
    ).toBe(false);
  });

  it('「所有邮件」口径下标记已读不出列', () => {
    expect(dropsFromFilteredList({ ...base, filter: 'all', patch: { read: true } })).toBe(false);
  });

  it('已标记筛选：取消星标 → 出列；仍在阅读的除外', () => {
    expect(
      dropsFromFilteredList({ ...base, filter: 'starred', patch: { starred: false } }),
    ).toBe(true);
    expect(
      dropsFromFilteredList({
        ...base,
        filter: 'starred',
        patch: { starred: false },
        isSelected: true,
      }),
    ).toBe(false);
  });

  it('已标记筛选：加星标不出列（原本就不在列表里，走重查）', () => {
    expect(
      dropsFromFilteredList({ ...base, filter: 'starred', patch: { starred: true } }),
    ).toBe(false);
  });

  it('操作后可能开始符合筛选时只能重查', () => {
    expect(needsFilteredReload({ filter: 'unread', patch: { read: false } })).toBe(true);
    expect(needsFilteredReload({ filter: 'starred', patch: { starred: true } })).toBe(true);
    expect(needsFilteredReload({ filter: 'unread', patch: { read: true } })).toBe(false);
    expect(needsFilteredReload({ filter: 'starred', patch: { starred: false } })).toBe(false);
    expect(needsFilteredReload({ filter: 'all', patch: { read: false } })).toBe(false);
  });
});
