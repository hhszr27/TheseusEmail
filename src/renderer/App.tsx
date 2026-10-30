import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { DRAFTS_FOLDER, OUTBOX_FOLDER, useMailStore } from './stores/mail-store';
import { Toolbar } from './components/Toolbar';
import { ActionRibbon } from './components/ActionRibbon';
import { Sidebar } from './components/Sidebar';
import { MailList } from './components/MailList';
import { DraftList } from './components/DraftList';
import { DraftReader } from './components/DraftReader';
import { OutboxList } from './components/OutboxList';
import { ReaderView } from './components/ReaderView';
import { SettingsView } from './components/SettingsView';
import { ThemeView } from './components/ThemeView';
import { PluginsView } from './components/PluginsView';
import { ComposeModal } from './components/ComposeModal';
import { PaneResizer } from './components/PaneResizer';
import { usePaneWidths } from './lib/use-pane-widths';
import { ICON_ONLY_SIDEBAR_WIDTH } from './lib/pane-layout';
import { outboxBadgeCount } from './lib/outbox';
import { subscribeRibbonChanges } from './lib/ribbon-sync';
import { CommandPalette, type PaletteCommand } from './components/CommandPalette';
import { AiCommandModal } from './components/AiCommandModal';
import { CalendarPanel } from './components/CalendarPanel';
import { ContactsPanel } from './components/ContactsPanel';
import { PluginMenu } from './components/PluginMenu';
import { PluginView } from './components/PluginView';
import { RibbonCustomizeDialog } from './components/RibbonCustomizeDialog';
import {
  PLUGIN_MENU_EVENT,
  openPluginMenu,
  type PluginMenuRequestDetail,
} from './lib/plugin-menu';
import { isPluginEnabledForAccount } from '../shared/plugin-access';
import {
  DEFAULT_RIBBON_CONFIG,
  RIBBON_SETTING_KEY,
  applyPluginRibbon,
  mergeRibbonConfig,
  parseRibbonOverrides,
  type RibbonOverrides,
} from '../shared/ribbon';
import type { EmailSummary, MenuRegion, SlotName } from '../shared/types';
import type { ComposeDraft, MailtoRequest } from '../shared/ipc';
import {
  HOST_COMMANDS,
  detectConflicts,
  matchesKeyboardEvent,
  type BindingSpec,
} from '../shared/keybindings';
import { KEYBINDINGS_SETTING_KEY } from '../shared/theme';
import { t } from '../shared/i18n';

let bootstrapped = false;

const EMPTY_COMPOSE: MailtoRequest = { to: [], cc: [], subject: '', body: '', raw: '' };

