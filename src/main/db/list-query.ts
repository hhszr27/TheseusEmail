import type { ListFilter, ListSort } from '../../shared/ipc';

/**
 * 列表筛选 / 排列方式的 SQL 映射（唯一来源）。
 *
 * 这里是列表查询里唯一允许拼 SQL 的地方，但拼接的每一段都来自固定白名单分支，
 * 绝不把外部传入的字符串插进语句（§36）。repo（单账户/统一收件箱）与
 * SearchService（全文检索结果）共用同一套映射，避免两处口径漂移。
 */

export const LIST_FILTERS = ['all', 'unread', 'starred'] as const;
export const LIST_SORTS = [
  'date',
  'from',
  'to',
  'flagged',
  'subject',
  'attachments',
  'account',
] as const;

/** IPC 边界归一化：非白名单值一律回落默认，调用方不需要再做校验。 */
export function normalizeListFilter(value: unknown): ListFilter {
  return typeof value === 'string' && (LIST_FILTERS as readonly string[]).includes(value)
    ? (value as ListFilter)
    : 'all';
}

export function normalizeListSort(value: unknown): ListSort {
  return typeof value === 'string' && (LIST_SORTS as readonly string[]).includes(value)
    ? (value as ListSort)
    : 'date';
}

function column(alias: string, name: string): string {
  return alias ? `${alias}.${name}` : name;
}

/**
 * 筛选条件（WHERE 片段，不含前导 AND）。无筛选时返回空字符串，
 * 调用方据此决定是否追加 `AND`。
 */
export function filterCondition(filter: ListFilter, alias = ''): string {
  if (filter === 'unread') return `${column(alias, 'unread')} = 1`;
  if (filter === 'starred') return `${column(alias, 'starred')} = 1`;
  return '';
}

/**
 * 排序方式（ORDER BY 之后的子句）。每种排序都以日期/uid 兜底，
 * 保证同一排序值内部顺序稳定（分页不会漏行或重复）。
 */
export function sortOrderSql(sort: ListSort, alias = ''): string {
  const tieBreak = `${column(alias, 'date')} DESC, ${column(alias, 'uid')} DESC`;
  switch (sort) {
    case 'from':
      return `${addressSortKey(alias, 'from_json')} COLLATE NOCASE ASC, ${tieBreak}`;
    case 'to':
      return `${addressSortKey(alias, 'to_json')} COLLATE NOCASE ASC, ${tieBreak}`;
    case 'flagged':
      // 「标记状态」：已标记（星标）的排在前面，同组内按日期倒序
      return `${column(alias, 'starred')} DESC, ${tieBreak}`;
    case 'subject':
      return `${column(alias, 'subject')} COLLATE NOCASE ASC, ${tieBreak}`;
    case 'attachments':
      return `${column(alias, 'has_attachments')} DESC, ${tieBreak}`;
    case 'account':
      // 账户 id 是本机 uuid，直接按 id 排会得到看似随机的分组顺序；
      // 用账户邮箱作为排序键，分组才是用户能理解的顺序（PK 子查询，代价可忽略）。
      return `COALESCE((SELECT a.email FROM accounts a WHERE a.id = ${column(alias, 'account_id')}), ${column(alias, 'account_id')}) COLLATE NOCASE ASC, ${tieBreak}`;
    default:
      return tieBreak;
  }
}

/**
 * 收件人/发件人列的排序键：与列表显示口径一致——有显示名用显示名，否则用地址。
 * json_valid 兜住脏行（CASE 会短路，非法 JSON 不会进入 json_extract 抛错）。
 */
function addressSortKey(alias: string, field: string): string {
  const raw = column(alias, field);
  return `CASE WHEN json_valid(${raw}) THEN COALESCE(json_extract(${raw}, '$[0].name'), json_extract(${raw}, '$[0].address'), '') ELSE ${raw} END`;
}
