import { describe, expect, it } from 'vitest';
import {
  AUTO_FULL_SCREEN_KEY,
  DEFAULT_AUTO_FULL_SCREEN,
  DEFAULT_MARK_READ_DELAY,
  MARK_READ_DELAY_KEY,
  MAX_MARK_READ_DELAY,
  normalizeAutoFullScreen,
  normalizeMarkReadDelay,
} from '../src/shared/reading-settings';

/**
 * 阅读设置的归一化规则。
 *
 * 这些函数同时被主进程（读 app_settings 决定阅读窗口是否全屏）和渲染进程
 * （设置页渲染、打开邮件时决定延迟）使用，所以「空值/脏值算多少」必须锁死：
 * 两边对同一个字符串理解不一致，会出现「设置页显示 60 秒、实际却立即标已读」。
 */
describe('reading settings keys', () => {
  it('键名是主/渲染进程共用的契约，不能随手改', () => {
    // 主进程 ipc 里直接按这个 key 查库；改了这里却没改主进程，设置会静默失效
    expect(MARK_READ_DELAY_KEY).toBe('reading.markReadDelay');
    expect(AUTO_FULL_SCREEN_KEY).toBe('reading.autoFullScreen');
  });
});

describe('normalizeMarkReadDelay', () => {
  it('缺失/空串按默认值（0 = 立即标已读）', () => {
    expect(normalizeMarkReadDelay(null)).toBe(DEFAULT_MARK_READ_DELAY);
    expect(normalizeMarkReadDelay(undefined)).toBe(DEFAULT_MARK_READ_DELAY);
    expect(normalizeMarkReadDelay('')).toBe(DEFAULT_MARK_READ_DELAY);
    expect(normalizeMarkReadDelay('   ')).toBe(DEFAULT_MARK_READ_DELAY);
    expect(DEFAULT_MARK_READ_DELAY).toBe(0);
  });

  it('合法数字原样保留，并容忍前后空格', () => {
    expect(normalizeMarkReadDelay('0')).toBe(0);
    expect(normalizeMarkReadDelay('60')).toBe(60);
    expect(normalizeMarkReadDelay(' 45 ')).toBe(45);
  });

  it('小数四舍五入成整数秒', () => {
    expect(normalizeMarkReadDelay('12.6')).toBe(13);
    expect(normalizeMarkReadDelay('12.4')).toBe(12);
  });

  it('负数/非数字/无穷大回落到默认值，而不是把定时器搞成负延迟', () => {
    expect(normalizeMarkReadDelay('-5')).toBe(DEFAULT_MARK_READ_DELAY);
    expect(normalizeMarkReadDelay('abc')).toBe(DEFAULT_MARK_READ_DELAY);
    expect(normalizeMarkReadDelay('Infinity')).toBe(DEFAULT_MARK_READ_DELAY);
    expect(normalizeMarkReadDelay('NaN')).toBe(DEFAULT_MARK_READ_DELAY);
  });

  it('超过上限按上限截断，避免误填巨大数字导致长期不标已读', () => {
    expect(normalizeMarkReadDelay('9999')).toBe(MAX_MARK_READ_DELAY);
    expect(normalizeMarkReadDelay(String(MAX_MARK_READ_DELAY))).toBe(MAX_MARK_READ_DELAY);
  });
});

describe('normalizeAutoFullScreen', () => {
  it('没设置过时默认开启', () => {
    expect(DEFAULT_AUTO_FULL_SCREEN).toBe(true);
    expect(normalizeAutoFullScreen(null)).toBe(true);
    expect(normalizeAutoFullScreen(undefined)).toBe(true);
    expect(normalizeAutoFullScreen('')).toBe(true);
  });

  it('只有显式写入 false 才关闭', () => {
    expect(normalizeAutoFullScreen('false')).toBe(false);
    expect(normalizeAutoFullScreen('true')).toBe(true);
    // 脏值一律按开启处理（与「默认开启」策略一致）
    expect(normalizeAutoFullScreen('0')).toBe(true);
    expect(normalizeAutoFullScreen('FALSE')).toBe(true);
  });
});
