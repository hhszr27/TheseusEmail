import { randomUUID } from 'node:crypto';
import type { Account, AccountRuntimeStatus, AccountSettings, AccountView } from '../../shared/types';
import {
  validateAccountInput,
  type AccountEndpointInput,
  type AccountInput,
} from '../../shared/accounts';
import type { Db } from '../db/open';
import type { AccountsRepo } from '../db/repositories/accounts-repo';
import type { EmailsRepo } from '../db/repositories/emails-repo';
import type { SecretStore } from '../mail/auth/token-store';
import type { AccountManager } from '../mail/account-manager';
import { log } from '../observability/logger';
import { purgeAccountData, type PurgeResult } from './purge';
import { verifyAccountConnection, type VerifyResult } from './verify';

/**
 * 账户生命周期（§7.8.1）：增删改、启用/禁用、重新认证、删除清理。
 * 所有状态变更都经主进程；渲染进程只提交表单。
 */

export class AccountOperationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AccountOperationError';
    this.code = code;
  }
}

export interface AccountServiceDeps {
  db: Db;
  accounts: AccountsRepo;
  emails: EmailsRepo;
  secrets: SecretStore;
  manager: AccountManager;
  attachmentsRoot?: string;
  clearPartition?: (accountId: string) => Promise<void>;
  /** 测试注入替代实现；生产使用真实 IMAP/SMTP 验证。 */
  verify?: (input: {
    imap: AccountEndpointInput;
    smtp?: AccountEndpointInput;
    email: string;
    password: string;
  }) => Promise<VerifyResult>;
  onChanged?: () => void;
}

function toView(account: Account, unreadCount: number, status: AccountRuntimeStatus): AccountView {
  return {
    id: account.id,
    displayName: account.displayName,
    email: account.email,
    protocol: account.protocol,
    ...(account.providerPreset ? { providerPreset: account.providerPreset } : {}),
    ...(account.imap
      ? {
          imapHost: account.imap.host,
          imapPort: account.imap.port,
          imapSecure: account.imap.secure,
        }
      : {}),
    ...(account.smtp
      ? {
          smtpHost: account.smtp.host,
          smtpPort: account.smtp.port,
          smtpSecure: account.smtp.secure,
        }
      : {}),
    authType: account.auth.type,
    authState: account.authState,
    enabled: account.enabled,
    order: account.order,
    ...(account.color ? { color: account.color } : {}),
    ...(account.lastSyncAt ? { lastSyncAt: account.lastSyncAt } : {}),
    ...(account.lastError ? { lastError: account.lastError } : {}),
    settings: account.settings,
    unreadCount,
    status,
  };
}

function mergeSettings(
  existing: AccountSettings,
  patch: Partial<AccountSettings> | undefined,
): AccountSettings {
  if (!patch) return existing;
  return {
    ...existing,
    ...(typeof patch.signature === 'string' ? { signature: patch.signature } : {}),
    ...(patch.signatureFormat === 'plain' || patch.signatureFormat === 'html'
      ? { signatureFormat: patch.signatureFormat }
      : {}),
    ...(patch.autoReply && typeof patch.autoReply === 'object'
      ? {
          autoReply: {
            enabled: patch.autoReply.enabled === true,
            message: String(patch.autoReply.message ?? ''),
            ...(typeof patch.autoReply.until === 'number' ? { until: patch.autoReply.until } : {}),
          },
        }
      : {}),
    ...(patch.notificationOverride === 'inherit' ||
    patch.notificationOverride === 'notify' ||
    patch.notificationOverride === 'silent'
      ? { notificationOverride: patch.notificationOverride }
      : {}),
    ...(patch.defaultSendAccount === true ? { defaultSendAccount: true } : {}),
    ...(patch.downloadPreference === 'entire' ||
    patch.downloadPreference === 'headers-then-item' ||
    patch.downloadPreference === 'headers-only' ||
    patch.downloadPreference === 'headers-only-slow'
      ? { downloadPreference: patch.downloadPreference }
      : {}),
  };
}

