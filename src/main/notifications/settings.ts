import type { Db } from '../db/open';
import {
  DEFAULT_DND,
  type DndSettings,
  type NotificationPolicy,
} from './policy';

/**
 * 通知设置的持久化（§22.1 / §22.3）。
 *
 * 存储位置：app_settings 表，两个 key——
 *  - `notifications`：NotificationSettings（邮件通知 / 发送结果 / 日程提醒）
 *  - `dnd`：免打扰时段
 * `notifications` 表（策略规则）由 decideNotification 消费，与本文件无关。
 *
 * 边界：本模块只做「读库 → 纯函数校验 → 结构化设置」，
 * 不弹通知、不碰 Electron，便于单测。
 */

export interface NotificationSettings {
  /** 新邮件桌面通知总开关（仍受 notifications 策略表与 DND 约束）。 */
  mail: boolean;
  /** 定时发送结果（成功/失败/取消）通知。 */
  sendResult: boolean;
  /** 日程提醒总开关。 */
  reminders: boolean;
  /** 日程提前提醒分钟数；0 表示准时提醒。 */
  reminderMinutes: number;
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  mail: true,
  sendResult: true,
  reminders: true,
  reminderMinutes: 10,
};

/** 提前量可选值（分钟），设置 UI 与解析共用一份口径。 */
export const MAX_REMINDER_MINUTES = 24 * 60;

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function minutes(value: unknown, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(MAX_REMINDER_MINUTES, Math.max(0, Math.round(num)));
}

function hour(value: unknown, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(23, Math.max(0, Math.round(num)));
}

/** 提前量分钟数夹取到 [0, 1440]。 */
export function clampReminderMinutes(value: unknown): number {
  return minutes(value, DEFAULT_NOTIFICATION_SETTINGS.reminderMinutes);
}

/** 小时夹取到 [0, 23]。 */
export function clampHour(value: unknown): number {
  return hour(value, 0);
}

/** 容忍脏数据：缺字段回退默认值，越界夹取，绝不抛异常。 */
export function parseNotificationSettings(raw: string | null): NotificationSettings {
  if (!raw) return { ...DEFAULT_NOTIFICATION_SETTINGS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_NOTIFICATION_SETTINGS };
  }
  if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_NOTIFICATION_SETTINGS };
  const obj = parsed as Record<string, unknown>;
  return {
    mail: bool(obj.mail, DEFAULT_NOTIFICATION_SETTINGS.mail),
    sendResult: bool(obj.sendResult, DEFAULT_NOTIFICATION_SETTINGS.sendResult),
    reminders: bool(obj.reminders, DEFAULT_NOTIFICATION_SETTINGS.reminders),
    reminderMinutes: minutes(obj.reminderMinutes, DEFAULT_NOTIFICATION_SETTINGS.reminderMinutes),
  };
}

export function parseDndSettings(raw: string | null): DndSettings {
  if (!raw) return { ...DEFAULT_DND };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_DND };
  }
  if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_DND };
  const obj = parsed as Record<string, unknown>;
  return {
    enabled: bool(obj.enabled, DEFAULT_DND.enabled),
    startHour: hour(obj.startHour, DEFAULT_DND.startHour),
    endHour: hour(obj.endHour, DEFAULT_DND.endHour),
  };
}

export function readNotificationSettings(db: Db): NotificationSettings {
  const row = db
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get('notifications') as { value: string } | undefined;
  return parseNotificationSettings(row?.value ?? null);
}

export function readDndSettings(db: Db): DndSettings {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get('dnd') as
    | { value: string }
    | undefined;
  return parseDndSettings(row?.value ?? null);
}

export function writeSettings(db: Db, key: string, value: unknown): void {
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value), Date.now());
}

export function writeNotificationSettings(db: Db, settings: NotificationSettings): void {
  writeSettings(db, 'notifications', {
    mail: settings.mail,
    sendResult: settings.sendResult,
    reminders: settings.reminders,
    reminderMinutes: minutes(settings.reminderMinutes, DEFAULT_NOTIFICATION_SETTINGS.reminderMinutes),
  });
}

export function writeDndSettings(db: Db, dnd: DndSettings): void {
  writeSettings(db, 'dnd', {
    enabled: dnd.enabled,
    startHour: hour(dnd.startHour, DEFAULT_DND.startHour),
    endHour: hour(dnd.endHour, DEFAULT_DND.endHour),
  });
}

/** notifications 策略表（§22.1）：账户/文件夹/发件人 → 动作。 */
export function readNotificationPolicies(db: Db): NotificationPolicy[] {
  const rows = db.prepare('SELECT * FROM notifications').all() as Array<{
    account_id: string | null;
    folder: string | null;
    from_pattern: string | null;
    action: NotificationPolicy['action'];
  }>;
  return rows.map((row) => ({
    ...(row.account_id ? { accountId: row.account_id } : {}),
    ...(row.folder ? { folder: row.folder } : {}),
    ...(row.from_pattern ? { from: row.from_pattern } : {}),
    action: row.action,
  }));
}
