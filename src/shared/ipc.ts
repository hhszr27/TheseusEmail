import type {
  AccountView,
  AttachmentRisk,
  EmailBody,
  EmailSummary,
  FolderView,
  P2pClientIdentity,
  ParsedCommand,
  PluginPermission,
  RiskLevel,
  ScanProgress,
  ScanResult,
  SlotName,
  SyncCapabilityLevel,
  TraySettings,
} from './types';
import type {
  PluginCommandRunResult,
  PluginDraftContext,
  PluginDraftPatch,
  PluginMenuItem,
  PluginMenuQuery,
  PluginRegistrySnapshot,
  PluginViewSession,
} from './plugin';
import type { PreviewKind } from './attachments';
import type { AccountInput } from './accounts';

export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

export type { TraySettings } from './types';

export type ProxySource = 'env' | 'system' | 'none';

export interface ProxyStatus {
  enabled: boolean;
  source: ProxySource;
  uri?: string;
  bypassPrivate: boolean;
}

export interface BootstrapData {
  accounts: AccountView[];
  folders: FolderView[];
  activeAccountId: string | null;
  defaultFolder: string;
  appVersion: string;
  electronVersion: string;
  platform: string;
  dbEncrypted: boolean;
  keyProtection: 'safeStorage' | 'plain' | 'master';
  proxy: ProxyStatus;
  firstRunHint: string | null;
}

/**
 * 邮件列表筛选（§7.8.2）。只保留本机数据模型有支撑的三项：
 * 「提及的邮件」需要 @我 语义，IMAP 没有对应字段，故不提供。
 */
export type ListFilter = 'all' | 'unread' | 'starred';

/**
 * 邮件列表排列方式。只保留可排序的列：
 * 「类别 / 大小 / 类型 / 重要性 / 标记日期」在本机模型中无对应字段。
 */
export type ListSort =
  | 'date'
  | 'from'
  | 'to'
  | 'flagged'
  | 'subject'
  | 'attachments'
  | 'account';

export interface ListEmailsRequest {
  accountId: string;
  folder: string;
  offset?: number;
  limit?: number;
  /** 筛选口径；缺省为 all（全部邮件）。总行数用同一口径计算。 */
  filter?: ListFilter;
  /** 排列方式；缺省为 date（按日期倒序）。 */
  sort?: ListSort;
}

export interface ListEmailsResponse {
  emails: EmailSummary[];
  total: number;
  offset: number;
}

export interface GetBodyRequest {
  emailId: string;
  allowRemoteImages?: boolean;
}

export interface GetBodyResponse {
  id: string;
  html: string;
  text: string;
  blockedRemoteImages: number;
  remoteImages: string[];
  /** 正文是否经过主进程净化（必须恒为 true）。 */
  sanitized: true;
}

export interface SyncStateView {
  accountId: string;
  folder: string;
  level: SyncCapabilityLevel;
  needsFullResync: boolean;
  lastSyncAt: number;
  error?: string;
  syncing: boolean;
}

export interface DiagnosticsData {
  startupMs: number | null;
  processCreationMs: number | null;
  dbPath: string;
  logDir: string;
  dbEncrypted: boolean;
  keyProtection: 'safeStorage' | 'plain' | 'master';
  proxy: ProxyStatus;
  gpuCrashes: number;
  hardwareAcceleration: boolean;
  counts: { emails: number; accounts: number; folders: number };
  /** 主窗口实际的 webPreferences 快照，用于证明 §36 安全基线。 */
  security: {
    sandbox: boolean;
    contextIsolation: boolean;
    nodeIntegration: boolean;
    webviewTag: boolean;
  };
  /** 托盘状态（宿主能力）：图标是否存活、当前未读数与设置。 */
  tray: {
    active: boolean;
    unread: number;
    settings: TraySettings;
  };
}

/** 通知设置视图（§22）：桌面通知总项 + 免打扰时段。 */
export interface NotificationSettingsView {
  mail: boolean;
  sendResult: boolean;
  reminders: boolean;
  reminderMinutes: number;
  dnd: {
    enabled: boolean;
    startHour: number;
    endHour: number;
  };
}

/** 托盘菜单/通知点击后要求渲染进程执行的动作。 */
export type TrayActionPayload =
  | { action: 'open' }
  | { action: 'compose' }
  | { action: 'refresh' }
  | { action: 'outbox' };

