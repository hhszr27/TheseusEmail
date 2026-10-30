import type { Account, AccountSettings } from './types';

/** 服务商预设（§7.3）：选择后自动填好主机、端口与加密方式。 */
export interface ProviderPreset {
  id: NonNullable<Account['providerPreset']>;
  label: string;
  imap: { host: string; port: number; secure: boolean };
  smtp: { host: string; port: number; secure: boolean } | null;
  hint?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'qq',
    label: 'QQ 邮箱',
    imap: { host: 'imap.qq.com', port: 993, secure: true },
    smtp: { host: 'smtp.qq.com', port: 465, secure: true },
    hint: '密码处填写 16 位客户端授权码，不是 QQ 登录密码。',
  },
  {
    id: 'netease',
    label: '网易 163 / 126',
    imap: { host: 'imap.163.com', port: 993, secure: true },
    smtp: { host: 'smtp.163.com', port: 465, secure: true },
    hint: '密码处填写客户端授权码，并在网页版邮箱开启 IMAP/SMTP 服务。',
  },
  {
    id: 'gmail',
    label: 'Gmail',
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    hint: '需开启两步验证并使用「应用专用密码」；OAuth 登录在后续 Phase 提供。',
  },
  {
    id: 'outlook',
    label: 'Outlook / Microsoft 365',
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp.office365.com', port: 587, secure: false },
    hint: '若账户启用了安全默认值，需使用应用密码；OAuth 登录在后续 Phase 提供。',
  },
  {
    id: 'custom',
    label: '自定义',
    imap: { host: '', port: 993, secure: true },
    smtp: null,
  },
];

export function presetById(id: string | undefined): ProviderPreset | null {
  return PROVIDER_PRESETS.find((preset) => preset.id === id) ?? null;
}

export interface AccountEndpointInput {
  host: string;
  port: number;
  secure: boolean;
}

/** 渲染进程提交的账户表单；主进程会重新校验，不信任客户端结果。 */
export interface AccountInput {
  displayName: string;
  email: string;
  providerPreset?: Account['providerPreset'];
  imap: AccountEndpointInput;
  /** null 表示不配置 SMTP（编辑时显式清空）。 */
  smtp?: AccountEndpointInput | null;
  /** 新增时必填；编辑时留空表示不修改凭证。 */
  password?: string;
  color?: string;
  settings?: Partial<AccountSettings>;
}

export const EMPTY_ACCOUNT_SETTINGS: AccountSettings = {};

export interface AccountValidation {
  ok: boolean;
  errors: string[];
  value?: {
    displayName: string;
    email: string;
    providerPreset: NonNullable<Account['providerPreset']>;
    imap: AccountEndpointInput;
    smtp?: AccountEndpointInput;
    password?: string;
    color?: string;
    settings: AccountSettings;
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;

function normalizeEndpoint(value: AccountEndpointInput | undefined): AccountEndpointInput | null {
  if (!value) return null;
  const host = String(value.host ?? '').trim();
  const port = Number(value.port);
  if (!host || /\s/.test(host)) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port, secure: value.secure !== false };
}

export function validateAccountInput(input: Partial<AccountInput>): AccountValidation {
  const errors: string[] = [];
  const displayName = String(input.displayName ?? '').trim();
  const email = String(input.email ?? '').trim();
  const providerPreset = (input.providerPreset ?? 'custom') as NonNullable<Account['providerPreset']>;

  if (!displayName) errors.push('请填写显示名称');
  if (displayName.length > 120) errors.push('显示名称过长（最多 120 字）');
  if (!EMAIL_RE.test(email)) errors.push('邮箱地址格式不正确');

  const imap = normalizeEndpoint(input.imap);
  if (!imap) errors.push('IMAP 主机或端口不合法');

  const smtp = input.smtp ? normalizeEndpoint(input.smtp) : null;
  if (input.smtp && !smtp) errors.push('SMTP 主机或端口不合法');

  const password = input.password === undefined ? undefined : String(input.password);
  if (password !== undefined && password.length > 512) errors.push('凭证过长');

  const color = input.color ? String(input.color).trim() : '';
  if (color && !COLOR_RE.test(color)) errors.push('标识色需为 #RRGGBB 格式');

  if (errors.length > 0 || !imap) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    errors: [],
    value: {
      displayName,
      email,
      providerPreset,
      imap,
      ...(smtp ? { smtp } : {}),
      ...(password !== undefined ? { password } : {}),
      ...(color ? { color } : {}),
      settings: { ...(input.settings ?? {}) },
    },
  };
}
