import { contextBridge, ipcRenderer } from 'electron';
import type { MailforgeApi, MailtoRequest, ScanUpdateEvent, SyncStateView } from '../shared/ipc';
import type { ScanProgress } from '../shared/types';

/**
 * 主窗口 preload（§2.1）。
 * 只暴露白名单 API，不暴露 ipcRenderer / require / fs 等任何特权对象。
 *
 * 注意：preload 运行在沙箱中，不能 require 相对路径的额外 chunk，
 * 因此频道名在此内联，必须与 src/shared/constants.ts 保持一致。
 */
const IPC = {
  getBootstrap: 'app:get-bootstrap',
  listEmails: 'mail:list',
  getBody: 'mail:get-body',
  getFolders: 'mail:get-folders',
  refresh: 'mail:refresh',
  openExternal: 'shell:open-external',
  getDiagnostics: 'app:get-diagnostics',
  rendererReady: 'app:renderer-ready',
  searchEmails: 'mail:search',
  setPinned: 'mail:set-pinned',
  setFlags: 'mail:set-flags',
  archive: 'mail:archive',
  move: 'mail:move',
  remove: 'mail:delete',
  contactsSearch: 'contacts:search',
  contactsList: 'contacts:list',
  scheduleSend: 'mail:schedule-send',
  pickAttachments: 'mail:pick-attachments',
  stageAttachments: 'mail:stage-attachments',
  draftGet: 'draft:get',
  draftSave: 'draft:save',
  draftDelete: 'draft:delete',
  draftList: 'draft:list',
  draftServerList: 'draft:server-list',
  draftServerDelete: 'draft:server-delete',
  dropAttachment: 'mail:drop-attachment',
  cancelSend: 'mail:cancel-send',
  listScheduled: 'mail:scheduled-list',
  snooze: 'mail:snooze',
  mailGetEmail: 'mail:get-email',
  pluginsRegistry: 'plugins:registry',
  pluginsSetEnabled: 'plugins:set-enabled',
  pluginsThemeCss: 'plugins:theme-css',
  pluginsIcon: 'plugins:icon',
  pluginsViewSession: 'plugins:view-session',
  pluginsOpenDevtools: 'plugins:open-devtools',
  pluginsSetActiveEmail: 'plugins:set-active-email',
  pluginsCapabilityRevoke: 'plugins:capability:revoke',
  pluginsAccountOverride: 'plugins:account-override',
  pluginsMenuItems: 'plugins:menu-items',
  pluginsRunCommand: 'plugins:run-command',
  pluginsDraftSet: 'plugins:draft:set',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  accountsList: 'accounts:list',
  accountsAdd: 'accounts:add',
  accountsUpdate: 'accounts:update',
  accountsRemove: 'accounts:remove',
  accountsSetEnabled: 'accounts:set-enabled',
  accountsReauth: 'accounts:reauth',
  accountsPrioritize: 'accounts:prioritize',
  p2pIdentity: 'p2p:identity',
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
  trayGet: 'tray:get',
  traySet: 'tray:set',
  notificationsGet: 'notifications:get',
  notificationsSet: 'notifications:set',
  notificationsTest: 'notifications:test',
  quit: 'app:quit',
} as const;

const IPC_EVENTS = {
  mailto: 'app:mailto-received',
  syncState: 'mail:sync-state',
  pluginsChanged: 'plugins:changed',
  scanResult: 'scan:result',
  scanProgress: 'scan:progress',
  accountsChanged: 'accounts:changed',
  draftPatch: 'plugin:draft-patch',
  notificationOpen: 'app:notification-open',
  trayAction: 'app:tray-action',
  ribbonChanged: 'ribbon:changed',
  keybindingsChanged: 'keybindings:changed',
} as const;

