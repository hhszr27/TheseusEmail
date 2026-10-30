import type { Account, AccountAuthState, AccountSettings, AuthMethod } from '../../../shared/types';
import type { Db } from '../open';

interface AccountRow {
  id: string;
  display_name: string;
  email: string;
  protocol: Account['protocol'];
  provider_preset: string | null;
  imap_host: string | null;
  imap_port: number | null;
  imap_secure: number | null;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_secure: number | null;
  auth_type: string;
  secret_ref: string | null;
  auth_state: AccountAuthState;
  namespace_prefix: string | null;
  folder_delimiter: string | null;
  created_at: number;
  enabled: number;
  sort_order: number;
  color: string | null;
  last_sync_at: number | null;
  last_error_json: string | null;
  settings_json: string | null;
}

function parseSettings(json: string | null): AccountSettings {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const value = parsed as AccountSettings;
    return {
      ...(typeof value.signature === 'string' ? { signature: value.signature } : {}),
      ...(value.signatureFormat === 'plain' || value.signatureFormat === 'html'
        ? { signatureFormat: value.signatureFormat }
        : {}),
      ...(value.autoReply && typeof value.autoReply === 'object'
        ? {
            autoReply: {
              enabled: value.autoReply.enabled === true,
              message: String(value.autoReply.message ?? ''),
              ...(typeof value.autoReply.until === 'number' ? { until: value.autoReply.until } : {}),
            },
          }
        : {}),
      ...(value.notificationOverride === 'inherit' ||
      value.notificationOverride === 'notify' ||
      value.notificationOverride === 'silent'
        ? { notificationOverride: value.notificationOverride }
        : {}),
      ...(value.defaultSendAccount === true ? { defaultSendAccount: true } : {}),
      ...(value.downloadPreference === 'entire' ||
      value.downloadPreference === 'headers-then-item' ||
      value.downloadPreference === 'headers-only' ||
      value.downloadPreference === 'headers-only-slow'
        ? { downloadPreference: value.downloadPreference }
        : {}),
      ...(value.demoMode === true ? { demoMode: true } : {}),
    };
  } catch {
    return {};
  }
}

function parseLastError(json: string | null): Account['lastError'] {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as { code?: unknown; message?: unknown; at?: unknown };
    if (typeof parsed.code !== 'string' || typeof parsed.message !== 'string') return undefined;
    return {
      code: parsed.code,
      message: parsed.message,
      at: typeof parsed.at === 'number' ? parsed.at : Date.now(),
    };
  } catch {
    return undefined;
  }
}

function toAccount(row: AccountRow): Account {
  let auth: AuthMethod;
  if (row.auth_type === 'oauth2') {
    auth = {
      type: 'oauth2',
      accessTokenRef: `${row.id}:access`,
      refreshTokenRef: `${row.id}:refresh`,
      expiresAt: 0,
    };
  } else if (row.auth_type === 'graph') {
    auth = {
      type: 'graph',
      accessTokenRef: `${row.id}:access`,
      refreshTokenRef: `${row.id}:refresh`,
      expiresAt: 0,
    };
  } else {
    auth = { type: 'password', secretRef: row.secret_ref ?? `${row.id}:password` };
  }

  const lastError = parseLastError(row.last_error_json);

  return {
    id: row.id,
    displayName: row.display_name,
    email: row.email,
    protocol: row.protocol,
    ...(row.provider_preset
      ? { providerPreset: row.provider_preset as NonNullable<Account['providerPreset']> }
      : {}),
    ...(row.imap_host && row.imap_port !== null
      ? {
          imap: {
            host: row.imap_host,
            port: row.imap_port,
            secure: row.imap_secure !== 0,
          },
        }
      : {}),
    ...(row.smtp_host && row.smtp_port !== null
      ? {
          smtp: {
            host: row.smtp_host,
            port: row.smtp_port,
            secure: row.smtp_secure !== 0,
          },
        }
      : {}),
    auth,
    authState: row.auth_state,
    ...(row.namespace_prefix ? { namespacePrefix: row.namespace_prefix } : {}),
    ...(row.folder_delimiter ? { folderDelimiter: row.folder_delimiter } : {}),
    createdAt: row.created_at,
    enabled: row.enabled !== 0,
    order: row.sort_order ?? 0,
    ...(row.color ? { color: row.color } : {}),
    ...(row.last_sync_at ? { lastSyncAt: row.last_sync_at } : {}),
    ...(lastError ? { lastError } : {}),
    settings: parseSettings(row.settings_json),
  };
}

export interface AccountEndpoint {
  host: string;
  port: number;
  secure: boolean;
}

export interface AccountProfileUpdate {
  displayName: string;
  email: string;
  providerPreset?: string;
  imap: AccountEndpoint;
  smtp?: AccountEndpoint;
  color?: string | null;
}

export class AccountsRepo {
  constructor(private readonly db: Db) {}

