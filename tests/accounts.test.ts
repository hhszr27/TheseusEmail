import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Account } from '../src/shared/types';
import type { AccountInput } from '../src/shared/accounts';
import { AccountsRepo } from '../src/main/db/repositories/accounts-repo';
import { EmailsRepo } from '../src/main/db/repositories/emails-repo';
import { AccountService } from '../src/main/accounts/service';
import type { AccountManager } from '../src/main/mail/account-manager';
import type { SecretStore } from '../src/main/mail/auth/token-store';
import type { VerifyResult } from '../src/main/accounts/verify';
import { createTestDb, insertAccount, type TestDb } from './helpers/test-db';

class FakeSecrets {
  readonly values = new Map<string, string>();

  async set(ref: string, value: string): Promise<void> {
    this.values.set(ref, value);
  }

  async get(ref: string): Promise<string | null> {
    return this.values.get(ref) ?? null;
  }

  async delete(ref: string): Promise<void> {
    this.values.delete(ref);
  }

  async has(ref: string): Promise<boolean> {
    return this.values.has(ref);
  }
}

class FakeManager {
  readonly workers = new Set<string>();
  readonly enqueued: string[] = [];
  readonly disposed: string[] = [];
  readonly prioritized: string[] = [];

  isSyncing(): boolean {
    return false;
  }

  hasWorker(accountId: string): boolean {
    return this.workers.has(accountId);
  }

  enqueue(account: Account): void {
    this.enqueued.push(account.id);
    this.workers.add(account.id);
  }

  prioritize(account: Account): void {
    this.prioritized.push(account.id);
    this.enqueue(account);
  }

  cancelPending(): void {
    // no-op
  }

  async disposeAccount(accountId: string): Promise<void> {
    this.disposed.push(accountId);
    this.workers.delete(accountId);
  }
}

let context: TestDb;
let accounts: AccountsRepo;
let emails: EmailsRepo;
let secrets: FakeSecrets;
let manager: FakeManager;
let service: AccountService;
let attachmentsRoot: string;
let verifyResult: VerifyResult;
let verifyCalls: number;
let changed: number;

function input(overrides: Partial<AccountInput> = {}): AccountInput {
  return {
    displayName: '工作邮箱',
    email: 'a@example.com',
    providerPreset: 'qq',
    imap: { host: 'imap.example.com', port: 993, secure: true },
    smtp: { host: 'smtp.example.com', port: 465, secure: true },
    password: 'secret-pass',
    color: '#5b9dff',
    ...overrides,
  };
}

function otherAccount(id: string, enabled = true): Account {
  return {
    id,
    displayName: id,
    email: `${id}@example.com`,
    protocol: 'imap-smtp',
    imap: { host: 'imap.example.com', port: 993, secure: true },
    auth: { type: 'password', secretRef: `${id}:password` },
    authState: 'ok',
    createdAt: Date.now(),
    enabled,
    order: 2,
    settings: {},
  };
}

function insertMail(inputRow: {
  id: string;
  accountId: string;
  from?: string;
  to?: string;
  uid?: number;
  unread?: boolean;
}): void {
  context.db
    .prepare(
      `INSERT INTO emails
         (id, account_id, folder, uid, uidvalidity, subject, from_json, to_json, date, snippet, unread)
       VALUES (?, ?, 'INBOX', ?, 1, 'subject', ?, ?, ?, '', ?)`,
    )
    .run(
      inputRow.id,
      inputRow.accountId,
      inputRow.uid ?? 1,
      JSON.stringify([{ address: inputRow.from ?? 'sender@example.com' }]),
      JSON.stringify([{ address: inputRow.to ?? 'me@example.com' }]),
      Date.now(),
      inputRow.unread === false ? 0 : 1,
    );
}

