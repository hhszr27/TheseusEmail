import type { RiskLevel, SpecialUse } from './types';

export const APP_NAME = 'MailForge';
export const APP_USER_MODEL_ID = 'com.mailforge.desktop';

/** 风险等级严格度排序，索引越大越严格。 */
export const RISK_ORDER: RiskLevel[] = ['safe', 'unknown', 'suspicious', 'danger'];

export const PREVIEW_TEXT_EXTS = [
  '.txt',
  '.md',
  '.log',
  '.csv',
  '.json',
  '.xml',
  '.yaml',
  '.ini',
] as const;

export const PREVIEW_IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'] as const;

export const DANGEROUS_EXTS = [
  '.exe',
  '.msi',
  '.bat',
  '.cmd',
  '.com',
  '.scr',
  '.js',
  '.vbs',
  '.jar',
  '.ps1',
  '.docm',
  '.xlsm',
  '.pptm',
] as const;

export const SUSPICIOUS_EXTS = ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.svg'] as const;

/**
 * 默认禁止打开：双击即执行、几乎没有正当邮件用途的类型。
 * 它们本就在 DANGEROUS_EXTS 里（默认只提示），这里单独提升为「禁止」——
 * 其余危险类型仍走「提示」，避免把安装包这类真要用到的文件挡死。
 */
export const BLOCKED_EXTS = ['.scr', '.pif', '.cpl'] as const;

/** IMAP 特殊文件夹的中文展示名。 */
export const SPECIAL_USE_LABELS: Record<SpecialUse, string> = {
  sent: '已发送',
  drafts: '草稿',
  trash: '已删除',
  archive: '归档',
  junk: '垃圾邮件',
  all: '所有邮件',
  flagged: '已星标',
};

/** 名称启发式匹配表（§7.7 第三层）。匹配前统一转小写。 */
export const SPECIAL_USE_NAME_HINTS: Array<{ use: SpecialUse; names: string[] }> = [
  { use: 'sent', names: ['sent', 'sent items', 'sent messages', '已发送', '已发送邮件'] },
  { use: 'drafts', names: ['drafts', 'draft', '草稿', '草稿箱'] },
  { use: 'trash', names: ['trash', 'deleted', 'deleted items', 'deleted messages', '已删除', '垃圾箱'] },
  { use: 'junk', names: ['junk', 'spam', 'junk email', '垃圾邮件'] },
  { use: 'archive', names: ['archive', 'archives', '归档'] },
  { use: 'all', names: ['all mail', 'all', '所有邮件'] },
  { use: 'flagged', names: ['flagged', 'starred', '星标'] },
];

/** 邮件正文允许保留的标签（DOMPurify FORBID_TAGS 之外的显式白名单依据）。 */
export const ALLOWED_HTML_TAGS = [
  'p', 'div', 'span', 'a', 'img', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'caption', 'colgroup', 'col', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'br', 'hr', 'strong', 'b', 'em', 'i', 'u', 'blockquote', 'pre', 'code', 'small', 'sub', 'sup',
  'dl', 'dt', 'dd', 'font', 'center', 'mark',
] as const;

export const FORBIDDEN_HTML_TAGS = [
  'script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  'form', 'input', 'textarea', 'button', 'select', 'option', 'meta', 'link', 'base',
  'style', 'svg', 'math', 'video', 'audio', 'source', 'track', 'template', 'portal',
] as const;

/** 列表分页与同步窗口默认值。 */
export const DEFAULT_PAGE_SIZE = 200;
export const MAIL_LIST_PAGE_SIZE = 100;

/** 日程提醒提前量可选值（分钟）；设置 UI 与主进程解析共用（§16/§22）。 */
export const REMINDER_MINUTE_OPTIONS = [0, 5, 10, 15, 30, 60] as const;