export default function App(): JSX.Element {
  const bootstrap = useMailStore((state) => state.bootstrap);
  const folders = useMailStore((state) => state.folders);
  const emails = useMailStore((state) => state.emails);
  const total = useMailStore((state) => state.total);
  const activeFolder = useMailStore((state) => state.activeFolder);
  const selectedEmailId = useMailStore((state) => state.selectedEmailId);
  const body = useMailStore((state) => state.body);
  const bodyLoading = useMailStore((state) => state.bodyLoading);
  const listLoading = useMailStore((state) => state.listLoading);
  const error = useMailStore((state) => state.error);
  const syncState = useMailStore((state) => state.syncState);
  const allowRemoteImages = useMailStore((state) => state.allowRemoteImages);
  const toast = useMailStore((state) => state.toast);
  const pluginSnapshot = useMailStore((state) => state.pluginSnapshot);
  const searchActive = useMailStore((state) => state.searchActive);
  const searchQuery = useMailStore((state) => state.searchQuery);
  const externalSelected = useMailStore((state) => state.externalSelected);
  const unified = useMailStore((state) => state.unified);
  const activeAccountId = useMailStore((state) => state.activeAccountId);
  const activeView = useMailStore((state) => state.activeView);
  const setView = useMailStore((state) => state.setView);
  const foldersByAccount = useMailStore((state) => state.foldersByAccount);
  const ensureAccountFolders = useMailStore((state) => state.ensureAccountFolders);
  const reloadAccountFolders = useMailStore((state) => state.reloadAccountFolders);
  const searchAllAccounts = useMailStore((state) => state.searchAllAccounts);
  const listFilter = useMailStore((state) => state.listFilter);
  const listSort = useMailStore((state) => state.listSort);
  const reloadBootstrap = useMailStore((state) => state.reloadBootstrap);
  const drafts = useMailStore((state) => state.drafts);
  const draftsLoading = useMailStore((state) => state.draftsLoading);
  /** 草稿箱里单击选中的草稿：右侧直接看内容并编辑，双击才进撰写窗口。 */
  const [selectedDraftKey, setSelectedDraftKey] = useState<string | null>(null);
  const outbox = useMailStore((state) => state.outbox);
  const outboxLoading = useMailStore((state) => state.outboxLoading);

  const workspaceRef = useRef<HTMLDivElement>(null);
  const {
    widths: paneWidths,
    sidebarCollapsed,
    readerHidden,
    vertical,
    setWidth: setPaneWidth,
    setSidebarCollapsed,
    setReaderHidden,
    setVertical,
    persist: persistPaneWidths,
    reset: resetPaneWidths,
    clampTo: clampPaneWidths,
  } = usePaneWidths();

  /** runCommand 在 effect 里定义，用 ref 取到最新的状态。 */
  const readerHiddenRef = useRef(readerHidden);
  readerHiddenRef.current = readerHidden;
  const verticalRef = useRef(vertical);
  verticalRef.current = vertical;

  // 独立窗口（右键「在新窗口中打开」）：URL 带 ?folder=accountId|path，启动后直接切过去
  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get('folder');
    if (!raw) return;
    const at = raw.indexOf('|');
    if (at <= 0) return;
    void useMailStore
      .getState()
      .selectAccountFolder(raw.slice(0, at), raw.slice(at + 1));
  }, []);

  // 窗口尺寸变化时把两栏夹回可用范围；上下布局时按「高度」夹列表
  useEffect(() => {
    const handleResize = (): void => {
      const element = workspaceRef.current;
      if (!element || element.clientWidth <= 0) return;
      const available = verticalRef.current ? element.clientHeight : element.clientWidth;
      clampPaneWidths(available);
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [clampPaneWidths]);

  const [paletteOpen, setPaletteOpen] = useState(false);  const [aiOpen, setAiOpen] = useState(false);
  /** 当前在主区域打开的插件侧栏视图（配合 activeView='plugin'）。 */
  const [activePluginView, setActivePluginView] = useState<string | null>(null);
  const [ribbonEditorOpen, setRibbonEditorOpen] = useState(false);
  const [compose, setCompose] = useState<MailtoRequest | null>(null);
  const [pluginMenu, setPluginMenu] = useState<PluginMenuRequestDetail | null>(null);
  const [pluginNotice, setPluginNotice] = useState<string | null>(null);
  const [activePanelPlugin, setActivePanelPlugin] = useState<string | null>(null);
  const [startupMs, setStartupMs] = useState<number | null>(null);
  const [bindingOverrides, setBindingOverrides] = useState<Record<string, BindingSpec | null>>({});
  const [shortcutWarning, setShortcutWarning] = useState<string | null>(null);
  /** 快捷键/ribbon 处理器在 openReplyWindow 之前定义，用 ref 取到最新闭包。 */
  const replyRef = useRef<() => void>(() => undefined);
  const replyAllRef = useRef<() => void>(() => undefined);
  const forwardRef = useRef<() => void>(() => undefined);
  /** ribbon 的统一命令分发入口（runCommand 定义在 useEffect 里，用 ref 暴露给 JSX）。 */
  const runCommandRef = useRef<(commandId: string, args?: Record<string, string>) => void>(
    () => undefined,
  );
  /** 插件命令入口（插件贡献的 ribbon 按钮走 plugin:<pluginId>:<commandId>）。 */
  const pluginCommandRef = useRef<(pluginId: string, commandId: string) => void>(() => undefined);
  /** ribbon 覆盖配置（用户自定义）；null 表示完全用内置默认。 */
  const [ribbonOverrides, setRibbonOverrides] = useState<RibbonOverrides | null>(null);
  /** 宿主自有配置（内置默认 + 用户覆盖）——编辑器只允许改这一层。 */
  const hostRibbonConfig = useMemo(
    () => mergeRibbonConfig(DEFAULT_RIBBON_CONFIG, ribbonOverrides),
    [ribbonOverrides],
  );

  /**
   * 插件贡献层：只取「就绪 + 启用 + 该账户未被禁用」的插件。
   * 账户级禁用要立刻从工具栏消失，所以这里跟视图槽用同一套判定。
   */
  const pluginRibbonSources = useMemo(() => {
    const readyIds = new Set(
      (pluginSnapshot?.plugins ?? [])
        .filter(
          (plugin) =>
            plugin.status === 'ready' &&
            plugin.enabled &&
            isPluginEnabledForAccount(true, plugin.accountOverrides, activeAccountId),
        )
        .map((plugin) => plugin.id),
    );
    return (pluginSnapshot?.ribbon ?? []).filter((source) => readyIds.has(source.pluginId));
  }, [pluginSnapshot, activeAccountId]);

  /** 实际渲染用的配置 = 宿主层 + 插件扩展层。 */
  // 用户可以在编辑器里单独关掉某个插件的工具栏贡献（不影响插件本身）
  const ribbonConfig = useMemo(
    () =>
      applyPluginRibbon(
        hostRibbonConfig,
        pluginRibbonSources,
        ribbonOverrides?.hiddenPlugins ?? [],
      ),
    [hostRibbonConfig, pluginRibbonSources, ribbonOverrides],
  );

  useEffect(() => {
    void window.api.getSetting(RIBBON_SETTING_KEY).then((result) => {
      if (result.ok && result.data) setRibbonOverrides(parseRibbonOverrides(result.data));
    });
  }, []);

  useEffect(() => {
    if (bootstrapped) return;
    bootstrapped = true;

    const mountMs = performance.now();
    void window.api.rendererReady({ mountMs }).then((result) => {
      if (result.ok) setStartupMs(result.data.startupMs);
    });
    void useMailStore.getState().init();
  }, []);

  useEffect(() => {
    const unsubscribe = window.api.onSyncState((state) => {
      useMailStore.getState().applySyncState(state);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = window.api.onMailto((request) => setCompose(request));
    return unsubscribe;
  }, []);

  // 点击邮件通知：定位到该邮件（§22.2）
  useEffect(() => {
    const unsubscribe = window.api.onNotificationOpen(({ emailId }) => {
      setView('mail');
      void useMailStore.getState().selectEmail(emailId);
    });
    return unsubscribe;
  }, [setView]);

  // 托盘菜单动作（宿主能力）：写信 / 刷新 / 打开发件箱
  useEffect(() => {
    const unsubscribe = window.api.onTrayAction((payload) => {
      if (payload.action === 'compose') {
        setView('mail');
        setCompose(EMPTY_COMPOSE);
        return;
      }
      if (payload.action === 'refresh') {
        void useMailStore.getState().refresh();
        return;
      }
      if (payload.action === 'outbox') {
        void useMailStore.getState().openOutbox();
      }
    });
    return unsubscribe;
  }, [setView]);

  useEffect(() => {
    const unsubscribe = window.api.onPluginsChanged(() => {
      void useMailStore.getState().loadPlugins();
    });
    return unsubscribe;
  }, []);

  // 多窗口同步：另一个窗口改了工具栏配置时，这里立刻跟上（否则要重启才生效）
  useEffect(() => subscribeRibbonChanges(window.api, setRibbonOverrides), []);

  useEffect(() => {
    const load = (): void => {
      void window.api.getSetting(KEYBINDINGS_SETTING_KEY).then((result) => {
        if (result.ok && result.data) {
          try {
            setBindingOverrides(JSON.parse(result.data) as Record<string, BindingSpec | null>);
            return;
          } catch {
            // 损坏的自定义配置回落到默认值
          }
        }
        setBindingOverrides({});
      });
    };

    load();
    // 本窗口内（设置页保存后立即生效）
    window.addEventListener('mf:keybindings-changed', load);
    // 跨窗口：另一个窗口改了快捷键，这里也跟着重载
    const unsubscribe = window.api.onKeybindingsChanged(() => load());
    return () => {
      window.removeEventListener('mf:keybindings-changed', load);
      unsubscribe();
    };
  }, []);

  const hostBindings = useMemo(
    () =>
      HOST_COMMANDS.map((command) => ({
        command: command.id,
        binding:
          bindingOverrides[command.id] === null
            ? null
            : bindingOverrides[command.id] ?? command.defaultKeybinding ?? null,
      })),
    [bindingOverrides],
  );

  useEffect(() => {
    const conflicts = detectConflicts([
      ...hostBindings
        .filter((entry): entry is { command: string; binding: BindingSpec } => entry.binding !== null)
        .map((entry) => ({ command: entry.command, binding: entry.binding })),
      ...(pluginSnapshot?.keybindings ?? []).map((binding) => ({
        command: `插件 ${binding.pluginId}: ${binding.command}`,
        binding,
      })),
    ]);

    setShortcutWarning(
      conflicts.length > 0
        ? `检测到 ${conflicts.length} 组快捷键冲突：${conflicts
            .map((conflict) => conflict.signature)
            .join('、')}`
        : null,
    );
  }, [hostBindings, pluginSnapshot]);

  useEffect(() => {
    /**
     * 命令统一分发入口：快捷键、命令面板、ribbon 三者共用。
     * args 供参数化命令使用（移动到哪个文件夹、跳到哪个视图/文件夹、列表筛选口径）。
     */
    const runCommand = (commandId: string, args?: Record<string, string>): void => {
      const state = useMailStore.getState();

      // 插件贡献的按钮：命令 id 形如 plugin:<pluginId>:<commandId>。
      // 权限（requires）在执行时由 runPluginCommand 侧校验，这里不再拦截。
      if (commandId.startsWith('plugin:')) {
        const rest = commandId.slice('plugin:'.length);
        const at = rest.indexOf(':');
        if (at > 0) pluginCommandRef.current(rest.slice(0, at), rest.slice(at + 1));
        return;
      }

      switch (commandId) {
        case 'palette.open':
          setPaletteOpen(true);
          break;
        case 'mail.compose':
          setCompose(EMPTY_COMPOSE);
          break;
        case 'mail.refresh':
          void useMailStore.getState().refresh();
          break;
        case 'search.focus': {
          const input = document.querySelector<HTMLInputElement>('.search-input');
          input?.focus();
          input?.select();
          break;
        }
        case 'settings.open':
        case 'view.settings':
          setView('settings');
          break;
        case 'view.theme':
          setView('theme');
          break;
        case 'view.plugins':
          setView('plugins');
          break;
        case 'ai.open':
          setAiOpen(true);
          break;
        case 'calendar.open':
          setView('calendar');
          break;
        case 'plugins.menu':
          openPluginMenu('main', {
            x: args?.x ? Number(args.x) : Math.round(window.innerWidth / 2),
            y: args?.y ? Number(args.y) : 96,
            accountId: activeAccountId,
          });
          break;
        case 'view.unified':
          void useMailStore.getState().selectFolder('__all__');
          break;
        case 'view.inbox':
        case 'view.sent':
        case 'view.folder': {
          const accountId = args?.accountId ?? activeAccountId ?? bootstrap?.accounts[0]?.id ?? null;
          if (!accountId) break;
          let folderPath = args?.folderPath;
          if (!folderPath) {
            const list = foldersByAccount[accountId] ?? [];
            folderPath =
              commandId === 'view.sent'
                ? (list.find((folder) => folder.specialUse === 'sent')?.path ?? '')
                : commandId === 'view.inbox'
                  ? (list.find((folder) => folder.path === 'INBOX')?.path ?? '')
                  : '';
          }
          if (!folderPath) break;
          void useMailStore.getState().selectAccountFolder(accountId, folderPath);
          break;
        }
        case 'view.drafts':
          void useMailStore.getState().openDrafts();
          break;
        case 'view.outbox':
          void useMailStore.getState().openOutbox();
          break;
        case 'view.toggleReader':
          // 「快速视图」：一键隐藏/显示右侧正文阅读区
          setReaderHidden(!readerHiddenRef.current);
          break;
        case 'view.toggleLayout':
          // 「布局」：列表/正文在左右与上下之间切换
          setVertical(!verticalRef.current);
          break;
        case 'list.filter': {
          const filter = args?.filter;
          if (filter === 'all' || filter === 'unread' || filter === 'starred') {
            void useMailStore.getState().setListFilter(filter);
          }
          break;
        }
        case 'ribbon.customize':
          setRibbonEditorOpen(true);
          break;
        case 'app.quit':
          void window.api.quit();
          break;
        case 'mail.pin': {
          const email = state.emails.find((item) => item.id === state.selectedEmailId);
          if (email) void state.setPinned(email.id, !email.pinned);
          break;
        }
        case 'mail.star':
        case 'mail.toggleRead': {
          const email = state.emails.find((item) => item.id === state.selectedEmailId);
          if (!email) break;
          void state.setEmailFlags(
            email.id,
            commandId === 'mail.star' ? { starred: !email.starred } : { read: email.unread },
          );
          break;
        }
        case 'mail.archive':
        case 'mail.delete': {
          if (!state.selectedEmailId) break;
          void (commandId === 'mail.archive'
            ? state.archiveEmail(state.selectedEmailId)
            : state.deleteEmail(state.selectedEmailId));
          break;
        }
        case 'mail.moveTo': {
          const folderPath = args?.folderPath;
          if (!state.selectedEmailId || !folderPath) break;
          void state.moveEmail(state.selectedEmailId, folderPath);
          break;
        }
        case 'mail.reply':
          // runCommand 定义在 openReplyWindow 之前，这里用最新一次渲染的闭包
          replyRef.current();
          break;
        case 'mail.replyAll':
          replyAllRef.current();
          break;
        case 'mail.forward':
          forwardRef.current();
          break;
        default:
          break;
      }
    };

    // 供 ribbon 按钮走同一条分发路径（JSX 在 effect 外渲染，只能经由 ref）
    runCommandRef.current = runCommand;

    const handler = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const editable =
        target !== null &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);

      for (const entry of hostBindings) {
        if (!entry.binding) continue;
        if (!matchesKeyboardEvent(entry.binding, event)) continue;

        const hasCommandModifier = (entry.binding.modifiers ?? []).some(
          (modifier) => modifier === 'ctrl' || modifier === 'meta',
        );
        if (editable && !hasCommandModifier) continue;

        event.preventDefault();
        runCommand(entry.command);
        return;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [hostBindings, activeAccountId, bootstrap, foldersByAccount]);

  useEffect(
    () =>
      window.api.onAccountsChanged(() => {
        void reloadBootstrap();
      }),
    [reloadBootstrap],
  );

  const selectedEmail = selectedEmailId
    ? emails.find((email) => email.id === selectedEmailId) ?? externalSelected
    : null;

  // 归档能力：该账户是否存在 \Archive（或名为 Archive/归档）的文件夹
  /**
   * 回复 / 全部回复 / 转发：像 Outlook 一样另开一个原生写信窗口，
   * 不再在主窗口上盖撰写弹层。窗口自己取正文并按设置决定是否保留引用。
   */
  const openReplyWindow = (kind: 'reply' | 'reply-all' | 'forward'): void => {
    if (!selectedEmail) return;
    void window.api.openReaderWindow(selectedEmail.id, kind).then((result) => {
      if (!result.ok) {
        useMailStore.getState().showToast(`打开写信窗口失败：${result.error.message}`);
      }
    });
  };

  /**
   * 空格读完一封后切到列表里的下一封（不跨列表边界）。
   * 用 getState() 取最新列表，避免闭包捕获旧数据。
   */
  const openNextEmail = useCallback((): void => {
    const state = useMailStore.getState();
    if (!state.selectedEmailId) return;
    const index = state.emails.findIndex((email) => email.id === state.selectedEmailId);
    if (index < 0) return;
    const next = state.emails[index + 1];
    if (!next) return;
    void state.selectEmail(next.id);
  }, []);

  /** 行内快捷操作是否可用归档（按该邮件所属账户的文件夹判断）。 */
  useEffect(() => {
    replyRef.current = (): void => openReplyWindow('reply');
    replyAllRef.current = (): void => openReplyWindow('reply-all');
    forwardRef.current = (): void => openReplyWindow('forward');
    // openReplyWindow 每次渲染重建，这里按它依赖的选中邮件更新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEmail]);

  /** 从草稿箱继续编辑：把草稿内容与附件重新装回撰写弹层。 */
  const openDraft = (draft: ComposeDraft): void => {
    setCompose({
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc ?? [],
      subject: draft.subject,
      body: draft.body,
      html: draft.html,
      raw: '',
      kind: 'new',
      accountId: draft.accountId,
      attachments: draft.attachments,
    });
  };

  const canArchiveEmail = useCallback(
    (email: EmailSummary): boolean => {
      const list = foldersByAccount[email.accountId] ?? [];
      return list.some(
        (folder) =>
          folder.specialUse === 'archive' || /^(archive|归档|存档)$/i.test(folder.name.trim()),
      );
    },
    [foldersByAccount],
  );

  const canArchive = useMemo(() => {
    if (!selectedEmail) return false;
    const folders = foldersByAccount[selectedEmail.accountId] ?? [];
    return folders.some(
      (folder) =>
        folder.specialUse === 'archive' || /^(archive|归档|存档)$/i.test(folder.name.trim()),
    );
  }, [selectedEmail, foldersByAccount]);

  const selectedDraft = drafts.find((draft) => (draft.key ?? draft.accountId) === selectedDraftKey) ?? null;
  const draftsMode = activeFolder === DRAFTS_FOLDER && !searchActive;
  const outboxMode = activeFolder === OUTBOX_FOLDER && !searchActive;
  const folderName = draftsMode
    ? '草稿箱'
    : outboxMode
      ? '发件箱'
      : unified
        ? '统一收件箱'
        : folders.find((folder) => folder.path === activeFolder)?.name ?? '收件箱';
  const hasAccounts = (bootstrap?.accounts.length ?? 0) > 0;

  // 发件箱由主进程发送队列推进（排队 → 发送中 → 已发送），打开时轮询刷新
  useEffect(() => {
    if (!outboxMode) return;
    const timer = window.setInterval(() => {
      void useMailStore.getState().loadOutbox();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [outboxMode]);

  const accountStats = useMemo(() => {
    const accounts = bootstrap?.accounts ?? [];
    const disabled = accounts.filter((account) => !account.enabled).length;
    return { online: accounts.length - disabled, disabled };
  }, [bootstrap]);

  /** 账户感知的插件视图解析（§7.8.4）：账户级禁用时该账户不加载视图。 */
  const pluginsForSlot = useMemo(() => {
    const ready = (pluginSnapshot?.plugins ?? []).filter(
      (plugin) => plugin.status === 'ready' && plugin.enabled,
    );
    return (slot: SlotName): string[] =>
      ready
        .filter(
          (plugin) =>
            plugin.slots.includes(slot) &&
            isPluginEnabledForAccount(true, plugin.accountOverrides, activeAccountId),
        )
        .map((plugin) => plugin.id);
  }, [pluginSnapshot, activeAccountId]);

  const readerPluginId = useMemo(() => {
    const plugin = (pluginSnapshot?.plugins ?? []).find(
      (item) =>
        item.status === 'ready' &&
        item.enabled &&
        item.hasReaderView &&
        isPluginEnabledForAccount(true, item.accountOverrides, activeAccountId),
    );
    return plugin?.id ?? null;
  }, [pluginSnapshot, activeAccountId]);

  const injectionPluginIds = pluginsForSlot('reader-panel-top');
  const globalToolbarPlugins = pluginsForSlot('global-toolbar');
  const statusBarPlugins = pluginsForSlot('status-bar');
  const panelPlugins = pluginsForSlot('panel');

  // 侧栏底部导航的插件入口（views['sidebar-item']）：插件名用于图标提示
  const sidebarPluginIds = pluginsForSlot('sidebar-item');
  const pluginNameById = useMemo(
    () => new Map((pluginSnapshot?.plugins ?? []).map((plugin) => [plugin.id, plugin.name])),
    [pluginSnapshot],
  );
  const sidebarPluginEntries = sidebarPluginIds.map((id) => ({
    id,
    name: pluginNameById.get(id) ?? id,
  }));

  useEffect(() => {
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<PluginMenuRequestDetail>).detail;
      if (!detail) return;
      setPluginMenu(detail);
    };
    window.addEventListener(PLUGIN_MENU_EVENT, handler as EventListener);
    return () => window.removeEventListener(PLUGIN_MENU_EVENT, handler as EventListener);
  }, []);

  // 右键菜单：按落点判断区域，避免每个组件各自维护菜单状态
  useEffect(() => {
    const onContextMenu = (event: MouseEvent): void => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      // 账户行的稳定挂点是 data-account-id（Sidebar 的 .account-item 自带它）。
      // 以前这里找 .tree-account-row，而侧栏早就改成 .account-item 了——
      // 选择器永远匹配不到，插件的 context:account 菜单成了死功能。
      const accountRow = target.closest('[data-account-id]') as HTMLElement | null;
      if (accountRow) {
        const accountId = accountRow.dataset.accountId ?? null;
        const account = bootstrap?.accounts.find((item) => item.id === accountId);
        if (!accountId || !account) return;
        event.preventDefault();
        openPluginMenu('context:account', {
          x: event.clientX,
          y: event.clientY,
          accountId,
          context: {
            accountEnabled: account.enabled,
            accountDisabled: !account.enabled,
          },
        });
        return;
      }

      const composeBody = target.closest('#compose-body');
      if (composeBody) {
        event.preventDefault();
        openPluginMenu('context:compose', {
          x: event.clientX,
          y: event.clientY,
          accountId: activeAccountId,
          context: { composeOpen: true },
        });
        return;
      }

      const reader = target.closest('.reader-pane');
      if (reader) {
        event.preventDefault();
        openPluginMenu('context:reader', {
          x: event.clientX,
          y: event.clientY,
          accountId: activeAccountId,
          context: {
            readerView: true,
            hasActiveEmail: Boolean(selectedEmail),
            hasSelection: Boolean(window.getSelection()?.toString()),
          },
        });
        return;
      }

      if (target.closest('.list-pane')) {
        event.preventDefault();
        openPluginMenu('context:mail-list', {
          x: event.clientX,
          y: event.clientY,
          accountId: activeAccountId,
          context: { mailListFocused: true },
        });
      }
    };

    window.addEventListener('contextmenu', onContextMenu);
    return () => window.removeEventListener('contextmenu', onContextMenu);
  }, [bootstrap, activeAccountId, selectedEmail]);

  const runPluginItem = async (item: {
    pluginId: string;
    commandId: string;
    missingPermission?: string;
    accountId?: string | null;
  }): Promise<void> => {
    setPluginMenu(null);
    if (item.missingPermission) {
      setPluginNotice(`此插件需要 ${item.missingPermission} 权限`);
      return;
    }
    // 右键账户菜单传来的是「被右键选中的账户」，应优先于侧栏当前选中项；
    // 否则点 A 账户的右键菜单却用 B 账户的上下文去查，会查不到或查错。
    const targetAccountId = item.accountId ?? activeAccountId;
    // 若插件贡献了面板视图（如「查看账户」），先把该插件的抽屉标记为「当前活动」，
    // 命令才能投递到已挂载的 webview；同一时刻只显示这一个面板，其余保持离屏。
    if (panelPlugins.includes(item.pluginId)) {
      setActivePanelPlugin(item.pluginId);
    }
    const result = await window.api.runPluginCommand(
      item.pluginId,
      item.commandId,
      targetAccountId,
    );
    if (!result.ok) {
      setPluginNotice(result.error.message);
      return;
    }
    if (result.data.delivered === 0) {
      setPluginNotice('该插件没有打开可接收命令的视图');
    }
  };

  // 每次渲染刷新引用，保证 ribbon 按钮始终调用到带最新 activeAccountId 的闭包
  useEffect(() => {
    pluginCommandRef.current = (pluginId, commandId) => {
      void runPluginItem({ pluginId, commandId });
    };
  });

  const commands = useMemo<PaletteCommand[]>(() => {
    const list: PaletteCommand[] = [
      {
        id: 'compose',
        label: '撰写新邮件',
        description: '打开撰写窗口',
        group: 'common',
        icon: '✎',
        run: () => setCompose(EMPTY_COMPOSE),
      },
      {
        id: 'refresh',
        label: '刷新邮件',
        description: '同步当前账户',
        group: 'common',
        icon: '⟳',
        run: () => void useMailStore.getState().refresh(),
      },
      {
        id: 'ai',
        label: 'AI 指令',
        description: '自然语言指令与语义搜索',
        group: 'common',
        icon: '✨',
        run: () => setAiOpen(true),
      },
      {
        id: 'search',
        label: '搜索邮件',
        description: '聚焦搜索框',
        group: 'common',
        icon: '🔍',
        run: () => document.querySelector<HTMLInputElement>('.search-input')?.focus(),
      },
      {
        id: 'settings',
        label: '打开设置',
        description: '账户、快捷键、翻译、AI、诊断',
        group: 'jump',
        icon: '⚙',
        run: () => setView('settings'),
      },
      {
        id: 'theme',
        label: '切换主题',
        description: '内置主题与插件主题',
        group: 'jump',
        icon: '🎨',
        run: () => setView('theme'),
      },
      {
        id: 'plugins',
        label: '管理插件',
        description: '插件列表、权限与调试',
        group: 'jump',
        icon: '🧩',
        run: () => setView('plugins'),
      },
      {
        id: 'drafts',
        label: '打开草稿箱',
        description: '本地草稿（每账户一封）',
        group: 'jump',
        icon: '📝',
        run: () => void useMailStore.getState().openDrafts(),
      },
      {
        id: 'outbox',
        label: '打开发件箱',
        description: '定时与发送队列（含已发送记录）',
        group: 'jump',
        icon: '📤',
        run: () => void useMailStore.getState().openOutbox(),
      },
      {
        id: 'ribbon.customize',
        label: '自定义功能区',
        description: '增删改工具栏的标签页与工具',
        group: 'common',
        icon: '🧰',
        run: () => setRibbonEditorOpen(true),
      },
      {
        id: 'calendar',
        label: '打开日历',
        description: 'CalDAV 与 ICS 订阅',
        group: 'jump',
        icon: '📅',
        run: () => setView('calendar'),
      },
    ];

    for (const folder of folders) {
      list.push({
        id: `folder:${folder.path}`,
        label: `跳转到 ${folder.name}`,
        description: folder.path,
        group: 'jump',
        icon: '📁',
        run: () => void useMailStore.getState().selectFolder(folder.path),
      });
    }

    for (const command of pluginSnapshot?.commands ?? []) {
      list.push({
        id: `plugin:${command.pluginId}:${command.id}`,
        label: command.label,
        ...(command.description ? { description: command.description } : {}),
        group: 'plugin',
        source: 'plugin',
        run: () => {
          console.info('插件命令触发', command.pluginId, command.id);
        },
      });
    }

    return list;
  }, [folders, pluginSnapshot]);

  const statusText = syncState?.syncing
    ? t('app.status.syncing')
    : syncState?.error
      ? `同步失败：${syncState.error}`
      : listLoading
        ? t('app.status.loading')
        : searchActive
          ? t('app.status.search', { query: searchQuery, count: total })
          : listFilter === 'unread'
            ? t('app.status.folderUnread', { count: total })
            : listFilter === 'starred'
              ? t('app.status.folderStarred', { count: total })
              : t('app.status.folder', { count: total });

  return (
    <div className="app">
      <Toolbar
        searchQuery={searchQuery}
        searchActive={searchActive}
        searchAllAccounts={searchAllAccounts}
        onSearch={(query) => void useMailStore.getState().search(query)}
        onClearSearch={() => void useMailStore.getState().clearSearch()}
        onToggleSearchAll={(value) => void useMailStore.getState().setSearchAllAccounts(value)}
        onOpenPalette={() => setPaletteOpen(true)}
        onOpenAi={() => setAiOpen(true)}
        onRefresh={() => void useMailStore.getState().refresh()}
        onOpenSettings={() => setView('settings')}
        onOpenTheme={() => setView('theme')}
        onOpenPlugins={() => setView('plugins')}
        onOpenPluginMenu={(x, y) =>
          openPluginMenu('main', { x, y, accountId: activeAccountId })
        }
      >
        {globalToolbarPlugins.map((pluginId) => (
          <PluginView
            key={`toolbar-${pluginId}`}
            pluginId={pluginId}
            slot="global-toolbar"
            accountId={activeAccountId}
            className="toolbar-slot"
            title={`${pluginId} 工具栏`}
          />
        ))}
      </Toolbar>

      <ActionRibbon
        config={ribbonConfig}
        activeView={activeView}
        unified={unified}
        foldersByAccount={foldersByAccount}
        selectedEmail={selectedEmail}
        listFilter={listFilter}
        hasAccounts={hasAccounts}
        readerShown={!readerHidden}
        vertical={vertical}
        onRunCommand={(commandId, args) => runCommandRef.current(commandId, args)}
      />

      {error ? (
        <div className="error-banner" role="alert">
          {error}
        </div>
      ) : null}

      {shortcutWarning ? (
        <div className="error-banner" role="note">
          {shortcutWarning}（可在设置中重新绑定）
        </div>
      ) : null}

      {pluginNotice ? (
        <div className="error-banner" role="note">
          {pluginNotice}
          <button type="button" className="link-button" onClick={() => setPluginNotice(null)}>
            关闭
          </button>
        </div>
      ) : null}

      {!hasAccounts && bootstrap?.firstRunHint ? (
        <div className="error-banner" role="note">
          {bootstrap.firstRunHint}
        </div>
      ) : null}

      <div
        className={`workspace${activeView === 'mail' ? '' : ' workspace-view'}${
          activeView === 'settings' ? ' settings-full' : ''
        }${readerHidden ? ' reader-hidden' : ''}${vertical ? ' vertical' : ''}`}
        ref={workspaceRef}
        style={
          {
            '--mf-sidebar-width': `${sidebarCollapsed ? ICON_ONLY_SIDEBAR_WIDTH : paneWidths.sidebar}px`,
            '--mf-list-width': `${paneWidths.list}px`,
            '--mf-list-height': `${paneWidths.list}px`,
          } as CSSProperties
        }
      >
        <Sidebar
          accounts={bootstrap?.accounts ?? []}
          foldersByAccount={foldersByAccount}
          activeAccountId={activeAccountId}
          activeFolder={activeFolder}
          activeView={activeView}
          unified={unified}
          collapsed={sidebarCollapsed}
          onSelectAccount={(accountId) => void useMailStore.getState().selectAccount(accountId)}
          onSelectUnified={() => void useMailStore.getState().selectFolder('__all__')}
          onOpenDrafts={() => void useMailStore.getState().openDrafts()}
          draftCount={drafts.length}
          onOpenOutbox={() => void useMailStore.getState().openOutbox()}
          outboxCount={outboxBadgeCount(outbox)}
          onSelectFolder={(accountId, folder) => {
            // 点树里的「草稿」文件夹（服务器上的草稿副本）一律跳到草稿箱：
            // 那边才能直接编辑；否则用户会打开一个只读的邮件阅读区，误以为坏了
            const target = (foldersByAccount[accountId] ?? []).find(
              (item) => item.path === folder,
            );
            if (target?.specialUse === 'drafts') {
              void useMailStore.getState().openDrafts();
              return;
            }
            void useMailStore.getState().selectAccountFolder(accountId, folder);
          }}
          // 展开账户就重新拉一次文件夹，别拿缓存（服务端可能刚加了/删了文件夹）
          onEnsureFolders={(accountId) => void reloadAccountFolders(accountId)}
          onOpenView={(view) => setView(view)}
          onOpenCalendar={() => setView('calendar')}
          onOpenContacts={() => setView('contacts')}
          pluginEntries={sidebarPluginEntries}
          activePluginId={activePluginView}
          onOpenPluginView={(pluginId) => {
            setActivePluginView(pluginId);
            setView('plugin');
          }}
        />

        {activeView === 'mail' ? (
          draftsMode ? (
            <>
              <DraftList
                drafts={drafts}
                loading={draftsLoading}
                accounts={bootstrap?.accounts ?? []}
                selectedKey={selectedDraftKey}
                onSelect={(draft) => setSelectedDraftKey(draft.key ?? draft.accountId)}
                onOpen={openDraft}
                onDelete={(draft) => {
                  setSelectedDraftKey(null);
                  void useMailStore.getState().discardDraft(draft);
                }}
                onCompose={() => setCompose(EMPTY_COMPOSE)}
                onRefresh={() => void useMailStore.getState().refreshDrafts()}
              />
              {selectedDraft ? (
                <DraftReader
                  draft={selectedDraft}
                  onSaved={(saved) => {
                    setSelectedDraftKey(saved.key ?? saved.accountId);
                    void useMailStore.getState().loadDrafts();
                  }}
                  onOpen={() => openDraft(selectedDraft)}
                  onDiscard={() => {
                    setSelectedDraftKey(null);
                    void useMailStore.getState().discardDraft(selectedDraft);
                  }}
                />
              ) : (
                <section className="reader-pane" aria-label="草稿说明">
                  <div className="reader-placeholder">
                    {/* 空状态容器是 grid + place-items:center，多个子节点会被拆成多行撑开，这里必须合成一个 */}
                    <div className="reader-placeholder-inner">
                      <p>单击左侧草稿，在这里查看并直接修改内容。</p>
                      <p className="hint">
                        双击草稿（或点「在撰写窗口打开」）才回到完整写信框；发送成功后草稿会自动删除。
                      </p>
                    </div>
                  </div>
                </section>
              )}
            </>
          ) : outboxMode ? (
            <>
              <OutboxList
                items={outbox}
                loading={outboxLoading}
                accounts={bootstrap?.accounts ?? []}
                onCancel={(id) => void useMailStore.getState().cancelOutboxSend(id)}
                onCompose={() => setCompose(EMPTY_COMPOSE)}
              />
              <section className="reader-pane" aria-label="发件箱说明">
                <div className="reader-placeholder">
                  <div className="reader-placeholder-inner">
                    <p>发件箱是本机发送队列：定时邮件在到点前停在这里，点「发送」后也会立刻入队。</p>
                    <p className="hint">
                      队列状态会自动刷新；未到点的邮件可以在这里取消，已发送的记录保留下来便于核对。
                    </p>
                  </div>
                </div>
              </section>
            </>
          ) : (
          <>
            <MailList
              emails={emails}
              total={total}
              folderName={folderName}
              selectedId={selectedEmailId}
              loading={listLoading}
              searchActive={searchActive}
              searchQuery={searchQuery}
              filter={listFilter}
              sort={listSort}
              accounts={bootstrap?.accounts ?? []}
              foldersByAccount={foldersByAccount}
              onSelect={(emailId) => void useMailStore.getState().selectEmail(emailId)}
              onFilterChange={(value) => void useMailStore.getState().setListFilter(value)}
              onSortChange={(value) => void useMailStore.getState().setListSort(value)}
              onCompose={() => setCompose(EMPTY_COMPOSE)}
              canArchive={canArchiveEmail}
              onToggleStar={(email) =>
                void useMailStore.getState().setEmailFlags(email.id, { starred: !email.starred })
              }
              onToggleRead={(email) =>
                void useMailStore.getState().setEmailFlags(email.id, { read: email.unread })
              }
              onArchive={(email) => void useMailStore.getState().archiveEmail(email.id)}
              onDelete={(email) => void useMailStore.getState().deleteEmail(email.id)}
              onMove={(email, folder) =>
                void useMailStore.getState().moveEmail(email.id, folder)
              }
              onOpenReaderWindow={(email) => void window.api.openReaderWindow(email.id)}
            />

            <ReaderView
              email={selectedEmail}
              body={body}
              loading={bodyLoading}
              allowRemoteImages={allowRemoteImages}
              readerPluginId={readerPluginId}
              injectionPluginIds={injectionPluginIds}
              accountId={activeAccountId}
              searchActive={searchActive}
              searchQuery={searchQuery}
              canArchive={canArchive}
              onReply={() => openReplyWindow('reply')}
              onReplyAll={() => openReplyWindow('reply-all')}
              onForward={() => openReplyWindow('forward')}
              onToggleImages={(value) => void useMailStore.getState().setAllowRemoteImages(value)}
              onTogglePin={() => {
                if (!selectedEmail) return;
                void useMailStore.getState().setPinned(selectedEmail.id, !selectedEmail.pinned);
              }}
              onSnooze={(until) => {
                if (!selectedEmail) return;
                void useMailStore.getState().snooze(selectedEmail.id, until);
              }}
              onToggleRead={() => {
                if (!selectedEmail) return;
                void useMailStore.getState().setEmailFlags(selectedEmail.id, {
                  read: selectedEmail.unread,
                });
              }}
              onToggleStar={() => {
                if (!selectedEmail) return;
                void useMailStore.getState().setEmailFlags(selectedEmail.id, {
                  starred: !selectedEmail.starred,
                });
              }}
              onArchive={() => {
                if (!selectedEmail) return;
                void useMailStore.getState().archiveEmail(selectedEmail.id);
              }}
              onDelete={() => {
                if (!selectedEmail) return;
                void useMailStore.getState().deleteEmail(selectedEmail.id);
              }}
              onNextEmail={openNextEmail}
            />
          </>
          )
        ) : activeView === 'settings' ? (
          <SettingsView />
        ) : activeView === 'theme' ? (
          <ThemeView />
        ) : activeView === 'calendar' ? (
          <CalendarPanel onBack={() => setView('mail')} />
        ) : activeView === 'contacts' ? (
          <ContactsPanel
            onBack={() => setView('mail')}
            onCompose={(email) => {
              // 从联系人直接写信：把邮箱塞进收件人，正文与主题留空
              setCompose({ to: [email], cc: [], subject: '', body: '', raw: '' });
            }}
          />
        ) : activeView === 'plugin' && activePluginView ? (
          <PluginView
            key={`sidebar-plugin-${activePluginView}`}
            pluginId={activePluginView}
            slot="sidebar-item"
            accountId={activeAccountId}
            className="plugin-view plugin-main-view"
            title={`${activePluginView} 插件视图`}
          />
        ) : (
          <PluginsView />
        )}

        {/* 两条分割线（绝对定位，不占栅格）；非邮件视图只有侧栏那条 */}
        <PaneResizer
          edge="sidebar"
          widths={paneWidths}
          onChange={setPaneWidth}
          onCommit={persistPaneWidths}
          onReset={resetPaneWidths}
          collapsed={sidebarCollapsed}
          onCollapsedChange={setSidebarCollapsed}
        />
        {activeView === 'mail' ? (
          <PaneResizer
            edge="list"
            widths={paneWidths}
            onChange={setPaneWidth}
            onCommit={persistPaneWidths}
            onReset={resetPaneWidths}
            readerHidden={readerHidden}
            onReaderHiddenChange={setReaderHidden}
            vertical={vertical}
          />
        ) : null}
      </div>

      <footer className="statusbar">
        <div className="status-item">
          <span
            className={`status-dot${syncState?.syncing ? ' sync' : syncState?.error ? ' error' : ''}`}
            aria-hidden="true"
          />
          <span>{statusText}</span>
        </div>
        <div className="status-item">
          <span className="status-dot" aria-hidden="true" />
          <span>
            {accountStats.online} 个账户在线
            {accountStats.disabled > 0 ? ` · ${accountStats.disabled} 个已禁用` : ''}
          </span>
        </div>
        <div className="status-item">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <rect x="3" y="11" width="18" height="11" rx="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          <span>{bootstrap?.dbEncrypted ? '数据库已加密' : '数据库未加密'}</span>
        </div>

        <span className="statusbar-spacer" />

        {statusBarPlugins.map((pluginId) => (
          <PluginView
            key={`status-${pluginId}`}
            pluginId={pluginId}
            slot="status-bar"
            accountId={activeAccountId}
            className="statusbar-slot"
            title={`${pluginId} 状态`}
          />
        ))}

        <span className="status-hint">Ctrl/Cmd+K 命令面板</span>
        <div className="status-item">
          <span>{bootstrap?.proxy.enabled ? '代理已启用' : '直连'}</span>
          <span aria-hidden="true">·</span>
          <span>启动 {startupMs === null ? '—' : `${Math.round(startupMs)} ms`}</span>
          <span aria-hidden="true">·</span>
          <span>v{bootstrap?.appVersion ?? '—'}</span>
        </div>
      </footer>

      {panelPlugins.map((pluginId) => (
        <div
          key={`panel-${pluginId}`}
          className={`plugin-panel-drawer${activePanelPlugin === pluginId ? ' open' : ''}`}
          role="complementary"
          aria-label="插件面板"
          aria-hidden={activePanelPlugin !== pluginId}
        >
          <div className="plugin-panel-head">
            <span>账户面板</span>
            <button
              type="button"
              className="plugin-panel-close"
              aria-label="关闭面板"
              onClick={() => setActivePanelPlugin(null)}
            >
              ×
            </button>
          </div>
          <PluginView
            pluginId={pluginId}
            slot="panel"
            accountId={activeAccountId}
            className="plugin-panel-body"
            title={`${pluginId} 面板`}
          />
        </div>
      ))}

      <ComposeModal
        request={compose}
        onClose={() => {
          setCompose(null);
          // 关闭后刷新草稿数量，侧栏角标不必等用户点进草稿箱
          void useMailStore.getState().loadDrafts();
        }}
        onSent={(message) => {
          useMailStore.getState().showToast(message);
          // 新入队的邮件要立刻出现在发件箱与角标里
          void useMailStore.getState().loadOutbox();
        }}
      />

      {toast ? (
        <div className="toast" role="status" aria-live="polite">
          {toast}
        </div>
      ) : null}
      <CommandPalette
        open={paletteOpen}
        commands={commands}
        onClose={() => setPaletteOpen(false)}
      />
      <AiCommandModal
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        onSelectEmail={(email) => {
          setAiOpen(false);
          void useMailStore.getState().selectEmail(email.id, email);
        }}
      />

      {ribbonEditorOpen ? (
        <RibbonCustomizeDialog
          config={hostRibbonConfig}
          overrides={ribbonOverrides}
          pluginContributions={pluginRibbonSources}
          onSave={(json) => {
            void window.api.setSetting(RIBBON_SETTING_KEY, json).then((result) => {
              if (!result.ok) {
                useMailStore.getState().showToast(`保存失败：${result.error.message}`);
                return;
              }
              setRibbonOverrides(parseRibbonOverrides(json));
              useMailStore.getState().showToast('功能区已更新');
            });
            setRibbonEditorOpen(false);
          }}
          onClose={() => setRibbonEditorOpen(false)}
        />
      ) : null}

      {pluginMenu ? (
        <PluginMenu
          region={pluginMenu.region as MenuRegion}
          x={pluginMenu.x}
          y={pluginMenu.y}
          accountId={pluginMenu.accountId}
          context={pluginMenu.context}
          onRun={(item) => void runPluginItem({ ...item, accountId: pluginMenu.accountId })}
          onClose={() => setPluginMenu(null)}
        />
      ) : null}
    </div>
  );
}