export class AccountService {
  constructor(private readonly deps: AccountServiceDeps) {}

  private statusOf(account: Account): AccountRuntimeStatus {
    if (!account.enabled) return 'disabled';
    if (account.settings.demoMode === true) return 'active';
    if (account.authState === 'requires_reauth') return 'requires_reauth';
    if (this.deps.manager.isSyncing(account.id)) return 'syncing';
    if (!this.deps.manager.hasWorker(account.id)) {
      if (account.lastError) return 'error';
      return account.lastSyncAt ? 'offline' : 'first_sync';
    }
    return account.lastError ? 'error' : 'active';
  }

  listViews(): AccountView[] {
    const unread = this.deps.emails.unreadInboxByAccount();
    return this.deps.accounts
      .list()
      .map((account) => toView(account, unread[account.id] ?? 0, this.statusOf(account)));
  }

  getView(id: string): AccountView | null {
    const account = this.deps.accounts.get(id);
    if (!account) return null;
    const unread = this.deps.emails.unreadInboxByAccount()[id] ?? 0;
    return toView(account, unread, this.statusOf(account));
  }

  private async verify(input: {
    imap: AccountEndpointInput;
    smtp?: AccountEndpointInput;
    email: string;
    password: string;
  }): Promise<VerifyResult> {
    const runner = this.deps.verify ?? verifyAccountConnection;
    return runner(input);
  }

  async add(raw: Partial<AccountInput>): Promise<AccountView> {
    const validation = validateAccountInput(raw);
    if (!validation.ok || !validation.value) {
      throw new AccountOperationError('INVALID_ACCOUNT', validation.errors.join('；') || '账户信息不完整');
    }
    const value = validation.value;
    if (!value.password) {
      throw new AccountOperationError('MISSING_PASSWORD', '请填写授权码或密码');
    }
    if (this.deps.accounts.findByEmail(value.email)) {
      throw new AccountOperationError('DUPLICATE_EMAIL', '该邮箱账户已存在');
    }

    const verified = await this.verify({
      imap: value.imap,
      ...(value.smtp ? { smtp: value.smtp } : {}),
      email: value.email,
      password: value.password,
    });
    if (!verified.ok) {
      throw new AccountOperationError(verified.code, verified.message);
    }

    const id = `acc-${randomUUID()}`;
    const account: Account = {
      id,
      displayName: value.displayName,
      email: value.email,
      protocol: 'imap-smtp',
      providerPreset: value.providerPreset,
      imap: value.imap,
      ...(value.smtp ? { smtp: value.smtp } : {}),
      auth: { type: 'password', secretRef: `${id}:password` },
      authState: 'ok',
      createdAt: Date.now(),
      enabled: true,
      order: this.deps.accounts.nextOrder(),
      ...(value.color ? { color: value.color } : {}),
      settings: value.settings,
    };

    this.deps.accounts.insert(account);
    try {
      await this.deps.secrets.set(`${id}:password`, value.password);
    } catch (error) {
      this.deps.accounts.remove(id);
      throw new AccountOperationError('SECRET_WRITE_FAILED', `凭证保存失败：${(error as Error).message}`);
    }

    log.info('accounts', '账户已添加', { accountId: id, email: value.email, preset: value.providerPreset });
    this.deps.onChanged?.();
    this.deps.manager.enqueue(account, true);
    return this.getView(id) as AccountView;
  }

