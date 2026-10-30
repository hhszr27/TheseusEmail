import { create } from 'zustand';
import type {
  BootstrapData,
  ComposeDraft,
  GetBodyResponse,
  ListFilter,
  ListSort,
  ScheduledSendInfo,
  SyncStateView,
} from '../../shared/ipc';
import type { EmailSummary, FolderView } from '../../shared/types';
import type { PluginRegistrySnapshot } from '../../shared/plugin';
import { THEME_SETTING_KEY } from '../../shared/theme';
import { applyTheme as applyThemeToDocument } from '../lib/theme';
import { dropsFromFilteredList, needsFilteredReload } from '../lib/list-filter';
import { readMarkReadDelay } from '../lib/reading-settings';

export type WorkspaceView =
  | 'mail'
  | 'settings'
  | 'theme'
  | 'plugins'
  | 'calendar'
  /** 联系人视图（右侧主区域，不再弹窗）。 */
  | 'contacts'
  /** 插件贡献的侧栏条目视图（`views['sidebar-item']`），具体插件由 activePluginView 决定。 */
  | 'plugin';

/** 草稿箱不是 IMAP 文件夹，用保留路径表示（不会与服务器路径冲突）。 */
export const DRAFTS_FOLDER = '__drafts__';

/** 发件箱同理：它是本机发送队列的视图（定时/排队/已发送/失败），不是服务器文件夹。 */
export const OUTBOX_FOLDER = '__outbox__';

interface MailState {
  bootstrap: BootstrapData | null;
  activeView: WorkspaceView;
  activeAccountId: string | null;
  activeFolder: string;
  folders: FolderView[];
  /** 每个账户的文件夹，供侧栏树形结构使用。 */
  foldersByAccount: Record<string, FolderView[]>;
  emails: EmailSummary[];
  total: number;
  selectedEmailId: string | null;
  /** 从搜索结果选中的邮件不在当前列表内时，用这份快照渲染阅读区。 */
  externalSelected: EmailSummary | null;
  unified: boolean;
  body: GetBodyResponse | null;
  bodyLoading: boolean;
  listLoading: boolean;
  error: string | null;
  syncState: SyncStateView | null;
  allowRemoteImages: boolean;
  /** 全局轻提示文案（发送成功等），null 表示不显示。 */
  toast: string | null;
  pluginSnapshot: PluginRegistrySnapshot | null;
  themeId: string;
  searchQuery: string;
  searchActive: boolean;
  /** 勾选后跨账户搜索（包括禁用账户，§7.8.2）。 */
  searchAllAccounts: boolean;
  /** 列表筛选口径（全部 / 未读 / 已标记，§7.8.2），列表与搜索共用。 */
  listFilter: ListFilter;
  /** 列表排列方式（日期 / 发件人 / 主题 / 附件 / 帐户），列表与搜索共用。 */
  listSort: ListSort;
  /** 本地草稿（跨账户），草稿箱视图使用。 */
  drafts: ComposeDraft[];
  draftsLoading: boolean;
  /** 本机发送队列（跨账户），发件箱视图使用。 */
  outbox: ScheduledSendInfo[];
  outboxLoading: boolean;

