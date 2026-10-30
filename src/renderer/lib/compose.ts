import type { ComposeDraft, MailtoRequest } from '../../shared/ipc';
import type { EmailAddress } from '../../shared/types';

/**
 * 回复 / 转发草稿构造（纯函数，便于单测）。
 * 规则：
 *  - 回复只发给原发件人；全部回复额外带上原收件人，剔除自己的地址并去重；
 *  - 主题前缀去重（Re: / Fwd: 只保留一层）；
 *  - 正文附原邮件头 + 引用正文（回复逐行 `> `，转发不缩进）。
 */

export type ComposeKind = 'reply' | 'reply-all' | 'forward';

export interface QuoteSource {
  from: EmailAddress[];
  to: EmailAddress[];
  subject: string;
  date: string;
  text?: string | null;
  html?: string | null;
}

export interface ComposeRequestOptions {
  /** 当前账户地址，用于在全部回复中剔除自己。 */
  selfAddress?: string;
  accountId?: string;
  /** 阅读区已取到的纯文本正文，优先使用。 */
  text?: string | null;
  /** 纯文本缺失时退回 HTML 提取。 */
  html?: string | null;
  /**
   * 是否在正文里保留原邮件引用；默认 true。
   * 关闭后回复/转发只带主题与收件人，正文从空白开始。
   */
  includeQuote?: boolean;
}

/** 「回复/转发时保留原邮件引用」的设置键。 */
export const COMPOSE_INCLUDE_QUOTE_KEY = 'compose.includeQuote';

/** 读取「保留原邮件引用」设置；读不到或 IPC 失败时默认开启。 */
export async function readComposeIncludeQuote(): Promise<boolean> {
  try {
    const result = await window.api.getSetting(COMPOSE_INCLUDE_QUOTE_KEY);
    if (!result.ok) return true;
    return result.data !== 'false';
  } catch {
    return true;
  }
}

const REPLY_PREFIX = /^(re|aw|sv)\s*[:：]\s*/i;
const FORWARD_PREFIX = /^(fwd|fw|wg)\s*[:：]\s*/i;

/** 去掉已有的同名主题前缀，避免出现 Re: Re: Re:。 */
export function stripSubjectPrefix(subject: string, pattern: RegExp): string {
  let result = subject.trim();
  while (pattern.test(result)) result = result.replace(pattern, '');
  return result;
}

