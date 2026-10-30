import nodemailer from 'nodemailer';
import type { Account } from '../../shared/types';
import type { SecretStore } from '../mail/auth/token-store';
import type { MailSender, OutgoingMessage } from './scheduled-service';

/**
 * SMTP 发送（§19.1）。使用账户配置的 SMTP + safeStorage 凭证。
 * 永久错误（认证/收件人被拒）不重试；网络错误重试。
 */

export class PermanentSendError extends Error {
  readonly permanent = true;
  constructor(message: string) {
    super(message);
    this.name = 'PermanentSendError';
  }
}

export class TransientSendError extends Error {
  readonly permanent = false;
  constructor(message: string) {
    super(message);
    this.name = 'TransientSendError';
  }
}

function classify(error: unknown): Error {
  const record = error as { code?: string; responseCode?: number; message?: string };
  const code = record.code ?? '';
  const message = record.message ?? String(error);

  if (
    record.responseCode === 535 ||
    record.responseCode === 530 ||
    ['EAUTH', 'EENVELOPE', 'EMESSAGE'].includes(code)
  ) {
    return new PermanentSendError(message);
  }
  return new TransientSendError(message);
}

/**
 * SMTP 信封收件人（RCPT TO）：to + cc + bcc。
 * 密送只允许出现在信封里——消息头写 Bcc 会让所有收件人看到密送对象。
 */
export function envelopeRecipients(message: OutgoingMessage): string[] {
  return [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])]
    .map((address) => address.trim())
    .filter(Boolean);
}

export class SmtpSender implements MailSender {
  constructor(private readonly secrets: SecretStore) {}

  async send(account: Account, message: OutgoingMessage): Promise<void> {
    if (!account.smtp) {
      throw new PermanentSendError('账户未配置 SMTP 服务器');
    }
    if (account.auth.type !== 'password') {
      throw new PermanentSendError('当前认证方式暂不支持 SMTP 发送');
    }

    const password = await this.secrets.get(account.auth.secretRef);
    if (!password) {
      throw new PermanentSendError('缺少 SMTP 凭证，请重新登录账户');
    }

    const transport = nodemailer.createTransport({
      host: account.smtp.host,
      port: account.smtp.port,
      secure: account.smtp.secure,
      auth: { user: account.email, pass: password },
      connectionTimeout: 20_000,
      greetingTimeout: 20_000,
      socketTimeout: 60_000,
    });

    try {
      await transport.sendMail({
        from: account.email,
        to: message.to.join(', '),
        ...(message.cc && message.cc.length ? { cc: message.cc.join(', ') } : {}),
        // 密送只进信封：显式给 envelope，nodemailer 就不会把 Bcc 写进消息头，
        // 收件人互相看不到密送对象（这是 Bcc 的全部意义）
        envelope: {
          from: account.email,
          to: envelopeRecipients(message),
        },
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
        ...(message.attachments && message.attachments.length
          ? {
              attachments: message.attachments.map((attachment) =>
                // 内嵌图片：带 cid 的 part 由 nodemailer 写成 multipart/related 的
                // `Content-ID`，正文的 `cid:` 引用才能落到这张图上
                attachment.cid
                  ? {
                      filename: attachment.filename,
                      path: attachment.path,
                      cid: attachment.cid,
                      contentType: attachment.contentType,
                      contentDisposition: 'inline' as const,
                    }
                  : { filename: attachment.filename, path: attachment.path },
              ),
            }
          : {}),
      });
    } catch (error) {
      throw classify(error);
    } finally {
      transport.close();
    }
  }
}
