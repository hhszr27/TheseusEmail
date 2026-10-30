import { randomBytes } from 'node:crypto';

/**
 * 手工拼装一封 RFC822 草稿消息（用于 IMAP APPEND 到服务器 Drafts 文件夹）。
 * 不依赖 nodemailer，避免为只读草稿构造引入额外复杂度。
 */

export interface DraftMessageOptions {
  from: string;
  to: string[];
  cc?: string[];
  /** 草稿也要保留密送，重新打开时才会带回。 */
  bcc?: string[];
  subject: string;
  /** 富文本正文；存在且非空时生成 multipart/alternative。 */
  html?: string;
  /** 纯文本正文（必填，作为 multipart 的 fallback）。 */
  text: string;
  date?: Date;
}

/** 最小 CRLF 归一：先统一成 \n，再换成 RFC822 要求的 \r\n，避免重复 \r。 */
function normalizeCrlf(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
}

function stripTrailingCrlf(text: string): string {
  return text.replace(/\r\n$/, '');
}

export function buildDraftMessage(opts: DraftMessageOptions): string {
  const boundary = randomBytes(16).toString('hex');
  const subject = `=?UTF-8?B?${Buffer.from(opts.subject ?? '', 'utf-8').toString('base64')}?=`;
  const to = (opts.to ?? []).join(', ');
  const cc = opts.cc && opts.cc.length > 0 ? opts.cc.join(', ') : '';
  const bcc = opts.bcc && opts.bcc.length > 0 ? opts.bcc.join(', ') : '';
  const date = (opts.date ?? new Date()).toUTCString();

  const lines: string[] = [`From: ${opts.from}`, `To: ${to}`];
  if (cc) lines.push(`Cc: ${cc}`);
  if (bcc) lines.push(`Bcc: ${bcc}`);
  lines.push(`Subject: ${subject}`);
  lines.push(`Date: ${date}`);
  lines.push('MIME-Version: 1.0');

  const textBody = stripTrailingCrlf(normalizeCrlf(opts.text ?? ''));

  if (opts.html && opts.html.trim().length > 0) {
    const htmlBody = stripTrailingCrlf(normalizeCrlf(opts.html));
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    lines.push('');
    lines.push(`--${boundary}`);
    lines.push('Content-Type: text/plain; charset=utf-8');
    lines.push('Content-Transfer-Encoding: 8bit');
    lines.push('');
    lines.push(textBody);
    lines.push(`--${boundary}`);
    lines.push('Content-Type: text/html; charset=utf-8');
    lines.push('Content-Transfer-Encoding: 8bit');
    lines.push('');
    lines.push(htmlBody);
    lines.push(`--${boundary}--`);
  } else {
    lines.push('Content-Type: text/plain; charset=utf-8');
    lines.push('Content-Transfer-Encoding: 8bit');
    lines.push('');
    lines.push(textBody);
  }

  return lines.join('\r\n');
}
