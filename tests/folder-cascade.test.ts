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

function seedTree(folders: FoldersRepo): void {
  folders.upsertFolder('acc-1', { path: 'A', name: 'A', delimiter: '/' });
  folders.upsertFolder('acc-1', { path: 'A/B', name: 'B', delimiter: '/' });
  folders.upsertFolder('acc-1', { path: 'A2', name: 'A2', delimiter: '/' });
  insertEmail(context!.db, { id: 'e-a', accountId: 'acc-1', uid: 1, folder: 'A' });
  insertEmail(context!.db, { id: 'e-b', accountId: 'acc-1', uid: 1, folder: 'A/B' });
  insertEmail(context!.db, { id: 'e-a2', accountId: 'acc-1', uid: 1, folder: 'A2' });
}

describe('文件夹改名（FoldersRepo.renameFolder）', () => {
  it('连带子文件夹一起换前缀，邮件跟着搬', () => {
    const { folders } = setup();
    seedTree(folders);

    expect(folders.renameFolder('acc-1', 'A', 'X', '/')).toBe(2);

    const paths = folders.list('acc-1').map((item) => item.path);
    expect(paths).toContain('X');
    expect(paths).toContain('X/B');
    expect(paths).not.toContain('A');
    expect(paths).not.toContain('A/B');

    const view = folders.list('acc-1');
    expect(view.find((item) => item.path === 'X')?.total).toBe(1);
    expect(view.find((item) => item.path === 'X/B')?.total).toBe(1);
    expect(view.find((item) => item.path === 'X/B')?.name).toBe('B');
  });

  it('相近前缀的兄弟文件夹不受影响（A2 不是 A 的子目录）', () => {
    const { folders } = setup();
    seedTree(folders);

    folders.renameFolder('acc-1', 'A', 'X', '/');
    const paths = folders.list('acc-1').map((item) => item.path);
    expect(paths).toContain('A2');
    expect(paths.find((item) => item.startsWith('X2'))).toBeUndefined();
  });

  it('不跨账户', () => {
    const { folders } = setup();
    folders.upsertFolder('acc-2', { path: 'A', name: 'A', delimiter: '/' });
    folders.upsertFolder('acc-1', { path: 'A', name: 'A', delimiter: '/' });

    folders.renameFolder('acc-1', 'A', 'X', '/');
    expect(folders.list('acc-1').map((item) => item.path)).toEqual(['X']);
    expect(folders.list('acc-2').map((item) => item.path)).toEqual(['A']);
  });

  it('本地没有这个文件夹时返回 0，不做任何改动', () => {
    const { folders } = setup();
    folders.upsertFolder('acc-1', { path: 'A', name: 'A', delimiter: '/' });
    expect(folders.renameFolder('acc-1', '不存在', 'X', '/')).toBe(0);
    expect(folders.list('acc-1').map((item) => item.path)).toEqual(['A']);
  });
});

describe('文件夹删除（FoldersRepo.removeFolder）', () => {
  it('连同子文件夹一起清掉，邮件与搜索索引都不留', () => {
    const { folders } = setup();
    seedTree(folders);
    // 给 e-a 造一条搜索索引，验证删除时会一起清掉
    context!.db
      .prepare('INSERT INTO emails_fts (email_id, subject, body) VALUES (?, ?, ?)')
      .run('e-a', '主题', '正文');

    const removed = folders.removeFolder('acc-1', 'A', '/');
    expect(removed).toEqual({ folders: 2, emails: 2 });

    const paths = folders.list('acc-1').map((item) => item.path);
    expect(paths).toEqual(['A2']);

    const left = context!.db
      .prepare('SELECT COUNT(*) AS c FROM emails_fts WHERE email_id = ?')
      .get('e-a') as { c: number };
    expect(left.c).toBe(0);
    const emailsLeft = context!.db
      .prepare('SELECT COUNT(*) AS c FROM emails WHERE account_id = ? AND folder IN (?, ?)')
      .get('acc-1', 'A', 'A/B') as { c: number };
    expect(emailsLeft.c).toBe(0);
  });

  it('只删目标文件夹，不碰相近前缀与别的账户', () => {
    const { folders } = setup();
    seedTree(folders);
    folders.upsertFolder('acc-2', { path: 'A', name: 'A', delimiter: '/' });

    folders.removeFolder('acc-1', 'A', '/');
    expect(folders.list('acc-1').map((item) => item.path)).toEqual(['A2']);
    expect(folders.list('acc-2').map((item) => item.path)).toEqual(['A']);
  });

  it('不存在的路径返回 0', () => {
    const { folders } = setup();
    expect(folders.removeFolder('acc-1', 'NOPE', '/')).toEqual({ folders: 0, emails: 0 });
  });
});