export interface RecoveryInfo {
  reason: string;
  exitCode: number;
  source: string;
  occurredAt: number;
  appVersion: string;
  electronVersion: string;
  /** 崩溃前最近的结构化日志行（已脱敏）。 */
  recentLogs: string[];
  reloadLabel: string;
}

export interface MailtoRequest {
  to: string[];
  subject: string;
  body: string;
  cc: string[];
  /** 密送：只进发送信封，不写进任何可见头。 */
  bcc?: string[];
  raw: string;
  /** 写信来源：回复/转发时用于界面提示，mailto 链接为 mailto。 */
  kind?: 'mailto' | 'new' | 'reply' | 'reply-all' | 'forward';
  /** 指定发件账户（回复/转发沿用原邮件账户）；缺省走当前视图或上次使用的账户。 */
  accountId?: string;
  /** 从草稿箱继续编辑时带回已选附件（文件本体仍在主进程暂存目录）。 */
  attachments?: ComposeAttachmentInfo[];
  /** 富文本正文（HTML）；存在且非空时写信编辑器用它初始化，否则回落到纯文本 body。 */
  html?: string;
}

export interface ThemeCssResponse {
  ok: boolean;
  css?: string;
  reason?: string;
}

export interface SearchRequest {
  query: string;
  accountId?: string;
  folder?: string;
  limit?: number;
  /** account：只搜该账户；enabled：全部启用账户；all：包含禁用账户。 */
  scope?: 'account' | 'enabled' | 'all';
  /** 与列表同口径的筛选（全部/未读/已标记）。 */
  filter?: ListFilter;
  /** 与列表同口径的排列方式。 */
  sort?: ListSort;
}

export interface ContactSuggestion {
  email: string;
  displayName: string | null;
  interactionCount: number;
  lastContactedAt: number;
}

/** 写信附件（暂存在主进程，渲染进程只拿 id 与元信息）。 */
export interface ComposeAttachmentInfo {
  id: string;
  filename: string;
  size: number;
  mimeType: string;
}

/** 本地草稿（每账户一封）。服务器草稿也复用此结构（见 listServerDrafts）。 */
export interface ComposeDraft {
  accountId: string;
  to: string[];
  cc: string[];
  /** 密送地址（草稿里也要保留）。 */
  bcc: string[];
  subject: string;
  body: string;
  attachments: ComposeAttachmentInfo[];
  updatedAt: number;
  /** 富文本正文（HTML）；为空字符串表示纯文本。 */
  html?: string;
  /** 对应服务器 Drafts 文件夹中的 uid；-1 表示尚未对应（-1 仅用于本地草稿内部表示）。 */
  serverUid?: number;
  /**
   * 草稿列表里稳定的唯一键：
   *  - 本地草稿用 accountId；
   *  - 服务器草稿用 `accountId:uid`，避免与同账户的本地草稿重复显示。
   */
  key?: string;
}

export interface ScheduleSendRequest {
  /** 密送：只用于 SMTP 信封，不写进消息头。 */
  bcc?: string[];
  accountId: string;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  /** 富文本正文（HTML）；存在且非空时随邮件一起发送 multipart/alternative。 */
  html?: string;
  /** 绝对发送时间（毫秒）；缺省表示立即发送。 */
  sendAt?: number;
  /** 兼容旧调用：未给 sendAt 时按「现在 + undoDelayMs」入队。 */
  undoDelayMs?: number;
  /** 暂存附件 id 列表（由 pickComposeAttachments 返回）。 */
  attachments?: string[];
}

export interface ScheduledSendInfo {
  id: string;
  accountId: string;
  sendAt: number;
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled';
  subject: string;
  to: string[];
  retryCount: number;
  lastError: string | null;
}

export interface SearchResponse {
  emails: EmailSummary[];
  total: number;
  parsed: {
    text: string;
    from?: string;
    subject?: string;
    hasAttachment?: boolean;
    after?: number;
    before?: number;
  };
}

