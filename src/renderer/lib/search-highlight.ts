/**
 * 搜索命中高亮（列表 / 阅读区共用）。
 *
 * 纯函数：查询 → 命中词 → 命中区间 → 文本片段。
 * 规则：
 * - `from:` / `subject:` 的值参与高亮；`has:` / `after:` / `before:` / `in:`
 *   是过滤条件，不当作文字高亮；未知前缀按整串处理（与用户直觉一致）。
 * - 大小写不敏感；重叠命中合并，避免同一段文字被切碎或重复标记。
 * - 命中数有上限，防止超长正文把主线程卡住。
 */

export interface TextSegment {
  text: string;
  hit: boolean;
}

export interface MatchRange {
  start: number;
  end: number;
}

const MAX_TERMS = 12;
/** 单次最多解析的命中数（正文可能很长）。 */
export const MAX_MATCHES = 800;

const FILTER_PREFIX = new Set(['has', 'after', 'before', 'in']);

function unquote(value: string): string {
  const trimmed = value.trim();
  const match = /^"(.*)"$/.exec(trimmed);
  return (match?.[1] ?? trimmed).trim();
}

/**
 * 从搜索框里提取「应该高亮」的词。
 * 例：`from:张三 季度报告 subject:"Q3 review"` → ['张三', '季度报告', 'Q3 review']
 */
export function parseHighlightTerms(query: string | null | undefined): string[] {
  const input = (query ?? '').trim();
  if (!input) return [];

  const terms: string[] = [];
  const seen = new Set<string>();

  // 可选的 key: 前缀 + 带引号的短语或普通词
  const tokenPattern = /(?:(\w+):)?("[^"]*"|\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(input)) !== null) {
    const key = (match[1] ?? '').toLowerCase();
    const raw = match[0];

    if (key && FILTER_PREFIX.has(key)) continue;

    const value =
      key === 'from' || key === 'subject' ? unquote(match[2] ?? '') : unquote(raw);
    if (!value) continue;

    const lowered = value.toLowerCase();
    if (seen.has(lowered)) continue;
    seen.add(lowered);
    terms.push(value);
    if (terms.length >= MAX_TERMS) break;
  }

  return terms;
}

/** 在文本里找出所有命中区间（已排序、已合并重叠），最多返回 `limit` 段。 */
export function findMatchRanges(
  text: string,
  terms: string[],
  limit: number = MAX_MATCHES,
): MatchRange[] {
  const source = text ?? '';
  if (!source || terms.length === 0 || limit <= 0) return [];

  const lower = source.toLowerCase();
  const found: MatchRange[] = [];

  for (const term of terms) {
    const needle = (term ?? '').toLowerCase();
    if (!needle || needle.length > lower.length) continue;

    let from = 0;
    while (from <= lower.length - needle.length) {
      const index = lower.indexOf(needle, from);
      if (index === -1) break;
      found.push({ start: index, end: index + needle.length });
      from = index + needle.length;
      if (found.length >= limit) break;
    }
    if (found.length >= limit) break;
  }

  if (found.length === 0) return [];

  found.sort((a, b) => a.start - b.start || b.end - a.end);

  const merged: MatchRange[] = [];
  for (const range of found) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      if (range.end > last.end) last.end = range.end;
    } else {
      merged.push({ start: range.start, end: range.end });
    }
  }
  return merged;
}

/** 把文本切成「命中 / 未命中」片段，拼接后与原文完全一致。 */
export function splitByMatches(text: string, terms: string[]): TextSegment[] {
  const source = text ?? '';
  const ranges = findMatchRanges(source, terms);
  if (ranges.length === 0) return source ? [{ text: source, hit: false }] : [];

  const segments: TextSegment[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) segments.push({ text: source.slice(cursor, range.start), hit: false });
    segments.push({ text: source.slice(range.start, range.end), hit: true });
    cursor = range.end;
  }
  if (cursor < source.length) segments.push({ text: source.slice(cursor), hit: false });
  return segments;
}
