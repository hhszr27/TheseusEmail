import { createHash } from 'node:crypto';
import type { Account } from '../../shared/types';

/**
 * 开发期通过 .env 配置账户（§35 Phase 1）。
 * 生产环境的账户管理 UI 在后续 Phase 提供。
 */

export interface EnvAccountInput {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
}

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return !/^(0|false|no|off)$/i.test(value.trim());
}

export function readEnvAccount(env: NodeJS.ProcessEnv = process.env): EnvAccountInput | null {
  const host = env.IMAP_HOST?.trim();
  const user = env.IMAP_USER?.trim();
  const pass = env.IMAP_PASS?.trim();

  if (!host || !user || !pass) return null;

  const smtpHost = env.SMTP_HOST?.trim();
  return {
    host,
    port: parsePort(env.IMAP_PORT, 993),
    secure: parseBool(env.IMAP_SECURE, true),
    user,
    pass,
    ...(smtpHost ? { smtpHost } : {}),
    ...(smtpHost ? { smtpPort: parsePort(env.SMTP_PORT, 465) } : {}),
    ...(smtpHost ? { smtpSecure: parseBool(env.SMTP_SECURE, true) } : {}),
  };
}

export function detectProviderPreset(host: string): NonNullable<Account['providerPreset']> {
  const lower = host.toLowerCase();
  if (lower.endsWith('qq.com')) return 'qq';
  if (lower.endsWith('163.com') || lower.endsWith('126.com')) return 'netease';
  if (lower.endsWith('gmail.com')) return 'gmail';
  if (lower.endsWith('outlook.com') || lower.endsWith('office365.com')) return 'outlook';
  return 'custom';
}

export function envAccountToAccount(input: EnvAccountInput): Account {
  const id = `env-${createHash('sha256').update(`${input.host}|${input.user}`).digest('hex').slice(0, 12)}`;
  return {
    id,
    displayName: input.user,
    email: input.user,
    protocol: 'imap-smtp',
    providerPreset: detectProviderPreset(input.host),
    imap: { host: input.host, port: input.port, secure: input.secure },
    ...(input.smtpHost
      ? {
          smtp: {
            host: input.smtpHost,
            port: input.smtpPort ?? 465,
            secure: input.smtpSecure ?? true,
          },
        }
      : {}),
    auth: { type: 'password', secretRef: `${id}:password` },
    authState: 'ok',
    createdAt: Date.now(),
    enabled: true,
    order: 0,
    settings: {},
  };
}
