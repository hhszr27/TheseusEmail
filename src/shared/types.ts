// ---------- 账户 ----------
export type AuthMethod =
  | { type: 'password'; secretRef: string }
  | { type: 'oauth2'; accessTokenRef: string; refreshTokenRef: string; expiresAt: number }
  | { type: 'graph'; accessTokenRef: string; refreshTokenRef: string; expiresAt: number };

export type AccountAuthState = 'ok' | 'requires_reauth';

export interface Account {
  id: string;
  displayName: string;
  email: string;
  protocol: 'imap-smtp' | 'graph' | 'jmap';
  providerPreset?: 'qq' | 'netease' | 'gmail' | 'outlook' | 'custom';
  imap?: { host: string; port: number; secure: boolean };
  smtp?: { host: string; port: number; secure: boolean };
  auth: AuthMethod;
  authState: AccountAuthState;
  namespacePrefix?: string;
  folderDelimiter?: string;
  createdAt: number;
  /** 启用/禁用；禁用只停同步，不删本地数据（§7.8.1）。 */
  enabled: boolean;
  /** 侧边栏显示排序，越小越靠前。 */
  order: number;
  color?: string;
  lastSyncAt?: number;
  lastError?: { code: string; message: string; at: number };
  settings: AccountSettings;
}

/**
 * 下载首选项（对齐 Outlook）：控制 IMAP 同步时正文的抓取范围。
 * - entire：下载整个项目（正文随同步一并抓取，离线可读全部）
 * - headers-then-item：先下载邮件头，再在后台补正文（默认）
 * - headers-only：仅下载邮件头，正文在点开时按需抓取
 * - headers-only-slow：低速连接时仅下载邮件头，否则同 headers-then-item
 */
export type DownloadPreference =
  | 'entire'
  | 'headers-then-item'
  | 'headers-only'
  | 'headers-only-slow';

export interface AccountSettings {
  signature?: string;
  signatureFormat?: 'plain' | 'html';
  autoReply?: { enabled: boolean; message: string; until?: number };
  notificationOverride?: 'inherit' | 'notify' | 'silent';
  defaultSendAccount?: boolean;
  /** 下载首选项：缺省 headers-then-item（先头后整）。 */
  downloadPreference?: DownloadPreference;
  /** pluginId -> 是否在该账户启用（缺省继承全局启用状态，§7.8.4）。 */
  pluginOverrides?: Record<string, boolean>;
  /**
   * 演示账户：不发起网络连接，仅用于界面预览（seed 脚本写入）。
   * 生产环境不会出现该字段。
   */
  demoMode?: boolean;
}

export type AccountRuntimeStatus =
  | 'active'
  | 'first_sync'
  | 'syncing'
  | 'offline'
  | 'requires_reauth'
  | 'disabled'
  | 'error';

/** 渲染进程可见的账户视图，绝不包含凭证信息（只有 secretRef 的存在性）。 */
export interface AccountView {
  id: string;
  displayName: string;
  email: string;
  protocol: Account['protocol'];
  providerPreset?: Account['providerPreset'];
  imapHost?: string;
  imapPort?: number;
  imapSecure?: boolean;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  authType: AuthMethod['type'];
  authState: AccountAuthState;
  enabled: boolean;
  order: number;
  color?: string;
  lastSyncAt?: number;
  lastError?: { code: string; message: string; at: number };
  settings: AccountSettings;
  unreadCount: number;
  status: AccountRuntimeStatus;
}

// ---------- 邮件 ----------
export interface EmailAddress {
  name?: string;
  address: string;
}

export interface EmailSummary {
  id: string;
  uid: number;
  folder: string;
  accountId: string;
  subject: string;
  from: EmailAddress[];
  to: EmailAddress[];
  date: string; // ISO 8601
  snippet: string;
  hasAttachments: boolean;
  unread: boolean;
  starred: boolean;
  pinned: boolean;
  snoozedUntil?: number;
}

export interface EmailBody {
  id: string;
  html?: string;
  text?: string;
}

export interface AttachmentMeta {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  ext: string;
  sha256?: string;
}

// ---------- 同步状态 ----------
export type SyncCapabilityLevel = 'L1_CHANGEDSINCE' | 'L2_SEARCH_SINCE' | 'L3_UIDNEXT';

export type SpecialUse =
  | 'sent'
  | 'drafts'
  | 'trash'
  | 'archive'
  | 'junk'
  | 'all'
  | 'flagged';

