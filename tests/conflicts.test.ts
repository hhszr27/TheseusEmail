import { describe, expect, it } from 'vitest';
import { describeConflict } from '../src/main/outbox/conflicts';

describe('冲突码映射（§8.5、§8.6）', () => {
  it('folderGone 明确告知邮件保留位置，不提示重试', () => {
    const result = describeConflict('folderGone', { folder: '项目/2026' });
    expect(result.message).toContain('项目/2026');
    expect(result.message).toContain('保留');
    expect(result.message).not.toContain('重试');
    expect(result.resolution).toBe('keep');
  });

  it('messageGone 提示已删除并 dismiss', () => {
    const result = describeConflict('messageGone');
    expect(result.message).toContain('删除');
    expect(result.resolution).toBe('dismiss');
  });

  it('stateConflict 允许重试', () => {
    expect(describeConflict('stateConflict').resolution).toBe('retry');
  });

  it('未知冲突码有兜底文案', () => {
    const result = describeConflict('quota');
    expect(result.message).toContain('空间不足');
  });
});