/** 主进程 IPC 频道。 */
export const IPC = {
  rendererReady: 'app:renderer-ready',
  getBootstrap: 'app:get-bootstrap',
  listEmails: 'mail:list',
  getBody: 'mail:get-body',
  refresh: 'mail:refresh',
  getFolders: 'mail:get-folders',
  openExternal: 'shell:open-external',
  openMailto: 'app:open-mailto',
  getDiagnostics: 'app:get-diagnostics',
  recoveryInfo: 'recovery:info',
  recoveryReload: 'recovery:reload',
  pluginsRegistry: 'plugins:registry',
  pluginsSetEnabled: 'plugins:set-enabled',
  pluginsThemeCss: 'plugins:theme-css',
  pluginsIcon: 'plugins:icon',
  pluginsViewSession: 'plugins:view-session',
  pluginsOpenDevtools: 'plugins:open-devtools',
  pluginsSetActiveEmail: 'plugins:set-active-email',
  pluginsHandshake: 'plugin:handshake',
  pluginsCall: 'plugin:call',
  pluginsCapabilityRevoke: 'plugins:capability:revoke',
  pluginsCapabilityList: 'plugins:capability:list',
  pluginsAccountOverride: 'plugins:account-override',
  pluginsMenuItems: 'plugins:menu-items',
  pluginsRunCommand: 'plugins:run-command',
  pluginsDraftSet: 'plugins:draft:set',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  mailSearch: 'mail:search',
  mailSetPinned: 'mail:set-pinned',
  mailSetFlags: 'mail:set-flags',
  mailArchive: 'mail:archive',
  mailMove: 'mail:move',
  mailDelete: 'mail:delete',
  contactsSearch: 'contacts:search',
  contactsList: 'contacts:list',
  mailScheduleSend: 'mail:schedule-send',
  mailPickAttachments: 'mail:pick-attachments',
  mailStageAttachments: 'mail:stage-attachments',
  draftGet: 'draft:get',
  draftSave: 'draft:save',
  draftDelete: 'draft:delete',
  draftList: 'draft:list',
  draftServerList: 'draft:server-list',
  draftServerDelete: 'draft:server-delete',
  mailDropAttachment: 'mail:drop-attachment',
  mailCancelSend: 'mail:cancel-send',
  mailScheduledList: 'mail:scheduled-list',
  mailSnooze: 'mail:snooze',
  mailGetEmail: 'mail:get-email',
  attachmentsList: 'attachments:list',
  attachmentsPayload: 'attachments:payload',
  attachmentsOpen: 'attachments:open',
  attachmentsSave: 'attachments:save',
  attachmentsScan: 'attachments:scan',
  attachmentsScanCancel: 'attachments:scan-cancel',
  attachmentsScanProviders: 'attachments:scan-providers',
  attachmentsExtGet: 'attachments:extensions:get',
  attachmentsExtSet: 'attachments:extensions:set',
  signaturesList: 'signatures:list',
  signaturesCreate: 'signatures:create',
  signaturesRename: 'signatures:rename',
  signaturesDelete: 'signatures:delete',
  signaturesSave: 'signatures:save',
  signaturesSetDefault: 'signatures:set-default',
  readerImageCopy: 'reader:image:copy',
  readerImageSave: 'reader:image:save',
  readerCopyText: 'reader:text:copy',
  folderCreate: 'folder:create',
  folderRename: 'folder:rename',
  folderMove: 'folder:move',
  folderDelete: 'folder:delete',
  folderDetails: 'folder:details',
  folderMarkRead: 'folder:mark-read',
  folderCopy: 'folder:copy',
  folderClear: 'folder:clear',
  folderDuplicates: 'folder:duplicates',
  folderDedupe: 'folder:dedupe',
  windowOpenFolder: 'window:open-folder',
  windowOpenReader: 'window:open-reader',
  /** 让承载渲染进程的窗口真正原生全屏（铺满整屏、隐藏标题栏）。 */
  windowSetFullScreen: 'window:set-fullscreen',
  appGetInstanceMode: 'app:get-instance-mode',
  appSetInstanceMode: 'app:set-instance-mode',
  translationGet: 'translation:settings:get',
  translationSet: 'translation:settings:set',
  translationTranslate: 'translation:translate',
  aiGet: 'ai:settings:get',
  aiSet: 'ai:settings:set',
  aiSummarize: 'ai:summarize',
  aiSemanticSearch: 'ai:semantic-search',
  aiPrepareCommand: 'ai:prepare-command',
  aiConfirmCommand: 'ai:confirm-command',
  calendarList: 'calendar:accounts:list',
  calendarAdd: 'calendar:accounts:add',
  calendarRemove: 'calendar:accounts:remove',
  calendarSync: 'calendar:sync',
  calendarEvents: 'calendar:events',
  calendarCreateEvent: 'calendar:events:create',
  calendarUpdateEvent: 'calendar:events:update',
  calendarDeleteEvent: 'calendar:events:delete',
  mboxImport: 'mbox:import',
  mboxExport: 'mbox:export',
  dohGet: 'network:doh:get',
  dohSet: 'network:doh:set',
  masterStatus: 'security:master-password:status',
  masterSet: 'security:master-password:set',
  metadataStatus: 'imap:metadata:status',
  metadataSync: 'imap:metadata:sync',
  accountsList: 'accounts:list',
  accountsAdd: 'accounts:add',
  accountsUpdate: 'accounts:update',
  accountsRemove: 'accounts:remove',
  accountsSetEnabled: 'accounts:set-enabled',
  accountsReauth: 'accounts:reauth',
  accountsPrioritize: 'accounts:prioritize',
  p2pIdentity: 'p2p:identity',
  trayGet: 'tray:get',
  traySet: 'tray:set',
  notificationsGet: 'notifications:get',
  notificationsSet: 'notifications:set',
  notificationsTest: 'notifications:test',
  /** 从界面触发正常退出（走 before-quit 清理，不跳过落盘）。 */
  quit: 'app:quit',
} as const;

export const IPC_EVENTS = {
  mailto: 'app:mailto-received',
  syncState: 'mail:sync-state',
  pluginsChanged: 'plugins:changed',
  pluginCommand: 'plugin:command',
  draftPatch: 'plugin:draft-patch',
  draftChanged: 'plugin:draft-changed',
  emailChanged: 'mail:selected-changed',
  scanResult: 'scan:result',
  scanProgress: 'scan:progress',
  calendarChanged: 'calendar:changed',
  metadataChanged: 'imap:metadata-changed',
  accountsChanged: 'accounts:changed',
  /** 点击邮件通知后定位到该邮件。 */
  notificationOpen: 'app:notification-open',
  /** 托盘菜单/通知点击后要求渲染进程执行的动作。 */
  trayAction: 'app:tray-action',
  /** 工具栏配置变更（跨窗口同步用，主进程广播给所有窗口）。 */
  ribbonChanged: 'ribbon:changed',
  /** 快捷键配置变更（同上，跨窗口同步）。 */
  keybindingsChanged: 'keybindings:changed',
} as const;