export interface FolderSyncState {
  accountId: string;
  folder: string;
  uidvalidity: number;
  highestModseq?: number;
  uidnext?: number;
  capabilityLevel: SyncCapabilityLevel;
  specialUse?: SpecialUse;
  specialUseSource?: 'user' | 'extension' | 'name';
  lastSyncAt: number;
  needsFullResync: boolean;
}

export interface FolderView {
  accountId: string;
  path: string;
  name: string;
  delimiter: string;
  specialUse?: SpecialUse;
  specialUseSource?: 'user' | 'extension' | 'name';
  unread: number;
  total: number;
}

// ---------- 托盘与通知（宿主能力，非插件） ----------
/** 托盘设置；主进程 src/main/app/tray-settings.ts 持有默认值与解析逻辑。 */
export interface TraySettings {
  /** 是否显示托盘图标。关闭后「关闭到托盘」同时失效（否则用户将无法退出）。 */
  enabled: boolean;
  /** 点关闭按钮时隐藏到托盘而非退出。 */
  closeToTray: boolean;
  /** 最小化时隐藏到托盘。 */
  minimizeToTray: boolean;
  /** 托盘图标显示未读徽章。 */
  showUnreadBadge: boolean;
}

// ---------- 离线撤销 ----------
export interface OutboxEntry {
  id: string;
  accountId: string;
  intent: 'send' | 'move' | 'delete' | 'flag' | 'draft_update';
  payload: Record<string, unknown>;
  undo?: OutboxUndo;
  retryCount: number;
  nextRetryAt: number;
  status: 'pending' | 'inflight' | 'permanently_failed';
  lastErrorCode?: ConflictCode;
}

export interface OutboxUndo {
  type: 'restore_flag' | 'restore_folder' | 'restore_draft' | 'noop';
  data: Record<string, unknown>;
}

export type ConflictCode =
  | 'messageGone'
  | 'folderGone'
  | 'forbidden'
  | 'quota'
  | 'tooLarge'
  | 'stateConflict';

// ---------- 风险 ----------
export type RiskLevel = 'danger' | 'suspicious' | 'unknown' | 'safe';

export interface AttachmentRisk {
  level: RiskLevel;
  reason: string;
  tooltip: string;
  scanSource?: string;
  scanDetail?: string;
}

// ---------- 扫描 ----------
export type ScanInput =
  | { type: 'url'; value: string }
  /** `localPath` 只有本地内容扫描器（Defender）需要；基于哈希的服务可以忽略。 */
  | { type: 'attachment'; sha256: string; filename: string; localPath?: string };

/** 扫描批次的开始/结束通知（用于把「打开」置灰、显示「扫描中」）。 */
export interface ScanProgress {
  emailId: string;
  phase: 'start' | 'end';
  /** 本批次计划扫描的目标数。 */
  total: number;
}

export interface ScanResult {  verdict: 'malicious' | 'suspicious' | 'clean' | 'unknown';
  source: string;
  score?: number;
  detail?: string;
  scannedAt: number;
}

// ---------- 翻译 ----------
export interface TranslationProvider {
  id: string;
  name: string;
  supportedLanguages: string[];
  translate(texts: string[], targetLang: string, sourceLang?: string): Promise<string[]>;
}

// ---------- AI ----------
export interface AiProvider {
  id: string;
  name: string;
  local: boolean;
  summarize(texts: string[]): Promise<string>;
  draftReply(context: { subject: string; body: string; from: EmailAddress[] }): Promise<string>;
  rewrite(text: string, tone: 'formal' | 'friendly' | 'concise'): Promise<string>;
  semanticSearch(query: string, emailIds: string[]): Promise<string[]>;
  parseCommand(input: string): Promise<unknown>;
}

export interface ParsedCommand {
  action: 'schedule_send' | 'send_now' | 'draft';
  sendAt?: number;
  recipients: { name?: string; address?: string }[];
  bodyInstruction: { type: 'explicit_text' | 'generate_from_prompt'; content: string };
  confidence: number;
  raw: string;
  /** 正文由模型生成（必须走确认模式）。 */
  generated?: boolean;
}

// ---------- 插件（Phase 2 起启用，此处为契约占位） ----------
export type PluginPermission =
  | 'read:email-body'
  | 'read:email-meta'
  | 'write:draft'
  | 'network:external'
  | 'fs:temp'
  | 'notifications';

export interface PluginCapabilityHandle {
  pluginId: string;
  sessionNonce: string;
  permissions: PluginPermission[];
  grantedAt: number;
  revoked: boolean;
}

export interface KeyBinding {
  key: string;
  modifiers?: string[];
  command: string;
  when?: string;
}

