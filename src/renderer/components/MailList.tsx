import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { AccountView, EmailSummary, FolderView } from '../../shared/types';
import type { ListFilter, ListSort } from '../../shared/ipc';
import { t } from '../../shared/i18n';
import { DRAFTS_FOLDER } from '../stores/mail-store';
import { computeActiveDescendant, nextIndexForKey } from '../lib/virtual-a11y';
import { accountTagFor, avatarFor, formatListDate, formatShortAddress } from '../lib/format';
import { useTimeFormat } from '../lib/use-time-format';
import { useTimeZone } from '../lib/use-time-zone';
import { parseHighlightTerms } from '../lib/search-highlight';
import { HighlightedText } from './HighlightedText';

interface MailListProps {
  emails: EmailSummary[];
  total: number;
  folderName: string;
  selectedId: string | null;
  loading: boolean;
  searchActive: boolean;
  /** 当前搜索词：列表里命中处用黄色底色标出。 */
  searchQuery?: string;
  /** 列表筛选口径（全部 / 未读 / 已标记，§7.8.2）。 */
  filter: ListFilter;
  /** 列表排列方式（日期 / 发件人 / 主题 / 附件 / 帐户）。 */
  sort: ListSort;
  accounts?: AccountView[];
  onSelect(emailId: string): void;
  onCompose?(): void;
  /** 切换筛选口径；切换后由 store 按新口径重查。 */
  onFilterChange(value: ListFilter): void;
  /** 切换排列方式；切换后由 store 按新口径重查。 */
  onSortChange(value: ListSort): void;
  /** 行内快捷操作：不改变选中态，直接作用于该行邮件。 */
  onToggleStar?(email: EmailSummary): void;
  onToggleRead?(email: EmailSummary): void;
  onArchive?(email: EmailSummary): void;
  onDelete?(email: EmailSummary): void;
  /** 该邮件所在账户是否有可用归档文件夹。 */
  canArchive?(email: EmailSummary): boolean;
  /** 每个账户的文件夹（按 accountId 索引），供行内「移动到」菜单使用。 */
  foldersByAccount?: Record<string, FolderView[]>;
  /** 行内「移动到文件夹」回调；提供后显示移动按钮。 */
  onMove?(email: EmailSummary, folder: string): void;
  /** 双击邮件：在新的原生阅读窗口里打开该邮件。 */
  onOpenReaderWindow?(email: EmailSummary): void;
}

/** 行内小图标按钮：点击不触发行的选中。 */
function RowAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick(): void;
  children: JSX.Element;
}): JSX.Element {
  return (
    <button
      type="button"
      className="row-action"
      title={label}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {children}
    </button>
  );
}

/**
 * 行内「移动到文件夹」浮层：点击图标弹出该账户文件夹列表（排除当前文件夹、
 * 草稿箱保留路径与回收站），选择后回调 onMove 并关闭。点外部 / ESC 关闭。
 * 浮层与触发按钮均 stopPropagation，避免触发行的选中。
 */
