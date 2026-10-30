import Database from 'better-sqlite3-multiple-ciphers';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountsRepo } from '../src/main/db/repositories/accounts-repo';
import { ScheduledSendService, type MailSender, type OutgoingMessage } from '../src/main/mail/scheduled-service';
import { PermanentSendError, TransientSendError } from '../src/main/mail/smtp-sender';

const KEY_HEX = 'ef'.repeat(32);
const MIGRATIONS = [
  'V001__initial.sql',
  'V002__phase2.sql',
  'V003__scheduled_retry.sql',
  'V004__phase3.sql',
  'V005__accounts.sql',
  'V006__plugin_accounts.sql',
].map((file) => fs.readFileSync(path.resolve('migrations', file), 'utf8'));

let dir = '';
let db: Database.Database;
let accounts: AccountsRepo;
let sender: FakeSender;
let service: ScheduledSendService;

class FakeSender implements MailSender {
  sent: OutgoingMessage[] = [];
  failure: Error | null = null;

  async send(_account: unknown, message: OutgoingMessage): Promise<void> {
    if (this.failure) throw this.failure;
    this.sent.push(message);
  }
}

const message: OutgoingMessage = {
  to: ['alice@example.com'],
  subject: '定时发送',
  text: 'body',
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-scheduled-'));
  const dbPath = path.join(dir, 'db.sqlite');
  db = new Database(dbPath);
  db.pragma(`key = "x'${KEY_HEX}'"`);
  for (const sql of MIGRATIONS) db.exec(sql);

  accounts = new AccountsRepo(db);
  accounts.ensure({
    id: 'acc-1',
    displayName: 'Demo',
    email: 'demo@example.com',
    protocol: 'imap-smtp',
    imap: { host: 'imap.example.com', port: 993, secure: true },
    smtp: { host: 'smtp.example.com', port: 465, secure: true },
    auth: { type: 'password', secretRef: 'acc-1:password' },
    authState: 'ok',
    createdAt: Date.now(),
    enabled: true,
    order: 0,
    settings: {},
  });

  sender = new FakeSender();
  service = new ScheduledSendService(db, accounts, sender);
});

afterEach(() => {
  service.stop();
  try {
    db.close();
  } catch {
    // ignore
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('定时发送与 Undo Send（§19）', () => {
  it('到点发送并标记 sent', async () => {
    const { id } = service.schedule('acc-1', message, 0);
    const result = await service.tick(Date.now() + 5_000);
    expect(result.sent).toBe(1);
    expect(sender.sent).toHaveLength(1);
    expect(service.list().find((item) => item.id === id)?.status).toBe('sent');
  });

  it('scheduleAt 传过去时间时按立即发送处理', async () => {
    const { sendAt } = service.scheduleAt('acc-1', message, Date.now() - 60_000);
    expect(sendAt).toBeLessThanOrEqual(Date.now());

    const result = await service.tick(Date.now() + 1_000);
    expect(result.sent).toBe(1);
  });

  it('scheduleAt 未来时间在到点前不发送', async () => {
    const at = Date.now() + 3_600_000;
    const { sendAt } = service.scheduleAt('acc-1', message, at);
    expect(sendAt).toBe(at);

    expect((await service.tick(Date.now() + 60_000)).sent).toBe(0);
    expect(sender.sent).toHaveLength(0);

    expect((await service.tick(at + 1_000)).sent).toBe(1);
  });

  it('撤销窗口内取消后不再发送', async () => {
    const { id } = service.schedule('acc-1', message, 60_000);
    expect(service.cancel(id)).toBe(true);
    await service.tick(Date.now() + 120_000);
    expect(sender.sent).toHaveLength(0);
    expect(service.list().find((item) => item.id === id)?.status).toBe('cancelled');
  });

  it('发送成功与取消都会回调终态清理（释放附件）', async () => {
    const released: string[] = [];
    const withCleanup = new ScheduledSendService(db, accounts, sender, (message) => {
      for (const attachment of message.attachments ?? []) released.push(attachment.filename);
    });

    const withAttachment = {
      ...message,
      attachments: [{ filename: '报表.pdf', path: '/tmp/stage/report.pdf' }],
    };
    withCleanup.scheduleAt('acc-1', withAttachment, Date.now());
    await withCleanup.tick(Date.now() + 5_000);

    const { id } = withCleanup.scheduleAt('acc-1', withAttachment, Date.now() + 60_000);
    expect(withCleanup.cancel(id)).toBe(true);

    expect(released).toEqual(['报表.pdf', '报表.pdf']);
  });

  it('attachmentPathsInUse 只返回待发送任务的附件', async () => {
    const withAttachment = {
      ...message,
      attachments: [{ filename: 'a.pdf', path: '/tmp/stage/a.pdf' }],
    };
    service.scheduleAt('acc-1', withAttachment, Date.now() + 60_000);
    expect([...service.attachmentPathsInUse()]).toEqual(['/tmp/stage/a.pdf']);
  });

  it('永久错误标记 failed，不重试', async () => {
    sender.failure = new PermanentSendError('认证失败');
    const { id } = service.schedule('acc-1', message, 0);
    const result = await service.tick(Date.now() + 5_000);
    expect(result.failed).toBe(1);
    const row = service.list().find((item) => item.id === id);
    expect(row?.status).toBe('failed');
    expect(row?.lastError).toContain('认证失败');
  });

  it('网络错误进入退避重试，恢复后发送成功', async () => {
    sender.failure = new TransientSendError('连接超时');
    const { id } = service.schedule('acc-1', message, 0);
    const now = Date.now();
    const first = await service.tick(now + 5_000);
    expect(first.retried).toBe(1);

    const pending = service.list().find((item) => item.id === id);
    expect(pending?.status).toBe('pending');
    expect(pending?.retryCount).toBe(1);

    // 退避期未到：不会再次尝试
    await service.tick(now + 6_000);
    expect(sender.sent).toHaveLength(0);

    sender.failure = null;
    await service.tick(now + 10 * 60_000);
    expect(sender.sent).toHaveLength(1);
    expect(service.list().find((item) => item.id === id)?.status).toBe('sent');
  });

  it('连续失败达到上限后标记 failed', async () => {
    sender.failure = new TransientSendError('持续超时');
    const { id } = service.schedule('acc-1', message, 0);
    let now = Date.now();
    for (let attempt = 0; attempt < 6; attempt += 1) {
      now += 10 * 60_000;
      await service.tick(now);
    }
    expect(service.list().find((item) => item.id === id)?.status).toBe('failed');
    expect(sender.sent).toHaveLength(0);
  });
});