export type MenuRegion =
  | 'main'
  | 'context:mail-list'
  | 'context:reader'
  | 'context:compose'
  | 'context:account';

export interface CommandDefinition {
  id: string;
  label: string;
  description?: string;
  /** 归属菜单区域；省略则只进命令面板（§13.3.1）。 */
  menu?: MenuRegion;
  /** 上下文条件表达式，如 "readerView && hasSelection"。 */
  when?: string;
  /** 执行该命令所需能力；缺失时菜单项仍显示，点击给出权限提示。 */
  requires?: PluginPermission;
  defaultKeybinding?: KeyBinding;
}

export interface RuleActionDefinition {
  id: string;
  label: string;
  description: string;
}

export type SlotName =
  | 'mail-list-header'
  | 'mail-list-item'
  | 'reader-view'
  | 'reader-panel-top'
  | 'reader-panel-bottom'
  | 'compose-view'
  | 'compose-toolbar'
  | 'sidebar-item'
  | 'settings-section'
  | 'status-bar'
  | 'global-toolbar'
  | 'panel';

/**
 * 插件对 ribbon 的工具贡献（§13.3.2）。
 *
 * 安全模型：只声明「在哪个标签放一个按钮、点了执行本插件的哪个命令」，
 * 不承载任意脚本。command 必须在本插件 contributes.commands 里声明，
 * 由清单校验强制（见 main/plugins/manifest.ts）。
 */
export interface PluginRibbonToolContribution {
  /** 目标标签页：内置 id（file/mail/view/tools）或本插件 tabs 里声明的本地 id。 */
  tab: string;
  /** 插件内唯一的工具 id；宿主会加 plugin:<pluginId>: 前缀。 */
  id: string;
  label: string;
  /** 必须指向本插件 contributes.commands 里的命令 id。 */
  command: string;
  icon?: string;
  when?: string;
  /** 同一目标标签内的排序权重（小的在前），同权重按声明顺序。 */
  order?: number;
}

/** 插件自建标签页（宿主会加 plugin:<pluginId>: 前缀）。 */
export interface PluginRibbonTabContribution {
  /** 插件内唯一的标签 id。 */
  id: string;
  label: string;
  order?: number;
}

export interface PluginRibbonContribution {
  tabs?: PluginRibbonTabContribution[];
  tools?: PluginRibbonToolContribution[];
}

/** 快照里按插件聚合的 ribbon 贡献（渲染层合并用，已做清单校验）。 */
export interface PluginRibbonSource {
  pluginId: string;
  pluginName: string;
  tabs: PluginRibbonTabContribution[];
  tools: PluginRibbonToolContribution[];
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  description?: string;
  /** 缺省为 true；示例/整体接管类插件可声明 false，安装后默认不启用。 */
  defaultEnabled?: boolean;
  author?: string;
  permissions?: PluginPermission[];
  main?: string;
  contributes?: {
    theme?: string;
    icons?: Record<string, string>;
    readerView?: string;
    /** 整体接管撰写窗口（§13.3）。 */
    composeView?: string;
    views?: Partial<Record<SlotName, string>>;
    securityScanner?: boolean;
    translationProvider?: boolean;
    aiProvider?: boolean;
    taskProvider?: boolean;
    feedReader?: boolean;
    cryptoProvider?: boolean;
    importer?: boolean;
    keybindings?: KeyBinding[];
    ruleActions?: RuleActionDefinition[];
    commands?: CommandDefinition[];
    /** 往工具栏追加标签页/按钮（只追加，不能改宿主内容）。 */
    ribbon?: PluginRibbonContribution;
  };
}

// ---------- P2P ----------
export interface P2pClientIdentity {
  /** UUID v4，客户端级，持久化；与邮箱账户无关（§24.1.1）。 */
  clientId: string;
  createdAt: number;
}

export interface P2pMessage {
  id: string;
  /** 对方 clientId。 */
  peerClientId: string;
  direction: 'inbound' | 'outbound';
  content: string;
  sentAt: number;
  deliveredAt?: number;
}

// ---------- 指标 ----------
export interface MetricEvent {
  type:
    | 'plugin_init'
    | 'sync_queue'
    | 'fts_latency'
    | 'memory_sample'
    | 'fts_segment_count'
    | 'fts_optimize_duration'
    | 'webview_count'
    | 'webview_heap_size'
    | 'startup_time'
    | 'scan_batch'
    | 'translation_request'
    | 'ai_command'
    | 'calendar_sync'
    | 'mbox_import';
  timestamp: number;
  payload: Record<string, number | string>;
}
