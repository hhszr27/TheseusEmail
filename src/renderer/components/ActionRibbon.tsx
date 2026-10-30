import {
  useEffect,
  useMemo,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
} from 'react';
import type { EmailSummary, FolderView } from '../../shared/types';
import type { ListFilter } from '../../shared/ipc';
import {
  buildRibbonViewModel,
  splitRibbonTools,
  type RibbonConfig,
  type RibbonContext,
  type RibbonIconName,
  type RibbonToolView,
} from '../../shared/ribbon';
import { t } from '../../shared/i18n';

/**
 * 可折叠带状工具栏（Outlook 风格 ribbon）：位于顶栏与工作区之间的横线处。
 *
 * 本组件只负责「把配置渲染出来」：标签页与按钮全部来自 buildRibbonViewModel，
 * 点击统一走 onRunCommand（与快捷键、命令面板同一条分发路径）。
 * 配置从哪来、能不能改，由 shared/ribbon.ts 与 ribbon 编辑器负责，这里不感知。
 *
 * 折叠时只收起下方按钮区，标签页行与右侧箭头始终可见；折叠态下点标签页会一并展开。
 */

export interface ActionRibbonProps {
  /** 生效配置（内置默认 + 用户覆盖合并后的结果）。 */
  config: RibbonConfig;
  activeView: string;
  unified: boolean;
  foldersByAccount: Record<string, FolderView[]>;
  selectedEmail: EmailSummary | null;
  listFilter: ListFilter;
  hasAccounts: boolean;
  /** 阅读区当前是否显示（供「快速视图」按钮）。 */
  readerShown?: boolean;
  /** 列表/正文当前是否上下布局（供「布局」按钮）。 */
  vertical?: boolean;
  /** 统一命令分发入口。 */
  onRunCommand(commandId: string, args?: Record<string, string>): void;
}

const COLLAPSED_KEY = 'mailforge.ribbon.collapsed';
const TAB_KEY = 'mailforge.ribbon.tab';

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : raw === '1';
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? '1' : '0');
  } catch {
    /* 隐私模式等场景忽略 */
  }
}

/**
 * 记住上次停留在哪个标签。
 * 回落顺序：上次的 → 邮件（主工作区）→ 第一个可用 → 占位。
 * 不直接用「第一个」，否则「文件」排在首位时会默认停在那里。
 */
function readTab(available: string[]): string {
  try {
    const raw = window.localStorage.getItem(TAB_KEY);
    if (raw && available.includes(raw)) return raw;
  } catch {
    /* ignore */
  }
  if (available.includes('mail')) return 'mail';
  return available[0] ?? 'mail';
}

/** 组件内部还会用到折叠箭头，与工具图标合在一张表里。 */
type RibbonGlyph = RibbonIconName | 'chevronDown' | 'chevronUp';