/** preload 通过 contextBridge 暴露给渲染进程的白名单 API。 */
export interface MailforgeApi {
  getBootstrap(): Promise<Result<BootstrapData>>;
  listEmails(req: ListEmailsRequest): Promise<Result<ListEmailsResponse>>;
  getBody(req: GetBodyRequest): Promise<Result<GetBodyResponse>>;
  /** 按 id 取单封邮件摘要（独立阅读窗口用，避免为单封邮件拉取整页列表）。 */
  getEmail(id: string): Promise<Result<EmailSummary>>;
  getFolders(accountId: string): Promise<Result<FolderView[]>>;
  refresh(accountId?: string): Promise<Result<{ queued: number }>>;
  openExternal(url: string): Promise<Result<{ opened: boolean; reason?: string }>>;
  /** 让承载渲染进程的窗口原生全屏/退出全屏（true=全屏，false=退出）。 */
  windowSetFullScreen(on: boolean): Promise<Result<boolean>>;
  getDiagnostics(): Promise<Result<DiagnosticsData>>;
  rendererReady(payload: { mountMs: number }): Promise<Result<{ startupMs: number }>>;
  /** 从界面正常退出应用（与托盘「退出」共用 before-quit 清理流程）。 */
  quit(): Promise<void>;
  searchEmails(req: SearchRequest): Promise<Result<SearchResponse>>;
  setPinned(emailId: string, pinned: boolean): Promise<Result<boolean>>;
  /** 已读/未读与星标（先写服务端再改本地）。 */
  setEmailFlags(emailId: string, patch: { read?: boolean; starred?: boolean }): Promise<Result<EmailSummary>>;
  archiveEmail(emailId: string): Promise<Result<{ folder: string }>>;
  moveEmail(emailId: string, folder: string): Promise<Result<EmailSummary>>;
  deleteEmail(emailId: string): Promise<Result<{ removed: boolean }>>;
  snoozeEmail(emailId: string, until: number | null): Promise<Result<boolean>>;
  searchContacts(query: string): Promise<Result<ContactSuggestion[]>>;
  /** 联系人面板：按交互频率取一批联系人（不是只取自动补全的前 8 条）。 */
  listContacts(limit?: number): Promise<Result<ContactSuggestion[]>>;
  scheduleSend(request: ScheduleSendRequest): Promise<Result<{ id: string; sendAt: number }>>;
  /** 选择附件：主进程弹文件对话框并把文件复制到暂存目录。 */
  pickComposeAttachments(): Promise<Result<ComposeAttachmentInfo[]>>;
  /** 移除并删除暂存附件。 */
  dropComposeAttachment(id: string): Promise<Result<boolean>>;
  /** 把拖入界面的本地文件路径暂存为附件（与选择附件共用暂存目录）。 */
  stageComposeAttachments(paths: string[]): Promise<Result<ComposeAttachmentInfo[]>>;
  /** 读取该账户的本地草稿（没有则返回 null）。 */
  getDraft(accountId: string): Promise<Result<ComposeDraft | null>>;
  /** 保存草稿（按账户覆盖）。 */
  saveDraft(input: Omit<ComposeDraft, 'updatedAt'>): Promise<Result<ComposeDraft>>;
  /** 删除草稿。serverGated=true 时：先删服务器，成功才删本地；服务器失败返回 fail 且不删本地（交由渲染进程回滚）。不传则尽力删服务器、本地始终删除。 */
  deleteDraft(accountId: string, serverGated?: boolean): Promise<Result<boolean>>;
  /** 所有账户的本地草稿，按更新时间倒序。 */
  listDrafts(): Promise<Result<ComposeDraft[]>>;
  /** 所有账户的服务器 Drafts 文件夹草稿（合并所有账户）；演示账户返回空。 */
  listServerDrafts(force?: boolean): Promise<Result<ComposeDraft[]>>;
  /** 删除某个账户的某一封服务器草稿（按 uid）。 */
  deleteServerDraft(accountId: string, uid: number): Promise<Result<boolean>>;
  cancelScheduledSend(id: string): Promise<Result<boolean>>;
  listScheduledSends(): Promise<Result<ScheduledSendInfo[]>>;
  pluginsRegistry(): Promise<Result<PluginRegistrySnapshot>>;
  setPluginEnabled(pluginId: string, enabled: boolean): Promise<Result<boolean>>;
  getPluginTheme(themeId: string): Promise<ThemeCssResponse>;
  getPluginIcon(pluginId: string, name: string): Promise<Result<string | null>>;
  getPluginView(
    pluginId: string,
    slot: SlotName,
    accountId?: string | null,
  ): Promise<Result<PluginViewSession | null>>;
  getPluginMenuItems(query: PluginMenuQuery): Promise<Result<PluginMenuItem[]>>;
  runPluginCommand(
    pluginId: string,
    commandId: string,
    accountId?: string | null,
  ): Promise<Result<PluginCommandRunResult>>;
  setPluginAccountOverride(
    pluginId: string,
    accountId: string,
    enabled: boolean | null,
  ): Promise<Result<boolean>>;
  setPluginDraftContext(context: PluginDraftContext | null): Promise<Result<boolean>>;
  onDraftPatch(cb: (payload: { pluginId: string; patch: PluginDraftPatch }) => void): () => void;
  openPluginDevtools(pluginId: string): Promise<Result<boolean>>;
  setPluginActiveEmail(emailId: string | null): Promise<Result<unknown>>;
  revokePluginPermission(
    pluginId: string,
    permission: PluginPermission,
    revoked: boolean,
  ): Promise<Result<boolean>>;
  getSetting(key: string): Promise<Result<string | null>>;
  setSetting(key: string, value: string): Promise<Result<boolean>>;

