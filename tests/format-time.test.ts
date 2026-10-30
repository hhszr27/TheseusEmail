import { describe, expect, it } from 'vitest';
import { formatFullDate } from '../src/renderer/lib/format';

/**
 * 邮件时间格式化同时受「12/24 小时制」与「时区」两个设置影响。
 * 这里用固定时间戳 + 显式时区，避免依赖运行机器的时区。
 */
describe('邮件时间格式化', () => {
  const iso = new Date(Date.UTC(2026, 9, 29, 6, 30)).toISOString(); // UTC 06:30

  it('24 小时制 + 时区', () => {
    expect(formatFullDate(iso, '24', 'Asia/Shanghai')).toBe('2026-10-29 14:30');
    expect(formatFullDate(iso, '24', 'UTC')).toBe('2026-10-29 06:30');
  });

  it('12 小时制 + 时区', () => {
    expect(formatFullDate(iso, '12', 'Asia/Shanghai')).toBe('2026-10-29 2:30 PM');
    // UTC 06:30 → 6:30 AM（不是 6:30 PM）
    expect(formatFullDate(iso, '12', 'UTC')).toBe('2026-10-29 6:30 AM');
  });

  it('跨时区时日期会跟着变', () => {
    const lateUtc = new Date(Date.UTC(2026, 9, 29, 16, 30)).toISOString(); // UTC 16:30
    // 上海已经进入 30 日
    expect(formatFullDate(lateUtc, '24', 'Asia/Shanghai')).toBe('2026-10-30 00:30');
  });

  it('非法时间返回空串', () => {
    expect(formatFullDate('not-a-date')).toBe('');
  });
});
