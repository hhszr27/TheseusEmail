import type { ScheduledSendInfo } from '../../shared/ipc';

/**
 * 发件箱（Outlook 式本地出站队列）的展示逻辑。
 *
 * 「发件箱」不是 IMAP 文件夹，而是本机 `scheduled_sends` 的视图：
 * 定时邮件在到点前停留在这里，点「发送」后也会立刻入队并出现在这里
 * （发完保留一条「已发送」记录，方便确认是否真的发出去了）。
 */
export type OutboxKind = 'scheduled' | 'queued' | 'sending' | 'sent' | 'failed' | 'cancelled';

export const OUTBOX_LABELS: Record<OutboxKind, string> = {
  scheduled: '定时',
  queued: '排队中',
  sending: '发送中',
  sent: '已发送',
  failed: '发送失败',
  cancelled: '已取消',
};

/** 定时与排队之间留 1s 余量，避免「定时发送」刚入队就被显示成「排队中」。 */
export function outboxKind(item: ScheduledSendInfo, now = Date.now()): OutboxKind {
  if (item.status === 'sent') return 'sent';
  if (item.status === 'failed') return 'failed';
  if (item.status === 'sending') return 'sending';
  if (item.status === 'cancelled') return 'cancelled';
  return item.sendAt > now + 1000 ? 'scheduled' : 'queued';
}

/** 已取消的记录不展示；其余按「待发优先、历史在后」排序。 */
export function visibleOutbox(items: ScheduledSendInfo[]): ScheduledSendInfo[] {
  const active = items.filter(
    (item) => item.status === 'pending' || item.status === 'sending',
  );
  const history = items.filter(
    (item) => item.status === 'sent' || item.status === 'failed',
  );
  active.sort((a, b) => a.sendAt - b.sendAt);
  history.sort((a, b) => b.sendAt - a.sendAt);
  return [...active, ...history];
}

/** 侧栏角标：只统计真正还在队列里的（失败项留在列表里但不制造永久红点）。 */
export function outboxBadgeCount(items: ScheduledSendInfo[]): number {
  return items.filter((item) => item.status === 'pending' || item.status === 'sending').length;
}

/** 当前队列里最快要发的那封（用于「下一封 14:30 发送」这类提示）。 */
export function nextOutboxSendAt(items: ScheduledSendInfo[], now = Date.now()): number | null {
  const upcoming = items
    .filter((item) => item.status === 'pending' && item.sendAt > now)
    .map((item) => item.sendAt);
  return upcoming.length > 0 ? Math.min(...upcoming) : null;
}
