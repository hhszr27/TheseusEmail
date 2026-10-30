import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { createTestDb, type TestDb } from './helpers/test-db';

/**
 * 托盘（宿主能力）纯逻辑：
 *  - 关闭/最小化到托盘的决策必须保证「应用永远能退出」；
 *  - 未读徽章图标选择：0 基础、1-9 数字、>9 收敛为 9+。
 */

let testDb: TestDb;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.cleanup();
});

const on: import('../src/shared/types').TraySettings = {
  enabled: true,
  closeToTray: true,
  minimizeToTray: true,
  showUnreadBadge: true,
};

describe('托盘设置解析与持久化', () => {
  it('缺省返回默认值', () => {
    expect(parseTraySettings(null)).toEqual(DEFAULT_TRAY_SETTINGS);
  });

  it('坏 JSON 与非对象回退默认值', () => {
    expect(parseTraySettings('{oops')).toEqual(DEFAULT_TRAY_SETTINGS);
    expect(parseTraySettings('[1,2]')).toEqual(DEFAULT_TRAY_SETTINGS);
    expect(parseTraySettings('7')).toEqual(DEFAULT_TRAY_SETTINGS);
  });

  it('部分字段合并', () => {
    const parsed = parseTraySettings(JSON.stringify({ closeToTray: false }));
    expect(parsed.closeToTray).toBe(false);
    expect(parsed.enabled).toBe(true);
    expect(parsed.minimizeToTray).toBe(true);
    expect(parsed.showUnreadBadge).toBe(true);
  });

  it('非布尔值回退默认', () => {
    const parsed = parseTraySettings(JSON.stringify({ enabled: 'true', showUnreadBadge: 1 }));
    expect(parsed.enabled).toBe(true);
    expect(parsed.showUnreadBadge).toBe(true);
  });

  it('写入后可读回，同键覆盖', () => {
    writeTraySettings(testDb.db, { ...on, closeToTray: false });
    expect(readTraySettings(testDb.db).closeToTray).toBe(false);

    writeTraySettings(testDb.db, { ...on });
    const rows = testDb.db
      .prepare('SELECT COUNT(*) AS c FROM app_settings WHERE key = ?')
      .get('tray') as { c: number };
    expect(rows.c).toBe(1);
    expect(readTraySettings(testDb.db)).toEqual(on);
  });

  it('未写入时读回默认值', () => {
    expect(readTraySettings(testDb.db)).toEqual(DEFAULT_TRAY_SETTINGS);
  });
});

describe('关闭/最小化到托盘决策', () => {
  it('正常关闭时隐藏到托盘', () => {
    expect(shouldHideOnClose(on, false)).toBe(true);
  });

  it('正在退出时必须放行（否则应用退不出去）', () => {
    expect(shouldHideOnClose(on, true)).toBe(false);
  });

  it('托盘整体停用时关闭即退出（否则用户无法退出）', () => {
    expect(shouldHideOnClose({ ...on, enabled: false, closeToTray: true }, false)).toBe(false);
  });

  it('关闭到托盘开关关闭时正常退出', () => {
    expect(shouldHideOnClose({ ...on, closeToTray: false }, false)).toBe(false);
  });

  it('最小化到托盘遵循各自开关与总开关', () => {
    expect(shouldHideOnMinimize(on)).toBe(true);
    expect(shouldHideOnMinimize({ ...on, minimizeToTray: false })).toBe(false);
    expect(shouldHideOnMinimize({ ...on, enabled: false, minimizeToTray: true })).toBe(false);
  });
});

describe('未读徽章图标', () => {
  it('0 用基础图标', () => {
    expect(badgeIconName(0)).toBe('tray-icon.png');
    expect(badgeIconName(-3)).toBe('tray-icon.png');
  });

  it('1-9 用对应数字徽章', () => {
    expect(badgeIconName(1)).toBe('tray-badge-1.png');
    expect(badgeIconName(5)).toBe('tray-badge-5.png');
    expect(badgeIconName(9)).toBe('tray-badge-9.png');
  });

  it('超过 9 收敛为 9+', () => {
    expect(badgeIconName(10)).toBe('tray-badge-9p.png');
    expect(badgeIconName(432)).toBe('tray-badge-9p.png');
  });

  it('关闭徽章开关后永远用基础图标', () => {
    expect(trayIconName({ ...on, showUnreadBadge: false }, 7)).toBe('tray-icon.png');
    expect(trayIconName(on, 7)).toBe('tray-badge-7.png');
  });
});

describe('托盘 tooltip 文案', () => {
  it('无未读只显示产品名', () => {
    expect(trayTooltip(0)).toBe('MailForge');
    expect(trayTooltip(-5)).toBe('MailForge');
  });

  it('有未读时附带精确封数（与右键菜单同口径）', () => {
    expect(trayTooltip(1)).toBe('MailForge · 1 封未读');
    expect(trayTooltip(42)).toBe('MailForge · 42 封未读');
    expect(trayTooltip(1523)).toBe('MailForge · 1523 封未读');
  });

  it('脏数据归零而非抛异常', () => {
    expect(trayTooltip(Number.NaN)).toBe('MailForge');
    expect(trayTooltip(Number.POSITIVE_INFINITY)).toBe('MailForge');
    expect(trayTooltip(3.7)).toBe('MailForge · 3 封未读');
  });
});

describe('未读数清洗', () => {
  it('负值与非有限值归零、取整', () => {
    expect(normalizeUnread(0)).toBe(0);
    expect(normalizeUnread(-1)).toBe(0);
    expect(normalizeUnread(Number.NaN)).toBe(0);
    expect(normalizeUnread(Number.POSITIVE_INFINITY)).toBe(0);
    expect(normalizeUnread(9.9)).toBe(9);
    expect(normalizeUnread(12)).toBe(12);
  });
});