  async update(id: string, raw: Partial<AccountInput>): Promise<AccountView> {
    const existing = this.deps.accounts.get(id);
    if (!existing) throw new AccountOperationError('NOT_FOUND', '账户不存在');

    const merged: Partial<AccountInput> = {
      displayName: raw.displayName ?? existing.displayName,
      email: raw.email ?? existing.email,
      providerPreset: raw.providerPreset ?? existing.providerPreset ?? 'custom',
      imap: raw.imap ?? existing.imap ?? { host: '', port: 993, secure: true },
      smtp: raw.smtp === null ? null : (raw.smtp ?? existing.smtp ?? null),
      ...(raw.password !== undefined ? { password: raw.password } : {}),
      ...(raw.color !== undefined ? { color: raw.color } : {}),
      settings: mergeSettings(existing.settings, raw.settings),
    };

    const validation = validateAccountInput(merged);
    if (!validation.ok || !validation.value) {
      throw new AccountOperationError('INVALID_ACCOUNT', validation.errors.join('；') || '账户信息不完整');
    }
    const value = validation.value;

    const duplicate = this.deps.accounts.findByEmail(value.email);
    if (duplicate && duplicate.id !== id) {
      throw new AccountOperationError('DUPLICATE_EMAIL', '该邮箱账户已存在');
    }

    const endpointChanged =
      existing.email.toLowerCase() !== value.email.toLowerCase() ||
      JSON.stringify(existing.imap ?? null) !== JSON.stringify(value.imap) ||
      JSON.stringify(existing.smtp ?? null) !== JSON.stringify(value.smtp ?? null);
    const credentialChanged = typeof value.password === 'string' && value.password.length > 0;

    if (endpointChanged || credentialChanged) {
      const secretRef = existing.auth.type === 'password' ? existing.auth.secretRef : null;
      const password =
        credentialChanged && value.password
          ? value.password
          : secretRef
            ? await this.deps.secrets.get(secretRef)
            : null;
      if (!password) {
        throw new AccountOperationError('MISSING_PASSWORD', '修改服务器或凭证前请重新输入授权码');
      }
      const verified = await this.verify({
        imap: value.imap,
        ...(value.smtp ? { smtp: value.smtp } : {}),
        email: value.email,
        password,
      });
      if (!verified.ok) {
        // 验证失败：保持旧配置不变（§7.8.1）
        throw new AccountOperationError(verified.code, verified.message);
      }
      if (credentialChanged && value.password && secretRef) {
        await this.deps.secrets.set(secretRef, value.password);
      }
      this.deps.accounts.setAuthState(id, 'ok');
    }

    this.deps.accounts.updateProfile(id, {
      displayName: value.displayName,
      email: value.email,
      ...(value.providerPreset ? { providerPreset: value.providerPreset } : {}),
      imap: value.imap,
      ...(value.smtp ? { smtp: value.smtp } : {}),
      color: value.color ?? null,
    });
    this.deps.accounts.setSettings(id, value.settings);
    if (value.password) {
      this.deps.accounts.setAuthState(id, 'ok');
    }
    this.deps.accounts.setLastError(id, null);

    if (endpointChanged || credentialChanged) {
      await this.deps.manager.disposeAccount(id);
      const updated = this.deps.accounts.get(id);
      if (updated) this.deps.manager.enqueue(updated, true);
    }

    log.info('accounts', '账户已更新', {
      accountId: id,
      endpointChanged,
      credentialChanged,
    });
    this.deps.onChanged?.();
    return this.getView(id) as AccountView;
  }

  async setEnabled(id: string, enabled: boolean): Promise<AccountView> {
    const account = this.deps.accounts.get(id);
    if (!account) throw new AccountOperationError('NOT_FOUND', '账户不存在');

    this.deps.accounts.setEnabled(id, enabled);
    if (!enabled) {
      this.deps.manager.cancelPending(id);
      await this.deps.manager.disposeAccount(id);
    } else {
      const updated = this.deps.accounts.get(id);
      if (updated && updated.authState === 'ok') {
        this.deps.manager.enqueue(updated, true);
      }
    }

    log.info('accounts', enabled ? '账户已启用' : '账户已禁用', { accountId: id });
    this.deps.onChanged?.();
    return this.getView(id) as AccountView;
  }

