import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountsRepo } from '../src/main/db/repositories/accounts-repo';
import { EmailsRepo } from '../src/main/db/repositories/emails-repo';
import { FoldersRepo } from '../src/main/db/repositories/folders-repo';
import { MailActionError, MailActionsService } from '../src/main/mail/actions';
import type { AccountManager } from '../src/main/mail/account-manager';
import { createTestDb, insertAccount, type TestDb } from './helpers/test-db';

/**
 * 邮件操作（§8 标志写入、归档、删除）：
 *  - 先写服务端、成功后才改本地；服务端失败时本地保持不变
 *  - 演示账户跳过网络，只改本地
 *  - 归档优先 \Archive，缺失时报 NO_ARCHIVE
 */

const ACCOUNT = 'acc-1';
const EMAIL_ID = `${ACCOUNT}|INBOX|7`;

interface FakeManager {
  setMessageFlags: ReturnType<typeof vi.fn>;
  moveMessage: ReturnType<typeof vi.fn>;
  deleteMessage: ReturnType<typeof vi.fn>;
  syncFolder: ReturnType<typeof vi.fn>;
}

function createManager(overrides: Partial<FakeManager> = {}): FakeManager {
  return {
    setMessageFlags: vi.fn(async () => undefined),
    moveMessage: vi.fn(async () => undefined),
    deleteMessage: vi.fn(async () => undefined),
    syncFolder: vi.fn(async () => undefined),
    ...overrides,
  };
}

let context: TestDb;
let accounts: AccountsRepo;
let emails: EmailsRepo;
let folders: FoldersRepo;

function service(manager: FakeManager): MailActionsService {
  return new MailActionsService({
    emails,
    accounts,
    folders,
    manager: manager as unknown as AccountManager,
  });
}

beforeEach(() => {
  context = createTestDb();
  accounts = new AccountsRepo(context.db);
  emails = new EmailsRepo(context.db);
  folders = new FoldersRepo(context.db);
  insertAccount(context.db, ACCOUNT);
  emails.upsertMany(ACCOUNT, 'INBOX', 1, [
    {
      uid: 7,
      messageId: '<7@example.com>',
      subject: 'hello',
      from: [{ address: 'sender@example.com' }],
      to: [{ address: 'me@example.com' }],
      dateMs: Date.UTC(2026, 9, 1, 9, 0, 0),
      snippet: 'hi',
      hasAttachments: false,
      unread: true,
      starred: false,
    },
  ]);
});

afterEach(() => {
  context.cleanup();
  vi.restoreAllMocks();
});

describe('已读/星标（先服务端后本地）', () => {
  it('写服务端成功后更新本地标志', async () => {
    const manager = createManager();
    const updated = await service(manager).setFlags(EMAIL_ID, { read: true, starred: true });

    expect(manager.setMessageFlags).toHaveBeenCalledWith(
      expect.objectContaining({ id: ACCOUNT }),
      'INBOX',
      7,
      ['\\Seen', '\\Flagged'],
      [],
    );
    expect(updated.unread).toBe(false);
    expect(updated.starred).toBe(true);
    expect(emails.get(EMAIL_ID)?.unread).toBe(false);
  });

  it('取消已读/星标写入的是 remove 列表', async () => {
    emails.updateFlags(EMAIL_ID, { unread: false, starred: true });
    const manager = createManager();

    await service(manager).setFlags(EMAIL_ID, { read: false, starred: false });

    expect(manager.setMessageFlags).toHaveBeenCalledWith(
      expect.objectContaining({ id: ACCOUNT }),
      'INBOX',
      7,
      [],
      ['\\Seen', '\\Flagged'],
    );
    expect(emails.get(EMAIL_ID)?.unread).toBe(true);
    expect(emails.get(EMAIL_ID)?.starred).toBe(false);
  });

  it('服务端失败时不改本地，并抛 SERVER_FAILED', async () => {
    const manager = createManager({
      setMessageFlags: vi.fn(async () => {
        throw new Error('connection lost');
      }),
    });

    await expect(service(manager).setFlags(EMAIL_ID, { read: true })).rejects.toMatchObject({
      code: 'SERVER_FAILED',
    });
    expect(emails.get(EMAIL_ID)?.unread).toBe(true);
  });

  it('演示账户跳过网络调用，只改本地', async () => {
    context.db
      .prepare('UPDATE accounts SET settings_json = ? WHERE id = ?')
      .run(JSON.stringify({ demoMode: true }), ACCOUNT);
    const manager = createManager();

    await service(manager).setFlags(EMAIL_ID, { read: true });

    expect(manager.setMessageFlags).not.toHaveBeenCalled();
    expect(emails.get(EMAIL_ID)?.unread).toBe(false);
  });

  it('邮件不存在时报 NOT_FOUND', async () => {
    await expect(service(createManager()).setFlags('missing', { read: true })).rejects.toBeInstanceOf(
      MailActionError,
    );
  });
});

describe('归档与删除', () => {
  it('优先使用 \\Archive 文件夹，移动后移除本地源行', async () => {
    folders.upsertFolder(ACCOUNT, { path: 'INBOX', name: 'INBOX', delimiter: '/' });
    folders.upsertFolder(ACCOUNT, {
      path: 'Archive',
      name: 'Archive',
      delimiter: '/',
      specialUse: 'archive',
    });
    const manager = createManager();

    const result = await service(manager).archive(EMAIL_ID);

    expect(result.folder).toBe('Archive');
    expect(manager.moveMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: ACCOUNT }),
      'INBOX',
      7,
      'Archive',
    );
    expect(emails.get(EMAIL_ID)).toBeNull();
    expect(manager.syncFolder).toHaveBeenCalledWith(expect.objectContaining({ id: ACCOUNT }), 'Archive');
  });

  it('没有归档文件夹时抛 NO_ARCHIVE，且不动本地数据', async () => {
    folders.upsertFolder(ACCOUNT, { path: 'INBOX', name: 'INBOX', delimiter: '/' });

    await expect(service(createManager()).archive(EMAIL_ID)).rejects.toMatchObject({
      code: 'NO_ARCHIVE',
    });
    expect(emails.get(EMAIL_ID)).not.toBeNull();
  });

  it('按名字识别「归档」文件夹（无 special-use 的服务器）', async () => {
    folders.upsertFolder(ACCOUNT, { path: 'INBOX', name: 'INBOX', delimiter: '/' });
    folders.upsertFolder(ACCOUNT, { path: '归档', name: '归档', delimiter: '/' });

    const result = await service(createManager()).archive(EMAIL_ID);
    expect(result.folder).toBe('归档');
  });

  it('删除：服务端成功后才清本地行', async () => {
    const manager = createManager();
    await service(manager).remove(EMAIL_ID);

    expect(manager.deleteMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: ACCOUNT }),
      'INBOX',
      7,
    );
    expect(emails.get(EMAIL_ID)).toBeNull();
  });

  it('删除服务端失败时保留本地行', async () => {
    const manager = createManager({
      deleteMessage: vi.fn(async () => {
        throw new Error('timeout');
      }),
    });

    await expect(service(manager).remove(EMAIL_ID)).rejects.toMatchObject({
      code: 'SERVER_FAILED',
    });
    expect(emails.get(EMAIL_ID)).not.toBeNull();
  });
});