  // ---- 账户管理（§7.8） ----
  listAccounts(): Promise<Result<AccountView[]>>;
  addAccount(input: AccountInput): Promise<Result<AccountView>>;
  updateAccount(id: string, input: AccountInput): Promise<Result<AccountView>>;
  removeAccount(id: string): Promise<Result<{ removed: boolean; emails?: number }>>;
  setAccountEnabled(id: string, enabled: boolean): Promise<Result<AccountView>>;
  reauthenticateAccount(id: string, password: string): Promise<Result<AccountView>>;
  prioritizeAccount(id: string): Promise<Result<boolean>>;
  /** P2P 客户端身份（§24.1.1）：首次启动生成并持久化，重启不变。 */
  getP2pIdentity(): Promise<Result<P2pClientIdentity>>;
  onAccountsChanged(cb: () => void): () => void;
  onMailto(cb: (req: MailtoRequest) => void): () => void;
  onSyncState(cb: (state: SyncStateView) => void): () => void;
  onPluginsChanged(cb: () => void): () => void;
  onScanUpdate(cb: (update: ScanUpdateEvent) => void): () => void;
  /** 扫描批次的开始/结束：用来把「打开」置灰、显示「扫描中」。 */
  onScanProgress(cb: (progress: ScanProgress) => void): () => void;

  // ---- Phase 3：附件 ----
  listAttachments(emailId: string): Promise<Result<AttachmentView[]>>;
  getAttachmentPayload(attachmentId: string): Promise<Result<AttachmentPayload>>;
  openAttachment(attachmentId: string): Promise<Result<{ opened: boolean; reason?: string }>>;
  saveAttachment(attachmentId: string): Promise<Result<{ saved: boolean; path?: string }>>;
  scanEmail(emailId: string): Promise<Result<{ queued: number }>>;
  /** 停止某封邮件正在进行的扫描（按邮件停，不影响其他邮件）。 */
  cancelScan(emailId: string): Promise<Result<{ cancelled: boolean }>>;
  /** 各扫描源的可用性（设置页展示"为什么没扫"）。 */
  getScanProviders(): Promise<Result<ScanProviderStatus[]>>;
  getAttachmentExtensions(): Promise<Result<AttachmentExtensionSettings>>;
  setAttachmentExtensions(settings: AttachmentExtensionSettings): Promise<Result<boolean>>;

  // ---- 签名（§ 撰写）----
  /** 列出某账户的全部签名（按创建时间）。 */
  listSignatures(accountId: string): Promise<Result<SignatureView[]>>;
  /** 新建一套空签名，返回新建项。 */
  createSignature(accountId: string, name?: string): Promise<Result<SignatureView>>;
  /** 重命名一套签名。 */
  renameSignature(id: string, name: string): Promise<Result<boolean>>;
  /** 删除一套签名（默认签名会自动顺延到同账户剩余第一套）。 */
  deleteSignature(id: string): Promise<Result<boolean>>;
  /** 保存签名正文（中间编辑框的 HTML）。 */
  saveSignature(id: string, html: string): Promise<Result<boolean>>;
  /** 设置某账户新邮件 / 回复转发的默认签名；signatureId 为 null 表示清除。 */
  setDefaultSignature(
    accountId: string,
    kind: 'new' | 'reply',
    signatureId: string | null,
  ): Promise<Result<boolean>>;

