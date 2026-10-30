import { describe, expect, it } from 'vitest';
import { sanitizeEmailHtml, toPlainSnippet } from '../src/main/security/sanitize';

describe('sanitizeEmailHtml（§10.1 验收底线）', () => {
  it('移除 script 且不保留脚本内容', () => {
    const result = sanitizeEmailHtml('<p>hello</p><script>alert(1)</script>');
    expect(result.html.toLowerCase()).not.toContain('<script');
    expect(result.html).not.toContain('alert(1)');
    expect(result.html).toContain('hello');
  });

  it('移除 on* 事件属性', () => {
    const result = sanitizeEmailHtml('<img src="https://a.example/x.png" onerror="alert(1)">');
    expect(result.html.toLowerCase()).not.toContain('onerror');
    expect(result.html.toLowerCase()).not.toContain('alert(1)');
  });

  it('移除 javascript: 链接', () => {
    const result = sanitizeEmailHtml('<a href="javascript:alert(1)">click</a>');
    expect(result.html.toLowerCase()).not.toContain('javascript:');
    expect(result.html).toContain('click');
  });

  it('移除 iframe / object / embed / form', () => {
    const result = sanitizeEmailHtml(
      '<iframe src="https://evil.example"></iframe><object data="x"></object><embed src="y"><form action="https://evil"><input value="1"></form>',
    );
    expect(result.html.toLowerCase()).not.toContain('<iframe');
    expect(result.html.toLowerCase()).not.toContain('<object');
    expect(result.html.toLowerCase()).not.toContain('<embed');
    expect(result.html.toLowerCase()).not.toContain('<form');
    expect(result.html.toLowerCase()).not.toContain('<input');
  });

  it('移除 SVG 与 MathML（USE_PROFILES html）', () => {
    const result = sanitizeEmailHtml('<svg><script>alert(1)</script><circle r="4"></circle></svg>');
    expect(result.html.toLowerCase()).not.toContain('<svg');
    expect(result.html.toLowerCase()).not.toContain('<circle');
    expect(result.html.toLowerCase()).not.toContain('alert(1)');
  });

  it('过滤内联 style 中的 url() 与 expression()', () => {
    const result = sanitizeEmailHtml(
      '<p style="background:url(https://tracker.example/p.png)">a</p><p style="width:expression(alert(1))">b</p>',
    );
    expect(result.html.toLowerCase()).not.toContain('url(');
    expect(result.html.toLowerCase()).not.toContain('expression(');
  });

  it('默认阻断远程图片并计数', () => {
    const result = sanitizeEmailHtml('<p>x</p><img src="https://tracker.example/pixel.png" alt="t">');
    expect(result.blockedRemoteImages).toBe(1);
    expect(result.remoteImages).toContain('https://tracker.example/pixel.png');
    expect(result.html).toContain('data-mf-blocked-src');
    expect(result.html).toContain('data:image/gif;base64');
    // 远程地址绝不能留在可加载的 src 上（data-mf-blocked-src 中的引用不算）
    expect(result.html).not.toMatch(/(^|\s)src="https:\/\/tracker\.example\/pixel\.png"/);
  });

  it('用户放行后保留远程图片', () => {
    const result = sanitizeEmailHtml('<img src="https://cdn.example/photo.jpg">', {
      allowRemoteImages: true,
    });
    expect(result.blockedRemoteImages).toBe(0);
    expect(result.html).toContain('https://cdn.example/photo.jpg');
  });

  it('保留光栅 data:image，阻断 svg data URI', () => {
    const raster = sanitizeEmailHtml('<img src="data:image/png;base64,iVBORw0KGgo=">');
    expect(raster.html).toContain('data:image/png');

    const svg = sanitizeEmailHtml('<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">');
    expect(svg.html).not.toContain('image/svg');
  });

  it('移除 srcset 与 background/poster', () => {
    const result = sanitizeEmailHtml(
      '<img src="https://a.example/1.png" srcset="https://a.example/2.png 2x"><td background="https://a.example/bg.png">x</td>',
    );
    expect(result.html.toLowerCase()).not.toContain('srcset');
    expect(result.html.toLowerCase()).not.toContain('background=');
  });

  it('保留合法的 https 链接并加 rel', () => {
    const result = sanitizeEmailHtml('<a href="https://example.com/path?q=1">ok</a>');
    expect(result.html).toContain('href="https://example.com/path?q=1"');
    expect(result.html).toContain('rel="noopener noreferrer"');
    expect(result.html.toLowerCase()).not.toContain('target=');
  });
});

describe('toPlainSnippet', () => {
  it('剥离标签、解实体并压缩空白', () => {
    expect(toPlainSnippet('<b>Hello</b>   &amp;  world')).toBe('Hello & world');
  });

  it('删除 script/style 内容', () => {
    expect(toPlainSnippet('<style>p{}</style><script>alert(1)</script>ok')).toBe('ok');
  });
});