beforeEach(() => {
  context = createTestDb();
  accounts = new AccountsRepo(context.db);
  emails = new EmailsRepo(context.db);
  secrets = new FakeSecrets();
  manager = new FakeManager();
  attachmentsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-accounts-att-'));
  verifyResult = { ok: true };
  verifyCalls = 0;
  changed = 0;

  service = new AccountService({
    db: context.db,
    accounts,
    emails,
    secrets: secrets as unknown as SecretStore,
    manager: manager as unknown as AccountManager,
    attachmentsRoot,
    verify: async () => {
      verifyCalls += 1;
      return verifyResult;
    },
    onChanged: () => {
      changed += 1;
    },
  });
});

afterEach(() => {
  context.cleanup();
  fs.rmSync(attachmentsRoot, { recursive: true, force: true });
});

describe('账户添加（§7.8.1）', () => {
  it('验证失败时不写入数据库、不保存凭证', async () => {
    verifyResult = { ok: false, code: 'AUTH_FAILED', message: '认证失败', stage: 'imap' };

    await expect(service.add(input())).rejects.toMatchObject({ code: 'AUTH_FAILED' });

    expect(accounts.list()).toHaveLength(0);
    expect(secrets.values.size).toBe(0);
    expect(manager.enqueued).toHaveLength(0);
    expect(changed).toBe(0);
  });

  it('验证通过后写入账户、凭证并进入同步队列', async () => {
    const view = await service.add(input());

    const stored = accounts.get(view.id);
    expect(stored).not.toBeNull();
    expect(stored?.enabled).toBe(true);
    expect(stored?.email).toBe('a@example.com');
    expect(stored?.settings).toEqual({});
    expect(stored?.order).toBe(1);
    expect(secrets.values.get(`${view.id}:password`)).toBe('secret-pass');
    expect(manager.enqueued).toContain(view.id);
    expect(changed).toBe(1);
  });

  it('同一邮箱不允许重复添加，且不会再次发起验证', async () => {
    await service.add(input());

    await expect(service.add(input())).rejects.toMatchObject({ code: 'DUPLICATE_EMAIL' });
    expect(accounts.list()).toHaveLength(1);
    expect(verifyCalls).toBe(1);
  });

  it('输入不合法时直接拒绝，不发起网络验证', async () => {
    await expect(service.add(input({ email: 'not-an-email' }))).rejects.toMatchObject({
      code: 'INVALID_ACCOUNT',
    });
    expect(verifyCalls).toBe(0);
  });
});

describe('账户编辑（§7.8.1）', () => {
  it('修改服务器参数验证失败时保留旧配置', async () => {
    const view = await service.add(input());
    const before = accounts.get(view.id);

    verifyResult = { ok: false, code: 'UNREACHABLE', message: '服务器不可达', stage: 'imap' };
    await expect(
      service.update(view.id, input({ imap: { host: 'imap.broken', port: 993, secure: true } })),
    ).rejects.toMatchObject({ code: 'UNREACHABLE' });

    const after = accounts.get(view.id);
    expect(after?.imap?.host).toBe(before?.imap?.host);
    expect(secrets.values.get(`${view.id}:password`)).toBe('secret-pass');
  });

  it('只改显示名不重新验证', async () => {
    const view = await service.add(input());
    const callsAfterAdd = verifyCalls;

    await service.update(view.id, input({ displayName: '新的名称', password: undefined }));

    expect(accounts.get(view.id)?.displayName).toBe('新的名称');
    expect(verifyCalls).toBe(callsAfterAdd);
  });

  it('修改凭证后重新验证并覆盖 safeStorage', async () => {
    const view = await service.add(input());
    await service.update(view.id, input({ password: 'new-pass' }));

    expect(verifyCalls).toBe(2);
    expect(secrets.values.get(`${view.id}:password`)).toBe('new-pass');
  });

  it('更新下载首选项会持久化，且不覆盖其他账户设置、不重新验证', async () => {
    const view = await service.add(
      input({ settings: { signature: '祝好', downloadPreference: 'headers-then-item' } }),
    );
    const callsAfterAdd = verifyCalls;

    await service.update(
      view.id,
      input({ password: undefined, settings: { downloadPreference: 'headers-only' } }),
    );

    const stored = accounts.get(view.id);
    expect(stored?.settings.downloadPreference).toBe('headers-only');
    expect(stored?.settings.signature).toBe('祝好');
    expect(verifyCalls).toBe(callsAfterAdd);
  });
});