function RowMoveMenu({
  email,
  folders,
  onMove,
}: {
  email: EmailSummary;
  folders: FolderView[];
  onMove(email: EmailSummary, folder: string): void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // 可移动目标：排除当前所在文件夹、草稿箱保留路径、回收站
  const targets = useMemo(
    () =>
      folders.filter(
        (folder) =>
          folder.path !== email.folder &&
          folder.path !== DRAFTS_FOLDER &&
          folder.specialUse !== 'trash',
      ),
    [folders, email.folder],
  );

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return (
    <div className="row-move" ref={containerRef}>
      <RowAction
        label="移动到文件夹"
        onClick={() => setOpen((value) => !value)}
      >
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <path d="M12 11v4M10 13h4" />
        </svg>
      </RowAction>
      {open ? (
        <div
          className="move-menu"
          role="menu"
          aria-label="移动到文件夹"
          onClick={(event) => event.stopPropagation()}
        >
          {targets.length === 0 ? (
            <div className="move-menu-empty">没有可移动的目标文件夹</div>
          ) : (
            targets.map((folder) => (
              <button
                key={folder.path}
                type="button"
                className="move-menu-item"
                role="menuitem"
                onClick={(event) => {
                  event.stopPropagation();
                  setOpen(false);
                  onMove(email, folder.path);
                }}
              >
                {folder.name}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

const ROW_HEIGHT = 96;
const HEADER_HEIGHT = 34;

/** 筛选口径选项（顺序与 Windows Mail 的「筛选」组一致）。 */
const FILTER_OPTIONS: ReadonlyArray<{ value: ListFilter; label: string }> = [
  { value: 'all', label: t('mail.filter.all') },
  { value: 'unread', label: t('mail.filter.unread') },
  { value: 'starred', label: t('mail.filter.starred') },
];

/**
 * 排列方式：与 Windows Mail 的菜单同序；本机没有对应字段的项保留位置并置灰，
 * 让用户看得到「为什么做不到」，而不是凭空少一项。
 */
type SortEntry =
  | { kind: 'sort'; value: ListSort; label: string }
  | { kind: 'unavailable'; key: string; label: string };

const SORT_ENTRIES: ReadonlyArray<SortEntry> = [
  { kind: 'sort', value: 'date', label: t('mail.sort.date') },
  { kind: 'sort', value: 'from', label: t('mail.sort.from') },
  { kind: 'sort', value: 'to', label: t('mail.sort.to') },
  { kind: 'unavailable', key: 'categories', label: t('mail.sort.categories') },
  { kind: 'sort', value: 'flagged', label: t('mail.sort.flagged') },
  { kind: 'unavailable', key: 'flagStart', label: t('mail.sort.flagStart') },
  { kind: 'unavailable', key: 'flagDue', label: t('mail.sort.flagDue') },
  { kind: 'unavailable', key: 'size', label: t('mail.sort.size') },
  { kind: 'sort', value: 'subject', label: t('mail.sort.subject') },
  { kind: 'unavailable', key: 'type', label: t('mail.sort.type') },
  { kind: 'sort', value: 'attachments', label: t('mail.sort.attachments') },
  { kind: 'sort', value: 'account', label: t('mail.sort.account') },
  { kind: 'unavailable', key: 'importance', label: t('mail.sort.importance') },
];

interface MenuRow {
  key: string;
  label: string;
  checked: boolean;
  disabled: boolean;
  onSelect(): void;
}

/**
 * 列表筛选/排列菜单：漏斗按钮 + 下拉浮层，两组单选（role=menuitemradio）。
 * 点外部 / ESC 关闭；选中后立即生效并关闭。浮层 stopPropagation，避免触发列表行。
 */
function ListQueryMenu({
  filter,
  sort,
  onFilterChange,
  onSortChange,
}: {
  filter: ListFilter;
  sort: ListSort;
  onFilterChange(value: ListFilter): void;
  onSortChange(value: ListSort): void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  // 非默认口径时按钮高亮，用户能看出列表被筛过/排过
  const active = filter !== 'all' || sort !== 'date';

  const renderRow = (row: MenuRow): JSX.Element => (
    <button
      key={row.key}
      type="button"
      className="filter-menu-item"
      role="menuitemradio"
      aria-checked={row.checked}
      aria-disabled={row.disabled || undefined}
      title={row.disabled ? t('mail.filter.unsupportedHint') : undefined}
      onClick={() => {
        if (row.disabled) return;
        setOpen(false);
        row.onSelect();
      }}
    >
      <span className="filter-menu-check" aria-hidden="true">
        {row.checked ? '✓' : ''}
      </span>
      <span className="filter-menu-label">{row.label}</span>
      {row.disabled ? (
        <span className="filter-menu-tag">{t('mail.filter.unsupported')}</span>
      ) : null}
    </button>
  );

  // 本机没有对应字段的选项保留位置，置灰并标注「暂不支持」（不伪造数据）
  const filterRows: MenuRow[] = [
    ...FILTER_OPTIONS.map((option) => ({
      key: option.value,
      label: option.label,
      checked: filter === option.value,
      disabled: false,
      onSelect: () => onFilterChange(option.value),
    })),
    {
      key: 'mentioned',
      label: t('mail.filter.mentioned'),
      checked: false,
      disabled: true,
      onSelect: () => undefined,
    },
  ];

  const sortRows: MenuRow[] = SORT_ENTRIES.map((entry) =>
    entry.kind === 'sort'
      ? {
          key: entry.value,
          label: entry.label,
          checked: sort === entry.value,
          disabled: false,
          onSelect: () => onSortChange(entry.value),
        }
      : {
          key: entry.key,
          label: entry.label,
          checked: false,
          disabled: true,
          onSelect: () => undefined,
        },
  );

  return (
    <div className="list-filter" ref={containerRef}>
      <button
        type="button"
        className={`icon-btn icon-btn-sm${active ? ' icon-btn-active' : ''}`}
        title={t('mail.filter.label')}
        aria-label={t('mail.filter.label')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />
        </svg>
      </button>
      {open ? (
        <div className="filter-menu" role="menu" aria-label={t('mail.filter.label')}>
          <div className="filter-menu-group" role="presentation">
            {t('mail.filter.group')}
          </div>
          {filterRows.map(renderRow)}
          <div className="filter-menu-sep" role="separator" />
          <div className="filter-menu-group" role="presentation">
            {t('mail.sort.label')}
          </div>
          {sortRows.map(renderRow)}
        </div>
      ) : null}
    </div>
  );
}

type Row =
  | { type: 'header'; key: string; label: string }
  | { type: 'email'; key: string; email: EmailSummary };

type EmailRow = { row: Extract<Row, { type: 'email' }>; rowIndex: number };

export function MailList({
  emails,
  total,
  folderName,
  selectedId,
  loading,
  searchActive,
  searchQuery = '',
  filter,
  sort,
  accounts = [],
  onSelect,
  onCompose,
  onFilterChange,
  onSortChange,
  onToggleStar,
  onToggleRead,
  onArchive,
  onDelete,
  canArchive,
  foldersByAccount,
  onMove,
  onOpenReaderWindow,
}: MailListProps): JSX.Element {
  const timeFormat = useTimeFormat();
  const timeZone = useTimeZone();
  const scrollRef = useRef<HTMLDivElement>(null);

  const accountMap = useMemo(() => {
    const map = new Map<string, { label: string; color: string }>();
    for (const account of accounts) map.set(account.id, accountTagFor(account));
    return map;
  }, [accounts]);

  // 命中词只解析一次，虚拟列表每行复用，避免逐行解析查询串
  const searchTerms = useMemo(
    () => (searchActive && searchQuery ? parseHighlightTerms(searchQuery) : []),
    [searchActive, searchQuery],
  );

  const rows = useMemo<Row[]>(() => {
    const pinned = emails.filter((email) => email.pinned);
    const rest = emails.filter((email) => !email.pinned);
    const result: Row[] = [];

    if (pinned.length > 0) {
      result.push({ type: 'header', key: 'header-pinned', label: `置顶 · ${pinned.length}` });
      for (const email of pinned) result.push({ type: 'email', key: email.id, email });
    }
    if (pinned.length > 0 && rest.length > 0) {
      result.push({ type: 'header', key: 'header-others', label: '其他邮件' });
    }
    for (const email of rest) result.push({ type: 'email', key: email.id, email });
    return result;
  }, [emails]);

  const emailRows = useMemo<EmailRow[]>(() => {
    const collected: EmailRow[] = [];
    rows.forEach((row, rowIndex) => {
      if (row.type === 'email') collected.push({ row, rowIndex });
    });
    return collected;
  }, [rows]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (rows[index]?.type === 'header' ? HEADER_HEIGHT : ROW_HEIGHT),
    overscan: 12,
  });

  const items = virtualizer.getVirtualItems();
  const selectedRowIndex =
    selectedId === null
      ? -1
      : rows.findIndex((row) => row.type === 'email' && row.email.id === selectedId);

  // 关键（§9.3）：只有选中行确实渲染在 DOM 里时才发布 active descendant
  const activeDescendant = computeActiveDescendant(selectedRowIndex, items);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const selectedEmailIndex = emailRows.findIndex(
      (entry) => entry.row.email.id === selectedId,
    );
    const next = nextIndexForKey(event.key, selectedEmailIndex, emailRows.length);
    if (next === null) return;
    event.preventDefault();
    const target = emailRows[next];
    if (!target) return;
    onSelect(target.row.email.id);
    virtualizer.scrollToIndex(target.rowIndex, { align: 'auto' });
  };

  return (
    <section className="list-pane" aria-label="邮件列表区域">
      <header className="list-header">
        <div className="list-heading">
          <h2 className="list-title">{searchActive ? '搜索结果' : folderName}</h2>
          {/* 常用的「全部/未读」留在文件夹名后面，完整筛选与排列在右侧漏斗菜单里 */}
          <div className="list-toggle" role="group" aria-label={t('mail.toggle.label')}>
            <button
              type="button"
              className="filter-seg"
              aria-pressed={filter === 'all'}
              onClick={() => onFilterChange('all')}
            >
              {t('mail.toggle.all')}
            </button>
            <button
              type="button"
              className="filter-seg"
              aria-pressed={filter === 'unread'}
              onClick={() => onFilterChange('unread')}
            >
              {t('mail.toggle.unread')}
            </button>
          </div>
          <span className="list-meta">
            {total} 封{loading ? ' · 载入中…' : ''}
          </span>
        </div>
        <div className="list-actions">
          <ListQueryMenu
            filter={filter}
            sort={sort}
            onFilterChange={onFilterChange}
            onSortChange={onSortChange}
          />
          {onCompose ? (
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
          ) : null}
        </div>
      </header>

      <div
        ref={scrollRef}
        className="list-scroll"
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        role="listbox"
        aria-label={`${searchActive ? '搜索结果' : folderName} 邮件列表`}
        aria-activedescendant={activeDescendant}
        onKeyDown={handleKeyDown}
      >
        {emails.length === 0 ? (
          <div className="list-empty">
            {loading ? (
              '正在载入邮件…'
            ) : searchActive ? (
              '没有匹配的邮件。'
            ) : filter === 'unread' ? (
              t('mail.filter.emptyUnread')
            ) : filter === 'starred' ? (
              t('mail.filter.emptyStarred')
            ) : (
              <>
                这个文件夹还没有邮件。
                <br />
                若刚刚配置账户，请点击右上角「刷新」。
              </>
            )}
          </div>
        ) : (
          <div className="virtual-canvas" style={{ height: `${virtualizer.getTotalSize()}px` }}>
            {items.map((item) => {
              const row = rows[item.index];
              if (!row) return null;

              if (row.type === 'header') {
                return (
                  <div
                    key={row.key}
                    className="list-section"
                    role="presentation"
                    style={{
                      transform: `translateY(${item.start}px)`,
                      height: `${item.size}px`,
                    }}
                  >
                    {row.label}
                  </div>
                );
              }

              const email = row.email;
              const isSelected = email.id === selectedId;
              const avatar = avatarFor(email.from);
              const tag = accountMap.get(email.accountId);
              return (
                <div
                  key={email.id}
                  id={`mail-row-${item.index}`}
                  role="option"
                  aria-selected={isSelected}
                  data-unread={email.unread}
                  className="mail-item"
                  style={{
                    transform: `translateY(${item.start}px)`,
                    height: `${item.size}px`,
                  }}
                  onClick={() => onSelect(email.id)}
                  onDoubleClick={() => onOpenReaderWindow?.(email)}
                >
                  <span className="unread-dot" aria-hidden="true" />
                  <span className="mail-avatar" style={{ backgroundColor: avatar.color }} aria-hidden="true">
                    {avatar.initial}
                  </span>
                  <div className="mail-main">
                    <div className="mail-line">
                      <span className="mail-from">
                        {email.unread ? <span className="sr-only">未读：</span> : null}
                        <HighlightedText
                          text={formatShortAddress(email.from)}
                          terms={searchTerms}
                        />
                      </span>
                      <time className="mail-time" dateTime={email.date}>
                        {formatListDate(email.date, timeFormat, timeZone)}
                      </time>
                    </div>
                    <div className="mail-subject">
                      <HighlightedText text={email.subject} terms={searchTerms} />
                    </div>
                    <div className="mail-snippet">
                      <HighlightedText text={email.snippet} terms={searchTerms} />
                    </div>
                    <div className="mail-indicators">
                      {tag && (accountMap.size > 1 || searchActive) ? (
                        <span className="account-tag" style={{ backgroundColor: tag.color }}>
                          {tag.label}
                        </span>
                      ) : null}
                      {email.hasAttachments ? <span className="mail-indicator">📎 含附件</span> : null}
                      {email.starred ? <span className="mail-indicator">★ 已星标</span> : null}
                      {email.pinned ? <span className="mail-indicator">★ 置顶</span> : null}
                    </div>
                  </div>

                  <div className="mail-row-actions">
                    {onToggleStar ? (
                      <RowAction
                        label={email.starred ? '取消星标' : '加星标'}
                        onClick={() => onToggleStar(email)}
                      >
                        <svg
                          viewBox="0 0 24 24"
                          width="13"
                          height="13"
                          fill={email.starred ? 'currentColor' : 'none'}
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                        </svg>
                      </RowAction>
                    ) : null}
                    {onToggleRead ? (
                      <RowAction
                        label={email.unread ? '标记为已读' : '标记为未读'}
                        onClick={() => onToggleRead(email)}
                      >
                        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                          {email.unread ? (
                            <path d="M2 6h20v12H2zM2 7l10 7 10-7" />
                          ) : (
                            <>
                              <path d="M2 8l10 6 10-6" />
                              <path d="M2 8v11h20V8" />
                            </>
                          )}
                        </svg>
                      </RowAction>
                    ) : null}
                    {onArchive && (canArchive ? canArchive(email) : true) ? (
                      <RowAction label="归档" onClick={() => onArchive(email)}>
                        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                          <rect x="3" y="4" width="18" height="4" rx="1" />
                          <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
                          <path d="M10 12h4" />
                        </svg>
                      </RowAction>
                    ) : null}
                    {onMove ? (
                      <RowMoveMenu
                        email={email}
                        folders={foldersByAccount?.[email.accountId] ?? []}
                        onMove={onMove}
                      />
                    ) : null}
                    {onDelete ? (
                      <RowAction label="删除" onClick={() => onDelete(email)}>
                        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
                        </svg>
                      </RowAction>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
