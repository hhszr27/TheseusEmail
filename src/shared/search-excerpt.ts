/**
 * 搜索结果摘要：围绕命中位置截一段正文。
 *
 * 为什么要单独做：IMAP 同步时 `emails.snippet` 只是主题的前 180 字，
 * 正文命中的邮件在列表里看不到「命中在哪」，高亮也就无从谈起。
 * 这里给出「命中前后各留一段」的纯文本摘录，命中词一定会出现在结果里。
 */

export interface ExcerptOptions {
  /** 命中前保留的字符数（默认 48）。 */
  before?: number;
  /** 命中后保留的字符数（默认 120）。 */
  after?: number;
}

/** 返回摘录；正文不含命中词时返回 null（调用方保留原摘要）。 */
export function buildExcerpt(
  text: string | null | undefined,
  needle: string | null | undefined,
  options: ExcerptOptions = {},
): string | null {
  const source = text ?? '';
  const term = (needle ?? '').trim();
  if (!source || !term) return null;

  const index = source.toLowerCase().indexOf(term.toLowerCase());
  if (index === -1) return null;

  const before = Math.max(0, options.before ?? 48);
  const after = Math.max(0, options.after ?? 120);
  const start = Math.max(0, index - before);
  const end = Math.min(source.length, index + term.length + after);

  // 换行/连续空白压成单空格：列表是一行摘要，多行会把行高撑坏
  const slice = source.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${slice}${end < source.length ? '…' : ''}`;
}
