import { describe, expect, it } from 'vitest';
import { buildComposeRequest, htmlToPlainText, stripSubjectPrefix } from '../src/renderer/lib/compose';
import type { QuoteSource } from '../src/renderer/lib/compose';

/**
 * 回复 / 转发草稿构造：
 *  - 收件人规则（回复只给发件人、全部回复合并去重并剔除自己、转发为空）
 *  - 主题前缀去重
 *  - 引用正文与邮件头
 */

function source(overrides: Partial<QuoteSource> = {}): QuoteSource {
  return {
    from: [{ name: '张总', address: 'boss@example.com' }],
    to: [{ name: '我', address: 'me@example.com' }, { address: 'team@example.com' }],
    subject: '项目进度',
    date: '2026-10-20T11:51:13.000Z',
    text: '第一行\n第二行',
    ...overrides,
  };
}

describe('收件人规则', () => {
  it('回复只发给原发件人', () => {
    const request = buildComposeRequest('reply', source(), { selfAddress: 'me@example.com' });
    expect(request.to).toEqual(['boss@example.com']);
    expect(request.cc).toEqual([]);
  });

  it('全部回复合并发件人与原收件人，剔除自己并去重', () => {
    const request = buildComposeRequest(
      'reply-all',
      source({
        from: [{ address: 'boss@example.com' }, { address: 'ME@example.com' }],
        to: [{ address: 'me@example.com' }, { address: 'team@example.com' }, { address: 'boss@example.com' }],
      }),
      { selfAddress: 'me@example.com' },
    );
    expect(request.to).toEqual(['boss@example.com', 'team@example.com']);
  });

  it('转发不预填收件人', () => {
    const request = buildComposeRequest('forward', source(), { selfAddress: 'me@example.com' });
    expect(request.to).toEqual([]);
  });
});

describe('主题前缀', () => {
  it('回复加 Re: 且不重复叠加', () => {
    const once = buildComposeRequest('reply', source({ subject: '项目进度' }));
    expect(once.subject).toBe('Re: 项目进度');

    const twice = buildComposeRequest('reply', source({ subject: 'Re: Re: 项目进度' }));
    expect(twice.subject).toBe('Re: 项目进度');

    const chineseColon = buildComposeRequest('reply', source({ subject: 'RE：项目进度' }));
    expect(chineseColon.subject).toBe('Re: 项目进度');
  });

  it('转发加 Fwd: 且不重复叠加', () => {
    const request = buildComposeRequest('forward', source({ subject: 'Fwd: 项目进度' }));
    expect(request.subject).toBe('Fwd: 项目进度');
  });

  it('空主题有兜底', () => {
    const request = buildComposeRequest('reply', source({ subject: '   ' }));
    expect(request.subject).toBe('Re: (无主题)');
  });

  it('stripSubjectPrefix 只剥离开头的前缀', () => {
    expect(stripSubjectPrefix('报告 Re: 讨论', /^re\s*[:：]\s*/i)).toBe('报告 Re: 讨论');
    expect(stripSubjectPrefix('Re: Re: 讨论', /^re\s*[:：]\s*/i)).toBe('讨论');
  });
});

describe('引用正文', () => {
  it('回复逐行加 > 前缀，并带原邮件头', () => {
    const request = buildComposeRequest('reply', source());
    expect(request.body).toContain('----------- 原邮件 -----------');
    expect(request.body).toContain('发件人：张总 <boss@example.com>');
    expect(request.body).toContain('主题：项目进度');
    expect(request.body).toContain('> 第一行');
    expect(request.body).toContain('> 第二行');
  });

  it('转发不加 > 前缀', () => {
    const request = buildComposeRequest('forward', source());
    expect(request.body).toContain('第一行');
    expect(request.body).not.toContain('> 第一行');
  });

  it('纯文本缺失时从 HTML 提取，且剥离脚本', () => {
    const request = buildComposeRequest('reply', source({ text: null }), {
      html: '<p>Hello&nbsp;<b>world</b></p><script>alert(1)</script><p>Second</p>',
    });
    expect(request.body).toContain('> Hello world');
    expect(request.body).toContain('> Second');
    expect(request.body).not.toContain('alert(1)');
  });

  it('无正文时仍保留邮件头', () => {
    const request = buildComposeRequest('reply', source({ text: null, html: null }));
    expect(request.body).toContain('----------- 原邮件 -----------');
  });

  it('htmlToPlainText 解码常见实体并折叠空行', () => {
    // 连续空行折叠成一段空行
    expect(htmlToPlainText('<div>a &amp; b</div><div></div><div></div><div>c</div>')).toBe(
      'a & b\n\nc',
    );
    expect(htmlToPlainText(null)).toBe('');
  });
});

describe('请求元数据', () => {
  it('带上 kind 与 accountId，供写信弹层显示标题与默认发件账户', () => {
    const request = buildComposeRequest('reply-all', source(), { accountId: 'acc-9' });
    expect(request.kind).toBe('reply-all');
    expect(request.accountId).toBe('acc-9');
    expect(request.raw).toBe('');
  });
});
