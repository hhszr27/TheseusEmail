import { useEffect, useRef, type ReactNode } from 'react';
import { t } from '../../shared/i18n';

interface ToolbarProps {
  searchQuery: string;
  searchActive: boolean;
  searchAllAccounts: boolean;
  onSearch(query: string): void;
  onClearSearch(): void;
  onToggleSearchAll(value: boolean): void;
  onOpenPalette(): void;
  onOpenAi(): void;
  onRefresh(): void;
  onOpenSettings(): void;
  /** 主题视图（从侧栏底部移到右上角）。 */
  onOpenTheme(): void;
  /** 插件管理视图（从侧栏底部移到右上角）。 */
  onOpenPlugins(): void;
  /** 打开 main 区域的插件菜单（§13.3.1）。 */
  onOpenPluginMenu(x: number, y: number): void;
  children?: ReactNode;
}

export function Toolbar({
  searchQuery,
  searchActive,
  searchAllAccounts,
  onSearch,
  onClearSearch,
  onToggleSearchAll,
  onOpenPalette,
  onOpenAi,
  onRefresh,
  onOpenSettings,
  onOpenTheme,
  onOpenPlugins,
  onOpenPluginMenu,
  children,
}: ToolbarProps): JSX.Element {
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (searchRef.current) searchRef.current.value = searchQuery;
  }, [searchQuery]);

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          M
        </span>
        <span>MailForge</span>
      </div>

      <div className="search-box">
        <svg
          className="search-icon"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.3-4.3" />
        </svg>
        <input
          ref={searchRef}
          className="search-input"
          type="search"
          placeholder={t('toolbar.searchPlaceholder')}
          aria-label={t('toolbar.search')}
          defaultValue={searchQuery}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              onSearch(event.currentTarget.value);
            }
            if (event.key === 'Escape') {
              event.currentTarget.value = '';
              onClearSearch();
              event.currentTarget.blur();
            }
          }}
        />
        {searchActive ? (
          <button
            type="button"
            className="search-clear"
            onClick={() => {
              if (searchRef.current) searchRef.current.value = '';
              onClearSearch();
            }}
            aria-label={t('toolbar.clearSearch')}
          >
            ×
          </button>
        ) : null}
      </div>

      <label className="checkbox checkbox-inline topbar-all" title="勾选后跨账户搜索，包含已禁用账户">
        <input
          type="checkbox"
          checked={searchAllAccounts}
          onChange={(event) => onToggleSearchAll(event.target.checked)}
        />
        所有账户
      </label>

      <div className="topbar-spacer" />

      {children}

      <button type="button" className="ai-btn" onClick={onOpenAi}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
        </svg>
        AI 指令
      </button>

      <button
        type="button"
        className="icon-btn"
        title={`${t('toolbar.palette')}（Ctrl/Cmd+K）`}
        aria-label={t('toolbar.palette')}
        onClick={onOpenPalette}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <rect x="2" y="4" width="20" height="16" rx="2" />
          <path d="M6 10h.01M10 10h.01M14 10h.01M6 14h12" />
        </svg>
      </button>

      <button
        type="button"
        className="icon-btn icon-btn-plugin"
        title="插件命令"
        aria-label="插件命令"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          onOpenPluginMenu(Math.round(rect.left), Math.round(rect.bottom + 6));
        }}
      >
        {/* 插件命令用闪电，避免和右上角的「插件管理」盒子图标撞脸 */}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
        </svg>
      </button>

      <button
        type="button"
        className="icon-btn"
        title="主题"
        aria-label="主题"
        onClick={onOpenTheme}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="13.5" cy="6.5" r="1.5" />
          <circle cx="17.5" cy="10.5" r="1.5" />
          <circle cx="8.5" cy="7.5" r="1.5" />
          <circle cx="6.5" cy="12.5" r="1.5" />
          <path d="M12 2a10 10 0 0 0 0 20c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.2 0-1 .8-1.8 1.8-1.8H16a6 6 0 0 0 6-6c0-4.4-4.5-8-10-8z" />
        </svg>
      </button>

      <button
        type="button"
        className="icon-btn"
        title="插件"
        aria-label="插件"
        onClick={onOpenPlugins}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 8v13H3V8" />
          <path d="M1 3h22v5H1z" />
          <path d="M10 12h4" />
        </svg>
      </button>

      <button
        type="button"
        className="icon-btn"
        title={t('toolbar.refresh')}
        aria-label={t('toolbar.refresh')}
        onClick={onRefresh}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M21 12a9 9 0 1 1-2.64-6.36" />
          <path d="M21 3v6h-6" />
        </svg>
      </button>

      <button
        type="button"
        className="icon-btn"
        title={t('toolbar.settings')}
        aria-label={t('toolbar.settings')}
        onClick={onOpenSettings}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
    </header>
  );
}