  async reauthenticate(id: string, password: string): Promise<AccountView> {
    const account = this.deps.accounts.get(id);
    if (!account) throw new AccountOperationError('NOT_FOUND', '账户不存在');
    if (account.auth.type !== 'password' || !account.imap) {
      throw new AccountOperationError('UNSUPPORTED_AUTH', '该账户的认证方式暂不支持手动重新认证');
    }
    const value = String(password ?? '');
    if (!value) throw new AccountOperationError('MISSING_PASSWORD', '请填写授权码或密码');

    const verified = await this.verify({
      imap: account.imap,
      ...(account.smtp ? { smtp: account.smtp } : {}),
      email: account.email,
      password: value,
    });
    if (!verified.ok) {
      throw new AccountOperationError(verified.code, verified.message);
    }

    await this.deps.secrets.set(account.auth.secretRef, value);
    this.deps.accounts.setAuthState(id, 'ok');
    this.deps.accounts.setLastError(id, null);

    await this.deps.manager.disposeAccount(id);
    const updated = this.deps.accounts.get(id);
    if (updated) this.deps.manager.enqueue(updated, true);

    log.info('accounts', '账户重新认证成功', { accountId: id });
    this.deps.onChanged?.();
    return this.getView(id) as AccountView;
  }

  /**
   * 删除账户（§7.8.5）：先标记「删除中」，再清理数据与凭证，账户行最后删。
   * 任一步失败时账户保留并保持「删除中」，下次启动重试。
   */
  async remove(id: string): Promise<PurgeResult> {
    const account = this.deps.accounts.get(id);
    if (!account) throw new AccountOperationError('NOT_FOUND', '账户不存在');

    this.deps.manager.cancelPending(id);
    await this.deps.manager.disposeAccount(id);
    this.deps.accounts.setLastError(id, {
      code: 'delete_pending',
      message: '账户正在删除，未完成的清理会在下次启动时重试',
      at: Date.now(),
    });

    const purge = await purgeAccountData(this.deps.db, id, {
      ...(this.deps.attachmentsRoot ? { attachmentsRoot: this.deps.attachmentsRoot } : {}),
      deleteAccountRow: false,
    });

    const refs = new Set<string>([`${id}:password`, `${id}:access`, `${id}:refresh`]);
    if (account.auth.type === 'password') refs.add(account.auth.secretRef);
    const failures = [...purge.failedSteps];
    for (const ref of refs) {
      await this.deps.secrets.delete(ref);
      if (await this.deps.secrets.has(ref)) failures.push(`凭证:${ref}`);
    }

    if (this.deps.clearPartition) {
      try {
        await this.deps.clearPartition(id);
      } catch (error) {
        failures.push('webview partition');
        log.warn('accounts', '账户 partition 清理失败', {
          accountId: id,
          message: (error as Error).message,
        });
      }
    }

    if (failures.length > 0) {
      this.deps.accounts.setLastError(id, {
        code: 'delete_pending',
        message: `清理未完成：${failures.join('、')}`,
        at: Date.now(),
      });
      log.warn('accounts', '账户删除未完成，保留账户等待重试', {
        accountId: id,
        failures,
      });
      this.deps.onChanged?.();
      throw new AccountOperationError('CLEANUP_PARTIAL', `部分数据未能清理：${failures.join('、')}`);
    }

    this.deps.accounts.remove(id);
    log.info('accounts', '账户已删除', {
      accountId: id,
      emails: purge.deletedEmails,
      files: purge.deletedFiles,
      contacts: purge.deletedContacts,
    });
    this.deps.onChanged?.();
    return purge;
  }

  /** 启动时重试上次未完成的删除（§7.8.5 清理失败处理）。 */
  async retryPendingDeletes(): Promise<void> {
    const pending = this.deps.accounts
      .list()
      .filter((account) => account.lastError?.code === 'delete_pending');
    for (const account of pending) {
      try {
        await this.remove(account.id);
      } catch (error) {
        log.warn('accounts', '重试删除账户失败', {
          accountId: account.id,
          message: (error as Error).message,
        });
      }
    }
  }
}
