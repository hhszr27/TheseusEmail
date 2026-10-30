import { describe, expect, it } from 'vitest';
import { sanitizeComposeHtml } from '../src/main/security/sanitize';

/**
 * 外发正文的权威净化（发送前的最后一道）。
 *
 * 为什么单独锁这一组：渲染进程里的 DOMPurify 只是「即时预览」，可被绕过；
 * 真正进 SMTP 的 HTML 必须由主进程重新净化，否则等于把脚本/事件属性原样寄给对方。
 */

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('sanitizeComposeHtml', () => {
  it('干掉 script 与事件属性', () => {
    const clean = sanitizeComposeHtml('<p>hi</p><script>alert(1)</script><img src="x" onerror="alert(2)">');
    expect(clean).not.toContain('<script');
    expect(clean).not.toContain('onerror');
    expect(clean).toContain('hi');
  });

  it('保留正常的排版与链接', () => {
    const clean = sanitizeComposeHtml('<p><strong>粗</strong> <a href="https://example.com">链</a></p>');
    expect(clean).toContain('<strong>粗</strong>');
    expect(clean).toContain('href="https://example.com"');
  });

  it('javascript: 链接被拦掉', () => {
    const clean = sanitizeComposeHtml('<a href="javascript:alert(1)">x</a>');
    expect(clean).not.toContain('javascript:');
  });

  it('内联 data 图片保留（截图粘贴走这条）', () => {
    const clean = sanitizeComposeHtml(`<p>看图</p><img src="${PNG}" alt="shot.png">`);
    expect(clean).toContain('data:image/png;base64');
  });

  it('远程图片保留（发件人自己的内容，不是阅读时的跟踪像素）', () => {
    const clean = sanitizeComposeHtml('<img src="https://example.com/a.png">');
    expect(clean).toContain('https://example.com/a.png');
  });

  it('iframe / form / style 一律不进正文', () => {
    const clean = sanitizeComposeHtml(
      '<iframe src="https://evil"></iframe><form action="/x"><input name="a"></form><style>*{}</style>',
    );
    expect(clean).not.toContain('<iframe');
    expect(clean).not.toContain('<form');
    expect(clean).not.toContain('<style');
  });
});

describe('编辑器产出（Tiptap 3）能过净化', () => {
  it('表格结构保留（tableWrapper/colgroup/td 不被剥掉）', () => {
    const html =
      '<div class="tableWrapper"><table><colgroup><col></colgroup><tbody><tr><th>甲</th><td>乙</td></tr></tbody></table></div>';
    const clean = sanitizeComposeHtml(html);
    expect(clean).toContain('<table');
    expect(clean).toContain('甲');
    expect(clean).toContain('乙');
  });

  it('文本对齐的 style 保留，危险 style 仍被拦', () => {
    expect(sanitizeComposeHtml('<p style="text-align: center">居中</p>')).toContain('text-align');
    expect(sanitizeComposeHtml('<p style="background:url(javascript:alert(1))">x</p>')).not.toContain('javascript:');
  });
});

describe('Outlook 风格编辑器产出（字体/颜色/高亮/缩进）能过净化', () => {
  it('字体色 / 字号 / 字体族 这三种 inline style 都保留', () => {
    const html =
      '<span style="color:#dc2626;font-size:20px;font-family:Georgia">红色大字</span>';
    const clean = sanitizeComposeHtml(html);
    expect(clean).toContain('color:#dc2626');
    expect(clean).toContain('font-size:20px');
    expect(clean).toContain('font-family:Georgia');
  });

  it('高亮（mark + 背景色）保留', () => {
    const clean = sanitizeComposeHtml('<mark style="background-color:#fde047">高亮</mark>');
    expect(clean).toContain('<mark');
    expect(clean).toContain('background-color:#fde047');
  });

  it('段落缩进（margin-left）保留', () => {
    const clean = sanitizeComposeHtml('<p style="margin-left:48px">缩进两段</p>');
    expect(clean).toContain('margin-left:48px');
  });

  it('上下标保留', () => {
    expect(sanitizeComposeHtml('H<sub>2</sub>O 与 x<sup>2</sup>')).toContain('<sub>2</sub>');
    expect(sanitizeComposeHtml('H<sub>2</sub>O 与 x<sup>2</sup>')).toContain('<sup>2</sup>');
  });

  it('危险 style 仍被拦（expression / url() 远程）', () => {
    expect(sanitizeComposeHtml('<p style="color:expression(alert(1))">x</p>')).not.toContain('expression');
    expect(sanitizeComposeHtml('<p style="background:url(javascript:alert(1))">x</p>')).not.toContain('javascript:');
  });
});
