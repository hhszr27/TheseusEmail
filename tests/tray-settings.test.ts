import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TRAY_SETTINGS,
  badgeIconName,
  normalizeUnread,
  parseTraySettings,
  readTraySettings,
  shouldHideOnClose,
  shouldHideOnMinimize,
  trayIconName,
  trayTooltip,
  writeTraySettings,
} from '../src/main/app/tray-settings';
import type { TraySettings } from '../src/shared/types';
import { createTestDb, type TestDb } from './helpers/test-db';

const FULL: TraySettings = {
  enabled: true,
  closeToTray: true,
  minimizeToTray: true,
  showUnreadBadge: true,
};

describe('parseTraySettings（脏数据容忍）', () => {
  it('null / 空串 / 非法 JSON / 非对象 → 全部回落默认', () => {
    expect(parseTraySettings(null)).toEqual(DEFAULT_TRAY_SETTINGS);
    expect(parseTraySettings('')).toEqual(DEFAULT_TRAY_SETTINGS);
    expect(parseTraySettings('not json')).toEqual(DEFAULT_TRAY_SETTINGS);
    expect(parseTraySettings('"a-string"')).toEqual(DEFAULT_TRAY_SETTINGS);
    expect(parseTraySettings('[1,2,3]')).toEqual(DEFAULT_TRAY_SETTINGS);
  });

  it('缺字段补默认，已有布尔值原样保留', () => {
    expect(parseTraySettings('{"enabled":false}')).toEqual({
      enabled: false,
      closeToTray: true,
      minimizeToTray: true,
      showUnreadBadge: true,
    });
  });

  it('完整对象原样回显', () => {
    expect(parseTraySettings(JSON.stringify(FULL))).toEqual(FULL);
  });

  it('非布尔字段回落默认，绝不抛异常', () => {
    expect(parseTraySettings('{"enabled":"true","closeToTray":null}')).toEqual({
      enabled: true,
      closeToTray: true,
      minimizeToTray: true,
      showUnreadBadge: true,
    });
  });
});

describe('normalizeUnread（未读数口径清洗）', () => {
  it('负值 / 非有限值归零', () => {
    expect(normalizeUnread(-5)).toBe(0);
    expect(normalizeUnread(-0.1)).toBe(0);
    expect(normalizeUnread(Number.NaN)).toBe(0);
    expect(normalizeUnread(Number.POSITIVE_INFINITY)).toBe(0);
    expect(normalizeUnread(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it('正常数与小数取整', () => {
    expect(normalizeUnread(0)).toBe(0);
    expect(normalizeUnread(7)).toBe(7);
    expect(normalizeUnread(5.9)).toBe(5);
  });
});

describe('badgeIconName（徽章文件名）', () => {
  it('零与负值用基础图标', () => {
    expect(badgeIconName(0)).toBe('tray-icon.png');
    expect(badgeIconName(-3)).toBe('tray-icon.png');
  });

  it('1–9 用对应数字徽章', () => {
    expect(badgeIconName(1)).toBe('tray-badge-1.png');
    expect(badgeIconName(9)).toBe('tray-badge-9.png');
  });

  it('超过 9 收敛为 9+', () => {
    expect(badgeIconName(10)).toBe('tray-badge-9p.png');
    expect(badgeIconName(999)).toBe('tray-badge-9p.png');
  });
});

describe('trayIconName（徽章开关）', () => {
  it('关闭徽章时永远返回基础图标', () => {
    const off: TraySettings = { ...FULL, showUnreadBadge: false };
    expect(trayIconName(off, 0)).toBe('tray-icon.png');
    expect(trayIconName(off, 42)).toBe('tray-icon.png');
  });

  it('开启徽章时按未读数选文件名', () => {
    expect(trayIconName(FULL, 0)).toBe('tray-icon.png');
    expect(trayIconName(FULL, 5)).toBe('tray-badge-5.png');
  });
});

describe('shouldHideOnClose（关闭拦截）', () => {
  it('正在退出时一律放行，避免无法退出', () => {
    expect(shouldHideOnClose(FULL, true)).toBe(false);
    expect(shouldHideOnClose({ ...FULL, closeToTray: true }, true)).toBe(false);
  });

  it('托盘未启用时放行', () => {
    expect(shouldHideOnClose({ ...FULL, enabled: false }, false)).toBe(false);
  });

  it('启用时跟随 closeToTray', () => {
    expect(shouldHideOnClose({ ...FULL, closeToTray: true }, false)).toBe(true);
    expect(shouldHideOnClose({ ...FULL, closeToTray: false }, false)).toBe(false);
  });
});

describe('shouldHideOnMinimize（最小化拦截）', () => {
  it('未启用或关闭最小化到托盘时返回 false', () => {
    expect(shouldHideOnMinimize({ ...FULL, enabled: false })).toBe(false);
    expect(shouldHideOnMinimize({ ...FULL, minimizeToTray: false })).toBe(false);
  });

  it('启用且开启最小化到托盘时返回 true', () => {
    expect(shouldHideOnMinimize(FULL)).toBe(true);
  });
});

describe('trayTooltip（悬停文案）', () => {
  it('无未读只显示产品名', () => {
    expect(trayTooltip(0)).toBe('MailForge');
    expect(trayTooltip(-2)).toBe('MailForge');
  });

  it('有未读附带封数', () => {
    expect(trayTooltip(3)).toBe('MailForge · 3 封未读');
  });
});

describe('读写 round-trip（app_settings 持久化）', () => {
  let ctx: TestDb | null = null;
  afterEach(() => {
    ctx?.cleanup();
    ctx = null;
  });

  it('写入后读回一致', () => {
    ctx = createTestDb();
    const settings: TraySettings = {
      enabled: false,
      closeToTray: true,
      minimizeToTray: false,
      showUnreadBadge: true,
    };
    writeTraySettings(ctx.db, settings);
    expect(readTraySettings(ctx.db)).toEqual(settings);
  });

  it('无行时回落默认', () => {
    ctx = createTestDb();
    expect(readTraySettings(ctx.db)).toEqual(DEFAULT_TRAY_SETTINGS);
  });

  it('损坏的 JSON 回落默认', () => {
    ctx = createTestDb();
    ctx.db
      .prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)')
      .run('tray', '{这不是合法json', Date.now());
    expect(readTraySettings(ctx.db)).toEqual(DEFAULT_TRAY_SETTINGS);
  });
});
