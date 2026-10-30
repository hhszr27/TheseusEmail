/**
 * Gmail 风格搜索语法（§18.2）。
 * 支持 from: subject: has:attachment after: before: in:
 * 纯文本部分交给 FTS5 trigram 查询。
 */

export interface ParsedSearchQuery {
  text: string;
  from?: string;
  subject?: string;
  hasAttachment?: boolean;
  after?: number;
  before?: number;
  folder?: string;
}

function parseDate(value: string): number | undefined {
  const trimmed = value.trim();
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? undefined : date.getTime();
}

function unquote(value: string): string {
  return value.replace(/^"(.*)"$/, '$1').trim();
}

export function parseSearchQuery(input: string): ParsedSearchQuery {
  const result: ParsedSearchQuery = { text: '' };
  const leftovers: string[] = [];

  const tokenPattern = /(\w+):("[^"]*"|\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(input)) !== null) {
    const key = (match[1] ?? '').toLowerCase();
    const rawValue = match[2] ?? '';
    const value = unquote(rawValue);

    switch (key) {
      case 'from':
        if (value) result.from = value;
        break;
      case 'subject':
        if (value) result.subject = value;
        break;
      case 'has':
        if (value.toLowerCase() === 'attachment') result.hasAttachment = true;
        break;
      case 'after': {
        const date = parseDate(value);
        if (date !== undefined) result.after = date;
        break;
      }
      case 'before': {
        const date = parseDate(value);
        if (date !== undefined) result.before = date;
        break;
      }
      case 'in':
        if (value) result.folder = value;
        break;
      default:
        continue;
    }
  }

  const leftoversText = input.replace(tokenPattern, ' ');
  for (const token of leftoversText.split(/\s+/)) {
    const trimmed = token.trim();
    if (trimmed) leftovers.push(trimmed);
  }

  result.text = leftovers.join(' ').trim();
  return result;
}

/** FTS5 短语查询转义：整体作为短语，内部双引号翻倍。 */
export function toFtsPhrase(text: string): string {
  return `"${text.replace(/"/g, '""')}"`;
}