  // ---- 正文右键菜单（图片 / 文本） ----
  /** 把正文里的图片复制到剪贴板（只接受 data:image 与 http(s)）。 */
  copyReaderImage(request: ReaderImageRequest): Promise<Result<{ copied: boolean }>>;
  /** 把正文里的图片另存为文件（主进程弹保存对话框，取消返回 saved=false）。 */
  saveReaderImage(request: ReaderImageRequest): Promise<Result<ReaderImageSaveResult>>;
  /** 复制纯文本到剪贴板（正文右键「复制」）。 */
  copyText(text: string): Promise<Result<boolean>>;

  // ---- 文件夹右键菜单 ----
  /** 在服务端新建文件夹（父路径为空表示根目录），成功后立即刷新侧栏。 */
  createFolder(request: FolderCreateRequest): Promise<Result<{ path: string }>>;
  /** 读取文件夹属性（含同步状态）。 */
  getFolderDetails(accountId: string, folder: string): Promise<Result<FolderDetails>>;
  /** 把整个文件夹标为已读：先本地立即生效，再尽力同步到服务端。 */
  markFolderRead(accountId: string, folder: string): Promise<Result<{ marked: number }>>;
  /** 重命名文件夹（系统文件夹不可改；子文件夹路径会一起迁移）。 */
  renameFolder(request: FolderRenameRequest): Promise<Result<{ path: string }>>;
  /** 移动文件夹到另一个父文件夹下（不能移进自己或自己的子目录）。 */
  moveFolder(request: FolderMoveRequest): Promise<Result<{ path: string }>>;
  /** 删除文件夹（不可撤销；服务端删除成功后才清本地）。 */
  deleteFolder(request: FolderDeleteRequest): Promise<Result<FolderDeleteResult>>;
  /** 复制文件夹（建目标 + 复制全部邮件；带子文件夹的拒绝）。 */
  copyFolder(request: FolderCopyRequest): Promise<Result<{ path: string; copied: number }>>;
  /** 清空文件夹里的全部邮件（服务端 + 本地）。 */
  clearFolder(accountId: string, folder: string): Promise<Result<FolderClearResult>>;
  /** 统计同一文件夹里 Message-ID 重复的邮件数（清理前先给用户看）。 */
  folderDuplicates(accountId: string, folder: string): Promise<Result<FolderDuplicatesResult>>;
  /** 清理重复邮件：保留每组的最后一封，其余删除。 */
  dedupeFolder(accountId: string, folder: string): Promise<Result<{ removed: number }>>;
  /** 在新的窗口里打开某个文件夹。 */
  openFolderWindow(accountId: string, folder: string): Promise<Result<boolean>>;
  /**
   * 双击邮件时，在新的原生窗口里打开该邮件的独立阅读视图。
   * 传入 compose 时，窗口直接进入回复/全部回复/转发的写信视图（Outlook 式）。
   */
  openReaderWindow(
    emailId: string,
    compose?: 'reply' | 'reply-all' | 'forward',
  ): Promise<Result<boolean>>;
  /** 启动时是否只允许一个实例（关闭后可以多开）。 */
  getInstanceMode(): Promise<Result<boolean>>;
  /** 写入单实例开关；下次启动生效。 */
  setInstanceMode(singleInstance: boolean): Promise<Result<boolean>>;

  // ---- Phase 3：翻译 ----
  getTranslationSettings(): Promise<Result<TranslationSettingsView>>;
  setTranslationSettings(
    settings: Partial<TranslationSettingsView> & { apiKey?: string; region?: string },
  ): Promise<Result<boolean>>;
  translateEmail(request: TranslationRequest): Promise<Result<TranslationOutcome>>;

  // ---- Phase 3：AI ----
  getAiSettings(): Promise<Result<AiSettingsView>>;
  setAiSettings(settings: Partial<AiSettingsView> & { apiKey?: string }): Promise<Result<boolean>>;
  summarizeEmail(emailId: string): Promise<Result<AiSummaryResult>>;
  semanticSearch(query: string, limit?: number): Promise<Result<SemanticSearchResult>>;
  prepareCommand(input: string): Promise<Result<CommandPreparation>>;
  confirmCommand(request: CommandConfirmRequest): Promise<Result<{ id: string; sendAt: number }>>;