/** 极简 HTML → 纯文本：只用于引用正文，不做完整解析。 */
export function htmlToPlainText(html: string | null | undefined): string {
  if (!html) return '';
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function formatAddress(address: EmailAddress): string {
  const name = address.name?.trim();
  return name ? `${name} <${address.address}>` : address.address;
}

function uniqueAddresses(addresses: EmailAddress[], self?: string): string[] {
  const selfKey = self?.trim().toLowerCase();
  const seen = new Set<string>();
  const result: string[] = [];
  for (const address of addresses) {
    const key = address.address.trim().toLowerCase();
    if (!key.includes('@')) continue;
    if (selfKey && key === selfKey) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(address.address.trim());
  }
  return result;
}

function quoteDate(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  const date = new Date(time);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

function quoteHeader(source: QuoteSource): string {
  const lines = [
    '----------- 原邮件 -----------',
    `发件人：${source.from.map(formatAddress).join(', ')}`,
    `时间：${quoteDate(source.date)}`,
    `收件人：${source.to.map(formatAddress).join(', ')}`,
    `主题：${source.subject}`,
  ];
  return lines.join('\n');
}

/** 纯文本转 HTML 转义（供引用块使用）。 */
function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * 构造回复/转发用的 HTML 引用块。
 *
 * 优先直接使用原邮件的 HTML（`sourceHtml`）：这样签名图、加粗、链接、表格都原样保留，
 * 不会退化成一行行 `> ` 文本，也不会把 `cid:` 占位符（`[cid:image005.png@...]`）当正文。
 * 只有没有 HTML 时才把纯文本转义成 `<br>` 段落——
 * 纯文本是给不支持 HTML 的客户端看的回退，不该拿来构造编辑器里的引用块。
 */
function buildQuoteHtml(source: QuoteSource, quoted: string, sourceHtml?: string | null): string {
  const originalHtml = typeof sourceHtml === 'string' ? sourceHtml.trim() : '';
  const bodyHtml = originalHtml || escapeHtmlText(quoted).replace(/\r?\n/g, '<br>\n');
  if (!bodyHtml.trim()) return '';

  const headerLines = [
    `发件人：${source.from.map(formatAddress).join(', ')}`,
    `时间：${quoteDate(source.date)}`,
    `收件人：${source.to.map(formatAddress).join(', ')}`,
    `主题：${source.subject}`,
  ]
    .map((line) => `<div class="mf-quote-header">${escapeHtmlText(line)}</div>`)
    .join('');

  return `<div class="mf-quote">${headerLines}<blockquote>${bodyHtml}</blockquote></div>`;
}

export type SendTimeResult =
  | { at: null; error?: undefined }
  | { at: number; error?: undefined }
  | { at: null; error: string };

/**
 * 解析「发送时间」输入（datetime-local，本地时区）。
 * 空值表示立即发送；非法或已过去的时间返回可读错误。
 */
export function parseSendTimeInput(value: string, now: number = Date.now()): SendTimeResult {
  const trimmed = value.trim();
  if (!trimmed) return { at: null };

  const at = Date.parse(trimmed);
  if (!Number.isFinite(at)) return { at: null, error: '发送时间格式不正确' };
  if (at <= now) return { at: null, error: '发送时间必须晚于当前时间' };
  return { at };
}

/** 附件大小展示：1.2 MB / 320 KB。 */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? Math.round(value) : value.toFixed(1).replace(/\.0$/, '')} ${units[unit]}`;
}

/** 定时倒计时状态
：remaining 为毫秒；due=true 表示已到点，界面应切到「已发送」。 */
export function countdownFor(sendAt: number, now: number): { remaining: number; due: boolean } {
  const left = sendAt - now;
  return { remaining: Math.max(0, left), due: left <= 0 };
}

/** 倒计时文本：分:秒；超过 1 小时显示时:分。 */

export function formatCountdown(msLeft: number): string {
  const total = Math.max(0, Math.ceil(msLeft / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/** yyyy-MM-dd HH:mm，用于定时确认文案。 */
export function formatSendTime(at: number): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** 构造回复/转发用的写信请求；`kind` 只用于界面提示，不参与发送。 */
export function buildComposeRequest(
  kind: ComposeKind,
  source: QuoteSource,
  options: ComposeRequestOptions = {},
): MailtoRequest {
  const includeQuote = options.includeQuote !== false;
  // 优先用调用方刚取到的正文，其次用 QuoteSource 上带的正文。
  // 关闭「保留引用」时不读取正文，正文从空白开始。
  const plain = includeQuote
    ? (options.text ?? source.text ?? '').trim() ||
      htmlToPlainText(options.html ?? source.html ?? '')
    : '';

  const quoted = kind === 'forward' ? plain : plain.replace(/^/gm, '> ');

  const recipients =
    kind === 'forward'
      ? []
      : kind === 'reply'
        ? uniqueAddresses(source.from, options.selfAddress)
        : uniqueAddresses([...source.from, ...source.to], options.selfAddress);

  const baseSubject =
    kind === 'forward'
      ? stripSubjectPrefix(source.subject, FORWARD_PREFIX)
      : stripSubjectPrefix(source.subject, REPLY_PREFIX);
  const subject = `${kind === 'forward' ? 'Fwd' : 'Re'}: ${baseSubject || '(无主题)'}`;

  const body = includeQuote ? `\n\n${quoteHeader(source)}\n\n${quoted}`.trimEnd() : '';
  // 只有在确有引用内容时才生成 HTML 引用块；否则回落为空串（纯文本 body 仍带邮件头）。
  // 有 HTML 时优先用 HTML（保留格式与内嵌图），纯文本只在没有 HTML 时兜底。
  // 引用块上方留一个空段落：回复/转发时光标可以从这里开始写，与 Outlook 的回复窗口一致；
  // 否则引用块顶在最上面，用户第一眼不知道从哪下笔。
  const originalHtml = options.html ?? source.html ?? '';
  // 引用块上方留 4 行空白：光标有地方落笔，视觉上也像 Outlook 的回复窗口
  const topBlank = '<p></p>'.repeat(4);
  const html =
    includeQuote && (plain.trim().length > 0 || originalHtml.trim().length > 0)
      ? `${topBlank}${buildQuoteHtml(source, quoted, originalHtml)}`
      : '';

  return {
    to: recipients,
    cc: [],
    subject,
    body,
    html,
    raw: '',
    kind,
    ...(options.accountId ? { accountId: options.accountId } : {}),
  };
}

/**
 * 判断撰写弹层当前预填内容是否已等于该草稿。
 * 从草稿箱点「继续编辑」时会命中，此时不必再弹「发现草稿」的恢复提示。
 */
export function draftMatchesComposeRequest(
  draft: ComposeDraft,
  request: Pick<MailtoRequest, 'to' | 'cc' | 'subject' | 'body' | 'attachments' | 'html'>,
): boolean {
  return (
    draft.subject === request.subject &&
    draft.body === request.body &&
    draft.html === request.html &&
    draft.to.join(',') === request.to.join(',') &&
    draft.cc.join(',') === request.cc.join(',') &&
    draft.attachments.length === (request.attachments?.length ?? 0)
  );
}
