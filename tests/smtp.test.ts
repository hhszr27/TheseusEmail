import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SmtpSender } from '../src/main/mail/smtp-sender';
import type { Account } from '../src/shared/types';
import type { SecretStore } from '../src/main/mail/auth/token-store';

/**
 * SMTP 发送：验证富文本 html 随邮件一起发送（nodemailer 据此生成 multipart/alternative）。
 * 用 vi.mock 替换 nodemailer，只断言传给 sendMail 的参数。
 */

const { sendMail, createTransport } = vi.hoisted(() => {
  const sendMail = vi.fn();
  const createTransport = vi.fn(() => ({ sendMail, close: vi.fn() }));
  return { sendMail, createTransport };
});

vi.mock('nodemailer', () => ({
  default: { createTransport },
}));

function makeAccount(): Account {
  return {
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
  } as unknown as Account;
}

const secrets = { get: vi.fn().mockResolvedValue('pw') } as unknown as SecretStore;

beforeEach(() => {
  sendMail.mockClear();
  createTransport.mockClear();
});

describe('SmtpSender 富文本发送', () => {
  it('纯文本发送时 sendMail 不含 html 字段', async () => {
    const sender = new SmtpSender(secrets);
    await sender.send(makeAccount(), { to: ['a@example.com'], subject: 's', text: 't' });

    expect(sendMail).toHaveBeenCalledTimes(1);
    const arg = sendMail.mock.calls[0]![0];
    expect(arg.html).toBeUndefined();
    expect(arg.text).toBe('t');
    expect(arg.subject).toBe('s');
  });

  it('带 html 时 sendMail 携带 html 字段（nodemailer 据此生成 multipart/alternative）', async () => {
    const sender = new SmtpSender(secrets);
    await sender.send(makeAccount(), {
      to: ['a@example.com'],
      subject: 's',
      text: 't',
      html: '<p>你好</p>',
    });

    expect(sendMail).toHaveBeenCalledTimes(1);
    const arg = sendMail.mock.calls[0]![0];
    expect(arg.html).toBe('<p>你好</p>');
    expect(arg.text).toBe('t');
  });
});
