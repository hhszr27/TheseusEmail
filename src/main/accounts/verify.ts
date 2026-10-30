import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import type { AccountEndpoint } from '../db/repositories/accounts-repo';

/**
 * 账户连接验证（§7.8.1）。
 * 添加/编辑账户前先在主进程建立临时连接：IMAP 登录 + SMTP verify。
 * 验证失败不写入数据库；编辑失败保留旧配置。
 */

export type VerifyErrorCode = 'AUTH_FAILED' | 'UNREACHABLE' | 'TIMEOUT' | 'SMTP_FAILED' | 'BAD_CONFIG';

export interface VerifyFailure {
  ok: false;
  code: VerifyErrorCode;
  message: string;
  stage: 'imap' | 'smtp';
}

export type VerifyResult = { ok: true } | VerifyFailure;

const IMAP_TIMEOUT_MS = 20_000;
const SMTP_TIMEOUT_MS = 20_000;

function withTimeout<T>(task: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}超时（${ms} ms）`)), ms);
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function describe(error: unknown): string {
  const record = error as { message?: string; code?: string; responseText?: string };
  return record?.responseText || record?.message || String(error);
}

function mapImapError(error: unknown): { code: VerifyErrorCode; message: string } {
  const record = error as { authenticationFailed?: boolean; code?: string; message?: string };
  const message = describe(error);
  if (record?.authenticationFailed) {
    return { code: 'AUTH_FAILED', message: '认证失败，请检查邮箱地址与授权码' };
  }
  if (/auth|login|credential|授权码|密码/i.test(message)) {
    return { code: 'AUTH_FAILED', message: `认证失败：${message}` };
  }
  if (/timeout|timed out|超时/i.test(message)) {
    return { code: 'TIMEOUT', message: `连接超时：${message}` };
  }
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|getaddrinfo/i.test(message)) {
    return { code: 'UNREACHABLE', message: `服务器不可达：${message}` };
  }
  return { code: 'UNREACHABLE', message: `连接失败：${message}` };
}

export async function verifyImap(
  endpoint: AccountEndpoint,
  user: string,
  pass: string,
): Promise<VerifyResult> {
  if (!endpoint.host || !endpoint.port || !user || !pass) {
    return { ok: false, code: 'BAD_CONFIG', message: 'IMAP 配置不完整', stage: 'imap' };
  }

  const client = new ImapFlow({
    host: endpoint.host,
    port: endpoint.port,
    secure: endpoint.secure,
    auth: { user, pass },
    logger: false,
    disableAutoIdle: true,
  });

  try {
    await withTimeout(client.connect(), IMAP_TIMEOUT_MS, 'IMAP 连接');
    return { ok: true };
  } catch (error) {
    const mapped = mapImapError(error);
    return { ok: false, ...mapped, stage: 'imap' };
  } finally {
    try {
      await withTimeout(client.logout(), 4000, 'IMAP 断开');
    } catch {
      try {
        client.close();
      } catch {
        // ignore
      }
    }
  }
}

export async function verifySmtp(
  endpoint: AccountEndpoint,
  user: string,
  pass: string,
): Promise<VerifyResult> {
  const transport = nodemailer.createTransport({
    host: endpoint.host,
    port: endpoint.port,
    secure: endpoint.secure,
    auth: { user, pass },
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
  });

  try {
    await withTimeout(transport.verify(), SMTP_TIMEOUT_MS, 'SMTP 验证');
    return { ok: true };
  } catch (error) {
    const record = error as { code?: string; responseCode?: number };
    const message = describe(error);
    const authFailed =
      record?.code === 'EAUTH' ||
      record?.responseCode === 535 ||
      record?.responseCode === 530 ||
      /auth|login|credential|授权码|密码/i.test(message);
    return {
      ok: false,
      code: authFailed ? 'AUTH_FAILED' : 'SMTP_FAILED',
      message: `SMTP 验证失败：${message}`,
      stage: 'smtp',
    };
  } finally {
    transport.close();
  }
}

/** 添加/编辑账户时的统一验证入口：IMAP 必验，配置了 SMTP 才验。 */
export async function verifyAccountConnection(input: {
  imap: AccountEndpoint;
  smtp?: AccountEndpoint;
  email: string;
  password: string;
}): Promise<VerifyResult> {
  const imap = await verifyImap(input.imap, input.email, input.password);
  if (!imap.ok) return imap;
  if (input.smtp) {
    const smtp = await verifySmtp(input.smtp, input.email, input.password);
    if (!smtp.ok) return smtp;
  }
  return { ok: true };
}
