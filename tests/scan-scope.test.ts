import { describe, expect, it } from 'vitest';
import { isScannableRisk } from '../src/main/attachments/scan';

/**
 * 自动扫描范围（方案 3）：只扫危险/可疑类型。
 * 普通文档扫出来几乎必然是 safe，扫了只是白耗配额、拖慢队列。
 */
describe('自动扫描范围', () => {
  it('危险与可疑类型会被扫描', () => {
    expect(isScannableRisk('danger')).toBe(true);
    expect(isScannableRisk('suspicious')).toBe(true);
  });

  it('普通文件不进入自动扫描', () => {
    expect(isScannableRisk('safe')).toBe(false);
  });
});
