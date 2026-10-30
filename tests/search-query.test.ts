import { describe, expect, it } from 'vitest';
import { parseSearchQuery, toFtsPhrase } from '../src/main/search/query';

describe('Gmail 风格搜索解析（§18.2）', () => {
  it('解析 from / subject / has / after / before / in', () => {
    const parsed = parseSearchQuery(
      'from:alice@example.com subject:"季度 报告" has:attachment after:2026-01-01 before:2026-02-01 in:INBOX 预算',
    );
    expect(parsed.from).toBe('alice@example.com');
    expect(parsed.subject).toBe('季度 报告');
    expect(parsed.hasAttachment).toBe(true);
    expect(parsed.folder).toBe('INBOX');
    expect(parsed.after).toBe(new Date(2026, 0, 1).getTime());
    expect(parsed.before).toBe(new Date(2026, 1, 1).getTime());
    expect(parsed.text).toBe('预算');
  });

  it('自由文本保留，未知过滤器当作普通文本', () => {
    const parsed = parseSearchQuery('hello world');
    expect(parsed.text).toBe('hello world');
    expect(parsed.from).toBeUndefined();
  });

  it('非法日期被忽略', () => {
    const parsed = parseSearchQuery('after:2026-13-45 test');
    expect(parsed.after).toBeUndefined();
    expect(parsed.text).toBe('test');
  });

  it('FTS 短语转义双引号', () => {
    expect(toFtsPhrase('a"b')).toBe('"a""b"');
    expect(toFtsPhrase('季度报告')).toBe('"季度报告"');
  });
});
