import { describe, expect, it } from 'vitest';
import {
  normalizeTimeZone,
  systemTimeZone,
  zonedDayKey,
  zonedMinutesOfDay,
  zonedParts,
  zonedTimeToUtc,
} from '../src/shared/timezone';

/**
 * 时区换算。核心是：**同一个时间戳，在不同时区可能属于不同的日期**。
 * 日历分列、邮件列表分组都依赖这一点；只按系统时区算会在跨时区时错一天。
 */
describe('时区换算', () => {
  it('同一时间戳在不同时区落在不同日期', () => {
    const timestamp = Date.UTC(2026, 9, 29, 16, 30); // UTC 16:30
    expect(zonedDayKey(timestamp, 'UTC')).toBe('2026-9-29');
    // 上海 +8 → 已经是次日 00:30
    expect(zonedDayKey(timestamp, 'Asia/Shanghai')).toBe('2026-9-30');
    expect(zonedParts(timestamp, 'Asia/Shanghai')).toMatchObject({
      year: 2026,
      month: 10,
      day: 30,
      hour: 0,
      minute: 30,
    });
  });

  it('当天第几分钟随时区变化', () => {
    const timestamp = Date.UTC(2026, 9, 29, 6, 0); // UTC 06:00 → 上海 14:00
    expect(zonedMinutesOfDay(timestamp, 'UTC')).toBe(6 * 60);
    expect(zonedMinutesOfDay(timestamp, 'Asia/Shanghai')).toBe(14 * 60);
  });

  it('「某时区某天某时」换算成时间戳，再读回一致', () => {
    const timestamp = zonedTimeToUtc(2026, 10, 29, 14, 30, 0, 'Asia/Shanghai');
    expect(timestamp).toBe(Date.UTC(2026, 9, 29, 6, 30));
    expect(zonedParts(timestamp, 'Asia/Shanghai')).toMatchObject({
      year: 2026,
      month: 10,
      day: 29,
      hour: 14,
      minute: 30,
    });
  });

  it('跟随系统 / 非法名称都回落到系统时区', () => {
    expect(normalizeTimeZone('system')).toBe(systemTimeZone());
    expect(normalizeTimeZone('Not/AZone')).toBe(systemTimeZone());
    expect(normalizeTimeZone('')).toBe(systemTimeZone());
    expect(normalizeTimeZone(null)).toBe(systemTimeZone());
  });

  it('合法 IANA 名称原样保留', () => {
    expect(normalizeTimeZone('Asia/Tokyo')).toBe('Asia/Tokyo');
    expect(normalizeTimeZone('UTC')).toBe('UTC');
  });
});