  // ---- Phase 3：日历 ----
  listCalendarAccounts(): Promise<Result<CalendarAccountView[]>>;
  addCalendarAccount(input: CalendarAccountInput): Promise<Result<CalendarAccountView>>;
  removeCalendarAccount(id: string): Promise<Result<boolean>>;
  syncCalendar(id?: string): Promise<Result<CalendarSyncResult[]>>;
  listCalendarEvents(range: { from: number; to: number }): Promise<Result<CalendarEventView[]>>;
  /** 新建本地日历事件（日程 / 会议 / 纪念日 / 生日），不写回远程服务器。 */
  createCalendarEvent(input: CalendarEventInput): Promise<Result<CalendarEventView>>;
  /** 修改本地事件；远程同步来的事件不可改。 */
  updateCalendarEvent(patch: CalendarEventPatch): Promise<Result<CalendarEventView>>;
  /** 删除本地事件；重复事件按 request.scope 处理单个实例或整段。 */
  deleteCalendarEvent(request: CalendarEventDeleteRequest): Promise<Result<boolean>>;

  // ---- Phase 3：归档 / 网络 / 安全 ----
  importMbox(request: { accountId: string; folderName?: string }): Promise<Result<MboxImportResult>>;
  exportMbox(request: { accountId: string; folder: string }): Promise<Result<MboxExportResult>>;
  getDohStatus(): Promise<Result<DohStatus>>;
  setDoh(enabled: boolean): Promise<Result<DohStatus>>;
  getMasterPasswordStatus(): Promise<Result<MasterPasswordStatus>>;
  setMasterPassword(password: string | null, currentPassword?: string): Promise<Result<MasterPasswordStatus>>;
  getMetadataStatus(): Promise<Result<MetadataStatus>>;
  syncMetadata(request: { accountId: string; direction: 'pull' | 'push' }): Promise<Result<MetadataStatus>>;

  // ---- 托盘与通知（宿主能力） ----
  getTraySettings(): Promise<Result<TraySettings>>;
  setTraySettings(patch: Partial<TraySettings>): Promise<Result<TraySettings>>;
  getNotificationSettings(): Promise<Result<NotificationSettingsView>>;
  setNotificationSettings(
    patch: Partial<Omit<NotificationSettingsView, 'dnd'>> & {
      dnd?: Partial<NotificationSettingsView['dnd']>;
    },
  ): Promise<Result<NotificationSettingsView>>;
  /** 发送测试通知；supported=false 表示当前系统不支持桌面通知。 */
  sendTestNotification(): Promise<Result<{ supported: boolean }>>;
  /** 订阅工具栏配置变更（主进程广播，用于多窗口同步）。返回取消订阅函数。 */
  onRibbonChanged(callback: (json: string) => void): () => void;
  /** 订阅快捷键配置变更（同上）。 */
  onKeybindingsChanged(callback: (json: string) => void): () => void;
  onNotificationOpen(cb: (payload: { emailId: string }) => void): () => void;
  onTrayAction(cb: (payload: TrayActionPayload) => void): () => void;
}

export interface ScanUpdateEvent {
  emailId: string;
  kind: 'url' | 'attachment';
  target: string;
  attachmentId?: string;
  result: ScanResult;
  riskLevel?: RiskLevel;
}

export interface AttachmentView {
  id: string;
  emailId: string;
  filename: string;
  mimeType: string;
  size: number;
  ext: string;
  sha256?: string;
  handling: 'preview' | 'system' | 'confirm' | 'blocked';
  /** 被禁止打开的原因：用户配置的扩展名策略，还是扫描判定恶意。 */
  blockedBy?: 'policy' | 'scan';
  previewKind: PreviewKind;
  risk: AttachmentRisk;
  scannedAt?: number;
}

export interface AttachmentPayload {
  id: string;
  kind: 'text' | 'image' | 'pdf';
  filename: string;
  mimeType: string;
  text?: string;
  dataBase64?: string;
  truncated: boolean;
}