const api: MailforgeApi = {
  getBootstrap: () => ipcRenderer.invoke(IPC.getBootstrap),
  listEmails: (request) => ipcRenderer.invoke(IPC.listEmails, request),
  getBody: (request) => ipcRenderer.invoke(IPC.getBody, request),
  getEmail: (id) => ipcRenderer.invoke(IPC.mailGetEmail, id),
  getFolders: (accountId) => ipcRenderer.invoke(IPC.getFolders, accountId),
  refresh: (accountId) => ipcRenderer.invoke(IPC.refresh, accountId),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
  windowSetFullScreen: (on: boolean) => ipcRenderer.invoke(IPC.windowSetFullScreen, on),
  getDiagnostics: () => ipcRenderer.invoke(IPC.getDiagnostics),
  rendererReady: (payload) => ipcRenderer.invoke(IPC.rendererReady, payload),
  searchEmails: (request) => ipcRenderer.invoke(IPC.searchEmails, request),
  setPinned: (emailId, pinned) => ipcRenderer.invoke(IPC.setPinned, { emailId, pinned }),
  setEmailFlags: (emailId, patch) => ipcRenderer.invoke(IPC.setFlags, { emailId, patch }),
  archiveEmail: (emailId) => ipcRenderer.invoke(IPC.archive, { emailId }),
  moveEmail: (emailId, folder) => ipcRenderer.invoke(IPC.move, { emailId, folder }),
  deleteEmail: (emailId) => ipcRenderer.invoke(IPC.remove, { emailId }),
  snoozeEmail: (emailId, until) => ipcRenderer.invoke(IPC.snooze, { emailId, until }),
  searchContacts: (query) => ipcRenderer.invoke(IPC.contactsSearch, query),
  listContacts: (limit) => ipcRenderer.invoke(IPC.contactsList, limit),
  scheduleSend: (request) => ipcRenderer.invoke(IPC.scheduleSend, request),
  pickComposeAttachments: () => ipcRenderer.invoke(IPC.pickAttachments),
  stageComposeAttachments: (paths) => ipcRenderer.invoke(IPC.stageAttachments, paths),
  dropComposeAttachment: (id) => ipcRenderer.invoke(IPC.dropAttachment, id),
  getDraft: (accountId) => ipcRenderer.invoke(IPC.draftGet, accountId),
  saveDraft: (input) => ipcRenderer.invoke(IPC.draftSave, input),
  deleteDraft: (accountId, serverGated) => ipcRenderer.invoke(IPC.draftDelete, accountId, serverGated),
  listDrafts: () => ipcRenderer.invoke(IPC.draftList),
  listServerDrafts: (force = false) => ipcRenderer.invoke(IPC.draftServerList, force),
  deleteServerDraft: (accountId, uid) => ipcRenderer.invoke(IPC.draftServerDelete, accountId, uid),
  cancelScheduledSend: (id) => ipcRenderer.invoke(IPC.cancelSend, id),
  listScheduledSends: () => ipcRenderer.invoke(IPC.listScheduled),
  pluginsRegistry: () => ipcRenderer.invoke(IPC.pluginsRegistry),
  setPluginEnabled: (pluginId, enabled) =>
    ipcRenderer.invoke(IPC.pluginsSetEnabled, { pluginId, enabled }),
  getPluginTheme: (themeId) => ipcRenderer.invoke(IPC.pluginsThemeCss, themeId),
  getPluginIcon: (pluginId, name) => ipcRenderer.invoke(IPC.pluginsIcon, { pluginId, name }),
  getPluginView: (pluginId, slot, accountId) =>
    ipcRenderer.invoke(IPC.pluginsViewSession, { pluginId, slot, accountId: accountId ?? null }),
  getPluginMenuItems: (query) => ipcRenderer.invoke(IPC.pluginsMenuItems, query),
  runPluginCommand: (pluginId, commandId, accountId) =>
    ipcRenderer.invoke(IPC.pluginsRunCommand, {
      pluginId,
      commandId,
      accountId: accountId ?? null,
    }),
  setPluginAccountOverride: (pluginId, accountId, enabled) =>
    ipcRenderer.invoke(IPC.pluginsAccountOverride, { pluginId, accountId, enabled }),
  setPluginDraftContext: (context) => ipcRenderer.invoke(IPC.pluginsDraftSet, context),
  openPluginDevtools: (pluginId) => ipcRenderer.invoke(IPC.pluginsOpenDevtools, pluginId),
  setPluginActiveEmail: (emailId) => ipcRenderer.invoke(IPC.pluginsSetActiveEmail, emailId),
  revokePluginPermission: (pluginId, permission, revoked) =>
    ipcRenderer.invoke(IPC.pluginsCapabilityRevoke, { pluginId, permission, revoked }),
  getSetting: (key) => ipcRenderer.invoke(IPC.settingsGet, key),
  setSetting: (key, value) => ipcRenderer.invoke(IPC.settingsSet, { key, value }),

  listAccounts: () => ipcRenderer.invoke(IPC.accountsList),
  addAccount: (input) => ipcRenderer.invoke(IPC.accountsAdd, input),
  updateAccount: (id, input) => ipcRenderer.invoke(IPC.accountsUpdate, { id, input }),
  removeAccount: (id) => ipcRenderer.invoke(IPC.accountsRemove, id),
  setAccountEnabled: (id, enabled) => ipcRenderer.invoke(IPC.accountsSetEnabled, { id, enabled }),
  reauthenticateAccount: (id, password) => ipcRenderer.invoke(IPC.accountsReauth, { id, password }),
  prioritizeAccount: (id) => ipcRenderer.invoke(IPC.accountsPrioritize, id),
  getP2pIdentity: () => ipcRenderer.invoke(IPC.p2pIdentity),

  listAttachments: (emailId) => ipcRenderer.invoke(IPC.attachmentsList, emailId),
  getAttachmentPayload: (attachmentId) => ipcRenderer.invoke(IPC.attachmentsPayload, attachmentId),
  openAttachment: (attachmentId) => ipcRenderer.invoke(IPC.attachmentsOpen, attachmentId),
  saveAttachment: (attachmentId) => ipcRenderer.invoke(IPC.attachmentsSave, attachmentId),
  scanEmail: (emailId) => ipcRenderer.invoke(IPC.attachmentsScan, emailId),
  cancelScan: (emailId) => ipcRenderer.invoke(IPC.attachmentsScanCancel, emailId),
  getScanProviders: () => ipcRenderer.invoke(IPC.attachmentsScanProviders),
  getAttachmentExtensions: () => ipcRenderer.invoke(IPC.attachmentsExtGet),
  setAttachmentExtensions: (settings) => ipcRenderer.invoke(IPC.attachmentsExtSet, settings),

  listSignatures: (accountId) => ipcRenderer.invoke(IPC.signaturesList, accountId),
  createSignature: (accountId, name) => ipcRenderer.invoke(IPC.signaturesCreate, { accountId, name }),
  renameSignature: (id, name) => ipcRenderer.invoke(IPC.signaturesRename, { id, name }),
  deleteSignature: (id) => ipcRenderer.invoke(IPC.signaturesDelete, id),
  saveSignature: (id, html) => ipcRenderer.invoke(IPC.signaturesSave, { id, html }),
  setDefaultSignature: (accountId, kind, signatureId) =>
    ipcRenderer.invoke(IPC.signaturesSetDefault, { accountId, kind, signatureId }),

  copyReaderImage: (request) => ipcRenderer.invoke(IPC.readerImageCopy, request),
  saveReaderImage: (request) => ipcRenderer.invoke(IPC.readerImageSave, request),
  copyText: (text) => ipcRenderer.invoke(IPC.readerCopyText, text),

  createFolder: (request) => ipcRenderer.invoke(IPC.folderCreate, request),
  copyFolder: (request) => ipcRenderer.invoke(IPC.folderCopy, request),
  clearFolder: (accountId, folder) => ipcRenderer.invoke(IPC.folderClear, { accountId, folder }),
  folderDuplicates: (accountId, folder) =>
    ipcRenderer.invoke(IPC.folderDuplicates, { accountId, folder }),
  dedupeFolder: (accountId, folder) => ipcRenderer.invoke(IPC.folderDedupe, { accountId, folder }),
  openFolderWindow: (accountId, folder) =>
    ipcRenderer.invoke(IPC.windowOpenFolder, { accountId, folder }),
  openReaderWindow: (emailId, compose) =>
    ipcRenderer.invoke(IPC.windowOpenReader, { emailId, compose }),
  getInstanceMode: () => ipcRenderer.invoke(IPC.appGetInstanceMode),
  setInstanceMode: (singleInstance) => ipcRenderer.invoke(IPC.appSetInstanceMode, singleInstance),
  renameFolder: (request) => ipcRenderer.invoke(IPC.folderRename, request),
  moveFolder: (request) => ipcRenderer.invoke(IPC.folderMove, request),
  deleteFolder: (request) => ipcRenderer.invoke(IPC.folderDelete, request),
  getFolderDetails: (accountId, folder) =>
    ipcRenderer.invoke(IPC.folderDetails, { accountId, folder }),
  markFolderRead: (accountId, folder) =>
    ipcRenderer.invoke(IPC.folderMarkRead, { accountId, folder }),

  getTranslationSettings: () => ipcRenderer.invoke(IPC.translationGet),
  setTranslationSettings: (settings) => ipcRenderer.invoke(IPC.translationSet, settings),
  translateEmail: (request) => ipcRenderer.invoke(IPC.translationTranslate, request),

  getAiSettings: () => ipcRenderer.invoke(IPC.aiGet),
  setAiSettings: (settings) => ipcRenderer.invoke(IPC.aiSet, settings),
  summarizeEmail: (emailId) => ipcRenderer.invoke(IPC.aiSummarize, emailId),
  semanticSearch: (query, limit) => ipcRenderer.invoke(IPC.aiSemanticSearch, { query, limit }),
  prepareCommand: (input) => ipcRenderer.invoke(IPC.aiPrepareCommand, input),
  confirmCommand: (request) => ipcRenderer.invoke(IPC.aiConfirmCommand, request),

  listCalendarAccounts: () => ipcRenderer.invoke(IPC.calendarList),
  addCalendarAccount: (input) => ipcRenderer.invoke(IPC.calendarAdd, input),
  removeCalendarAccount: (id) => ipcRenderer.invoke(IPC.calendarRemove, id),
  syncCalendar: (id) => ipcRenderer.invoke(IPC.calendarSync, id),
  listCalendarEvents: (range) => ipcRenderer.invoke(IPC.calendarEvents, range),
  createCalendarEvent: (input) => ipcRenderer.invoke(IPC.calendarCreateEvent, input),
  updateCalendarEvent: (patch) => ipcRenderer.invoke(IPC.calendarUpdateEvent, patch),
  deleteCalendarEvent: (id) => ipcRenderer.invoke(IPC.calendarDeleteEvent, id),

  importMbox: (request) => ipcRenderer.invoke(IPC.mboxImport, request),
  exportMbox: (request) => ipcRenderer.invoke(IPC.mboxExport, request),
  getDohStatus: () => ipcRenderer.invoke(IPC.dohGet),
  setDoh: (enabled) => ipcRenderer.invoke(IPC.dohSet, enabled),
  getMasterPasswordStatus: () => ipcRenderer.invoke(IPC.masterStatus),
  setMasterPassword: (password, currentPassword) =>
    ipcRenderer.invoke(IPC.masterSet, { password, currentPassword }),
  getMetadataStatus: () => ipcRenderer.invoke(IPC.metadataStatus),
  syncMetadata: (request) => ipcRenderer.invoke(IPC.metadataSync, request),

  getTraySettings: () => ipcRenderer.invoke(IPC.trayGet),
  setTraySettings: (patch) => ipcRenderer.invoke(IPC.traySet, patch),
  getNotificationSettings: () => ipcRenderer.invoke(IPC.notificationsGet),
  setNotificationSettings: (patch) => ipcRenderer.invoke(IPC.notificationsSet, patch),
  sendTestNotification: () => ipcRenderer.invoke(IPC.notificationsTest),
  onKeybindingsChanged: (callback: (json: string) => void) => {
    const handler = (_event: unknown, json: string): void => callback(json);
    ipcRenderer.on(IPC_EVENTS.keybindingsChanged, handler);
    return () => {
      ipcRenderer.removeListener(IPC_EVENTS.keybindingsChanged, handler);
    };
  },
  onRibbonChanged: (callback: (json: string) => void) => {
    const handler = (_event: unknown, json: string): void => callback(json);
    ipcRenderer.on(IPC_EVENTS.ribbonChanged, handler);
    return () => {
      ipcRenderer.removeListener(IPC_EVENTS.ribbonChanged, handler);
    };
  },
  quit: () => ipcRenderer.invoke(IPC.quit),
  onNotificationOpen: (callback: (payload: { emailId: string }) => void) => {
    const handler = (_event: unknown, payload: { emailId: string }): void => callback(payload);
    ipcRenderer.on(IPC_EVENTS.notificationOpen, handler);
    return () => {
      ipcRenderer.removeListener(IPC_EVENTS.notificationOpen, handler);
    };
  },
  onTrayAction: (callback: (payload: { action: 'open' | 'compose' | 'refresh' | 'outbox' }) => void) => {
    const handler = (_event: unknown, payload: { action: 'open' | 'compose' | 'refresh' | 'outbox' }): void =>
      callback(payload);
    ipcRenderer.on(IPC_EVENTS.trayAction, handler);
    return () => {
      ipcRenderer.removeListener(IPC_EVENTS.trayAction, handler);
    };
  },

  onMailto: (callback: (request: MailtoRequest) => void) => {
    const handler = (_event: unknown, payload: MailtoRequest): void => callback(payload);
    ipcRenderer.on(IPC_EVENTS.mailto, handler);
    return () => {
      ipcRenderer.removeListener(IPC_EVENTS.mailto, handler);
    };
  },
  onSyncState: (callback: (state: SyncStateView) => void) => {
    const handler = (_event: unknown, payload: SyncStateView): void => callback(payload);
    ipcRenderer.on(IPC_EVENTS.syncState, handler);
    return () => {
      ipcRenderer.removeListener(IPC_EVENTS.syncState, handler);
    };
  },
  onDraftPatch: (callback) => {
    const handler = (_event: unknown, payload: { pluginId: string; patch: unknown }): void =>
      callback(payload as { pluginId: string; patch: never });
    ipcRenderer.on(IPC_EVENTS.draftPatch, handler);
    return () => {
      ipcRenderer.removeListener(IPC_EVENTS.draftPatch, handler);
    };
  },

  onPluginsChanged: (callback: () => void) => {
    const handler = (): void => callback();
    ipcRenderer.on(IPC_EVENTS.pluginsChanged, handler);
    return () => {
      ipcRenderer.removeListener(IPC_EVENTS.pluginsChanged, handler);
    };
  },
  onAccountsChanged: (callback: () => void) => {
    const handler = (): void => callback();
    ipcRenderer.on(IPC_EVENTS.accountsChanged, handler);
    return () => {
      ipcRenderer.removeListener(IPC_EVENTS.accountsChanged, handler);
    };
  },
  onScanUpdate: (callback: (update: ScanUpdateEvent) => void) => {
    const handler = (_event: unknown, payload: ScanUpdateEvent): void => callback(payload);
    ipcRenderer.on(IPC_EVENTS.scanResult, handler);
    return () => {
      ipcRenderer.removeListener(IPC_EVENTS.scanResult, handler);
    };
  },
  onScanProgress: (callback: (progress: ScanProgress) => void) => {
    const handler = (_event: unknown, payload: ScanProgress): void => callback(payload);
    ipcRenderer.on(IPC_EVENTS.scanProgress, handler);
    return () => {
      ipcRenderer.removeListener(IPC_EVENTS.scanProgress, handler);
    };
  },
};

contextBridge.exposeInMainWorld('api', api);
