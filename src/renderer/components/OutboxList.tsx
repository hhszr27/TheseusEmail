import type { ScheduledSendInfo } from '../../shared/ipc';
import type { AccountView } from '../../shared/types';
import { accountTagFor } from '../lib/format';
import { formatSendTime } from '../lib/compose';
import { OUTBOX_LABELS, outboxKind, visibleOutbox, type OutboxKind } from '../lib/outbox';

interface OutboxListProps {
  items: ScheduledSendInfo[];
  loading: boolean;
  accounts: AccountView[];
  onCancel(id: string): void;
  onCompose(): void;
}

const STATUS_HINT: Record<OutboxKind, (item: ScheduledSendInfo) => string> = {
  scheduled: (item) => `将于 ${formatSendTime(item.sendAt)} 发送`,
  queued: () => '已进入发送队列，马上发出',
  sending: () => '正在投递…',
  sent: (item) => `已于 ${formatSendTime(item.sendAt)} 发出`,
  failed: (item) => item.lastError ?? '发送失败',
  cancelled: () => '已取消',
};

/**
 * 发件箱（Outlook 式出站队列）。
 * 定时邮件在到点前留在这里；点「发送」后也会立刻入队并留下一条「已发送」记录，
 * 让用户能确认邮件到底发没发出去（SMTP 没有 IMAP Sent 文件夹那样的服务端副本）。
 */
export function OutboxList({
  items,
  loading,
  accounts,
  onCancel,
  onCompose,
}: OutboxListProps): JSX.Element {
  const rows = visibleOutbox(items);
  const pending = rows.filter(
    (item) => item.status === 'pending' || item.status === 'sending',
  ).length;
  const tagFor = (accountId: string): { label: string; color: string } | null => {
    const account = accounts.find((item) => item.id === accountId);
    return account ? accountTagFor(account) : null;
  };

  return (
    <section className="list-pane" aria-label="发件箱">
      <header className="list-header">
        <div className="list-heading">
          <h2 className="list-title">发件箱</h2>
          <span className="list-meta">
            {pending > 0 ? `${pending} 封待发 · ` : ''}
            共 {rows.length} 条{loading ? ' · 载入中…' : ''}
          </span>
        </div>
        <div className="list-actions">
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            title="撰写邮件"
            aria-label="撰写邮件"
            onClick={onCompose}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
            </svg>
          </button>
        </div>
      </header>

      <div className="list-scroll">
        {rows.length === 0 ? (
          <div className="list-empty">
            {loading ? (
              '正在读取发送队列…'
            ) : (
              <>
                发件箱是空的。
                <br />
                点「发送」或设置定时发送后，邮件会先出现在这里。
              </>
            )}
          </div>
        ) : (
          <ul className="outbox-list">
            {rows.map((item) => {
              const kind = outboxKind(item);
              const tag = tagFor(item.accountId);
              const cancellable = item.status === 'pending';
              return (
                <li className={`outbox-item outbox-item-${kind}`} key={item.id}>
                  <div className="outbox-item-main">
                    <div className="outbox-item-line">
                      <span className={`outbox-status outbox-status-${kind}`}>
                        {OUTBOX_LABELS[kind]}
                      </span>
                      <span className="outbox-item-subject">{item.subject || '（无主题）'}</span>
                      <time className="mail-time" dateTime={new Date(item.sendAt).toISOString()}>
                        {formatSendTime(item.sendAt)}
                      </time>
                    </div>
                    <div className="outbox-item-to">
                      收件人：{item.to.length > 0 ? item.to.join(', ') : '（无收件人）'}
                    </div>
                    <div className={`outbox-item-hint${kind === 'failed' ? ' is-error' : ''}`}>
                      {STATUS_HINT[kind](item)}
                      {item.retryCount > 0 && kind !== 'failed' ? ` · 已重试 ${item.retryCount} 次` : ''}
                    </div>
                    {tag ? (
                      <span className="mail-indicators">
                        <span className="account-tag" style={{ backgroundColor: tag.color }}>
                          {tag.label}
                        </span>
                      </span>
                    ) : null}
                  </div>
                  {cancellable ? (
                    <div className="outbox-item-actions">
                      <button type="button" className="btn btn-sm" onClick={() => onCancel(item.id)}>
                        取消发送
                      </button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
