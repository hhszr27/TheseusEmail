import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORK_HOURS,
  WORK_HOURS_KEY,
  formatClock,
  formatHourLabel,
  formatWorkHours,
  isWorkHour,
  normalizeTimeFormat,
  normalizeWorkHours,
} from '../src/shared/calendar-settings';

/**
 * 工作时间归一化。
 *
 * 关键取舍：非法组合一律回落到默认 9–18，而不是「尽力猜」。
 * 因为周视图完全按这个值灰格子 —— 猜错的表现是「整周全灰」或「整周不灰」，
 * 用户看到的只是背景颜色不对，根本不会想到是设置解析出了问题。
 */
describe('日历工作时间', () => {
  it('设置键名稳定（主进程与渲染进程共用）', () => {
    expect(WORK_HOURS_KEY).toBe('calendar.workHours');
  });

  it('解析 9-18', () => {
    expect(normalizeWorkHours('9-18')).toEqual({ start: 9, end: 18 });
  });

  it('允许两侧空格与两位数', () => {
    expect(normalizeWorkHours(' 8 - 17 ')).toEqual({ start: 8, end: 17 });
    expect(normalizeWorkHours('00-24')).toEqual({ start: 0, end: 24 });
  });

  it('缺失 / 空串 / 乱码回落默认', () => {
    for (const value of [null, undefined, '', '   ', 'abc', '9', '9~18']) {
      expect(normalizeWorkHours(value), String(value)).toEqual(DEFAULT_WORK_HOURS);
    }
  });

  it('起止颠倒或相同回落默认', () => {
    expect(normalizeWorkHours('18-9')).toEqual(DEFAULT_WORK_HOURS);
    expect(normalizeWorkHours('9-9')).toEqual(DEFAULT_WORK_HOURS);
  });

  it('越界小时被夹到 0–24；夹完不合法仍回落默认', () => {
    expect(normalizeWorkHours('25-30')).toEqual(DEFAULT_WORK_HOURS);
    expect(normalizeWorkHours('8-30')).toEqual({ start: 8, end: 24 });
  });

  it('只把开始小时算作工作时间（结束小时不含）', () => {
    const hours = { start: 9, end: 18 };
    expect(isWorkHour(8, hours)).toBe(false);
    expect(isWorkHour(9, hours)).toBe(true);
    expect(isWorkHour(17, hours)).toBe(true);
    expect(isWorkHour(18, hours)).toBe(false);
  });

  it('格式化回字符串', () => {
    expect(formatWorkHours({ start: 9, end: 18 })).toBe('9-18');
    expect(formatWorkHours(normalizeWorkHours('0-24'))).toBe('0-24');
  });
});

describe('时间显示格式（12 / 24 小时制）', () => {
  it('只有显式 "12" 才切到 12 小时制', () => {
    expect(normalizeTimeFormat('12')).toBe('12');
    for (const value of ['24', '', null, undefined, 'x', '13']) {
      expect(normalizeTimeFormat(value), String(value)).toBe('24');
    }
  });

  it('整点标签：24h 带冒号，12h 带 AM/PM', () => {
    expect(formatHourLabel(0, '24')).toBe('00:00');
    expect(formatHourLabel(14, '24')).toBe('14:00');
    expect(formatHourLabel(0, '12')).toBe('12 AM');
    expect(formatHourLabel(12, '12')).toBe('12 PM');
    expect(formatHourLabel(14, '12')).toBe('2 PM');
    expect(formatHourLabel(23, '12')).toBe('11 PM');
  });

  it('具体时刻：0 点与 12 点不能显示成 0 PM', () => {
    expect(formatClock(870, '24')).toBe('14:30');
    expect(formatClock(870, '12')).toBe('2:30 PM');
    expect(formatClock(0, '12')).toBe('12:00 AM');
    expect(formatClock(12 * 60, '12')).toBe('12:00 PM');
    expect(formatClock(23 * 60 + 59, '12')).toBe('11:59 PM');
  });
});