  init(): Promise<void>;
  setView(view: WorkspaceView): void;
  loadFoldersForAccounts(): Promise<void>;
  ensureAccountFolders(accountId: string): Promise<void>;
  /** 强制刷新文件夹列表（改名/新建/删除后必须用这个，ensure 版本有缓存）。 */
  reloadAccountFolders(accountId: string): Promise<void>;
  selectAccountFolder(accountId: string, folder: string): Promise<void>;
  loadEmails(): Promise<void>;
  loadPlugins(): Promise<void>;
  reloadBootstrap(): Promise<void>;
  selectAccount(accountId: string): Promise<void>;
  setAccountEnabled(accountId: string, enabled: boolean): Promise<void>;
  selectFolder(folder: string): Promise<void>;
  selectEmail(emailId: string, summary?: EmailSummary): Promise<void>;
  snooze(emailId: string, until: number | null): Promise<void>;
  refresh(): Promise<void>;
  setAllowRemoteImages(value: boolean): Promise<void>;
  applyTheme(themeId: string): Promise<void>;
  search(query: string): Promise<void>;
  clearSearch(): Promise<void>;
  setSearchAllAccounts(value: boolean): Promise<void>;
  /** 切换筛选口径；切换后按新口径重查（搜索中则重搜）。 */
  setListFilter(filter: ListFilter): Promise<void>;
  /** 切换排列方式；切换后按新口径重查（搜索中则重搜）。 */
  setListSort(sort: ListSort): Promise<void>;
  setPinned(emailId: string, pinned: boolean): Promise<void>;
  setEmailFlags(emailId: string, patch: { read?: boolean; starred?: boolean }): Promise<void>;
  archiveEmail(emailId: string): Promise<void>;
  moveEmail(emailId: string, folder: string): Promise<void>;
  deleteEmail(emailId: string): Promise<void>;
  loadDrafts(force?: boolean): Promise<void>;
  refreshDrafts(): Promise<void>;
  openDrafts(): Promise<void>;
  discardDraft(draft: ComposeDraft): Promise<void>;
  loadOutbox(): Promise<void>;
  openOutbox(): Promise<void>;
  cancelOutboxSend(id: string): Promise<void>;
  applySyncState(state: SyncStateView): void;
  setError(message: string | null): void;
  showToast(message: string): void;
}

let loadToken = 0;
let bodyToken = 0;
let toastTimer: number | null = null;

/**
 * 筛选口径/排列方式变化后的重查。
 * 旧选中大概率不在新列表里，先清掉阅读区，由 loadEmails 自动选中第一封；
 * 搜索态下同理重跑搜索，否则只重载当前文件夹。
 */
async function reloadForListQuery(
  set: (partial: Partial<MailState>) => void,
  get: () => MailState,
): Promise<void> {
  set({
    selectedEmailId: null,
    externalSelected: null,
    body: null,
    emails: [],
    total: 0,
  });
  if (get().searchActive && get().searchQuery) {
    await get().search(get().searchQuery);
  } else {
    await get().loadEmails();
  }
}

/**
 * 「打开 N 秒后再标已读」的定时器。
 *
 * 同一时刻只可能有一封邮件处于打开状态，所以用单例定时器即可。切换邮件时取消
 * 上一封的定时器 —— 这正是延迟设置的意义：停留不足 N 秒就切走，邮件保持未读。
 */
let markReadTimer: ReturnType<typeof setTimeout> | null = null;

function cancelPendingMarkRead(): void {
  if (markReadTimer !== null) {
    clearTimeout(markReadTimer);
    markReadTimer = null;
  }
}

