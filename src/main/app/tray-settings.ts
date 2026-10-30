import type { Db } from '../db/open';
import type { TraySettings } from '../../shared/types';

/**
 * 托盘设置（宿主能力，与插件无关）。
 *
 * 存储：app_settings 表 `tray` key；类型在 shared/types.ts（渲染层共用）。
 * 本文件只放纯函数与持久化，不 import electron，便于单测。
 */

export const DEFAULT_TRAY_SETTINGS: TraySettings = {
  enabled: true,
  closeToTray: true,
  minimizeToTray: true,
  showUnreadBadge: true,
};

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** 容忍脏数据：缺字段回退默认值，绝不抛异常。 */
export function parseTraySettings(raw: string | null): TraySettings {
  if (!raw) return { ...DEFAULT_TRAY_SETTINGS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_TRAY_SETTINGS };
  }
  if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_TRAY_SETTINGS };
  const obj = parsed as Record<string, unknown>;
  return {
    enabled: bool(obj.enabled, DEFAULT_TRAY_SETTINGS.enabled),
    closeToTray: bool(obj.closeToTray, DEFAULT_TRAY_SETTINGS.closeToTray),
    minimizeToTray: bool(obj.minimizeToTray, DEFAULT_TRAY_SETTINGS.minimizeToTray),
    showUnreadBadge: bool(obj.showUnreadBadge, DEFAULT_TRAY_SETTINGS.showUnreadBadge),
  };
}

export function readTraySettings(db: Db): TraySettings {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get('tray') as
    | { value: string }
    | undefined;
  return parseTraySettings(row?.value ?? null);
}

export function writeTraySettings(db: Db, settings: TraySettings): void {
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(
    'tray',
    JSON.stringify({
      enabled: settings.enabled,
      closeToTray: settings.closeToTray,
      minimizeToTray: settings.minimizeToTray,
      showUnreadBadge: settings.showUnreadBadge,
    }),
    Date.now(),
  );
}

/**
 * 关闭窗口时是否拦截为「隐藏到托盘」。
 * 正在退出、或托盘本身未启用时都必须放行（否则应用将无法退出）。
 */
export function shouldHideOnClose(settings: TraySettings, quitting: boolean): boolean {
  if (quitting) return false;
  if (!settings.enabled) return false;
  return settings.closeToTray;
}

/** 最小化时是否隐藏到托盘。 */
export function shouldHideOnMinimize(settings: TraySettings): boolean {
  return settings.enabled && settings.minimizeToTray;
}

const BASE_ICON = 'tray-icon.png';

/** 未读数 → 图标文件名（0 用基础图标，1-9 用数字徽章，>9 用 9+）。 */
export function badgeIconName(unread: number): string {
  if (unread <= 0) return BASE_ICON;
  if (unread <= 9) return `tray-badge-${unread}.png`;
  return 'tray-badge-9p.png';
}

/** 实际使用的图标：关闭徽章设置时永远返回基础图标。 */
export function trayIconName(settings: TraySettings, unread: number): string {
  if (!settings.showUnreadBadge) return BASE_ICON;
  return badgeIconName(unread);
}

/** 未读数清洗：负值/非有限值归零、取整（徽章、tooltip、菜单共用同一口径）。 */
export function normalizeUnread(unread: number): number {
  return Math.max(0, Math.floor(Number.isFinite(unread) ? unread : 0));
}

/**
 * 托盘悬停文案：无未读只显示产品名，否则附带未读封数。
 * 与右键菜单的未读项保持同一口径（精确数，不做 9+ 收敛——
 * 菜单能显示完整数字，tooltip 没有理由更少）。
 */
export function trayTooltip(unread: number): string {
  const count = normalizeUnread(unread);
  if (count === 0) return 'MailForge';
  return `MailForge · ${count} 封未读`;
}
