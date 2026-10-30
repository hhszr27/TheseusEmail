import { describe, expect, it } from 'vitest';
import {
  countdownFor,
  formatCountdown,
  formatSendTime,
  parseSendTimeInput,
} from '../src/renderer/lib/compose';

/**
 * 定时发送的时间输入解析与展示：
 *  - 留空 = 立即发送
 *  - 过去时间必须被拒绝，避免入队后立刻发出却显示"已定时"
 */

const NOW = Date.UTC(2026, 9, 21, 9, 0, 0);

describe('parseSendTimeInput', () => {
  it('留空表示立即发送', () => {
    expect(parseSendTimeInput('', NOW)).toEqual({ at: null });
    expect(parseSendTimeInput('   ', NOW)).toEqual({ at: null });
  });

  it('未来的时间解析为绝对毫秒', () => {
    const result = parseSendTimeInput('2026-10-21T20:30', NOW);
    // 本地时区解析，只断言是未来且能往返格式化
    expect(result.error).toBeUndefined();
    expect(result.at).toBeTypeOf('number');
    expect(result.at as number).toBeGreaterThan(NOW);
  });

  it('已过去的时间报错，不返回时间', () => {
    const result = parseSendTimeInput('2020-01-01T08:00', NOW);
    expect(result.at).toBeNull();
    expect(result.error).toBe('发送时间必须晚于当前时间');
  });

  it('格式非法时报错', () => {
    const result = parseSendTimeInput('不是时间', NOW);
    expect(result.at).toBeNull();
    expect(result.error).toBe('发送时间格式不正确');
  });
});

describe('countdownFor（倒计时归零必须切换状态）', () => {
  const sendAt = NOW + 10_000;

  it('未到点返回剩余毫秒且 due=false', () => {
    expect(countdownFor(sendAt, NOW)).toEqual({ remaining: 10_000, due: false });
  });

  it('刚好到点与已过点都判定 due=true，剩余不为负', () => {
    expect(countdownFor(sendAt, sendAt)).toEqual({ remaining: 0, due: true });
    expect(countdownFor(sendAt, sendAt + 5_000)).toEqual({ remaining: 0, due: true });
  });
});

describe('时间展示', () => {
  it('倒计时按分:秒，超过一小时带小时', () => {
    expect(formatCountdown(0)).toBe('00:00');
    expect(formatCountdown(59_000)).toBe('00:59');
    expect(formatCountdown(61_000)).toBe('01:01');
    expect(formatCountdown(3_661_000)).toBe('1:01:01');
    expect(formatCountdown(-5_000)).toBe('00:00');
  });

  it('发送时间格式化到分钟', () => {
    const at = new Date(2026, 9, 21, 20, 30, 45).getTime();
    expect(formatSendTime(at)).toBe('2026-10-21 20:30');
  });
});
