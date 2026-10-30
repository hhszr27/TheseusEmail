import { describe, expect, it } from 'vitest';
import { buildDraftMessage } from '../src/main/mail/draft-message';

/**
 * 手工拼装的 RFC822 草稿消息（用于 IMAP APPEND 到服务器 Drafts 文件夹）。
 * 仅校验结构正确、可被邮件服务器解析即可，不依赖 nodemailer。
 */

describe('buildDraftMessage (RFC822 草稿)', () => {
  it('纯文本草稿只生成 text/plain', () => {
    const raw = buildDraftMessage({
      from: 'me@example.com',
      to: ['a@example.com'],
      subject: 'hi',
      text: 'hello',
    });
    expect(raw).toContain('Content-Type: text/plain; charset=utf-8');
    expect(raw).not.toContain('multipart/alternative');
    expect(raw).toContain('hello');
  });

  it('含 html 时生成 multipart/alternative（text + html 两部分）', () => {
    const raw = buildDraftMessage({
      from: 'me@example.com',
      to: ['a@example.com'],
      subject: 'hi',
      text: 'hello',
      html: '<p>hello</p>',
    });
    expect(raw).toContain('Content-Type: multipart/alternative; boundary=');
    expect(raw).toContain('Content-Type: text/plain; charset=utf-8');
    expect(raw).toContain('Content-Type: text/html; charset=utf-8');
    expect(raw).toContain('--');
    expect(raw).toContain('<p>hello</p>');
  });

  it('主题以 UTF-8 base64 编码，可正确解码还原', () => {
    const subject = '会议邀请：周五';
    const raw = buildDraftMessage({
      from: 'me@example.com',
      to: ['a@example.com'],
      subject,
      text: 'x',
    });
    const match = raw.match(/Subject: =\?UTF-8\?B\?([^?]+)\?=/);
    expect(match).not.toBeNull();
    const encoded = match![1] ?? '';
    const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
    expect(decoded).toBe(subject);
  });

  it('From / To / Cc 头按预期生成', () => {
    const raw = buildDraftMessage({
      from: 'me@example.com',
      to: ['a@example.com', 'b@example.com'],
      cc: ['c@example.com'],
      subject: 's',
      text: 't',
    });
    expect(raw).toContain('From: me@example.com');
    expect(raw).toContain('To: a@example.com, b@example.com');
    expect(raw).toContain('Cc: c@example.com');
  });

  it('正文换行统一为 CRLF（符合 RFC822 行尾）', () => {
    const raw = buildDraftMessage({
      from: 'me@example.com',
      to: ['a@example.com'],
      subject: 's',
      text: 'line1\nline2\r\nline3',
    });
    expect(raw).toContain('line1\r\nline2\r\nline3');
    // 不存在单独的 LF（非 \r\n 形式）
    expect(raw).not.toMatch(/[^\r]\n/);
  });

  it('空 html 回落为纯文本', () => {
    const raw = buildDraftMessage({
      from: 'me@example.com',
      to: ['a@example.com'],
      subject: 's',
      text: 't',
      html: '   ',
    });
    expect(raw).not.toContain('multipart/alternative');
  });
});
