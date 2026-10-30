import { useEffect, useState } from 'react';
import type { AccountRuntimeStatus, AccountView, FolderView } from '../../shared/types';
import { OUTBOX_FOLDER, DRAFTS_FOLDER, useMailStore, type WorkspaceView } from '../stores/mail-store';
import { accountTagFor } from '../lib/format';
import { t } from '../../shared/i18n';
import { isProtectedFolder, isSameOrDescendantPath, parentPathOf } from '../../shared/folder-name';
import { applyFolderOrder, buildFolderTree, flattenFolderTree } from '../lib/folder-tree';
import { FolderContextMenu, type FolderMenuTarget } from './FolderContextMenu';
import { TextPromptDialog } from './TextPromptDialog';
import { FolderPropertiesDialog } from './FolderPropertiesDialog';
import { FolderMoveDialog } from './FolderMoveDialog';
import { ConfirmDialog } from './ConfirmDialog';

const FAVORITES_KEY = 'folder.favorites';
const FOLDER_ORDER_KEY = 'folder.order';

interface SidebarProps {
  accounts: AccountView[];
  foldersByAccount: Record<string, FolderView[]>;
  activeAccountId: string | null;
  activeFolder: string;
  activeView: WorkspaceView;
  unified: boolean;
  /** 图标模式：只显示图标，收起文字（由左侧分割线拖到最左触发）。 */
  collapsed?: boolean;
  onSelectAccount(accountId: string): void;
  onSelectUnified(): void;
  onOpenDrafts(): void;
  draftCount: number;
  onOpenOutbox(): void;
  outboxCount: number;
  onSelectFolder(accountId: string, folder: string): void;
  onEnsureFolders(accountId: string): void;
  onOpenView(view: WorkspaceView): void;
  onOpenCalendar(): void;
  /** 联系人面板（侧栏底部导航）。 */
  onOpenContacts(): void;
  /** 贡献了 `sidebar-item` 视图的插件；每个在底部导航排一个图标。 */
  pluginEntries: { id: string; name: string }[];
  /** 当前打开的插件视图 id（用于高亮对应图标）；null 表示未打开。 */
  activePluginId: string | null;
  onOpenPluginView(pluginId: string): void;
}

const STATUS_LABEL: Record<AccountRuntimeStatus, string> = {
  active: '在线',
  first_sync: '首次同步',
  syncing: '同步中',
  offline: '离线',
  requires_reauth: '需重新登录',
  disabled: '已禁用',
  error: '同步失败',
};

function dotState(account: AccountView): string {
  if (!account.enabled || account.status === 'disabled') return 'disabled';
  if (account.status === 'requires_reauth') return 'reauth';
  if (account.status === 'offline' || account.status === 'error') return 'offline';
  return 'online';
}