export interface AttachmentExtensionSettings {
  customTextExts: string[];
  /** 兼容旧数据；新写入统一用 warnExts 表达完整列表。 */
  customDangerExts: string[];
  /** 「打开前提示」的完整列表：用户可增删，未提供时用内置默认。 */
  warnExts?: string[];
  /** 「禁止打开」的完整列表：用户可增删，未提供时用内置默认。 */
  blockExts?: string[];
  /** 旧字段：等价于 warnExts。 */
  dangerousExts?: string[];
}

/** 一套签名（§ 撰写）：每个账户可有多套，新邮件与回复/转发各一个默认。 */
export interface SignatureView {
  id: string;
  accountId: string;
  name: string;
  html: string;
  isDefaultNew: boolean;
  isDefaultReply: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 扫描源状态：不可用时给出原因，避免"静默不扫"让用户以为扫过了。 */
export interface ScanProviderStatus {
  id: string;
  name: string;
  available: boolean;
  reason?: string;
}

/** 正文图片操作请求（右键菜单）。 */
export interface ReaderImageRequest {
  /** 图片地址：只接受 data:image/* 与 http(s)，其他协议一律拒绝。 */
  src: string;
  /** 用于生成默认文件名的提示（图片 alt / 邮件主题）。 */
  alt?: string;
}

export interface ReaderImageSaveResult {
  saved: boolean;
  path?: string;
}

/** 新建文件夹请求。 */
export interface FolderCreateRequest {
  accountId: string;
  /** 父文件夹路径；为空表示建在账户根目录下。 */
  parentPath?: string;
  name: string;
}

/** 重命名文件夹请求（只改最后一段名字，父路径不动）。 */
export interface FolderRenameRequest {
  accountId: string;
  path: string;
  name: string;
}

/** 移动文件夹请求（targetParent 为空表示移到根目录）。 */
export interface FolderMoveRequest {
  accountId: string;
  path: string;
  targetParent: string;
}

export interface FolderDeleteRequest {
  accountId: string;
  path: string;
}

export interface FolderDeleteResult {
  path: string;
  /** 连带清掉的本地文件夹数（含子文件夹）与邮件数。 */
  folders: number;
  emails: number;
}

/** 复制文件夹：在同一父目录下建一个新名字，再把源里的邮件全部复制过去。 */
export interface FolderCopyRequest {
  accountId: string;
  path: string;
  name: string;
}

export interface FolderClearResult {
  /** 服务端删掉的封数。 */
  removed: number;
  /** 本地清掉的封数。 */
  localRemoved: number;
}

export interface FolderDuplicatesResult {
  /** 同 Message-ID 的重复邮件数（保留最新一封后剩下的）。 */
  count: number;
}

/** 文件夹属性（右键「属性」+ 侧栏悬停提示的数据来源）。 */export interface FolderDetails {
  accountId: string;
  path: string;
  name: string;
  delimiter: string;
  specialUse?: string;
  total: number;
  unread: number;
  /** 服务端 UIDVALIDITY；从未同步过为 0。 */
  uidValidity: number;
  lastSyncAt: number;
  capabilityLevel: string;
  needsFullResync: boolean;
}

export interface TranslationSettingsView {
  enabled: boolean;
  providerId: string;
  targetLang: string;
  configured: boolean;
  /** 设置页必须展示的数据出境提示（§14.4）。 */
  dataTransferNotice: string;
}

export interface TranslationRequest {
  emailId: string;
  targetLang?: string;
  confirmLong?: boolean;
}

export type TranslationOutcome =
  | {
      status: 'ok';
      emailId: string;
      targetLang: string;
      provider: string;
      text: string;
      cached: boolean;
      chars: number;
    }
  | { status: 'needs_confirm'; chars: number; message: string }
  | { status: 'unavailable'; message: string }
  | { status: 'skipped'; reason: 'same-language' | 'empty' };

export interface AiSettingsView {
  enabled: boolean;
  providerId: string;
  model: string;
  baseUrl: string;
  local: boolean;
  configured: boolean;
  features: { summarize: boolean; semanticSearch: boolean; command: boolean };
  dataTransferNotice: string;
}

export interface AiSummaryResult {
  summary: string;
  provider: string;
}

export interface SemanticSearchResult {
  emailIds: string[];
  scores: Array<{ emailId: string; score: number }>;
  emails: EmailSummary[];
}

export interface CommandChoice {
  index: number;
  query: string;
  candidates: Array<{ email: string; displayName: string | null }>;
}

export type CommandPreparation =
  | {
      status: 'ready';
      command: ParsedCommand;
      requiresConfirmation: boolean;
      attempts: number;
    }
  | {
      status: 'needs_choice';
      command: ParsedCommand;
      choices: CommandChoice[];
      attempts: number;
    }
  | { status: 'rejected'; message: string; attempts: number; issues: Array<{ path: string; message: string }> };

export interface CommandConfirmRequest {
  accountId: string;
  command: ParsedCommand;
}

export interface CalendarAccountInput {
  kind: 'caldav' | 'ics';
  name: string;
  url: string;
  username?: string;
  password?: string;
  color?: string;
}

export interface CalendarAccountView {
  id: string;
  kind: 'caldav' | 'ics';
  name: string;
  url: string;
  username: string | null;
  color: string | null;
  readOnly: boolean;
  lastSyncAt: number;
  lastError: string | null;
  enabled: boolean;
}

export interface CalendarEventView {
  id: string;
  calendarId: string;
  uid: string | null;
  summary: string;
  startsAt: number;
  endsAt: number;
  allDay: boolean;
  location?: string;
  description?: string;
  /** 事件类型；远程同步来的事件没有该字段（按普通日程处理）。 */
  kind?: CalendarEventKind;
  /** 重复规则；没有表示单次事件。 */
  rrule?: CalendarRecurrence;
}

/** 本地事件的重复规则（简化版：只支持频率与间隔，够覆盖日常用法）。 */
export interface CalendarRecurrence {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  /** 间隔，缺省 1（如每 2 周）。 */
  interval?: number;
  /** 截止时间（含），用于「删除此及后续」截断系列。 */
  until?: number;
}

/**
 * 重复事件的操作范围。
 * - this：仅这一实例
 * - thisAndFuture：这一实例及之后
 * - all：整个系列
 * - future：这一实例之后（不含）
 * - past：这一实例之前（不含）
 * - pastAndThis：这一实例及之前
 */
export type CalendarEventScope =
  | 'this'
  | 'thisAndFuture'
  | 'all'
  | 'future'
  | 'past'
  | 'pastAndThis';

export interface CalendarEventDeleteRequest {
  id: string;
  /** 操作针对的实例开始时间；单次事件可不传。 */
  occurrenceStart?: number;
  scope?: CalendarEventScope;
}

/** 本地新建事件的类型（日程 / 会议 / 纪念日 / 生日）。 */
export type CalendarEventKind = 'event' | 'meeting' | 'anniversary' | 'birthday';

export interface CalendarEventInput {
  kind: CalendarEventKind;
  summary: string;
  startsAt: number;
  /** 省略时：全天事件按当天结束，定时事件默认 1 小时。 */
  endsAt?: number;
  allDay: boolean;
  location?: string;
  description?: string;
  /** 重复规则；省略表示单次事件。 */
  rrule?: CalendarRecurrence;
}

/** 修改本地事件：在新建字段基础上带上事件 id 与（重复事件的）操作范围。 */
export type CalendarEventPatch = CalendarEventInput & {
  id: string;
  /** 省略 = 整个系列。 */
  scope?: CalendarEventScope;
  /** 操作针对的实例开始时间。 */
  occurrenceStart?: number;
};

export interface CalendarSyncResult {
  accountId: string;
  added: number;
  updated: number;
  deleted: number;
  error?: string;
}

export interface MboxImportResult {
  imported: number;
  folder: string;
  errors: number;
}

export interface MboxExportResult {
  exported: number;
  path: string;
}

export interface DohStatus {
  enabled: boolean;
  template: string;
  applied: boolean;
  requiresRestart: boolean;
}

export interface MasterPasswordStatus {
  enabled: boolean;
}

export interface MetadataStatus {
  supported: boolean;
  enabled: boolean;
  lastSyncAt: number | null;
  error: string | null;
}

export interface RecoveryApi {
  getInfo(): Promise<RecoveryInfo>;
  reload(): Promise<void>;
  quit(): Promise<void>;
}

export type EmailBodyPayload = EmailBody;
