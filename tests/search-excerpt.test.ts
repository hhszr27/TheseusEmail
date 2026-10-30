import { describe, expect, it } from 'vitest';
import { buildExcerpt } from '../src/shared/search-excerpt';

describe('buildExcerpt — 搜索结果围绕命中的正文摘录', () => {
  it('命中在中间：前后截断并加省略号，且一定包含命中词', () => {
    const text = `${'x'.repeat(100)}季度报告${'y'.repeat(200)}`;
    const excerpt = buildExcerpt(text, '季度报告', { before: 10, after: 10 });
    expect(excerpt).toContain('季度报告');
    expect(excerpt?.startsWith('…')).toBe(true);
    expect(excerpt?.endsWith('…')).toBe(true);
  });

  it('命中在开头/结尾时不加多余省略号', () => {
    expect(buildExcerpt('季度报告', '季度')).toBe('季度报告');
    expect(buildExcerpt('季度报告', '报告')).toBe('季度报告');
  });

  it('大小写不敏感（英文）', () => {
    expect(buildExcerpt('Hello WORLD', 'world')).toBe('Hello WORLD');
  });

  it('换行与连续空白压成单空格（列表摘要只能占一行）', () => {
    const text = '第一行\n\n第二行 命中 第三行\t\t结束';
    expect(buildExcerpt(text, '命中', { before: 100, after: 100 })).toBe(
      '第一行 第二行 命中 第三行 结束',
    );
  });

  it('无命中 / 空文本 / 空词安全返回 null（调用方保留原摘要）', () => {
    expect(buildExcerpt('abc', 'z')).toBeNull();
    expect(buildExcerpt('', 'a')).toBeNull();
    expect(buildExcerpt('abc', '')).toBeNull();
    expect(buildExcerpt(null, 'a')).toBeNull();
    expect(buildExcerpt('abc', null)).toBeNull();
  });
});
