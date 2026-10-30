import { useRef } from 'react';
import type { ComposeDraft } from '../../shared/ipc';
import type { AccountView } from '../../shared/types';
import { accountTagFor, formatListDate } from '../lib/format';
import { useTimeFormat } from '../lib/use-time-format';
import { useTimeZone } from '../lib/use-time-zone';

interface DraftListProps {
  drafts: ComposeDraft[];
  loading: boolean;
  accounts: AccountView[];
  /** 当前在右侧打开的草稿（键同 draft.key ?? accountId）。 */
  selectedKey: string | null;
  /** 单击：在右侧阅读/编辑（不弹撰写框）。 */
  onSelect(draft: ComposeDraft): void;
  /** 双击：回到写作窗口。 */
  onOpen(draft: ComposeDraft): void;
  onDelete(draft: ComposeDraft): void;
  onCompose(): void;
  /** 手动刷新（绕过服务器草稿缓存，重新拉取）。 */
  onRefresh(): void;
}

/**
 * 草稿箱列表（§8 本地草稿）。
 * 草稿不是服务器邮件，没有已读/星标等 IMAP 语义，只提供「继续编辑」与「删除」。
 */
export function DraftList({
  drafts,
  loading,
  accounts,
  selectedKey,
  onSelect,
  onOpen,
  onDelete,
  onCompose,
  onRefresh,
}: DraftListProps): JSX.Element {
  const timeFormat = useTimeFormat();
  const timeZone = useTimeZone();
  // 自己判定双击：React 的 onDoubleClick 依赖元素不重建，列表刷新时容易丢
  const lastClick = useRef<{ key: string; at: number } | null>(null);

  const handleClick = (draft: ComposeDraft): void => {
    const key = draft.key ?? draft.accountId;
    const now = Date.now();
    const previous = lastClick.current;
    lastClick.current = { key, at: now };
    if (previous && previous.key === key && now - previous.at <= 400) {
      onOpen(draft);
      return;
    }
    onSelect(draft);
  };

  const tagFor = (accountId: string): { label: string; color: string } | null => {
    const account = accounts.find((item) => item.id === accountId);
    return account ? accountTagFor(account) : null;
  };

  return (
    <section className="list-pane" aria-label="草稿列表区域">
      <header className="list-header">
        <div className="list-heading">
          <h2 className="list-title">草稿箱</h2>
          <span className="list-meta">
            {drafts.length} 封{loading ? ' · 载入中…' : ''}
          </span>
        </div>
        <div className="list-actions">
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            title="刷新草稿"
            aria-label="刷新草稿"
            disabled={loading}
            onClick={onRefresh}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <path d="M21 3v6h-6" />
            </svg>
          </button>
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
        {drafts.length === 0 ? (
          <div className="list-empty">
            {loading ? (
              '正在读取草稿…'
            ) : (
              <>
                还没有草稿。
                <br />
                写信时内容会自动保存在这里。
              </>
            )}
          </div>
        ) : (
              <ul className="draft-list">
            {drafts.map((draft) => {
              const tag = tagFor(draft.accountId);
              const recipients = draft.to.length > 0 ? draft.to.join(', ') : '（未填写收件人）';
              const key = draft.key ?? draft.accountId;
              const selected = selectedKey === key;
              return (
                <li className={`draft-item${selected ? ' is-selected' : ''}`} key={key}>
                  <button
                    type="button"
                    className="draft-item-main"
                    aria-current={selected}
                    title="单击查看内容，双击打开撰写窗口"
                    onClick={() => handleClick(draft)}
                  >
                    <span className="draft-item-line">
                      <span className="draft-item-subject">{draft.subject || '（无主题）'}</span>
                      <time className="mail-time" dateTime={new Date(draft.updatedAt).toISOString()}>
                        {formatListDate(
                          new Date(draft.updatedAt).toISOString(),
                          timeFormat,
                          timeZone,
                        )}
                      </time>
                    </span>
                    <span className="draft-item-to">收件人：{recipients}</span>
                    <span className="draft-item-snippet">{draft.body.slice(0, 80) || '（正文为空）'}</span>
                    <span className="mail-indicators">
                      {tag ? (
                        <span className="account-tag" style={{ backgroundColor: tag.color }}>
                          {tag.label}
                        </span>
                      ) : null}
                      {draft.attachments.length > 0 ? (
                        <span className="mail-indicator">📎 {draft.attachments.length} 个附件</span>
                      ) : null}
                    </span>
                  </button>
                  <div className="draft-item-actions">
                    <button type="button" className="btn btn-sm" onClick={() => onOpen(draft)}>
                      继续编辑
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => onDelete(draft)}
                      aria-label={`删除草稿 ${draft.subject || '（无主题）'}`}
                    >
                      删除
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