const ICONS: Record<RibbonGlyph, JSX.Element> = {
  compose: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
    </>
  ),
  reply: (
    <>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h11a5 5 0 0 1 5 5v6" />
    </>
  ),
  replyAll: (
    <>
      <path d="M11 14 6 9l5-5" />
      <path d="M6 9h9a6 6 0 0 1 6 6v5" />
      <path d="M17 14l3-3-3-3" />
    </>
  ),
  forward: (
    <>
      <path d="M15 14l5-5-5-5" />
      <path d="M20 9H9a5 5 0 0 0-5 5v6" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
    </>
  ),
  archive: (
    <>
      <path d="M21 8v13H3V8" />
      <path d="M1 3h22v5H1z" />
      <path d="M10 12h4" />
    </>
  ),
  move: (
    <>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M12 11v5M9.5 13.5 12 16l2.5-2.5" />
    </>
  ),
  read: (
    <>
      <path d="M3 8l9 6 9-6" />
      <path d="M21 8v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8" />
    </>
  ),
  star: <path d="M12 3l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 18l-5.8 3 1.1-6.5L2.6 9.8l6.5-.9z" />,
  unified: (
    <>
      <path d="M12 2 2 7l10 5 10-5z" />
      <path d="M2 12l10 5 10-5" />
      <path d="M2 17l10 5 10-5" />
    </>
  ),
  inbox: (
    <>
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24A2 2 0 0 0 5.45 5.11z" />
    </>
  ),
  sent: (
    <>
      <path d="M22 2 11 13" />
      <path d="M22 2 15 22l-4-9-9-4z" />
    </>
  ),
  drafts: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  filter: <path d="M3 5h18l-7 8v6l-4-2v-4z" />,
  refresh: (
    <>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </>
  ),
  ai: (
    <>
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
    </>
  ),
  command: (
    <>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M6 14h12" />
    </>
  ),
  plugin: (
    <>
      <path d="M21 8v13H3V8" />
      <path d="M1 3h22v5H1z" />
      <path d="M10 12h4" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>
  ),
  power: (
    <>
      <path d="M12 2v10" />
      <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
    </>
  ),
  quickView: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M14 4v16" />
      <path d="M17.5 9.5a3 3 0 0 1 0 5" />
    </>
  ),
  layout: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 10h18" />
      <path d="M9 10v10" />
    </>
  ),
  chevronDown: <path d="M6 9l6 6 6-6" />,
  chevronUp: <path d="M18 15l-6-6-6 6" />,
};

function Ico({ name }: { name: RibbonGlyph }): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICONS[name]}
    </svg>
  );
}

interface RibbonBtnProps {
  tool: RibbonToolView;
  onActivate(event: MouseEvent<HTMLButtonElement>, tool: RibbonToolView): void;
  onOpenPicker(): void;
  pickerOpen: boolean;
}

function RibbonBtn({ tool, onActivate, onOpenPicker, pickerOpen }: RibbonBtnProps): JSX.Element {
  const cls = `ribbon-btn${tool.active ? ' is-active' : ''}${tool.danger ? ' is-danger' : ''}`;
  const isPicker = tool.picker === 'folder';
  return (
    <button
      type="button"
      className={cls}
      onClick={(event) => (isPicker ? onOpenPicker() : onActivate(event, tool))}
      disabled={tool.disabled}
      aria-expanded={isPicker ? pickerOpen : undefined}
      title={tool.label}
    >
      <span className="ribbon-btn-icon">
        <Ico name={tool.icon} />
      </span>
      <span className="ribbon-btn-label">{tool.label}</span>
    </button>
  );
}

