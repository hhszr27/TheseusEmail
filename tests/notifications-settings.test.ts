import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  clampHour,
  clampReminderMinutes,
  parseDndSettings,
  parseNotificationSettings,
  readDndSettings,
  readNotificationPolicies,
  readNotificationSettings,
  writeDndSettings,
  writeNotificationSettings,
} from '../src/main/notifications/settings';
import { createTestDb, type TestDb } from './helpers/test-db';

/**
 * 通知设置（§22.1/§22.3）：
 *  - 解析容忍脏数据（坏 JSON / 缺字段 / 越界），绝不抛异常；
 *  - 读写走 app_settings，键为 notifications 与 dnd。
 */

let testDb: TestDb;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.cleanup();
});

describe('通知设置解析', () => {
  it('缺省返回默认值', () => {
    expect(parseNotificationSettings(null)).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
    expect(parseDndSettings(null)).toEqual({ enabled: false, startHour: 22, endHour: 8 });
  });

  it('坏 JSON 回退默认值', () => {
    expect(parseNotificationSettings('{oops')).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
    expect(parseDndSettings('not-json')).toEqual({ enabled: false, startHour: 22, endHour: 8 });
  });

  it('非对象 JSON 回退默认值', () => {
    expect(parseNotificationSettings('"mail"')).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
    expect(parseNotificationSettings('42')).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
  });

  it('部分字段合并，未提供的回退默认', () => {
    const parsed = parseNotificationSettings(JSON.stringify({ mail: false }));
    expect(parsed.mail).toBe(false);
    expect(parsed.sendResult).toBe(true);
    expect(parsed.reminders).toBe(true);
    expect(parsed.reminderMinutes).toBe(10);
  });

  it('提前量越界夹取到 [0, 1440]', () => {
    expect(parseNotificationSettings(JSON.stringify({ reminderMinutes: 99999 })).reminderMinutes).toBe(
      24 * 60,
    );
    expect(parseNotificationSettings(JSON.stringify({ reminderMinutes: -5 })).reminderMinutes).toBe(0);
    expect(parseNotificationSettings(JSON.stringify({ reminderMinutes: 7.6 })).reminderMinutes).toBe(8);
    // 非数字（字符串/布尔）回退默认
    expect(parseNotificationSettings(JSON.stringify({ reminderMinutes: '十五' })).reminderMinutes).toBe(
      10,
    );
  });

  it('DND 小时越界夹取到 [0, 23]，缺字段回退', () => {
    const parsed = parseDndSettings(JSON.stringify({ enabled: true, startHour: 99, endHour: -3 }));
    expect(parsed).toEqual({ enabled: true, startHour: 23, endHour: 0 });
  });

  it('布尔字段必须是布尔，其他类型回退', () => {
    expect(parseNotificationSettings(JSON.stringify({ mail: 'yes' })).mail).toBe(true);
    expect(parseDndSettings(JSON.stringify({ enabled: 1 })).enabled).toBe(false);
  });

  it('clamp 助手与解析口径一致', () => {
    expect(clampReminderMinutes(99999)).toBe(24 * 60);
    expect(clampReminderMinutes('abc')).toBe(10);
    expect(clampHour(30)).toBe(23);
    expect(clampHour('x')).toBe(0);
  });
});

describe('通知设置持久化', () => {
  it('写入后可读回，且键隔离', () => {
    writeNotificationSettings(testDb.db, {
      mail: false,
      sendResult: false,
      reminders: true,
      reminderMinutes: 15,
    });
    writeDndSettings(testDb.db, { enabled: true, startHour: 23, endHour: 7 });

    expect(readNotificationSettings(testDb.db)).toEqual({
      mail: false,
      sendResult: false,
      reminders: true,
      reminderMinutes: 15,
    });
    expect(readDndSettings(testDb.db)).toEqual({ enabled: true, startHour: 23, endHour: 7 });

    // 覆盖写：同一键更新而非新增
    writeNotificationSettings(testDb.db, {
      mail: true,
      sendResult: true,
      reminders: true,
      reminderMinutes: 5,
    });
    const rows = testDb.db
      .prepare('SELECT COUNT(*) AS c FROM app_settings WHERE key = ?')
      .get('notifications') as { c: number };
    expect(rows.c).toBe(1);
    expect(readNotificationSettings(testDb.db).reminderMinutes).toBe(5);
  });

  it('写入会夹取越界值', () => {
    writeNotificationSettings(testDb.db, {
      mail: true,
      sendResult: true,
      reminders: true,
      reminderMinutes: 99999,
    });
    writeDndSettings(testDb.db, { enabled: true, startHour: 99, endHour: 99 });
    expect(readNotificationSettings(testDb.db).reminderMinutes).toBe(24 * 60);
    expect(readDndSettings(testDb.db)).toEqual({ enabled: true, startHour: 23, endHour: 23 });
  });

  it('未写入时读回默认值', () => {
    expect(readNotificationSettings(testDb.db)).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
    expect(readDndSettings(testDb.db)).toEqual({ enabled: false, startHour: 22, endHour: 8 });
  });
});

describe('notifications 策略表', () => {
  it('空表返回空列表', () => {
    expect(readNotificationPolicies(testDb.db)).toEqual([]);
  });

  it('按行映射为策略（§22.1）', () => {
    testDb.db
      .prepare(
        `INSERT INTO notifications (id, account_id, folder, from_pattern, priority, action)
         VALUES ('n1', 'acc-1', 'INBOX', 'boss', 'high', 'silent'),
                ('n2', NULL, NULL, NULL, NULL, 'notify')`,
      )
      .run();

    const policies = readNotificationPolicies(testDb.db);
    expect(policies).toHaveLength(2);
    expect(policies[0]).toEqual({ accountId: 'acc-1', folder: 'INBOX', from: 'boss', action: 'silent' });
    expect(policies[1]).toEqual({ action: 'notify' });
  });
});