export const useMailStore = create<MailState>()((set, get) => ({
  bootstrap: null,
  activeView: 'mail',
  activeAccountId: null,
  activeFolder: 'INBOX',
  folders: [],
  foldersByAccount: {},
  emails: [],
  total: 0,
  selectedEmailId: null,
  externalSelected: null,
  unified: false,
  body: null,
  bodyLoading: false,
  listLoading: false,
  error: null,
  syncState: null,
  allowRemoteImages: false,
  toast: null,
  pluginSnapshot: null,
  themeId: 'builtin:light',
  searchQuery: '',
  searchActive: false,
  searchAllAccounts: false,
  listFilter: 'all',
  listSort: 'date',
  drafts: [],
  draftsLoading: false,
  outbox: [],
  outboxLoading: false,

  async init() {
    const result = await window.api.getBootstrap();
    if (!result.ok) {
      set({ error: result.error.message });
      return;
    }
    const data = result.data;
    // 多账户时默认进入统一收件箱（§7.8.2）；单账户保持账户视图
    const multiAccount = data.accounts.filter((account) => account.enabled).length > 1;
    set({
      bootstrap: data,
      activeAccountId: data.activeAccountId,
      activeFolder: data.defaultFolder,
      unified: multiAccount,
      folders: data.folders,
      error: null,
    });

    await get().loadPlugins();

    const savedTheme = await window.api.getSetting(THEME_SETTING_KEY);
    const themeId = savedTheme.ok && savedTheme.data ? savedTheme.data : 'builtin:light';
    await get().applyTheme(themeId);

    await get().loadFoldersForAccounts();
    await get().loadEmails();
    // 发件箱角标（待发/发送中）在启动时就要准确，不必等用户点进去
    void get().loadOutbox();
  },

  setView(view) {
    set({ activeView: view });
  },

  async loadFoldersForAccounts() {
    const accounts = get().bootstrap?.accounts ?? [];
    const entries = await Promise.all(
      accounts.map(async (account) => {
        const result = await window.api.getFolders(account.id);
        return [account.id, result.ok ? result.data : []] as const;
      }),
    );
    set({ foldersByAccount: Object.fromEntries(entries) });
  },

  async ensureAccountFolders(accountId) {
    if (get().foldersByAccount[accountId]) return;
    await get().reloadAccountFolders(accountId);
  },

  /**
   * 强制重新拉取文件夹列表。
   * 新建/改名/移动/删除/整批标已读之后必须走这个——ensureAccountFolders 有缓存，
   * 再调一次什么也不会发生（侧栏会一直显示旧列表）。
   */
  async reloadAccountFolders(accountId) {
    const result = await window.api.getFolders(accountId);
    if (!result.ok) return;
    set({
      foldersByAccount: { ...get().foldersByAccount, [accountId]: result.data },
    });
  },

  async selectAccountFolder(accountId, folder) {
    set({
      activeView: 'mail',
      activeAccountId: accountId,
      activeFolder: folder,
      unified: false,
      selectedEmailId: null,
      externalSelected: null,
      body: null,
      emails: [],
      total: 0,
      searchActive: false,
      searchQuery: '',
    });
    void window.api.setPluginActiveEmail(null);
    void window.api.prioritizeAccount(accountId);
    const result = await window.api.getFolders(accountId);
    if (result.ok) {
      set({
        folders: result.data,
        foldersByAccount: { ...get().foldersByAccount, [accountId]: result.data },
      });
    }
    await get().loadEmails();
  },

  async loadPlugins() {
    const result = await window.api.pluginsRegistry();
    if (!result.ok) {
      set({ error: result.error.message });
      return;
    }
    const snapshot = result.data;
    const ready = snapshot.plugins.filter(
      (plugin) => plugin.status === 'ready' && plugin.enabled,
    );
    set({ pluginSnapshot: snapshot });

    if (get().themeId.startsWith('builtin:') === false) {
      const themeExists = snapshot.themes.some((theme) => theme.id === get().themeId);
      if (!themeExists) {
        await get().applyTheme('builtin:light');
      }
    }
  },

  async reloadBootstrap() {
    const result = await window.api.getBootstrap();
    if (!result.ok) {
      set({ error: result.error.message });
      return;
    }
    const data = result.data;
    const current = get().activeAccountId;
    const stillExists = Boolean(current && data.accounts.some((account) => account.id === current));
    const nextId = stillExists
      ? current
      : (data.accounts.find((account) => account.enabled)?.id ?? data.accounts[0]?.id ?? null);

    set({ bootstrap: data, activeAccountId: nextId });
    if (!stillExists) {
      set({
        folders: data.folders,
        emails: [],
        total: 0,
        selectedEmailId: null,
        externalSelected: null,
        body: null,
      });
    }
    if (!get().unified && nextId) {
      const folders = await window.api.getFolders(nextId);
      if (folders.ok) set({ folders: folders.data });
    }
    await get().loadFoldersForAccounts();
    if (!get().searchActive) await get().loadEmails();
  },

  async selectAccount(accountId) {
    const state = get();
    if (state.activeAccountId === accountId && !state.unified) return;
    set({
      activeView: 'mail',
      activeAccountId: accountId,
      unified: false,
      activeFolder: 'INBOX',
      selectedEmailId: null,
      externalSelected: null,
      body: null,
      emails: [],
      total: 0,
      searchActive: false,
      searchQuery: '',
    });
    void window.api.setPluginActiveEmail(null);
    void window.api.prioritizeAccount(accountId);
    const folders = await window.api.getFolders(accountId);
    if (folders.ok) {
      set({
        folders: folders.data,
        foldersByAccount: { ...get().foldersByAccount, [accountId]: folders.data },
      });
    }
    await get().loadEmails();
  },

  async setAccountEnabled(accountId, enabled) {
    const result = await window.api.setAccountEnabled(accountId, enabled);
    if (!result.ok) {
      set({ error: result.error.message });
      return;
    }
    await get().reloadBootstrap();
  },

  async loadEmails() {
    const { activeAccountId, activeFolder, unified, listFilter, listSort } = get();
    if (activeFolder === DRAFTS_FOLDER) {
      await get().loadDrafts();
      return;
    }
    if (activeFolder === OUTBOX_FOLDER) {
      await get().loadOutbox();
      return;
    }
    if (!unified && !activeAccountId) {
      set({ emails: [], total: 0 });
      return;
    }

    const token = ++loadToken;
    set({ listLoading: true, error: null });

    const result = await window.api.listEmails({
      accountId: unified ? '__all__' : (activeAccountId as string),
      folder: unified ? 'INBOX' : activeFolder,
      offset: 0,
      limit: 200,
      filter: listFilter,
      sort: listSort,
    });

    if (token !== loadToken) return;

    if (!result.ok) {
      set({ listLoading: false, error: result.error.message });
      return;
    }

    set({
      emails: result.data.emails,
      total: result.data.total,
      listLoading: false,
    });

    // 首屏自动选中第一封，阅读区不会停在大片空白上
    const state = get();
    if (!state.selectedEmailId && state.activeView === 'mail' && result.data.emails[0]) {
      await get().selectEmail(result.data.emails[0].id);
    }
  },

  async selectFolder(folder) {
    if (get().activeFolder === folder && !get().searchActive) return;
    set({
      activeView: 'mail',
      activeFolder: folder,
      unified: folder === '__all__',
      selectedEmailId: null,
      externalSelected: null,
      body: null,
      emails: [],
      total: 0,
      searchActive: false,
      searchQuery: '',
    });
    void window.api.setPluginActiveEmail(null);
    await get().loadEmails();
  },

  async selectEmail(emailId, summary) {
    const { bootstrap, selectedEmailId } = get();
    if (!bootstrap) return;
    if (selectedEmailId === emailId && get().body) return;

    // 切走时取消上一封「延迟标已读」的定时器：停留不足设定秒数就保持未读
    cancelPendingMarkRead();

    set({
      activeView: 'mail',
      selectedEmailId: emailId,
      externalSelected: summary ?? null,
      bodyLoading: true,
      body: null,
      error: null,
    });
    const token = ++bodyToken;

    void window.api.setPluginActiveEmail(emailId);

    const result = await window.api.getBody({
      emailId,
      allowRemoteImages: get().allowRemoteImages,
    });

    if (token !== bodyToken) return;

    if (!result.ok) {
      set({ bodyLoading: false, error: result.error.message });
      return;
    }

    set({ body: result.data, bodyLoading: false });

    // 打开即已读（§8 \Seen）：按设置可延迟 N 秒，避免「扫一眼」就被标已读。
    // 默认 0 = 立即标，行为与之前一致。
    const opened = get().emails.find((email) => email.id === emailId) ?? summary;
    if (!opened?.unread) return;

    const delaySeconds = await readMarkReadDelay();
    // 读取设置期间可能已切走或已标已读，只在仍是当前选中且仍未读时继续
    if (token !== bodyToken || get().selectedEmailId !== emailId) return;
    if (!get().emails.find((email) => email.id === emailId)?.unread) return;

    if (delaySeconds === 0) {
      void get().setEmailFlags(emailId, { read: true });
      return;
    }

    markReadTimer = setTimeout(() => {
      markReadTimer = null;
      // 定时器到点时仍停留在同一封且仍未读，才真正标已读
      if (get().selectedEmailId === emailId && get().emails.find((email) => email.id === emailId)?.unread) {
        void get().setEmailFlags(emailId, { read: true });
      }
    }, delaySeconds * 1000);
  },

  async snooze(emailId, until) {
    const result = await window.api.snoozeEmail(emailId, until);
    if (!result.ok) {
      set({ error: result.error.message });
      return;
    }
    const { emails, total, selectedEmailId } = get();
    set({
      emails: emails.filter((email) => email.id !== emailId),
      total: Math.max(0, total - 1),
      ...(selectedEmailId === emailId
        ? { selectedEmailId: null, externalSelected: null, body: null }
        : {}),
    });
  },

  async refresh() {
    const { activeAccountId } = get();
    if (!activeAccountId) return;
    const result = await window.api.refresh(activeAccountId);
    if (!result.ok) {
      set({ error: result.error.message });
      return;
    }
    set({ error: null });
  },

  async setAllowRemoteImages(value) {
    const { selectedEmailId } = get();
    set({ allowRemoteImages: value });
    if (!selectedEmailId) return;

    const token = ++bodyToken;
    set({ bodyLoading: true });
    const result = await window.api.getBody({
      emailId: selectedEmailId,
      allowRemoteImages: value,
    });
    if (token !== bodyToken) return;

    if (!result.ok) {
      set({ bodyLoading: false, error: result.error.message });
      return;
    }
    set({ body: result.data, bodyLoading: false });
  },

  async applyTheme(themeId) {
    const previous = get().themeId;
    const result = await applyThemeToDocument(themeId);

    if (!result.ok) {
      set({ error: `主题切换失败：${result.reason ?? '未知原因'}` });
      await applyThemeToDocument(previous);
      return;
    }

    set({ themeId, error: null });
    await window.api.setSetting(THEME_SETTING_KEY, themeId);
  },

  async search(query) {
    const trimmed = query.trim();
    if (!trimmed) {
      await get().clearSearch();
      return;
    }

    const { activeAccountId, unified, searchAllAccounts } = get();
    const token = ++loadToken;
    set({ activeView: 'mail', listLoading: true, error: null, searchQuery: trimmed, searchActive: true });

    // 草稿箱/发件箱是本地视图，搜索时先切回收件箱，否则结果列表不会显示
    if (get().activeFolder === DRAFTS_FOLDER || get().activeFolder === OUTBOX_FOLDER) {
      set({ activeFolder: 'INBOX' });
    }

    const scope = searchAllAccounts ? 'all' : unified ? 'enabled' : 'account';
    const result = await window.api.searchEmails({
      query: trimmed,
      scope,
      ...(scope === 'account' && activeAccountId ? { accountId: activeAccountId } : {}),
      filter: get().listFilter,
      sort: get().listSort,
      limit: 200,
    });

    if (token !== loadToken) return;

    if (!result.ok) {
      set({ listLoading: false, error: result.error.message });
      return;
    }

    set({
      emails: result.data.emails,
      total: result.data.total,
      listLoading: false,
      selectedEmailId: null,
      externalSelected: null,
      body: null,
    });
  },

  async clearSearch() {
    if (!get().searchActive) return;
    set({ searchActive: false, searchQuery: '', selectedEmailId: null, body: null });
    await get().loadEmails();
  },

  async setSearchAllAccounts(value) {
    set({ searchAllAccounts: value });
    if (get().searchActive && get().searchQuery) {
      await get().search(get().searchQuery);
    }
  },

  async setListFilter(filter) {
    if (get().listFilter === filter) return;
    set({ listFilter: filter });
    await reloadForListQuery(set, get);
  },

  async setListSort(sort) {
    if (get().listSort === sort) return;
    set({ listSort: sort });
    await reloadForListQuery(set, get);
  },

  async setPinned(emailId, pinned) {
    const result = await window.api.setPinned(emailId, pinned);
    if (!result.ok) {
      set({ error: result.error.message });
      return;
    }
    set({
      emails: get().emails.map((email) =>
        email.id === emailId ? { ...email, pinned } : email,
      ),
    });
  },

  async setEmailFlags(emailId, patch) {
    const result = await window.api.setEmailFlags(emailId, patch);
    if (!result.ok) {
      set({ error: result.error.message });
      return;
    }
    const updated = result.data;
    const state = get();
    // 筛选态下「不再符合」的邮件立即出列（总数同步-1）；正在阅读的那封先留着，
    // 避免正文还在看、列表把人抖掉（见 lib/list-filter.ts）。
    const dropsOut = dropsFromFilteredList({
      filter: state.listFilter,
      patch,
      stillUnread: updated.unread,
      stillStarred: updated.starred,
      isSelected: state.selectedEmailId === emailId,
    });
    // 「开始符合」则相反：旧列表里没有这封邮件，只能按新口径重查。
    if (needsFilteredReload({ filter: state.listFilter, patch })) {
      if (state.searchActive && state.searchQuery) {
        await get().search(state.searchQuery);
      } else {
        await get().loadEmails();
      }
      return;
    }
    // 回包期间可能有同步触发的重载落地，用最新快照做局部更新，避免旧列表覆盖新数据
    const current = get();
    set({
      emails: dropsOut
        ? current.emails.filter((email) => email.id !== emailId)
        : current.emails.map((email) => (email.id === emailId ? { ...email, ...updated } : email)),
      total: dropsOut ? Math.max(0, current.total - 1) : current.total,
      ...(current.selectedEmailId === emailId
        ? { externalSelected: current.externalSelected?.id === emailId ? updated : current.externalSelected }
        : {}),
    });
  },

  async archiveEmail(emailId) {
    const result = await window.api.archiveEmail(emailId);
    if (!result.ok) {
      set({ error: result.error.message });
      return;
    }
    const { emails, total, selectedEmailId } = get();
    set({
      emails: emails.filter((email) => email.id !== emailId),
      total: Math.max(0, total - 1),
      ...(selectedEmailId === emailId
        ? { selectedEmailId: null, externalSelected: null, body: null }
        : {}),
    });
  },

  async moveEmail(emailId, folder) {
    const result = await window.api.moveEmail(emailId, folder);
    if (!result.ok) {
      set({ error: result.error.message });
      return;
    }
    const { emails, total, selectedEmailId } = get();
    set({
      emails: emails.filter((email) => email.id !== emailId),
      total: Math.max(0, total - 1),
      ...(selectedEmailId === emailId
        ? { selectedEmailId: null, externalSelected: null, body: null }
        : {}),
    });
  },

  async deleteEmail(emailId) {
    const result = await window.api.deleteEmail(emailId);
    if (!result.ok) {
      set({ error: result.error.message });
      return;
    }
    const { emails, total, selectedEmailId } = get();
    set({
      emails: emails.filter((email) => email.id !== emailId),
      total: Math.max(0, total - 1),
      ...(selectedEmailId === emailId
        ? { selectedEmailId: null, externalSelected: null, body: null }
        : {}),
    });
  },

  async loadDrafts(force = false) {
    set({ draftsLoading: true });
    const result = await window.api.listDrafts();
    if (!result.ok) {
      set({ draftsLoading: false, error: result.error.message });
      return;
    }

    // 合并服务器 Drafts 文件夹里的草稿：本地优先，按账户去重（避免同一账户重复显示）
    let drafts = result.data;
    try {
      const server = await window.api.listServerDrafts(force);
      if (server.ok && server.data.length > 0) {
        const localAccounts = new Set(drafts.map((item) => item.accountId));
        const merged = [...drafts];
        for (const serverDraft of server.data) {
          if (!localAccounts.has(serverDraft.accountId)) merged.push(serverDraft);
        }
        drafts = merged;
      }
    } catch {
      // 服务器草稿读取失败不影响本地草稿展示
    }

    // total 在草稿视图里代表草稿数；其他视图下不能覆盖邮件总数
    set({
      drafts,
      draftsLoading: false,
      ...(get().activeFolder === DRAFTS_FOLDER ? { total: drafts.length } : {}),
    });
  },

  async openDrafts() {
    set({
      activeView: 'mail',
      activeFolder: DRAFTS_FOLDER,
      unified: false,
      selectedEmailId: null,
      externalSelected: null,
      body: null,
      emails: [],
      total: get().drafts.length,
      searchActive: false,
      searchQuery: '',
    });
    void window.api.setPluginActiveEmail(null);
    await get().loadDrafts();
  },

  async refreshDrafts() {
    await get().loadDrafts(true);
  },

  async discardDraft(draft: ComposeDraft) {
    const targetKey = draft.key ?? draft.accountId;
    const originalIndex = get().drafts.findIndex((item) => (item.key ?? item.accountId) === targetKey);
    // 乐观隐藏：点击瞬间先从列表移除，草稿立即消失（不等服务器往返）
    const next = get().drafts.filter((item) => (item.key ?? item.accountId) !== targetKey);
    set({ drafts: next, total: next.length });
    // 后台：serverGated 模式先删服务器，成功才删本地；
    // 若服务器删除失败（如断网），回滚——把这条草稿放回原位置并显示错误。
    void (async () => {
      const result = await window.api.deleteDraft(draft.accountId, true);
      if (!result.ok) {
        set((state) => {
          const drafts = [...state.drafts];
          const idx = originalIndex >= 0 ? Math.min(originalIndex, drafts.length) : drafts.length;
          drafts.splice(idx, 0, draft);
          return { drafts, total: drafts.length, error: result.error.message };
        });
      }
    })();
  },

  async loadOutbox() {
    set({ outboxLoading: true });
    const result = await window.api.listScheduledSends();
    if (!result.ok) {
      set({ outboxLoading: false, error: result.error.message });
      return;
    }
    // total 在发件箱视图里代表队列条数；其他视图下不能覆盖邮件总数
    set({
      outbox: result.data,
      outboxLoading: false,
      ...(get().activeFolder === OUTBOX_FOLDER ? { total: result.data.length } : {}),
    });
  },

  async openOutbox() {
    set({
      activeView: 'mail',
      activeFolder: OUTBOX_FOLDER,
      unified: false,
      selectedEmailId: null,
      externalSelected: null,
      body: null,
      emails: [],
      total: get().outbox.length,
      searchActive: false,
      searchQuery: '',
    });
    void window.api.setPluginActiveEmail(null);
    await get().loadOutbox();
  },

  async cancelOutboxSend(id) {
    const result = await window.api.cancelScheduledSend(id);
    if (!result.ok) {
      set({ error: result.error.message });
      return;
    }
    await get().loadOutbox();
  },

  applySyncState(state) {
    // 上一次的同步错误：同步恢复正常后要把横幅撤掉，否则一条已经消失的错误会一直挂在界面上
    const previousSyncError = get().syncState?.error;
    set({ syncState: state });
    void window.api.listAccounts().then((result) => {
      const bootstrap = get().bootstrap;
      if (result.ok && bootstrap) {
        set({ bootstrap: { ...bootstrap, accounts: result.data } });
      }
    });
    if (state.error) {
      set({ error: state.error });
    } else if (previousSyncError && get().error === previousSyncError) {
      set({ error: null });
    }
    if (
      !state.syncing &&
      (get().unified || state.folder === get().activeFolder) &&
      !get().searchActive
    ) {
      void get().loadEmails();
      const accountId = get().activeAccountId;
      if (accountId) {
        void window.api.getFolders(accountId).then((result) => {
          if (result.ok) set({ folders: result.data });
        });
      }
    }
  },

  setError(message) {
    set({ error: message });
  },

  showToast(message) {
    set({ toast: message });
    if (toastTimer !== null) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toastTimer = null;
      set({ toast: null });
    }, 3200);
  },
}));