export function ActionRibbon(props: ActionRibbonProps): JSX.Element {
  const {
    config,
    activeView,
    unified,
    foldersByAccount,
  selectedEmail,
  listFilter,
  hasAccounts,
  readerShown = true,
  vertical = false,
  onRunCommand,
} = props;

  const [collapsed, setCollapsed] = useState<boolean>(() => readFlag(COLLAPSED_KEY, false));
  const [pickerKey, setPickerKey] = useState<string | null>(null);
  /** 「更多」菜单是否展开（按钮超出一个标签页容量时出现）。 */
  const [overflowOpen, setOverflowOpen] = useState(false);

  const ctx: RibbonContext = useMemo(
    () => ({
      activeView,
      mailSelected: activeView === 'mail' && Boolean(selectedEmail),
      selectedUnread: Boolean(selectedEmail?.unread),
      selectedStarred: Boolean(selectedEmail?.starred),
      hasAccounts,
      unified,
      listFilter,
      viewSettings: activeView === 'settings',
      readerShown,
      vertical,
    }),
    [activeView, selectedEmail, hasAccounts, unified, listFilter, readerShown, vertical],
  );

  const viewModel = useMemo(() => buildRibbonViewModel(config, ctx), [config, ctx]);
  const tabIds = viewModel.map((item) => item.id);
  const [tab, setTab] = useState<string>(() => readTab(tabIds));

  // 标签被用户删掉/改名后旧 id 失效：回落到「邮件」，再退回第一个可用标签
  const activeTabId = tabIds.includes(tab) ? tab : (tabIds.includes('mail') ? 'mail' : (tabIds[0] ?? 'mail'));
  const activeTab = viewModel.find((item) => item.id === activeTabId) ?? null;

  const toggleCollapsed = (): void => {
    const next = !collapsed;
    setCollapsed(next);
    writeFlag(COLLAPSED_KEY, next);
  };

  const selectTab = (next: string): void => {
    setTab(next);
    setPickerKey(null);
    setOverflowOpen(false);
    // 折叠态下点标签页：切过去的同时展开，让用户看到对应按钮区
    if (collapsed) {
      setCollapsed(false);
      writeFlag(COLLAPSED_KEY, false);
    }
    try {
      window.localStorage.setItem(TAB_KEY, next);
    } catch {
      /* ignore */
    }
  };

  // Esc 关闭展开的菜单（「移动到」与「更多」都要能键盘退出）
  useEffect(() => {
    if (!pickerKey && !overflowOpen) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setPickerKey(null);
      setOverflowOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pickerKey, overflowOpen]);

  /**
   * 标签页键盘导航（ARIA tabs 模式）：←/→ 循环切换，Home/End 跳到首尾。
   * 只切不提交，焦点跟着走，避免键盘用户在标签行里「点不动」。
   */
  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    const { key } = event;
    if (key !== 'ArrowRight' && key !== 'ArrowLeft' && key !== 'Home' && key !== 'End') return;
    const row = event.currentTarget.parentElement;
    if (!row) return;
    const tabs = Array.from(row.querySelectorAll<HTMLButtonElement>('.ribbon-tab'));
    const index = tabs.indexOf(event.currentTarget);
    if (index < 0) return;
    event.preventDefault();
    const nextIndex =
      key === 'Home'
        ? 0
        : key === 'End'
          ? tabs.length - 1
          : (index + (key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    const next = tabs[nextIndex];
    if (!next) return;
    const id = next.dataset.tabId;
    if (id) selectTab(id);
    next.focus();
  };

  const activate = (event: MouseEvent<HTMLButtonElement>, tool: RibbonToolView): void => {
    if (tool.openWithAnchor) {
      const rect = event.currentTarget.getBoundingClientRect();
      onRunCommand(tool.commandId, {
        ...(tool.args ?? {}),
        x: String(Math.round(rect.left)),
        y: String(Math.round(rect.bottom + 6)),
      });
      return;
    }
    onRunCommand(tool.commandId, tool.args);
  };

  // 「移动到」的候选文件夹：该邮件所属账户下、非当前文件夹
  const moveTargets = selectedEmail
    ? (foldersByAccount[selectedEmail.accountId] ?? []).filter(
        (folder) => folder.path !== selectedEmail.folder,
      )
    : [];

  // 按钮太多时折进「更多」，避免把标签页撑爆
  const toolSplit = activeTab ? splitRibbonTools(activeTab.tools) : { visible: [], overflow: [] };

  return (
    <div className={`ribbon${collapsed ? ' ribbon-collapsed' : ''}`} role="toolbar" aria-label={t('ribbon.aria.toolbar')}>
      <div className="ribbon-tabs" role="tablist" aria-label={t('ribbon.aria.tabs')}>
        {viewModel.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            data-tab-id={item.id}
            className={`ribbon-tab${item.id === activeTabId ? ' is-active' : ''}`}
            aria-selected={item.id === activeTabId}
            aria-current={item.id === activeTabId}
            tabIndex={item.id === activeTabId ? 0 : -1}
            onClick={() => selectTab(item.id)}
            onKeyDown={handleTabKeyDown}
          >
            {item.label}
          </button>
        ))}
        <div className="ribbon-tabs-spacer" />
        {/* 自定义功能区：原来在「工具」标签里，移到折叠按钮旁常驻 */}
        <button
          type="button"
          className="ribbon-collapse ribbon-customize"
          onClick={() => onRunCommand('ribbon.customize')}
          title={t('ribbon.editor.title')}
          aria-label={t('ribbon.editor.title')}
        >
          <Ico name="layout" />
        </button>
        <button
          type="button"
          className="ribbon-collapse"
          onClick={toggleCollapsed}
          title={collapsed ? t('ribbon.expand') : t('ribbon.collapse')}
          aria-expanded={!collapsed}
        >
          <Ico name={collapsed ? 'chevronDown' : 'chevronUp'} />
        </button>
      </div>

      {!collapsed && activeTab ? (
      <div className="ribbon-body">
        <div className="ribbon-group">
          <div className="ribbon-group-btns">
            {toolSplit.visible.map((tool) => {
              const key = `${activeTab.id}:${tool.id}`;
              const pickerOpen = tool.picker === 'folder' && pickerKey === key;
              if (tool.picker === 'folder') {
                return (
                  <div className="ribbon-move-wrap" key={key}>
                    <RibbonBtn
                      tool={tool}
                      onActivate={activate}
                      onOpenPicker={() => setPickerKey((current) => (current === key ? null : key))}
                      pickerOpen={pickerOpen}
                    />
                    {pickerOpen ? (
                      <>
                        <button
                          type="button"
                          className="ribbon-menu-backdrop"
                          aria-hidden="true"
                          tabIndex={-1}
                          onClick={() => setPickerKey(null)}
                        />
                        <div className="ribbon-move-menu" role="menu">
                          {moveTargets.length === 0 ? (
                            <div className="ribbon-move-empty">{t('ribbon.move.empty')}</div>
                          ) : (
                            moveTargets.map((folder) => (
                              <button
                                key={folder.path}
                                type="button"
                                role="menuitem"
                                className="ribbon-move-item"
                                onClick={() => {
                                  onRunCommand(tool.commandId, {
                                    ...(tool.args ?? {}),
                                    folderPath: folder.path,
                                  });
                                  setPickerKey(null);
                                }}
                              >
                                {folder.name}
                              </button>
                            ))
                          )}
                        </div>
                      </>
                    ) : null}
                  </div>
                );
              }
              return (
                <RibbonBtn
                  key={key}
                  tool={tool}
                  onActivate={activate}
                  onOpenPicker={() => undefined}
                  pickerOpen={false}
                />
              );
            })}

            {toolSplit.overflow.length > 0 ? (
              <div className="ribbon-overflow-wrap">
                <button
                  type="button"
                  className="ribbon-btn ribbon-overflow-btn"
                  onClick={() => {
                    setOverflowOpen((open) => !open);
                    setPickerKey(null);
                  }}
                  title={t('ribbon.more.title', { count: toolSplit.overflow.length })}
                  aria-expanded={overflowOpen}
                  aria-haspopup="menu"
                >
                  <span className="ribbon-btn-icon">
                    <Ico name={overflowOpen ? 'chevronUp' : 'chevronDown'} />
                  </span>
                  <span className="ribbon-btn-label">{t('ribbon.more')}</span>
                </button>
                {overflowOpen ? (
                  <>
                    <button
                      type="button"
                      className="ribbon-menu-backdrop"
                      aria-hidden="true"
                      tabIndex={-1}
                      onClick={() => setOverflowOpen(false)}
                    />
                    <div className="ribbon-move-menu ribbon-overflow-menu" role="menu">
                      {toolSplit.overflow.map((tool) => (
                        <button
                          key={tool.id}
                          type="button"
                          role="menuitem"
                          className={`ribbon-move-item${tool.danger ? ' is-danger' : ''}`}
                          disabled={tool.disabled}
                          title={`${tool.label}（${tool.commandId}）`}
                          onClick={() => {
                            onRunCommand(tool.commandId, tool.args);
                            setOverflowOpen(false);
                          }}
                        >
                          {tool.label}
                        </button>
                      ))}
                    </div>
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
          <span className="ribbon-group-label">
            {activeTab.origin === 'user'
              ? t('ribbon.group.custom')
              : activeTab.origin === 'plugin'
                ? t('ribbon.group.plugin')
                : activeTab.label}
          </span>
        </div>
      </div>
      ) : null}
    </div>
  );
}
