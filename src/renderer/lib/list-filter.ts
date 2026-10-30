import type { ListFilter } from '../../shared/ipc';

/**
 * 列表筛选（全部 / 未读 / 已标记）在列表层的局部演化规则。
 *
 * 两个方向都需要判断：
 *  - 筛选态下某封邮件「不再符合」当前筛选 → 立即出列（total-1）；
 *  - 筛选态下某封邮件「开始符合」当前筛选 → 只能重查，因为旧列表里没有它。
 * 例外：正在阅读的那封即使不再符合筛选也先留着，否则正文还在看、列表先把人抖掉
 * （下次重载自然消失，与 Outlook 的行为一致）。
 *
 * 纯函数放这里而不是写在 store 里，是为了能用单测锁死这条规则。
 */

export interface FilteredListTransition {
  /** 当前筛选口径。 */
  filter: ListFilter;
  /** 本次操作要应用的补丁（已读/星标）。 */
  patch: { read?: boolean; starred?: boolean };
  /** 服务端回传的最新状态（防呆：写入可能被拒绝）。 */
  stillUnread: boolean;
  stillStarred: boolean;
  /** 是否为当前选中（正在阅读）的邮件。 */
  isSelected: boolean;
}

/** 操作后这封邮件是否应当立即从当前筛选列表里消失。 */
export function dropsFromFilteredList(input: FilteredListTransition): boolean {
  if (input.isSelected) return false;
  if (input.filter === 'unread') return input.patch.read === true && !input.stillUnread;
  if (input.filter === 'starred') return input.patch.starred === false && !input.stillStarred;
  return false;
}

/** 操作后这封邮件是否可能开始符合筛选口径（只能靠重查把它加进列表）。 */
export function needsFilteredReload(input: {
  filter: ListFilter;
  patch: { read?: boolean; starred?: boolean };
}): boolean {
  if (input.filter === 'unread') return input.patch.read === false;
  if (input.filter === 'starred') return input.patch.starred === true;
  return false;
}