describe('启用/禁用与统一收件箱（§7.8.2）', () => {
  it('禁用后统一收件箱不再出现该账户邮件，单账户视图仍可见', async () => {
    const view = await service.add(input());
    insertAccount(context.db, 'acc-2', 'b@example.com');
    insertMail({ id: 'a-mail', accountId: view.id, from: 'x@example.com' });
    insertMail({ id: 'b-mail', accountId: 'acc-2', from: 'y@example.com' });

    expect(emails.listUnified(0, 10).map((email) => email.id)).toContain('a-mail');
    expect(emails.listUnified(0, 10).map((email) => email.id)).toContain('b-mail');

    await service.setEnabled(view.id, false);

    expect(accounts.get(view.id)?.enabled).toBe(false);
    expect(manager.disposed).toContain(view.id);
    expect(emails.listUnified(0, 10).map((email) => email.id)).toEqual(['b-mail']);
    expect(emails.list(view.id, 'INBOX', 0, 10).map((email) => email.id)).toEqual(['a-mail']);
  });
});

describe('重新认证（§7.8.6）', () => {
  it('错误凭证不覆盖旧凭证，状态保持 requires_reauth', async () => {
    const view = await service.add(input());
    accounts.setAuthState(view.id, 'requires_reauth');
    verifyResult = { ok: false, code: 'AUTH_FAILED', message: '认证失败', stage: 'imap' };

    await expect(service.reauthenticate(view.id, 'wrong')).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    });

    expect(accounts.get(view.id)?.authState).toBe('requires_reauth');
    expect(secrets.values.get(`${view.id}:password`)).toBe('secret-pass');
  });

  it('正确凭证恢复 ok 并重新入队', async () => {
    const view = await service.add(input());
    accounts.setAuthState(view.id, 'requires_reauth');
    manager.enqueued.length = 0;

    await service.reauthenticate(view.id, 'new-pass');

    expect(accounts.get(view.id)?.authState).toBe('ok');
    expect(secrets.values.get(`${view.id}:password`)).toBe('new-pass');
    expect(manager.enqueued).toContain(view.id);
  });
});