  /** `.env` 账户的幂等写入：已存在时保持用户后续在界面里的修改。 */
  ensure(account: Account): void {
    const secretRef = account.auth.type === 'password' ? account.auth.secretRef : null;
    this.db
      .prepare(
        `INSERT INTO accounts (
           id, display_name, email, protocol, provider_preset,
           imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
           auth_type, secret_ref, auth_state, namespace_prefix, folder_delimiter, created_at,
           enabled, sort_order, color, last_sync_at, last_error_json, settings_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        account.id,
        account.displayName,
        account.email,
        account.protocol,
        account.providerPreset ?? null,
        account.imap?.host ?? null,
        account.imap?.port ?? null,
        account.imap ? (account.imap.secure ? 1 : 0) : null,
        account.smtp?.host ?? null,
        account.smtp?.port ?? null,
        account.smtp ? (account.smtp.secure ? 1 : 0) : null,
        account.auth.type,
        secretRef,
        account.authState,
        account.namespacePrefix ?? null,
        account.folderDelimiter ?? null,
        account.createdAt,
        account.enabled ? 1 : 0,
        account.order,
        account.color ?? null,
        account.lastSyncAt ?? null,
        account.lastError ? JSON.stringify(account.lastError) : null,
        JSON.stringify(account.settings ?? {}),
      );
  }

  /** 新建账户；id 由调用方生成，重复 id 会抛错。 */
  insert(account: Account): void {
    const secretRef = account.auth.type === 'password' ? account.auth.secretRef : null;
    this.db
      .prepare(
        `INSERT INTO accounts (
           id, display_name, email, protocol, provider_preset,
           imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
           auth_type, secret_ref, auth_state, created_at,
           enabled, sort_order, color, last_sync_at, last_error_json, settings_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        account.id,
        account.displayName,
        account.email,
        account.protocol,
        account.providerPreset ?? null,
        account.imap?.host ?? null,
        account.imap?.port ?? null,
        account.imap ? (account.imap.secure ? 1 : 0) : null,
        account.smtp?.host ?? null,
        account.smtp?.port ?? null,
        account.smtp ? (account.smtp.secure ? 1 : 0) : null,
        account.auth.type,
        secretRef,
        account.authState,
        account.createdAt,
        account.enabled ? 1 : 0,
        account.order,
        account.color ?? null,
        account.lastSyncAt ?? null,
        account.lastError ? JSON.stringify(account.lastError) : null,
        JSON.stringify(account.settings ?? {}),
      );
  }

  list(): Account[] {
    const rows = this.db
      .prepare('SELECT * FROM accounts ORDER BY sort_order ASC, created_at ASC')
      .all() as AccountRow[];
    return rows.map(toAccount);
  }

  listEnabled(): Account[] {
    return this.list().filter((account) => account.enabled);
  }

  get(id: string): Account | null {
    const row = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as
      | AccountRow
      | undefined;
    return row ? toAccount(row) : null;
  }

  findByEmail(email: string): Account | null {
    const row = this.db
      .prepare('SELECT * FROM accounts WHERE lower(email) = lower(?) LIMIT 1')
      .get(email) as AccountRow | undefined;
    return row ? toAccount(row) : null;
  }

  nextOrder(): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(sort_order), 0) AS value FROM accounts')
      .get() as { value: number };
    return row.value + 1;
  }

  updateProfile(id: string, update: AccountProfileUpdate): void {
    this.db
      .prepare(
        `UPDATE accounts
            SET display_name = ?,
                email = ?,
                provider_preset = ?,
                imap_host = ?,
                imap_port = ?,
                imap_secure = ?,
                smtp_host = ?,
                smtp_port = ?,
                smtp_secure = ?,
                color = ?
          WHERE id = ?`,
      )
      .run(
        update.displayName,
        update.email,
        update.providerPreset ?? 'custom',
        update.imap.host,
        update.imap.port,
        update.imap.secure ? 1 : 0,
        update.smtp?.host ?? null,
        update.smtp?.port ?? null,
        update.smtp ? (update.smtp.secure ? 1 : 0) : null,
        update.color ?? null,
        id,
      );
  }

  setAuthState(id: string, state: AccountAuthState): void {
    this.db.prepare('UPDATE accounts SET auth_state = ? WHERE id = ?').run(state, id);
  }

  setEnabled(id: string, enabled: boolean): void {
    this.db.prepare('UPDATE accounts SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  }

  setSettings(id: string, settings: AccountSettings): void {
    this.db
      .prepare('UPDATE accounts SET settings_json = ? WHERE id = ?')
      .run(JSON.stringify(settings), id);
  }

  setLastSync(id: string, at: number | null): void {
    this.db.prepare('UPDATE accounts SET last_sync_at = ? WHERE id = ?').run(at, id);
  }

  setLastError(id: string, error: Account['lastError'] | null): void {
    this.db
      .prepare('UPDATE accounts SET last_error_json = ? WHERE id = ?')
      .run(error ? JSON.stringify(error) : null, id);
  }

  setDiscovery(id: string, namespacePrefix: string | null, delimiter: string | null): void {
    this.db
      .prepare('UPDATE accounts SET namespace_prefix = ?, folder_delimiter = ? WHERE id = ?')
      .run(namespacePrefix, delimiter, id);
  }

  remove(id: string): boolean {
    const result = this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    return result.changes > 0;
  }
}
