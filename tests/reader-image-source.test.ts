import { describe, expect, it } from 'vitest';
import {
  classifyImageSource,
  decodeDataImage,
  extensionForMime,
  normalizeRemoteUrl,
  suggestImageFilename,
} from '../src/main/reader/image-source';

/** 1x1 PNG，用来验证 data URL 能真的解出字节。 */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * 正文图片的来源闸口：只认 data:image 与 http(s)。
 * 邮件 HTML 里可能残留任何协议，放进来就能被复制/写盘，所以这条边界必须锁死。
 */
describe('图片地址分类（classifyImageSource）', () => {
  it('data:image/* 才是合法内联图', () => {
    expect(classifyImageSource(`data:image/png;base64,${PNG_BASE64}`)).toBe('data');
    expect(classifyImageSource('data:image/svg+xml,<svg/>')).toBe('data');
    expect(classifyImageSource('data:text/html;base64,PGI+')).toBe('invalid');
    expect(classifyImageSource('data:,' + 'x')).toBe('invalid');
  });

  it('http(s) 与协议相对地址算远程图', () => {
    expect(classifyImageSource('https://cdn.example.com/a.png')).toBe('remote');
    expect(classifyImageSource('http://intranet/a.png')).toBe('remote');
    expect(classifyImageSource('//cdn.example.com/a.png')).toBe('remote');
  });

  it('其他协议一律拒绝', () => {
    expect(classifyImageSource('file:///C:/Windows/a.png')).toBe('invalid');
    expect(classifyImageSource('javascript:alert(1)')).toBe('invalid');
    expect(classifyImageSource('blob:https://x/1')).toBe('invalid');
    expect(classifyImageSource('cid:image001@x')).toBe('invalid');
    expect(classifyImageSource('')).toBe('invalid');
    expect(classifyImageSource(null)).toBe('invalid');
    expect(classifyImageSource(undefined)).toBe('invalid');
  });

  it('协议相对地址补成 https', () => {
    expect(normalizeRemoteUrl('//cdn.example.com/a.png')).toBe('https://cdn.example.com/a.png');
    expect(normalizeRemoteUrl(' https://a/b.png ')).toBe('https://a/b.png');
  });
});

describe('内联图解析（decodeDataImage）', () => {
  it('base64 内联图能解出真实字节', () => {
    const decoded = decodeDataImage(`data:image/png;base64,${PNG_BASE64}`);
    expect(decoded?.mime).toBe('image/png');
    expect(decoded?.buffer.length).toBeGreaterThan(60);
    // PNG 魔数
    expect([...(decoded?.buffer.subarray(0, 4) ?? [])]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('非 base64 的 URL 编码内容也能解析', () => {
    const decoded = decodeDataImage('data:image/svg+xml,%3Csvg%2F%3E');
    expect(decoded?.mime).toBe('image/svg+xml');
    expect(decoded?.buffer.toString('utf8')).toBe('<svg/>');
  });

  it('空内容 / 非图片 / 非内联地址返回 null', () => {
    expect(decodeDataImage('data:image/png;base64,')).toBeNull();
    expect(decodeDataImage('data:text/plain,abc')).toBeNull();
    expect(decodeDataImage('https://a/b.png')).toBeNull();
    expect(decodeDataImage('')).toBeNull();
  });
});

describe('扩展名与文件名（extensionForMime / suggestImageFilename）', () => {
  it('常见图片 MIME 映射', () => {
    expect(extensionForMime('image/png')).toBe('png');
    expect(extensionForMime('image/jpeg')).toBe('jpg');
    expect(extensionForMime('image/gif')).toBe('gif');
    expect(extensionForMime('image/webp')).toBe('webp');
    expect(extensionForMime('image/svg+xml')).toBe('svg');
    expect(extensionForMime('IMAGE/PNG')).toBe('png');
    expect(extensionForMime('image/unknown')).toBe('png');
  });

  it('优先用 alt 当文件名，并补正确扩展名', () => {
    expect(suggestImageFilename('https://a/b.png', '季度报表', 'image/png')).toBe('季度报表.png');
    // alt 里带着错误后缀时按 MIME 纠正
    expect(suggestImageFilename('https://a/b.png', 'photo.JPG', 'image/jpeg')).toBe('photo.jpg');
  });

  it('没有 alt 时用地址里的文件名（解码 + 去掉查询串）', () => {
    expect(
      suggestImageFilename('https://cdn.example.com/x/pic%20a.png?token=1', '', 'image/png'),
    ).toBe('pic a.png');
  });

  it('没有可用名字时回落「图片」，不会为空', () => {
    expect(suggestImageFilename('data:image/png;base64,AAAA', '', 'image/png')).toBe('图片.png');
    expect(suggestImageFilename('https://cdn.example.com/', '   ', 'image/gif')).toBe('图片.gif');
  });

  it('非法字符被清理，超长名字被截断', () => {
    expect(suggestImageFilename('https://a/b.png', 'a/b:c*?"<>|', 'image/png')).toBe('a b c.png');
    const long = 'x'.repeat(200);
    expect(suggestImageFilename('https://a/b.png', long, 'image/png')).toBe(`${'x'.repeat(80)}.png`);
  });
});