export function Sidebar({
  accounts,
  foldersByAccount,
  activeAccountId,
  activeFolder,
  activeView,
  unified,
  collapsed = false,
  onSelectAccount,
  onSelectUnified,
  onOpenDrafts,
  draftCount,
  onOpenOutbox,
  outboxCount,
  onSelectFolder,
  onEnsureFolders,
  onOpenView,
  onOpenCalendar,
  onOpenContacts,
  pluginEntries,
  activePluginId,
  onOpenPluginView,
}: SidebarProps): JSX.Element {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  /** 文件夹树的折叠状态（键 `accountId|path`）；缺省即展开。 */
  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>({});
  /** 收藏夹（`accountId|path`）与自定义排序（`accountId|父路径` → 同级路径数组）。 */
  const [favorites, setFavorites] = useState<string[]>([]);
  const [folderOrder, setFolderOrder] = useState<Record<string, string[]>>({});
  const [copyTarget, setCopyTarget] = useState<{
    accountId: string;
    path: string;
    name: string;
    delimiter: string;
  } | null>(null);
  const [clearTarget, setClearTarget] = useState<{
    accountId: string;
    path: string;
    name: string;
    total: number;
  } | null>(null);
  const [dedupeTarget, setDedupeTarget] = useState<{
    accountId: string;
    path: string;
    name: string;
    count: number;
  } | null>(null);

  useEffect(() => {
    void window.api.getSetting(FAVORITES_KEY).then((result) => {
      if (!result.ok || !result.data) return;
      try {
        const parsed: unknown = JSON.parse(result.data);
        if (Array.isArray(parsed)) {
          setFavorites(parsed.filter((item): item is string => typeof item === 'string'));
        }
      } catch {
        // 脏数据忽略，保持空收藏
      }
    });
    void window.api.getSetting(FOLDER_ORDER_KEY).then((result) => {
      if (!result.ok || !result.data) return;
      try {
        const parsed: unknown = JSON.parse(result.data);
        if (!parsed || typeof parsed !== 'object') return;
        const next: Record<string, string[]> = {};
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (Array.isArray(value)) {
            next[key] = value.filter((item): item is string => typeof item === 'string');
          }
        }
        setFolderOrder(next);
      } catch {
        // 脏数据忽略
      }
    });
  }, []);
  const [folderMenu, setFolderMenu] = useState<FolderMenuTarget | null>(null);
  const [createTarget, setCreateTarget] = useState<{
    accountId: string;
    parentPath: string;
    parentName: string;
  } | null>(null);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [propsTarget, setPropsTarget] = useState<{
    accountId: string;
    path: string;
    name: string;
  } | null>(null);
  const [renameTarget, setRenameTarget] = useState<{
    accountId: string;
    path: string;
    name: string;
  } | null>(null);
  const [moveTarget, setMoveTarget] = useState<{
    accountId: string;
    path: string;
    name: string;
    delimiter: string;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    accountId: string;
    path: string;
    name: string;
    total: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  /**
   * 改名/移动/删除的共同收尾：处理当前打开的文件夹、刷新侧栏、清弹窗。
   * （服务端已在主进程完成，这里只同步界面。）
   */
  const afterFolderMutation = async (
    accountId: string,
    oldPath: string,
    nextPath: string | null,
  ): Promise<void> => {
    const store = useMailStore.getState();
    if (store.activeFolder === oldPath) {
      await store.selectAccountFolder(accountId, nextPath ?? 'INBOX');
    }
    await store.reloadAccountFolders(accountId);
    void store.reloadBootstrap();
  };

  const submitRename = async (name: string): Promise<void> => {
    if (!renameTarget) return;
    setBusy(true);
    setActionError(null);
    const result = await window.api.renameFolder({
      accountId: renameTarget.accountId,
      path: renameTarget.path,
      name,
    });
    setBusy(false);
    if (!result.ok) {
      setActionError(t('folder.rename.failed', { reason: result.error.message }));
      return;
    }
    useMailStore.getState().showToast(t('folder.rename.done', { name }));
    await afterFolderMutation(renameTarget.accountId, renameTarget.path, result.data.path);
    setRenameTarget(null);
  };

  const submitMove = async (targetParent: string): Promise<void> => {
    if (!moveTarget) return;
    setBusy(true);
    setActionError(null);
    const result = await window.api.moveFolder({
      accountId: moveTarget.accountId,
      path: moveTarget.path,
      targetParent,
    });
    setBusy(false);
    if (!result.ok) {
      setActionError(t('folder.move.failed', { reason: result.error.message }));
      return;
    }
    useMailStore.getState().showToast(t('folder.move.done', { path: result.data.path }));
    await afterFolderMutation(moveTarget.accountId, moveTarget.path, result.data.path);
    setMoveTarget(null);
  };

  // ---- 收藏夹与自定义排序：只存 app_settings，不动服务端 ----
  const persistFavorites = (next: string[]): void => {
    setFavorites(next);
    void window.api.setSetting(FAVORITES_KEY, JSON.stringify(next));
  };

  const persistOrder = (next: Record<string, string[]>): void => {
    setFolderOrder(next);
    void window.api.setSetting(FOLDER_ORDER_KEY, JSON.stringify(next));
  };

  const toggleFavorite = (accountId: string, path: string): void => {
    const key = `${accountId}|${path}`;
    persistFavorites(
      favorites.includes(key) ? favorites.filter((item) => item !== key) : [...favorites, key],
    );
  };

  /** 同级文件夹（按当前显示顺序），「上移/下移」要在这一串里换位置。 */
  const orderedSiblings = (accountId: string, path: string): string[] => {
    const folders = foldersByAccount[accountId] ?? [];
    const delimiter = folders.find((item) => item.path === path)?.delimiter ?? '/';
    const index = path.lastIndexOf(delimiter);
    const parent = index > 0 ? path.slice(0, index) : '';
    const parentOf = (candidate: string): string => {
      const at = candidate.lastIndexOf(delimiter);
      return at > 0 ? candidate.slice(0, at) : '';
    };
    const siblings = folders.filter((item) => parentOf(item.path) === parent).map((item) => item.path);
    const ranked = folderOrder[`${accountId}|${parent}`];
    if (ranked && ranked.length > 0) {
      const rank = new Map(ranked.map((item, at) => [item, at]));
      siblings.sort(
        (a, b) =>
          (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER),
      );
    }
    return siblings;
  };

  const moveSibling = (accountId: string, path: string, direction: -1 | 1): void => {
    const siblings = orderedSiblings(accountId, path);
    const at = siblings.indexOf(path);
    const target = at + direction;
    if (at < 0 || target < 0 || target >= siblings.length) return;
    const next = [...siblings];
    const moved = next[at] as string;
    next[at] = next[target] as string;
    next[target] = moved;
    const delimiter = (foldersByAccount[accountId] ?? []).find((item) => item.path === path)?.delimiter ?? '/';
    const index = path.lastIndexOf(delimiter);
    const parent = index > 0 ? path.slice(0, index) : '';
    persistOrder({ ...folderOrder, [`${accountId}|${parent}`]: next });
  };

  /** 清掉这一层的自定义顺序，回到默认（按名称）。 */
  const sortAscending = (accountId: string, path: string): void => {
    const delimiter = (foldersByAccount[accountId] ?? []).find((item) => item.path === path)?.delimiter ?? '/';
    const index = path.lastIndexOf(delimiter);
    const parent = index > 0 ? path.slice(0, index) : '';
    const key = `${accountId}|${parent}`;
    if (!folderOrder[key]) {
      useMailStore.getState().showToast(t('folder.sort.alreadyDefault'));
      return;
    }
    const next = { ...folderOrder };
    delete next[key];
    persistOrder(next);
    useMailStore.getState().showToast(t('folder.sort.done'));
  };

  const submitCopy = async (name: string): Promise<void> => {
    if (!copyTarget) return;
    setBusy(true);
    setActionError(null);
    const result = await window.api.copyFolder({
      accountId: copyTarget.accountId,
      path: copyTarget.path,
      name,
    });
    setBusy(false);
    if (!result.ok) {
      setActionError(t('folder.copy.failed', { reason: result.error.message }));
      return;
    }
    useMailStore.getState().showToast(
      t('folder.copy.done', { name, count: result.data.copied }),
    );
    await useMailStore.getState().reloadAccountFolders(copyTarget.accountId);
    setCopyTarget(null);
  };

  const submitClear = async (): Promise<void> => {
    if (!clearTarget) return;
    setBusy(true);
    setActionError(null);
    const result = await window.api.clearFolder(clearTarget.accountId, clearTarget.path);
    setBusy(false);
    if (!result.ok) {
      setActionError(t('folder.clear.failed', { reason: result.error.message }));
      return;
    }
    useMailStore.getState().showToast(
      t('folder.clear.done', { name: clearTarget.name, count: result.data.localRemoved }),
    );
    const store = useMailStore.getState();
    await store.reloadAccountFolders(clearTarget.accountId);
    if (store.activeFolder === clearTarget.path) await store.loadEmails();
    void store.reloadBootstrap();
    setClearTarget(null);
  };

  const submitDedupe = async (): Promise<void> => {
    if (!dedupeTarget) return;
    setBusy(true);
    setActionError(null);
    const result = await window.api.dedupeFolder(dedupeTarget.accountId, dedupeTarget.path);
    setBusy(false);
    if (!result.ok) {
      setActionError(t('folder.dedupe.failed', { reason: result.error.message }));
      return;
    }
    useMailStore.getState().showToast(
      t('folder.dedupe.done', { name: dedupeTarget.name, count: result.data.removed }),
    );
    const store = useMailStore.getState();
    await store.reloadAccountFolders(dedupeTarget.accountId);
    if (store.activeFolder === dedupeTarget.path) await store.loadEmails();
    void store.reloadBootstrap();
    setDedupeTarget(null);
  };

  const startDedupe = async (accountId: string, folder: { path: string; name: string }): Promise<void> => {
    const result = await window.api.folderDuplicates(accountId, folder.path);
    if (!result.ok) {
      useMailStore.getState().showToast(t('folder.dedupe.failed', { reason: result.error.message }));
      return;
    }
    if (result.data.count === 0) {
      useMailStore.getState().showToast(t('folder.dedupe.none'));
      return;
    }
    setActionError(null);
    setDedupeTarget({ accountId, path: folder.path, name: folder.name, count: result.data.count });
  };

  const submitDelete = async (): Promise<void> => {
    if (!deleteTarget) return;
    setBusy(true);
    setActionError(null);
    const result = await window.api.deleteFolder({
      accountId: deleteTarget.accountId,
      path: deleteTarget.path,
    });
    setBusy(false);
    if (!result.ok) {
      setActionError(t('folder.delete.failed', { reason: result.error.message }));
      return;
    }
    useMailStore.getState().showToast(
      t('folder.delete.done', { name: deleteTarget.name, count: result.data.emails }),
    );
    await afterFolderMutation(deleteTarget.accountId, deleteTarget.path, null);
    setDeleteTarget(null);
  };

  /**
   * 整文件夹标为已读：主进程先改本地再尽力同步服务端，
   * 这里刷一遍侧栏徽章与当前列表，避免界面还显示未读。
   */
  const markFolderRead = async (accountId: string, folder: FolderView): Promise<void> => {
    const result = await window.api.markFolderRead(accountId, folder.path);
    const store = useMailStore.getState();
    if (!result.ok) {
      store.showToast(t('folder.markFailed', { reason: result.error.message }));
      return;
    }
    const { marked } = result.data;
    store.showToast(
      marked > 0
        ? t('folder.marked', { folder: folder.name, count: marked })
        : t('folder.markedZero', { folder: folder.name }),
    );
    await store.reloadAccountFolders(accountId);
    if (store.activeFolder === folder.path) await store.loadEmails();
    void store.reloadBootstrap();
  };

  const createFolder = async (name: string): Promise<void> => {
    if (!createTarget) return;
    setCreateBusy(true);
    setCreateError(null);
    const result = await window.api.createFolder({
      accountId: createTarget.accountId,
      parentPath: createTarget.parentPath,
      name,
    });
    setCreateBusy(false);
    if (!result.ok) {
      setCreateError(t('folder.create.failed', { reason: result.error.message }));
      return;
    }
    useMailStore.getState().showToast(t('folder.create.done', { name }));
    await useMailStore.getState().reloadAccountFolders(createTarget.accountId);
    setCreateTarget(null);
  };

  useEffect(() => {
    if (!activeAccountId) return;
    setExpanded((current) => ({ ...current, [activeAccountId]: true }));
  }, [activeAccountId]);

  const toggle = (accountId: string): void => {
    setExpanded((current) => {
      const open = !current[accountId];
      if (open) onEnsureFolders(accountId);
      return { ...current, [accountId]: open };
    });
  };

  /** 折叠/展开单个文件夹（有子文件夹的才显示三角）。 */
  const toggleFolder = (accountId: string, path: string): void => {
    const key = `${accountId}|${path}`;
    setCollapsedFolders((current) => ({ ...current, [key]: !current[key] }));
  };

  const online = accounts.filter((account) => account.enabled && account.status !== 'disabled').length;
  const unifiedUnread = accounts
    .filter((account) => account.enabled)
    .reduce((sum, account) => sum + account.unreadCount, 0);

  // 右键菜单的可用性：系统文件夹不能改；有子文件夹时不许直接删
  const menuFolder = folderMenu
    ? foldersByAccount[folderMenu.accountId]?.find((item) => item.path === folderMenu.path)
    : undefined;
  const menuDelimiter = menuFolder?.delimiter ?? '/';
  const menuChildCount = folderMenu
    ? (foldersByAccount[folderMenu.accountId] ?? []).filter(
        (item) =>
          item.path !== folderMenu.path &&
          item.path.startsWith(`${folderMenu.path}${menuDelimiter}`),
      ).length
    : 0;
  const menuProtected = menuFolder
    ? isProtectedFolder({ path: menuFolder.path, specialUse: menuFolder.specialUse })
    : false;
  const menuSiblings =
    folderMenu && menuFolder ? orderedSiblings(folderMenu.accountId, folderMenu.path) : [];
  const menuIndex = folderMenu ? menuSiblings.indexOf(folderMenu.path) : -1;
  const folderGuards = {
    ...(menuProtected
      ? { rename: t('folder.menu.whyProtected'), move: t('folder.menu.whyProtected') }
      : {}),
    ...(menuProtected
      ? { remove: t('folder.menu.whyProtected') }
      : menuChildCount > 0
        ? { remove: t('folder.menu.whyHasChildren', { count: menuChildCount }) }
        : {}),
    ...(menuChildCount > 0
      ? { copy: t('folder.menu.whyHasChildren', { count: menuChildCount }) }
      : {}),
    ...(menuFolder && menuFolder.total === 0 ? { clear: t('folder.menu.whyEmpty') } : {}),
    ...(menuIndex <= 0 ? { moveUp: t('folder.menu.whyTop') } : {}),
    ...(menuIndex < 0 || menuIndex === menuSiblings.length - 1
      ? { moveDown: t('folder.menu.whyBottom') }
      : {}),
  };

  /** 某一账户的自定义顺序（键从 `accountId|父路径` 剥成 `父路径`）。 */
  const orderForAccount = (accountId: string): Record<string, string[]> => {
    const prefix = `${accountId}|`;
    const result: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(folderOrder)) {
      if (key.startsWith(prefix)) result[key.slice(prefix.length)] = value;
    }
    return result;
  };

  const favoriteFolders = favorites
    .map((key) => {
      const at = key.indexOf('|');
      if (at <= 0) return null;
      const accountId = key.slice(0, at);
      const path = key.slice(at + 1);
      const folder = (foldersByAccount[accountId] ?? []).find((item) => item.path === path);
      return folder ? { accountId, folder } : null;
    })
    .filter((item): item is { accountId: string; folder: FolderView } => item !== null);

  // 移动目标：根目录 + 除自己与自身子目录外的所有文件夹（防止造出环）
  const moveCandidates = moveTarget
    ? [
        { path: '', label: t('folder.move.root') },
        ...(foldersByAccount[moveTarget.accountId] ?? [])
          .filter(
            (item) => !isSameOrDescendantPath(item.path, moveTarget.path, moveTarget.delimiter),
          )
          .map((item) => ({ path: item.path, label: item.path })),
      ]
    : [];

  // 图标模式：不渲染文件树，只显示几个顶层导航图标按钮（收件箱/草稿/发件箱/日历 + 设置/主题/插件）
  if (collapsed) {
    const atMailRoot =
      activeView === 'mail' && activeFolder !== DRAFTS_FOLDER && activeFolder !== OUTBOX_FOLDER;
    const goInbox = (): void => {
      if (accounts.length > 1) {
        onSelectUnified();
        return;
      }
      const id = activeAccountId ?? accounts[0]?.id;
      if (id) onSelectAccount(id);
      else onOpenView('mail');
    };
    return (
      <aside className="sidebar sidebar-collapsed" aria-label="快捷导航">
        <nav className="sidebar-rail" aria-label="主要视图">
          <button
            type="button"
            className={`rail-btn${atMailRoot ? ' active' : ''}`}
            title="收件箱"
            aria-label="收件箱"
            aria-current={atMailRoot}
            onClick={goInbox}
          >
            <span className="rail-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="4" width="20" height="16" rx="2" />
                <path d="M22 7l-10 6L2 7" />
              </svg>
            </span>
          </button>
          <button
            type="button"
            className={`rail-btn${activeView === 'mail' && activeFolder === DRAFTS_FOLDER ? ' active' : ''}`}
            title={`草稿箱${draftCount > 0 ? `（${draftCount}）` : ''}`}
            aria-label="草稿箱"
            aria-current={activeView === 'mail' && activeFolder === DRAFTS_FOLDER}
            onClick={onOpenDrafts}
          >
            <span className="rail-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
              </svg>
            </span>
            {draftCount > 0 ? <span className="account-badge rail-badge">{draftCount}</span> : null}
          </button>
          <button
            type="button"
            className={`rail-btn${activeView === 'mail' && activeFolder === OUTBOX_FOLDER ? ' active' : ''}`}
            title={`发件箱${outboxCount > 0 ? `（${outboxCount}）` : ''}`}
            aria-label="发件箱"
            aria-current={activeView === 'mail' && activeFolder === OUTBOX_FOLDER}
            onClick={onOpenOutbox}
          >
            <span className="rail-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 2 11 13" />
                <path d="M22 2 15 22l-4-9-9-4z" />
              </svg>
            </span>
            {outboxCount > 0 ? <span className="account-badge rail-badge">{outboxCount}</span> : null}
          </button>
          <button
            type="button"
            className="rail-btn"
            title="日历"
            aria-label="日历"
            onClick={onOpenCalendar}
          >
            <span className="rail-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="18" rx="2" />
                <path d="M16 2v4M8 2v4M3 10h18" />
              </svg>
            </span>
          </button>
        </nav>

        <div className="sidebar-rail sidebar-rail-bottom" aria-label="邮件、日历与联系人">
          <button
            type="button"
            className={`rail-btn${activeView === 'mail' ? ' active' : ''}`}
            title="邮件"
            aria-label="邮件"
            aria-current={activeView === 'mail'}
            onClick={() => onOpenView('mail')}
          >
            <span className="rail-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="4" width="20" height="16" rx="2" />
                <path d="M22 7l-10 6L2 7" />
              </svg>
            </span>
          </button>
          <button
            type="button"
            className="rail-btn"
            title="日历"
            aria-label="日历"
            onClick={onOpenCalendar}
          >
            <span className="rail-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="18" rx="2" />
                <path d="M16 2v4M8 2v4M3 10h18" />
              </svg>
            </span>
          </button>
          <button
            type="button"
            className="rail-btn"
            title="联系人"
            aria-label="联系人"
            onClick={onOpenContacts}
          >
            <span className="rail-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
            </span>
          </button>
          {pluginEntries.map((entry) => {
            const active = activeView === 'plugin' && activePluginId === entry.id;
            return (
              <button
                key={`plugin-rail-${entry.id}`}
                type="button"
                className={`rail-btn${active ? ' active' : ''}`}
                title={entry.name}
                aria-label={entry.name}
                aria-current={active}
                onClick={() => onOpenPluginView(entry.id)}
              >
                <span className="rail-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="7" height="7" rx="1.6" />
                    <rect x="14" y="3" width="7" height="7" rx="1.6" />
                    <rect x="3" y="14" width="7" height="7" rx="1.6" />
                    <path d="M17.5 14v7M14 17.5h7" />
                  </svg>
                </span>
              </button>
            );
          })}
        </div>
      </aside>
    );
  }

  return (
    <aside className={`sidebar${collapsed ? ' sidebar-collapsed' : ''}`} aria-label="账户与文件夹">
      <div className="sidebar-tree-wrap">
        <div className="sidebar-section">
          <div className="sidebar-label">收件箱</div>
          {accounts.length > 1 ? (
            <button
              type="button"
              className={`nav-item${unified && activeView === 'mail' ? ' active' : ''}`}
              aria-current={unified && activeView === 'mail'}
              onClick={onSelectUnified}
            >
              <span className="account-color" style={{ backgroundColor: '#2563eb' }} aria-hidden="true">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.4">
                  <path d="M22 12h-6l-2 3h-4l-2-3H2" />
                  <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
                </svg>
              </span>
              <span className="account-name">统一收件箱</span>
              {unifiedUnread > 0 ? <span className="account-badge">{unifiedUnread}</span> : null}
            </button>
          ) : (
            <p className="hint sidebar-hint">添加第二个账户后会出现统一收件箱。</p>
          )}

          <button
            type="button"
            className={`nav-item${activeView === 'mail' && activeFolder === DRAFTS_FOLDER ? ' active' : ''}`}
            aria-current={activeView === 'mail' && activeFolder === DRAFTS_FOLDER}
            onClick={onOpenDrafts}
          >
            <span className="account-color" style={{ backgroundColor: '#0d9488' }} aria-hidden="true">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.4">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
              </svg>
            </span>
            <span className="account-name">草稿箱</span>
            <span className={`account-badge${draftCount > 0 ? '' : ' account-badge-muted'}`}>
              {draftCount}
            </span>
          </button>

          <button
            type="button"
            className={`nav-item${activeView === 'mail' && activeFolder === OUTBOX_FOLDER ? ' active' : ''}`}
            aria-current={activeView === 'mail' && activeFolder === OUTBOX_FOLDER}
            title="本机发送队列：定时、排队、已发送记录"
            onClick={onOpenOutbox}
          >
            <span className="account-color" style={{ backgroundColor: '#b45309' }} aria-hidden="true">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2">
                <path d="M22 2 11 13" />
                <path d="M22 2 15 22l-4-9-9-4z" />
              </svg>
            </span>
            <span className="account-name">发件箱</span>
            <span className={`account-badge${outboxCount > 0 ? '' : ' account-badge-muted'}`}>
              {outboxCount}
            </span>
          </button>
        </div>

        {favoriteFolders.length > 0 ? (
          <div className="sidebar-section">
            <div className="sidebar-label">收藏</div>
            {favoriteFolders.map(({ accountId, folder }) => {
              const isActive =
                activeView === 'mail' &&
                !unified &&
                activeAccountId === accountId &&
                activeFolder === folder.path;
              return (
                <button
                  key={`${accountId}|${folder.path}`}
                  type="button"
                  className={`nav-item${isActive ? ' active' : ''}`}
                  aria-current={isActive}
                  onClick={() => onSelectFolder(accountId, folder.path)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setFolderMenu({
                      x: event.clientX,
                      y: event.clientY,
                      accountId,
                      path: folder.path,
                      name: folder.name,
                    });
                  }}
                >
                  <span
                    className="account-color"
                    style={{ backgroundColor: '#0ea5e9' }}
                    aria-hidden="true"
                  >
                    ★
                  </span>
                  <span className="account-name">{folder.name}</span>
                  {folder.unread > 0 ? <span className="account-badge">{folder.unread}</span> : null}
                </button>
              );
            })}
          </div>
        ) : null}

        <div className="sidebar-section">
          <div className="sidebar-label">
            账户{accounts.length > 0 ? `（${online} 个在线）` : ''}
          </div>

          {accounts.length === 0 ? (
            <button type="button" className="account-empty" onClick={() => onOpenView('settings')}>
              尚未添加账户，点击添加
            </button>
          ) : (
            <div className="account-tree" role="tree" aria-label="账户与文件夹">
              {accounts.map((account) => {
                const open = expanded[account.id] ?? false;
                const folders = foldersByAccount[account.id];
                // 扁平列表 → 树（套用自定义顺序）→ 按折叠状态压平成要渲染的行
                const tree = buildFolderTree(folders ?? []);
                applyFolderOrder(tree, orderForAccount(account.id));
                const folderRows = flattenFolderTree(
                  tree,
                  (path) => collapsedFolders[`${account.id}|${path}`] === true,
                );
                const active = !unified && activeView === 'mail' && account.id === activeAccountId;
                const tag = accountTagFor(account);
                const dot = dotState(account);

                return (
                  <div className="account-node" role="treeitem" aria-expanded={open} key={account.id}>
                    <div
                      className={`account-item${active ? ' active' : ''}${account.enabled ? '' : ' disabled'}${dot === 'reauth' ? ' reauth' : ''}`}
                      data-account-id={account.id}
                    >
                      <span
                        className="account-color"
                        style={{ backgroundColor: tag.color }}
                        aria-hidden="true"
                      >
                        {tag.label.slice(0, 1)}
                      </span>
                      <button
                        type="button"
                        className="account-main"
                        title={`${account.displayName} <${account.email}>`}
                        onClick={() => {
                          onSelectAccount(account.id);
                          setExpanded((current) => ({ ...current, [account.id]: true }));
                          onEnsureFolders(account.id);
                        }}
                      >
                        <span className="account-name">{account.displayName}</span>
                      </button>
                      <span
                        className={`account-dot ${dot}`}
                        title={STATUS_LABEL[account.status]}
                        aria-label={STATUS_LABEL[account.status]}
                      />
                      {account.unreadCount > 0 ? (
                        <span className="account-badge" aria-label={`${account.unreadCount} 封未读`}>
                          {account.unreadCount}
                        </span>
                      ) : null}
                      <button
                        type="button"
                        className="tree-toggle"
                        aria-label={open ? `收起 ${account.displayName}` : `展开 ${account.displayName}`}
                        onClick={() => toggle(account.id)}
                      >
                        {open ? '▾' : '▸'}
                      </button>
                    </div>

                    {open ? (
                      <ul className="tree-folder-list" role="group">
                        {folderRows.map((node) => {
                          const folder = node.folder;
                          const hasChildren = node.children.length > 0;
                          const collapsed = collapsedFolders[`${account.id}|${folder.path}`] === true;
                          return (
                            <li
                              key={`${account.id}-${folder.path}`}
                              className="tree-folder-row"
                              style={{ paddingLeft: `${node.depth * 16}px` }}
                            >
                              {hasChildren ? (
                                <button
                                  type="button"
                                  className="tree-folder-toggle"
                                  aria-label={
                                    collapsed ? `展开 ${folder.name}` : `收起 ${folder.name}`
                                  }
                                  aria-expanded={!collapsed}
                                  onClick={() => toggleFolder(account.id, folder.path)}
                                >
                                  {collapsed ? '▸' : '▾'}
                                </button>
                              ) : (
                                <span className="tree-folder-toggle placeholder" aria-hidden="true" />
                              )}
                              <button
                                type="button"
                                className="tree-folder"
                                aria-current={
                                  activeView === 'mail' &&
                                  !unified &&
                                  activeAccountId === account.id &&
                                  activeFolder === folder.path
                                }
                                onContextMenu={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  setFolderMenu({
                                    x: event.clientX,
                                    y: event.clientY,
                                    accountId: account.id,
                                    path: folder.path,
                                    name: folder.name,
                                  });
                                }}
                                onClick={() => onSelectFolder(account.id, folder.path)}
                              >
                                <span className="tree-folder-icon" aria-hidden="true">
                                  <svg
                                    viewBox="0 0 24 24"
                                    width="13"
                                    height="13"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.8"
                                  >
                                    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                                  </svg>
                                </span>
                                <span className="tree-folder-name">{folder.name}</span>
                                {folder.unread > 0 ? (
                                  <span className="folder-count" aria-label={`${folder.unread} 封未读`}>
                                    {folder.unread}
                                  </span>
                                ) : null}
                              </button>
                            </li>
                          );
                        })}
                        {folders && folders.length === 0 ? (
                          <li>
                            <p className="hint tree-hint">尚未发现文件夹。</p>
                          </li>
                        ) : null}
                        {!folders ? (
                          <li>
                            <p className="hint tree-hint">正在读取文件夹…</p>
                          </li>
                        ) : null}
                      </ul>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>

      </div>

      <div className="sidebar-tools">
        <button
          type="button"
          aria-current={activeView === 'mail'}
          onClick={() => onOpenView('mail')}
          title="邮件"
        >
          <span className="tool-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="M22 7l-10 6L2 7" />
            </svg>
          </span>
        </button>
        <button type="button" onClick={onOpenCalendar} title="日历">
          <span className="tool-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="18" rx="2" />
              <path d="M16 2v4M8 2v4M3 10h18" />
            </svg>
          </span>
        </button>
        <button type="button" onClick={onOpenContacts} title="联系人">
          <span className="tool-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          </span>
        </button>
        {pluginEntries.map((entry) => {
          const active = activeView === 'plugin' && activePluginId === entry.id;
          return (
            <button
              key={`plugin-tool-${entry.id}`}
              type="button"
              aria-current={active}
              onClick={() => onOpenPluginView(entry.id)}
              title={entry.name}
            >
              <span className="tool-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="7" height="7" rx="1.6" />
                  <rect x="14" y="3" width="7" height="7" rx="1.6" />
                  <rect x="3" y="14" width="7" height="7" rx="1.6" />
                  <path d="M17.5 14v7M14 17.5h7" />
                </svg>
              </span>
            </button>
          );
        })}
      </div>

      {folderMenu ? (
        <FolderContextMenu
          target={folderMenu}
          guards={folderGuards}
          favorite={favorites.includes(`${folderMenu.accountId}|${folderMenu.path}`)}
          onClose={() => setFolderMenu(null)}
          onOpenWindow={() => {
            void window.api.openFolderWindow(folderMenu.accountId, folderMenu.path);
          }}
          onNewFolder={() =>
            setCreateTarget({
              accountId: folderMenu.accountId,
              parentPath: folderMenu.path,
              parentName: folderMenu.name,
            })
          }
          onRename={() => {
            setActionError(null);
            setRenameTarget({
              accountId: folderMenu.accountId,
              path: folderMenu.path,
              name: folderMenu.name,
            });
          }}
          onCopy={() => {
            setActionError(null);
            setCopyTarget({
              accountId: folderMenu.accountId,
              path: folderMenu.path,
              name: folderMenu.name,
              delimiter: menuDelimiter,
            });
          }}
          onMove={() => {
            setActionError(null);
            setMoveTarget({
              accountId: folderMenu.accountId,
              path: folderMenu.path,
              name: folderMenu.name,
              delimiter: menuDelimiter,
            });
          }}
          onRemove={() => {
            setActionError(null);
            setDeleteTarget({
              accountId: folderMenu.accountId,
              path: folderMenu.path,
              name: folderMenu.name,
              total: menuFolder?.total ?? 0,
            });
          }}
          onMarkAllRead={() => {
            const accountId = folderMenu.accountId;
            const folder = foldersByAccount[accountId]?.find(
              (item) => item.path === folderMenu.path,
            );
            if (folder) void markFolderRead(accountId, folder);
          }}
          onCleanup={() => void startDedupe(folderMenu.accountId, folderMenu)}
          onClear={() => {
            setActionError(null);
            setClearTarget({
              accountId: folderMenu.accountId,
              path: folderMenu.path,
              name: folderMenu.name,
              total: menuFolder?.total ?? 0,
            });
          }}
          onToggleFavorite={() => toggleFavorite(folderMenu.accountId, folderMenu.path)}
          onSortAsc={() => sortAscending(folderMenu.accountId, folderMenu.path)}
          onMoveUp={() => moveSibling(folderMenu.accountId, folderMenu.path, -1)}
          onMoveDown={() => moveSibling(folderMenu.accountId, folderMenu.path, 1)}
          onProperties={() =>
            setPropsTarget({
              accountId: folderMenu.accountId,
              path: folderMenu.path,
              name: folderMenu.name,
            })
          }
        />
      ) : null}

      {createTarget ? (
        <TextPromptDialog
          title={t('folder.create.title')}
          hint={
            createTarget.parentPath
              ? t('folder.create.hintParent', { parent: createTarget.parentName })
              : t('folder.create.hintRoot')
          }
          placeholder={t('folder.create.placeholder')}
          confirmLabel={t('folder.create.submit')}
          busy={createBusy}
          error={createError}
          onSubmit={(name) => void createFolder(name)}
          onClose={() => {
            setCreateTarget(null);
            setCreateError(null);
          }}
        />
      ) : null}

      {propsTarget ? (
        <FolderPropertiesDialog
          accountId={propsTarget.accountId}
          folder={propsTarget.path}
          name={propsTarget.name}
          onClose={() => setPropsTarget(null)}
        />
      ) : null}

      {renameTarget ? (
        <TextPromptDialog
          title={t('folder.rename.title')}
          hint={t('folder.rename.hint', { path: renameTarget.path })}
          placeholder={t('folder.create.placeholder')}
          confirmLabel={t('folder.rename.submit')}
          initialValue={renameTarget.name}
          busy={busy}
          error={actionError}
          onSubmit={(name) => void submitRename(name)}
          onClose={() => {
            setRenameTarget(null);
            setActionError(null);
          }}
        />
      ) : null}

      {moveTarget ? (
        <FolderMoveDialog
          folderName={moveTarget.name}
          currentParent={parentPathOf(moveTarget.path, moveTarget.delimiter)}
          candidates={moveCandidates}
          busy={busy}
          error={actionError}
          onSubmit={(targetParent) => void submitMove(targetParent)}
          onClose={() => {
            setMoveTarget(null);
            setActionError(null);
          }}
        />
      ) : null}

      {deleteTarget ? (
        <ConfirmDialog
          title={t('folder.delete.title')}
          message={t('folder.delete.message', { name: deleteTarget.name })}
          hint={t('folder.delete.hint', { count: deleteTarget.total })}
          confirmLabel={t('folder.delete.submit')}
          danger
          busy={busy}
          error={actionError}
          onConfirm={() => void submitDelete()}
          onClose={() => {
            setDeleteTarget(null);
            setActionError(null);
          }}
        />
      ) : null}

      {copyTarget ? (
        <TextPromptDialog
          title={t('folder.copy.title')}
          hint={t('folder.copy.hint', { name: copyTarget.name })}
          placeholder={t('folder.create.placeholder')}
          confirmLabel={t('folder.copy.submit')}
          initialValue={t('folder.copy.defaultName', { name: copyTarget.name })}
          busy={busy}
          error={actionError}
          onSubmit={(name) => void submitCopy(name)}
          onClose={() => {
            setCopyTarget(null);
            setActionError(null);
          }}
        />
      ) : null}

      {clearTarget ? (
        <ConfirmDialog
          title={t('folder.clear.title')}
          message={t('folder.clear.message', { name: clearTarget.name })}
          hint={t('folder.clear.hint', { count: clearTarget.total })}
          confirmLabel={t('folder.clear.submit')}
          danger
          busy={busy}
          error={actionError}
          onConfirm={() => void submitClear()}
          onClose={() => {
            setClearTarget(null);
            setActionError(null);
          }}
        />
      ) : null}

      {dedupeTarget ? (
        <ConfirmDialog
          title={t('folder.dedupe.title')}
          message={t('folder.dedupe.message', {
            name: dedupeTarget.name,
            count: dedupeTarget.count,
          })}
          hint={t('folder.dedupe.hint')}
          confirmLabel={t('folder.dedupe.submit')}
          danger
          busy={busy}
          error={actionError}
          onConfirm={() => void submitDedupe()}
          onClose={() => {
            setDedupeTarget(null);
            setActionError(null);
          }}
        />
      ) : null}
    </aside>
  );
}
