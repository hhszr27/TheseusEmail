import { describe, expect, it } from 'vitest';
import {
  findMatchRanges,
  parseHighlightTerms,
  splitByMatches,
} from '../src/renderer/lib/search-highlight';

describe('parseHighlightTerms — 查询串 → 命中词', () => {
  it('空查询不产生命中词', () => {
    expect(parseHighlightTerms('')).toEqual([]);
    expect(parseHighlightTerms('   ')).toEqual([]);
    expect(parseHighlightTerms(null)).toEqual([]);
    expect(parseHighlightTerms(undefined)).toEqual([]);
  });

  it('普通查询按空格分词（中文整串/多词都支持）', () => {
    expect(parseHighlightTerms('季度报告')).toEqual(['季度报告']);
    expect(parseHighlightTerms('季度 报告')).toEqual(['季度', '报告']);
  });

  it('from: / subject: 的值参与高亮，过滤类前缀不参与', () => {
    expect(parseHighlightTerms('from:张三 报告')).toEqual(['张三', '报告']);
    expect(parseHighlightTerms('subject:发票 报销')).toEqual(['发票', '报销']);
    expect(parseHighlightTerms('has:attachment after:2026-01-01 in:INBOX 报告')).toEqual(['报告']);
  });

  it('带引号的短语作为一个词（可含空格）', () => {
    expect(parseHighlightTerms('subject:"Q3 review"')).toEqual(['Q3 review']);
    expect(parseHighlightTerms('"季度 报告"')).toEqual(['季度 报告']);
  });

  it('去重不区分大小写', () => {
    expect(parseHighlightTerms('Foo foo FOO')).toEqual(['Foo']);
  });

  it('词数有上限，避免超长查询拖慢渲染', () => {
    const query = Array.from({ length: 40 }, (_, index) => `w${index}`).join(' ');
    expect(parseHighlightTerms(query).length).toBeLessThanOrEqual(12);
  });
});

describe('findMatchRanges — 命中区间', () => {
  it('英文大小写不敏感', () => {
    expect(findMatchRanges('Hello WORLD', ['world'])).toEqual([{ start: 6, end: 11 }]);
  });

  it('中文多次命中按位置排序', () => {
    expect(findMatchRanges('季度报告和季度总结', ['季度'])).toEqual([
      { start: 0, end: 2 },
      { start: 5, end: 7 },
    ]);
  });

  it('重叠命中合并成一段，避免把文字切碎', () => {
    expect(findMatchRanges('abcd', ['abc', 'bcd'])).toEqual([{ start: 0, end: 4 }]);
  });

  it('正则元字符按字面匹配（不当成通配符）', () => {
    expect(findMatchRanges('a.b axb', ['a.b'])).toEqual([{ start: 0, end: 3 }]);
  });

  it('空词 / 无命中 / 超长词都安全返回空数组', () => {
    expect(findMatchRanges('abc', [''])).toEqual([]);
    expect(findMatchRanges('abc', ['z'])).toEqual([]);
    expect(findMatchRanges('abc', ['abcdef'])).toEqual([]);
    expect(findMatchRanges('', ['a'])).toEqual([]);
  });

  it('limit 生效，防止长正文产生过多命中', () => {
    expect(findMatchRanges('a a a a', ['a'], 2)).toHaveLength(2);
    expect(findMatchRanges('a a a a', ['a'], 1)).toHaveLength(1);
  });
});

describe('splitByMatches — 文本片段', () => {
  it('拼接后必须与原文完全一致', () => {
    const text = '季度报告：Q3 Review 已完成';
    const segments = splitByMatches(text, ['季度', 'q3']);
    expect(segments.map((segment) => segment.text).join('')).toBe(text);
  });

  it('命中片段 hit=true，其余 false', () => {
    const segments = splitByMatches('Hello WORLD', ['world']);
    expect(segments).toEqual([
      { text: 'Hello ', hit: false },
      { text: 'WORLD', hit: true },
    ]);
  });

  it('无命中词时原样返回一段', () => {
    expect(splitByMatches('abc', [])).toEqual([{ text: 'abc', hit: false }]);
    expect(splitByMatches('abc', ['z'])).toEqual([{ text: 'abc', hit: false }]);
  });

  it('空文本返回空数组', () => {
    expect(splitByMatches('', ['a'])).toEqual([]);
  });
});
