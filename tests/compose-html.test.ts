import { describe, expect, it } from 'vitest';
import {
  buildComposeRequest,
  draftMatchesComposeRequest,
  type QuoteSource,
} from '../src/renderer/lib/compose';

/**
 * 富文本写信：回复 / 转发构造的 HTML 引用块，以及富文本下 draftMatchesComposeRequest 的比较。
 */

function source(overrides: Partial<QuoteSource> = {}): QuoteSource {
  return {
    from: [{ name: '张总', address: 'boss@example.com' }],
    to: [{ address: 'me@example.com' }],
    subject: '项目进度',
    date: '2026-10-20T11:51:13.000Z',
    text: '第一行\n第二行',
    ...overrides,
  };
}

describe('buildComposeRequest 富文本引用块', () => {
  it('回复生成包含 blockquote 的 HTML，且与纯文本 body 对应', () => {
    const request = buildComposeRequest('reply', source());
    expect(request.html).toContain('<blockquote>');
    expect(request.html).toContain('发件人：张总');
    expect(request.html).toContain('&lt;boss@example.com&gt;');
    expect(request.html).toContain('第一行');
    expect(request.html).toContain('第二行');
    // 纯文本正文仍带 > 引用前缀
    expect(request.body).toContain('> 第一行');
    expect(request.body).toContain('> 第二行');
  });

  it('回复/转发的 HTML 在引用块上方留 4 个空段落（Outlook 式，光标有地方落）', () => {
    const blanks = '<p></p>'.repeat(4);
    expect(buildComposeRequest('reply', source()).html?.startsWith(blanks)).toBe(true);
    expect(buildComposeRequest('forward', source()).html?.startsWith(blanks)).toBe(true);
  });

  it('转发同样生成 HTML 引用块（不带 > 前缀）', () => {
    const request = buildComposeRequest('forward', source());
    expect(request.html).toContain('<blockquote>');
    expect(request.html).toContain('第一行');
    expect(request.body).not.toContain('> 第一行');
  });

  it('有 HTML 正文时引用块直接用 HTML（保留格式与内嵌图），不再转成 > 文本', () => {
    const request = buildComposeRequest(
      'reply',
      source({
        text: '[cid:image005.png@01D66EA.0B53E1D0]\nFrom: Huang, He',
        html:
          '<p><strong>加粗</strong> <a href="https://example.com">链接</a></p>' +
          '<img src="data:image/png;base64,AAAA">',
      }),
    );

    expect(request.html).toContain('<strong>加粗</strong>');
    expect(request.html).toContain('<a href="https://example.com">链接</a>');
    expect(request.html).toContain('<img src="data:image/png;base64,AAAA">');
    // 不能把 HTML 转义成文本，也不能把 cid 占位符当正文
    expect(request.html).not.toContain('&lt;strong&gt;');
    expect(request.html).not.toContain('[cid:image005.png@01D66EA.0B53E1D0]');
    // 纯文本 body 仍保留 > 前缀，作为不支持 HTML 客户端的回退
    expect(request.body).toContain('> [cid:image005.png@01D66EA.0B53E1D0]');
  });

  it('关闭「保留原邮件引用」后只带主题与收件人，正文为空', () => {
    const reply = buildComposeRequest('reply', source(), { includeQuote: false });
    expect(reply.to).toEqual(['boss@example.com']);
    expect(reply.subject).toBe('Re: 项目进度');
    expect(reply.body).toBe('');
    expect(reply.html).toBe('');

    const forward = buildComposeRequest('forward', source(), { includeQuote: false });
    expect(forward.subject).toBe('Fwd: 项目进度');
    expect(forward.body).toBe('');
    expect(forward.html).toBe('');
  });

  it('无引用正文时 html 为空串（回落到纯文本 body）', () => {
    const request = buildComposeRequest('reply', source({ text: null, html: null }), {});
    expect(request.html).toBe('');
    expect(request.body).toContain('----------- 原邮件 -----------');
  });
});

describe('draftMatchesComposeRequest 富文本比较', () => {
  const base = {
    accountId: 'acc-1',
    to: ['a@example.com'],
    cc: [],

    bcc: [],
    subject: '主题',
    body: '正文',
    html: '<p>正文</p>',
    attachments: [],
    updatedAt: 1,
  };

  it('html 一致时视为同一草稿', () => {
    expect(
      draftMatchesComposeRequest(base, {
        to: ['a@example.com'],
        cc: [],
        subject: '主题',
        body: '正文',
        html: '<p>正文</p>',
      }),
    ).toBe(true);
  });

  it('html 不同则不算同一草稿', () => {
    expect(
      draftMatchesComposeRequest(base, {
        to: ['a@example.com'],
        cc: [],
        subject: '主题',
        body: '正文',
        html: '<p>别的</p>',
      }),
    ).toBe(false);
  });

  it('未带 html 的请求与无 html 的草稿匹配', () => {
    const plain = { ...base, html: undefined };
    expect(
      draftMatchesComposeRequest(plain, {
        to: ['a@example.com'],
        cc: [],
        subject: '主题',
        body: '正文',
      }),
    ).toBe(true);
  });
});
