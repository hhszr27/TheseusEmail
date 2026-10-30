/**
 * 账户级插件启用（§7.8.4、§30.5）的共享判定。
 *
 * 语义：全局 `enabled=false` 是硬开关——任何账户级覆盖都不能把全局已停用的插件
 * 重新启用。全局启用时，`accountOverrides[accountId] === false` 可在该账户进一步禁用，
 * 未列出或为 `true` 则继承全局（防止陈旧 / 脏覆盖让已下架插件复活）。
 * 账户级禁用只影响该账户上下文里的视图 / 菜单 / 命令，
 * 插件在主进程的全局能力（例如安全扫描）不受影响。
 *
 * 主进程与渲染进程共用同一份判定，避免两侧结论不一致。
 */

export type AccountOverrides = Record<string, boolean>;

/** 某插件在某账户上下文是否启用。 */
export function isPluginEnabledForAccount(
  globalEnabled: boolean,
  overrides: AccountOverrides | undefined,
  accountId: string | null | undefined,
): boolean {
  // 全局禁用是硬开关：账户级覆盖只能把某个账户进一步禁用，
  // 不能把全局已停用的插件重新启用（防止陈旧 / 脏覆盖让下架插件复活）。
  if (!globalEnabled) return false;
  if (!accountId) return globalEnabled;
  const override = overrides?.[accountId];
  return typeof override === 'boolean' ? override : globalEnabled;
}

/** 账户显式覆盖值；null 表示继承全局。 */
export function explicitOverride(
  overrides: AccountOverrides | undefined,
  accountId: string,
): boolean | null {
  const value = overrides?.[accountId];
  return typeof value === 'boolean' ? value : null;
}

/** 删除账户时从覆盖表中移除该账户，返回剩余覆盖。 */
export function withoutAccount(overrides: AccountOverrides, accountId: string): AccountOverrides {
  const next: AccountOverrides = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (key === accountId) continue;
    next[key] = value;
  }
  return next;
}
