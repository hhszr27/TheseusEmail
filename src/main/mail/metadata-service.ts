import type { Db } from '../db/open';
import type { AccountsRepo } from '../db/repositories/accounts-repo';
import type { SecretStore } from '../mail/auth/token-store';
import type { MetadataStatus } from '../../shared/ipc';
import { DEFAULT_DND, type DndSettings } from '../notifications/policy';
import { log } from '../observability/logger';
import { readMetadataValue, writeMetadataValue } from './imap-metadata';

/**
 * 通知偏好的服务器漫游（§8.8，可选能力）。
 * 只在用户显式同步时读写；METADATA 不可用时静默降级，不影响本地配置。
 */

const STATUS_KEY = 'imap.metadata';

export class MetadataService {
  constructor(
    private readonly db: Db,
    private readonly accounts: AccountsRepo,
    private readonly secrets: SecretStore,
  ) {}

  status(): MetadataStatus {
    const row = this.db
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get(STATUS_KEY) as { value: string } | undefined;
    if (!row) return { supported: false, enabled: false, lastSyncAt: null, error: null };
    try {
      const parsed = JSON.parse(row.value) as Partial<MetadataStatus>;
      return {
        supported: parsed.supported === true,
        enabled: parsed.enabled === true,
        lastSyncAt: typeof parsed.lastSyncAt === 'number' ? parsed.lastSyncAt : null,
        error: typeof parsed.error === 'string' ? parsed.error : null,
      };
    } catch {
      return { supported: false, enabled: false, lastSyncAt: null, error: null };
    }
  }

  private saveStatus(status: MetadataStatus): void {
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(STATUS_KEY, JSON.stringify(status), Date.now());
  }

  private readDnd(): DndSettings {
    const row = this.db.prepare("SELECT value FROM app_settings WHERE key = 'dnd'").get() as
      | { value: string }
      | undefined;
    if (!row) return DEFAULT_DND;
    try {
      const parsed = JSON.parse(row.value) as Partial<DndSettings>;
      return {
        enabled: parsed.enabled === true,
        startHour: Number.isFinite(parsed.startHour) ? Number(parsed.startHour) : DEFAULT_DND.startHour,
        endHour: Number.isFinite(parsed.endHour) ? Number(parsed.endHour) : DEFAULT_DND.endHour,
      };
    } catch {
      return DEFAULT_DND;
    }
  }

  private writeDnd(dnd: DndSettings): void {
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ('dnd', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify(dnd), Date.now());
  }

  /** 从服务器读取通知偏好；返回最新状态。 */
  async pull(accountId: string): Promise<MetadataStatus> {
    const account = this.accounts.get(accountId);
    if (!account?.imap) {
      return this.fail('账户未配置 IMAP');
    }
    if (account.auth.type !== 'password') {
      return this.fail('OAuth 账户暂不支持 METADATA 漫游');
    }

    const secret = await this.secrets.get(account.auth.secretRef);
    if (!secret) return this.fail('缺少账户凭据');

    try {
      const value = await readMetadataValue({
        host: account.imap.host,
        port: account.imap.port,
        secure: account.imap.secure,
        user: account.email,
        pass: secret,
      });

      if (value === null) {
        const status: MetadataStatus = {
          supported: false,
          enabled: false,
          lastSyncAt: Date.now(),
          error: null,
        };
        this.saveStatus(status);
        return status;
      }

      const parsed = JSON.parse(value) as { v?: number; dnd?: Partial<DndSettings> };
      if (parsed.dnd) {
        this.writeDnd({
          enabled: parsed.dnd.enabled === true,
          startHour: Number.isFinite(parsed.dnd.startHour)
            ? Number(parsed.dnd.startHour)
            : DEFAULT_DND.startHour,
          endHour: Number.isFinite(parsed.dnd.endHour)
            ? Number(parsed.dnd.endHour)
            : DEFAULT_DND.endHour,
        });
      }

      const status: MetadataStatus = {
        supported: true,
        enabled: true,
        lastSyncAt: Date.now(),
        error: null,
      };
      this.saveStatus(status);
      return status;
    } catch (error) {
      log.warn('metadata', '读取服务器配置失败', { message: (error as Error).message });
      return this.fail((error as Error).message);
    }
  }

  /** 把本地通知偏好写入服务器。 */
  async push(accountId: string): Promise<MetadataStatus> {
    const account = this.accounts.get(accountId);
    if (!account?.imap) return this.fail('账户未配置 IMAP');
    if (account.auth.type !== 'password') return this.fail('OAuth 账户暂不支持 METADATA 漫游');

    const secret = await this.secrets.get(account.auth.secretRef);
    if (!secret) return this.fail('缺少账户凭据');

    try {
      const payload = JSON.stringify({ v: 1, dnd: this.readDnd() });
      const written = await writeMetadataValue(
        {
          host: account.imap.host,
          port: account.imap.port,
          secure: account.imap.secure,
          user: account.email,
          pass: secret,
        },
        payload,
      );

      const status: MetadataStatus = {
        supported: written,
        enabled: written,
        lastSyncAt: Date.now(),
        error: written ? null : '服务器未声明 METADATA 能力',
      };
      this.saveStatus(status);
      return status;
    } catch (error) {
      log.warn('metadata', '写入服务器配置失败', { message: (error as Error).message });
      return this.fail((error as Error).message);
    }
  }

  private fail(message: string): MetadataStatus {
    const previous = this.status();
    const status: MetadataStatus = {
      supported: previous.supported,
      enabled: false,
      lastSyncAt: previous.lastSyncAt,
      error: message,
    };
    this.saveStatus(status);
    return status;
  }
}