describe('账户删除（§7.8.5）', () => {
  it('清除邮件、索引、附件、队列、联系人与凭证，保留共享附件文件', async () => {
    const view = await service.add(input());
    insertAccount(context.db, 'acc-2', 'b@example.com');
    accounts.insert(otherAccount('acc-3'));

    insertMail({ id: 'a-mail', accountId: view.id, from: 'only-a@example.com', to: 'shared@example.com' });
    insertMail({ id: 'b-mail', accountId: 'acc-2', from: 'shared@example.com', to: 'b@example.com' });

    context.db
      .prepare('INSERT INTO email_bodies (email_id, html, text, fetched_at) VALUES (?, ?, ?, ?)')
      .run('a-mail', '<p>x</p>', 'x', Date.now());
    context.db
      .prepare('INSERT INTO emails_fts (email_id, subject, body) VALUES (?, ?, ?)')
      .run('a-mail', 'subject', 'hello');
    context.db
      .prepare('INSERT INTO ai_embeddings (email_id, model, vector_json, created_at) VALUES (?, ?, ?, ?)')
      .run('a-mail', 'local-ngram', '[]', Date.now());
    context.db
      .prepare(
        `INSERT INTO translation_cache (email_id, target_lang, source_hash, translated_text, provider, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('a-mail', 'zh-CN', 'hash', '你好', 'test', Date.now());

    const sharedSha = 'a'.repeat(64);
    const uniqueSha = 'b'.repeat(64);
    const sharedPath = path.join(attachmentsRoot, `${sharedSha}.txt`);
    const uniquePath = path.join(attachmentsRoot, `${uniqueSha}.txt`);
    fs.writeFileSync(sharedPath, 'shared');
    fs.writeFileSync(uniquePath, 'unique');

    const insertAttachment = context.db.prepare(
      `INSERT INTO attachments (id, email_id, filename, mime_type, size, ext, sha256, local_path)
       VALUES (?, ?, ?, 'text/plain', 1, '.txt', ?, ?)`,
    );
    insertAttachment.run('att-a-1', 'a-mail', 'shared.txt', sharedSha, sharedPath);
    insertAttachment.run('att-a-2', 'a-mail', 'unique.txt', uniqueSha, uniquePath);
    insertAttachment.run('att-b-1', 'b-mail', 'shared.txt', sharedSha, sharedPath);

    context.db
      .prepare('INSERT INTO folder_sync_state (account_id, folder) VALUES (?, ?)')
      .run(view.id, 'INBOX');
    context.db
      .prepare(
        `INSERT INTO outbox (id, account_id, intent, payload_json, created_at)
         VALUES ('o1', ?, 'send', '{}', ?)`,
      )
      .run(view.id, Date.now());
    context.db
      .prepare(
        `INSERT INTO scheduled_sends (id, account_id, send_at, payload_json, created_at)
         VALUES ('s1', ?, ?, '{}', ?)`,
      )
      .run(view.id, Date.now() + 60_000, Date.now());
    // 本地草稿是「每账户一封」：删账户时必须一起走，否则草稿箱里
    // 会留下一封点进去就报错的孤儿草稿（draftList 不按账户过滤）。
    context.db
      .prepare(
        `INSERT INTO drafts (account_id, to_json, cc_json, bcc_json, subject, body, updated_at)
         VALUES (?, '[]', '[]', '[]', '未发送', '', ?)`,
      )
      .run(view.id, Date.now());
    context.db
      .prepare(
        `INSERT INTO contacts (email, display_name, last_contacted_at, interaction_count)
         VALUES (?, ?, ?, ?)`,
      )
      .run('only-a@example.com', 'Only A', Date.now(), 1);
    context.db
      .prepare(
        `INSERT INTO contacts (email, display_name, last_contacted_at, interaction_count)
         VALUES (?, ?, ?, ?)`,
      )
      .run('shared@example.com', 'Shared', Date.now(), 2);
    context.db
      .prepare('INSERT INTO scan_cache (key, result_json, expires_at) VALUES (?, ?, ?)')
      .run(`file:${uniqueSha}`, '{}', Date.now() + 60_000);
    context.db
      .prepare('INSERT INTO scan_cache (key, result_json, expires_at) VALUES (?, ?, ?)')
      .run(`file:${sharedSha}`, '{}', Date.now() + 60_000);

    secrets.values.set(`${view.id}:password`, 'secret-pass');
    const purge = await service.remove(view.id);

    expect(purge.deletedEmails).toBe(1);
    expect(purge.deletedContacts).toBe(1);
    expect(accounts.get(view.id)).toBeNull();
    expect(emails.get('a-mail')).toBeNull();
    expect(emails.get('b-mail')).not.toBeNull();
    expect(
      (context.db.prepare('SELECT COUNT(*) AS c FROM email_bodies WHERE email_id = ?').get('a-mail') as { c: number }).c,
    ).toBe(0);
    expect(
      (context.db.prepare('SELECT COUNT(*) AS c FROM emails_fts WHERE email_id = ?').get('a-mail') as { c: number }).c,
    ).toBe(0);
    expect(
      (context.db.prepare('SELECT COUNT(*) AS c FROM ai_embeddings WHERE email_id = ?').get('a-mail') as { c: number }).c,
    ).toBe(0);
    expect(
      (context.db.prepare('SELECT COUNT(*) AS c FROM translation_cache WHERE email_id = ?').get('a-mail') as { c: number }).c,
    ).toBe(0);
    expect(
      (context.db.prepare('SELECT COUNT(*) AS c FROM attachments WHERE email_id = ?').get('a-mail') as { c: number }).c,
    ).toBe(0);
    expect(
      (context.db.prepare('SELECT COUNT(*) AS c FROM folder_sync_state WHERE account_id = ?').get(view.id) as { c: number }).c,
    ).toBe(0);
    expect(
      (context.db.prepare('SELECT COUNT(*) AS c FROM outbox WHERE account_id = ?').get(view.id) as { c: number }).c,
    ).toBe(0);
    expect(
      (context.db.prepare('SELECT COUNT(*) AS c FROM scheduled_sends WHERE account_id = ?').get(view.id) as { c: number }).c,
    ).toBe(0);
    expect(
      (context.db.prepare('SELECT COUNT(*) AS c FROM drafts WHERE account_id = ?').get(view.id) as { c: number }).c,
    ).toBe(0);
    expect(
      (context.db.prepare('SELECT COUNT(*) AS c FROM contacts WHERE email = ?').get('only-a@example.com') as { c: number }).c,
    ).toBe(0);
    expect(
      (context.db.prepare('SELECT COUNT(*) AS c FROM contacts WHERE email = ?').get('shared@example.com') as { c: number }).c,
    ).toBe(1);
    expect(
      (context.db.prepare('SELECT COUNT(*) AS c FROM scan_cache WHERE key = ?').get(`file:${uniqueSha}`) as { c: number }).c,
    ).toBe(0);
    expect(
      (context.db.prepare('SELECT COUNT(*) AS c FROM scan_cache WHERE key = ?').get(`file:${sharedSha}`) as { c: number }).c,
    ).toBe(1);
    expect(fs.existsSync(uniquePath)).toBe(false);
    expect(fs.existsSync(sharedPath)).toBe(true);
    expect(secrets.values.has(`${view.id}:password`)).toBe(false);
  });

  it('清理步骤失败时保留账户并标记删除中，可重试完成', async () => {
    const view = await service.add(input());
    insertMail({ id: 'a-mail', accountId: view.id });
    context.db.exec('DROP TABLE scan_cache');

    await expect(service.remove(view.id)).rejects.toMatchObject({ code: 'CLEANUP_PARTIAL' });
    const pending = accounts.get(view.id);
    expect(pending).not.toBeNull();
    expect(pending?.lastError?.code).toBe('delete_pending');
    expect(emails.get('a-mail')).toBeNull();

    context.db.exec(
      'CREATE TABLE scan_cache (key TEXT PRIMARY KEY, result_json TEXT NOT NULL, expires_at INTEGER NOT NULL)',
    );
    await service.remove(view.id);
    expect(accounts.get(view.id)).toBeNull();
  });
});

describe('账户视图（§7.8.2）', () => {
  it('未读数按账户统计，禁用状态透出', async () => {
    const view = await service.add(input());
    insertAccount(context.db, 'acc-2', 'b@example.com');
    insertMail({ id: 'a-1', accountId: view.id, unread: true, uid: 1 });
    insertMail({ id: 'a-2', accountId: view.id, unread: false, uid: 2 });
    insertMail({ id: 'b-1', accountId: 'acc-2', unread: true, uid: 1 });
    insertMail({ id: 'b-2', accountId: 'acc-2', unread: true, uid: 2 });

    let views = service.listViews();
    expect(views.find((item) => item.id === view.id)?.unreadCount).toBe(1);
    expect(views.find((item) => item.id === 'acc-2')?.unreadCount).toBe(2);

    await service.setEnabled(view.id, false);
    views = service.listViews();
    expect(views.find((item) => item.id === view.id)?.status).toBe('disabled');
    expect(views.find((item) => item.id === 'acc-2')?.status).not.toBe('disabled');
  });
});

describe('搜索范围（§7.8.2）', () => {
  it('单账户只搜本账户，统一收件箱搜启用账户，勾选后包含禁用账户', async () => {
    const { SearchService } = await import('../src/main/search/service');
    const view = await service.add(input());
    insertAccount(context.db, 'acc-2', 'b@example.com');
    insertMail({ id: 'a-mail', accountId: view.id, from: 'a@example.com' });
    insertMail({ id: 'b-mail', accountId: 'acc-2', from: 'b@example.com' });
    context.db
      .prepare('INSERT INTO emails_fts (email_id, subject, body) VALUES (?, ?, ?)')
      .run('a-mail', 'budget report', 'budget details');
    context.db
      .prepare('INSERT INTO emails_fts (email_id, subject, body) VALUES (?, ?, ?)')
      .run('b-mail', 'budget plan', 'budget plan');

    await service.setEnabled(view.id, false);
    const search = new SearchService(context.db, emails);

    expect(
      search.search({ query: 'budget', accountId: 'acc-2', scope: 'account' }).emails.map((e) => e.id),
    ).toEqual(['b-mail']);
    expect(
      search.search({ query: 'budget', accountId: 'acc-2', scope: 'enabled' }).emails.map((e) => e.id),
    ).toEqual(['b-mail']);
    expect(
      search.search({ query: 'budget', scope: 'all' }).emails.map((e) => e.id).sort(),
    ).toEqual(['a-mail', 'b-mail']);
    // 这条用例要动态 import 搜索栈并建 FTS 索引，并发跑全量时接近默认 5s 上限
  }, 20_000);
});

describe('多账户调度（§7.8.3）', () => {
  function accountFor(id: string, lastSyncAt?: number, order = 0): Account {
    return {
      ...otherAccount(id),
      order,
      ...(lastSyncAt ? { lastSyncAt } : {}),
    };
  }

  it('并发不超过 3，最久未同步的优先', async () => {
    const { AccountManager } = await import('../src/main/mail/account-manager');
    const scheduler = new AccountManager({} as never);
    const started: string[] = [];
    let active = 0;
    let peak = 0;

    (scheduler as unknown as { start(account: Account): Promise<void> }).start = async (account) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      started.push(account.id);
      active -= 1;
    };

    scheduler.startAll([
      accountFor('a', 300),
      accountFor('b', 100),
      accountFor('c', 200),
      accountFor('d'),
      accountFor('e', 50),
      accountFor('f', 400),
    ]);

    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(peak).toBeLessThanOrEqual(3);
    expect(started.slice(0, 3)).toEqual(['d', 'e', 'b']);
    expect(started).toHaveLength(6);
  });

  it('删除中的账户不进入同步队列', async () => {
    const { AccountManager } = await import('../src/main/mail/account-manager');
    const scheduler = new AccountManager({} as never);
    const started: string[] = [];
    (scheduler as unknown as { start(account: Account): Promise<void> }).start = async (account) => {
      started.push(account.id);
    };

    scheduler.startAll([
      {
        ...accountFor('pending'),
        lastError: { code: 'delete_pending', message: '删除中', at: Date.now() },
      },
      accountFor('normal'),
    ]);

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(started).toEqual(['normal']);
  });

  it('点击账户插队到等待队列最前', async () => {
    const { AccountManager } = await import('../src/main/mail/account-manager');
    const scheduler = new AccountManager({} as never);
    const started: string[] = [];

    (scheduler as unknown as { start(account: Account): Promise<void> }).start = async (account) => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      started.push(account.id);
    };

    scheduler.startAll([]);
    for (const id of ['a', 'b', 'c', 'd', 'e']) scheduler.enqueue(accountFor(id));
    scheduler.prioritize(accountFor('e'));

    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(started.slice(0, 3)).toEqual(['a', 'b', 'c']);
    expect(started[3]).toBe('e');
    expect(started).toHaveLength(5);
  });
});
