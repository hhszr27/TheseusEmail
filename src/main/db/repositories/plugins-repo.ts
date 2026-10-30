import type { Db } from '../open';
import type { PluginPermission } from '../../../shared/types';
import type { PluginSignatureStatus } from '../../../shared/plugin';

/** 插件启用状态、账户级覆盖与能力撤销的持久化（§7.8.4、§30.3、§30.5）。 */
export class PluginsRepo {
  constructor(private readonly db: Db) {}

  listStates(): Array<{ id: string; enabled: boolean }> {
    const rows = this.db.prepare('SELECT id, enabled FROM plugins').all() as Array<{
      id: string;
      enabled: number;
    }>;
    return rows.map((row) => ({ id: row.id, enabled: row.enabled === 1 }));
  }

  disabledIds(): string[] {
    return this.listStates()
      .filter((row) => !row.enabled)
      .map((row) => row.id);
  }

  setEnabled(id: string, enabled: boolean, signature?: PluginSignatureStatus): void {
    this.db
      .prepare(
        `INSERT INTO plugins (id, enabled, config_json, signature_status, installed_at)
         VALUES (?, ?, '{}', ?, ?)
         ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled,
           signature_status = COALESCE(excluded.signature_status, plugins.signature_status)`,
      )
      .run(id, enabled ? 1 : 0, signature ?? null, Date.now());
  }

  /** 首次发现插件时登记默认启用，不覆盖用户已有选择。 */
  /** 首次登记插件；enabled 取清单的 defaultEnabled（缺省启用）。已有记录不覆盖用户选择。 */
  ensure(id: string, signature: PluginSignatureStatus, enabledByDefault = true): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO plugins (id, enabled, config_json, signature_status, installed_at)
         VALUES (?, ?, '{}', ?, ?)`,
      )
      .run(id, enabledByDefault ? 1 : 0, signature, Date.now());
  }

  // ---------- 账户级启用（§7.8.4） ----------

  /** pluginId -> { accountId: enabled }。 */
  loadAccountOverrides(): Map<string, Record<string, boolean>> {
    const rows = this.db
      .prepare('SELECT id, account_overrides FROM plugins')
      .all() as Array<{ id: string; account_overrides: string | null }>;
    const result = new Map<string, Record<string, boolean>>();
    for (const row of rows) {
      const parsed = parseOverrides(row.account_overrides);
      if (Object.keys(parsed).length > 0) result.set(row.id, parsed);
    }
    return result;
  }

  accountOverridesFor(pluginId: string): Record<string, boolean> {
    const row = this.db
      .prepare('SELECT account_overrides FROM plugins WHERE id = ?')
      .get(pluginId) as { account_overrides: string | null } | undefined;
    return parseOverrides(row?.account_overrides);
  }

  /** enabled 为 null 表示删除该账户的覆盖，回落到全局启用状态。 */
  setAccountOverride(pluginId: string, accountId: string, enabled: boolean | null): void {
    if (!pluginId || !accountId) return;
    const current = this.accountOverridesFor(pluginId);
    if (enabled === null) {
      delete current[accountId];
    } else {
      current[accountId] = enabled;
    }
    this.db
      .prepare(
        `INSERT INTO plugins (id, enabled, config_json, signature_status, installed_at, account_overrides)
         VALUES (?, 1, '{}', NULL, ?, ?)
         ON CONFLICT(id) DO UPDATE SET account_overrides = excluded.account_overrides`,
      )
      .run(pluginId, Date.now(), JSON.stringify(current));
  }

  /** 删除账户时清除所有插件里该账户的覆盖（§7.8.5 第 12 步）。 */
  clearAccount(accountId: string): number {
    if (!accountId) return 0;
    const rows = this.db
      .prepare('SELECT id, account_overrides FROM plugins')
      .all() as Array<{ id: string; account_overrides: string | null }>;
    let cleared = 0;
    for (const row of rows) {
      const parsed = parseOverrides(row.account_overrides);
      if (!(accountId in parsed)) continue;
      delete parsed[accountId];
      this.db
        .prepare('UPDATE plugins SET account_overrides = ? WHERE id = ?')
        .run(JSON.stringify(parsed), row.id);
      cleared += 1;
    }
    return cleared;
  }

  // ---------- 能力撤销 ----------

  loadRevoked(): Array<{ pluginId: string; permission: PluginPermission }> {
    const rows = this.db
      .prepare('SELECT plugin_id, permission FROM plugin_capabilities WHERE granted = 0')
      .all() as Array<{ plugin_id: string; permission: PluginPermission }>;
    return rows.map((row) => ({ pluginId: row.plugin_id, permission: row.permission }));
  }

  setCapability(pluginId: string, permission: PluginPermission, granted: boolean): void {
    this.db
      .prepare(
        `INSERT INTO plugin_capabilities (plugin_id, permission, granted, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(plugin_id, permission) DO UPDATE SET
           granted = excluded.granted, updated_at = excluded.updated_at`,
      )
      .run(pluginId, permission, granted ? 1 : 0, Date.now());
  }
}

/** 容错解析：损坏的 JSON 视为没有覆盖，不影响启动。 */
export function parseOverrides(raw: string | null | undefined): Record<string, boolean> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: Record<string, boolean> = {};
    for (const [accountId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!accountId) continue;
      if (value === true) result[accountId] = true;
      else if (value === false) result[accountId] = false;
    }
    return result;
  } catch {
    return {};
  }
}
