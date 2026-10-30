/**
 * MBOX 拆分与生成（§32.1）。
 * 只处理文本层；单封邮件的 MIME 解析交给 mailparser。
 */

const FROM_LINE = /^From .*\r?\n/m;

/** 按 mboxo 规则拆分：以行首 "From " 作为分隔，分隔行不属于任何邮件。 */
export function splitMbox(raw: string): string[] {
  const normalized = raw.replace(/\r\n/g, '\n');
  const messages: string[] = [];
  const matches: Array<{ index: number; length: number }> = [];

  const pattern = /^From [^\n]*\n/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(normalized)) !== null) {
    matches.push({ index: match.index, length: match[0].length });
  }

  if (matches.length === 0) {
    const trimmed = normalized.trim();
    return trimmed ? [trimmed] : [];
  }

  for (let index = 0; index < matches.length; index += 1) {
    const start = matches[index]!.index + matches[index]!.length;
    const end = index + 1 < matches.length ? matches[index + 1]!.index : normalized.length;
    const body = normalized.slice(start, end).replace(/\n$/, '');
    if (body.trim()) messages.push(unescapeFromLines(body));
  }

  return messages;
}

/** mboxo：正文行首的 ">From " 还原为 "From "。 */
export function unescapeFromLines(body: string): string {
  return body.replace(/^>From /gm, 'From ');
}

/** 导出时转义正文行首的 "From "，避免被下一个客户端误判为分隔。 */
export function escapeFromLines(body: string): string {
  return body.replace(/^From /gm, '>From ');
}

export function buildMbox(messages: string[], fromLine = 'From MailForge@localhost Thu Jan  1 00:00:00 1970'): string {
  if (messages.length === 0) return '';
  return messages.map((message) => `${fromLine}\n${escapeFromLines(message)}\n`).join('\n');
}

export function isMbox(raw: string): boolean {
  return FROM_LINE.test(raw);
}
