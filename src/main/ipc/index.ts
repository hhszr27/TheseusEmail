import { app, BrowserWindow, dialog, ipcMain, Notification, shell, webContents, type IpcMainInvokeEvent } from 'electron';
import crypto from 'node:crypto';
import { IPC, IPC_EVENTS } from '../../shared/constants';
import { broadcastChannelFor } from './settings-broadcast';
import type {
  AiSettingsView,
  AiSummaryResult,
  AttachmentExtensionSettings,
  AttachmentPayload,
  AttachmentView,
  BootstrapData,
  CalendarAccountInput,
  CalendarAccountView,
  CalendarEventInput,
  CalendarEventKind,
  CalendarEventDeleteRequest,
  CalendarEventPatch,
  CalendarEventScope,
  CalendarEventView,
  CalendarRecurrence,
  CalendarSyncResult,
  CommandConfirmRequest,
  CommandPreparation,
  DiagnosticsData,
  DohStatus,
  FolderClearResult,
  FolderCopyRequest,
  FolderCreateRequest,
  FolderDeleteRequest,
  FolderDeleteResult,
  FolderDetails,
  FolderDuplicatesResult,
  FolderMoveRequest,
  FolderRenameRequest,
  GetBodyResponse,
  ListEmailsRequest,
  ListEmailsResponse,
  MasterPasswordStatus,
  MboxExportResult,
  MboxImportResult,
  MetadataStatus,
  ReaderImageRequest,
  ReaderImageSaveResult,
  Result,
  ScanProviderStatus,
  SignatureView,
  ScheduleSendRequest,
  SearchRequest,
  SearchResponse,
  ScheduledSendInfo,
  SemanticSearchResult,
  TranslationOutcome,
  TranslationRequest,
  TranslationSettingsView,
  NotificationSettingsView,
  TraySettings,
} from '../../shared/ipc';
import type {
  Account,
  AccountView,
  EmailSummary,
  FolderView,
  MenuRegion,
  P2pClientIdentity,
  ParsedCommand,
  PluginPermission,
  SlotName,
} from '../../shared/types';
import type { AccountInput } from '../../shared/accounts';
import type { ComposeAttachmentInfo, ComposeDraft } from '../../shared/ipc';
import { AccountOperationError } from '../accounts/service';
import { MailActionError } from '../mail/actions';
import type {
  PluginAccountInfo,
  PluginCallRequest,
  PluginCallResult,
  PluginCommandRunResult,
  PluginHandshake,
  PluginMenuItem,
  PluginMenuQuery,
  PluginRegistrySnapshot,
  PluginViewSession,
} from '../../shared/plugin';
import { normalizeDraftContext, normalizeDraftPatch } from '../plugins/draft';
import { normalizeListFilter, normalizeListSort } from '../db/list-query';
import { buildFolderPath, folderNameErrorMessage as folderNameErrorText, isProtectedFolder, isSameOrDescendantPath, leafNameOf, parentPathOf, validateFolderName } from '../../shared/folder-name';
import { createFolderWindow, createReaderWindow } from '../app/main-window';
import { readSingleInstanceMode, writeSingleInstanceMode } from '../app/instance-mode';
import { copyImageToClipboard, saveImageToFile, writeClipboardText } from '../reader/image-actions';
import type { MenuContext } from '../plugins/menu-registry';
import { THEME_SETTING_KEY, themeVariablesFor } from '../../shared/theme';
import { AUTO_FULL_SCREEN_KEY, normalizeAutoFullScreen } from '../../shared/reading-settings';
import { getServices } from '../services';
import { validateExternalUrl } from '../security/url-policy';
import { htmlToPlainText, sanitizeComposeHtml, sanitizeEmailHtml } from '../security/sanitize';
import { extractInlineImages, restoreUnstagedInlineImages } from '../mail/inline-images';
import { resolveInlineImages } from '../mail/inline-parts';
import { getLogDir, log } from '../observability/logger';
import { faultRecovery } from '../observability/fault-state';
import { getStartupMs, markInteractive, processStartedAt } from '../app/startup-perf';
import { getMainWindow, getRecoveryWindow, sendToRenderer } from '../app/app-context';
import { createMainWindow, getSecurityBaseline } from '../app/main-window';
import { getAppFlags } from '../app/app-flags';
import { readTraySettings, writeTraySettings } from '../app/tray-settings';
import {
  clampHour,
  clampReminderMinutes,
  readDndSettings,
  readNotificationSettings,
  writeDndSettings,
  writeNotificationSettings,
} from '../notifications/settings';
import { METHOD_PERMISSIONS } from '../plugins/capabilities';
import { ensurePluginProtocolForPartition } from '../plugins/protocol';
import { buildBlockedNotice, buildOpenConfirm, buildScanBlockedNotice } from '../../shared/attachments';
import { buildAttachmentPayload } from '../attachments/preview';
import { openStagedFile, saveTo, stageForExternalOpen } from '../attachments/open';
import { extractScannableUrls, isScannableRisk } from '../attachments/scan';
import { deriveSubject } from '../ai/orchestrator';
import { validateParsedCommand } from '../ai/command-schema';
import { disableMasterPassword, enableMasterPassword, masterPasswordEnabled } from '../db/key-manager';
import { dohStatus, writeDohSetting } from '../app/doh';

function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

function fail<T>(code: string, message: string): Result<T> {
  return { ok: false, error: { code, message } };
}

/**
 * §36 硬约束：处理敏感请求前校验 event.senderFrame 的 origin。
 * 生产只允许打包后的 file:// 渲染页面；开发额外允许 Vite dev server。
 */
function isTrustedFrame(event: IpcMainInvokeEvent): boolean {
  let frameUrl = '';
  try {
    frameUrl = event.senderFrame?.url ?? '';
  } catch {
    return false;
  }
  if (!frameUrl) return false;

  if (frameUrl.startsWith('file://')) return true;

  if (!app.isPackaged) {
    const devBase = process.env.ELECTRON_RENDERER_URL;
    if (devBase && frameUrl.startsWith(devBase)) return true;
    return /^http:\/\/(localhost|127\.0\.0\.1):\d+\//.test(frameUrl);
  }

  return false;
}

function assertTrusted(event: IpcMainInvokeEvent, channel: string): void {
  if (!isTrustedFrame(event)) {
    log.warn('ipc', '拒绝不受信任的调用来源', { channel });
    throw new Error('不受信任的调用来源');
  }
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 选中邮件后的后台扫描（§12.2）：不阻塞正文渲染，
 * 结果通过 scan:result 事件原地更新附件标记。
 */
function triggerEmailScan(emailId: string): void {
  const services = getServices();
  if (!services.scanner.isEnabled()) return;

  const stored = services.emails.getBody(emailId);
  const attachments = services.attachments.list(emailId);
  const urls = stored?.html ? extractScannableUrls(stored.html) : [];

  void services.scanner
    .scanEmail({
      emailId,
      urls,
      attachments: attachments
        .filter((item) => item.sha256)
        // 只扫危险/可疑类型：普通文档几乎必然是 safe，白白消耗配额
        .filter((item) => isScannableRisk(item.risk.level))
        .map((item) => {
          const localPath = services.attachments.localPathOf(item.id);
          return {
            id: item.id,
            filename: item.filename,
            mimeType: item.mimeType,
            sha256: item.sha256 as string,
            baseRisk: item.risk.level,
            ...(localPath ? { localPath } : {}),
          };
        }),
    })
    .catch((error: Error) => {
      log.warn('scan', '邮件扫描失败', { emailId, message: error.message });
    });
}

export function registerIpcHandlers(): void {
  ipcMain.handle(IPC.getBootstrap, (event): Result<BootstrapData> => {
    assertTrusted(event, IPC.getBootstrap);
    const services = getServices();
    const accounts = services.accountService.listViews();
    const active = accounts.find((account) => account.enabled) ?? accounts[0] ?? null;
    const folders = active ? services.folders.list(active.id) : [];

    return ok({
      accounts,
      folders,
      activeAccountId: active?.id ?? null,
      defaultFolder: 'INBOX',
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? 'unknown',
      platform: process.platform,
      dbEncrypted: services.dbEncrypted,
      keyProtection: services.keyProtection,
      proxy: services.proxy,
      firstRunHint:
        accounts.length === 0
          ? '尚未配置邮箱账户。打开「设置 → 账户」添加 QQ / 网易 / Gmail / Outlook 或自定义 IMAP 账户。'
          : null,
    });
  });

  ipcMain.handle(
    IPC.listEmails,
    (event, request: ListEmailsRequest): Result<ListEmailsResponse> => {
      assertTrusted(event, IPC.listEmails);
      const services = getServices();
      const accountId = request?.accountId ?? '';
      const folder = request?.folder ?? 'INBOX';
      const offset = Math.max(0, Math.floor(request?.offset ?? 0));
      const limit = Math.min(500, Math.max(1, Math.floor(request?.limit ?? 100)));
      // 筛选/排列：IPC 边界归一化到白名单，非白名单值回落默认（§36）
      const filter = normalizeListFilter(request?.filter);
      const sort = normalizeListSort(request?.sort);

      // __all__ 表示统一收件箱（§23.1）：跨账户合并，忽略 accountId
      if (accountId === '__all__') {
        return ok({
          emails: services.emails.listUnified(offset, limit, 'INBOX', undefined, filter, sort),
          total: services.emails.totalUnified('INBOX', undefined, filter),
          offset,
        });
      }

      const total = services.emails.total(accountId, folder, undefined, filter);
      const emails = services.emails.list(
        accountId,
        folder,
        offset,
        limit,
        undefined,
        filter,
        sort,
      );
      return ok({ emails, total, offset });
    },
  );

  ipcMain.handle(
    IPC.getBody,
    async (event, request: { emailId: string; allowRemoteImages?: boolean }): Promise<Result<GetBodyResponse>> => {
      assertTrusted(event, IPC.getBody);
      const services = getServices();
      const emailId = request?.emailId ?? '';
      const email = services.emails.get(emailId);
      if (!email) return fail('NOT_FOUND', '邮件不存在');

      let stored = services.emails.getBody(emailId);
      if (!stored) {
        try {
          const fetched = await services.manager.fetchBody(email.accountId, email.folder, email.uid);
          services.emails.saveBody(emailId, fetched.html, fetched.text);
          if (fetched.attachments.length > 0) {
            services.attachments.save(emailId, fetched.attachments);
          }
          try {
            services.search.indexEmail(emailId);
          } catch (error) {
            log.warn('fts', '正文写入后索引失败', { emailId, message: (error as Error).message });
          }
          services.ai.indexEmail(emailId);
          stored = { html: fetched.html, text: fetched.text };
        } catch (error) {
          log.warn('ipc', '获取邮件正文失败', {
            emailId,
            message: (error as Error).message,
          });
          return fail('BODY_UNAVAILABLE', (error as Error).message);
        }
      }

      // 收到的邮件里 multipart/related 的内嵌图片必须在这里还原成 data URI：
      // 净化器会丢掉既不是 http(s) 也不是 data: 的 src，不还原则用户看到的就是空 <img>。
      let bodyHtml = stored.html;
      if (bodyHtml && /\bcid:/i.test(bodyHtml)) {
        try {
          const parts = services.attachments.inlineParts(emailId);
          if (parts.length > 0) {
            const resolved = resolveInlineImages(bodyHtml, parts);
            if (resolved.skipped > 0) {
              log.info('ipc', '部分内嵌图片未能还原', { emailId, skipped: resolved.skipped });
            }
            bodyHtml = resolved.html;
          }
        } catch (error) {
          log.warn('ipc', '还原内嵌图片失败（正文仍可显示）', {
            emailId,
            message: (error as Error).message,
          });
        }
      }

      const htmlSource =
        bodyHtml && bodyHtml.trim().length > 0
          ? bodyHtml
          : `<pre>${escapeHtml(stored.text ?? '（此邮件没有可显示的正文）')}</pre>`;

      const result = sanitizeEmailHtml(htmlSource, {
        allowRemoteImages: request?.allowRemoteImages === true,
      });

      triggerEmailScan(emailId);

      return ok({
        id: emailId,
        html: result.html,
        text: stored.text ?? '',
        blockedRemoteImages: result.blockedRemoteImages,
        remoteImages: result.remoteImages.slice(0, 50),
        sanitized: true,
      });
    },
  );

  ipcMain.handle(IPC.getFolders, (event, accountId: string): Result<FolderView[]> => {
    assertTrusted(event, IPC.getFolders);
    const services = getServices();
    return ok(services.folders.list(accountId));
  });

  // ---- 文件夹右键菜单 ----
  /**
   * 服务器拒绝时的可读文案。
   * QQ 邮箱（Foxmail）只允许在「账户根目录」或「登录时已存在的自定义文件夹」下建/改子文件夹，
   * 其余情况一律回 `Invalid top folder name!`——不翻译成人话用户只会以为是我们坏了。
   */
  const folderWriteErrorMessage = (raw: string): string => {
    if (!/invalid top folder name/i.test(raw)) return raw;
    return `${raw}（该服务器只允许在账户根目录或已有的自定义文件夹下建子文件夹；收件箱、垃圾邮件、已发送这类系统文件夹，以及本次登录后新建的文件夹都不行）`;
  };
  ipcMain.handle(
    IPC.folderCreate,
    async (event, request: FolderCreateRequest): Promise<Result<{ path: string }>> => {
      assertTrusted(event, IPC.folderCreate);
      const services = getServices();
      const account = services.accounts.get(request?.accountId ?? '');
      if (!account) return fail('NO_ACCOUNT', '账户不存在');
      if (!account.enabled) return fail('ACCOUNT_DISABLED', '账户已禁用，请先在设置中启用');

      // 分隔符各家不同（/ 或 .），优先用已发现文件夹的真实值
      const known = services.folders.list(account.id);
      const delimiter = known[0]?.delimiter || account.folderDelimiter || '/';
      const name = typeof request?.name === 'string' ? request.name : '';
      const check = validateFolderName(name, delimiter);
      if (!check.ok) return fail('BAD_FOLDER_NAME', folderNameErrorText(check.error));

      const parentPath = typeof request?.parentPath === 'string' ? request.parentPath : '';
      const path = buildFolderPath(parentPath, delimiter, name);
      if (known.some((folder) => folder.path === path)) {
        return fail('FOLDER_EXISTS', `「${path}」已存在`);
      }

      try {
        await services.manager.createFolder(account, path);
        return ok({ path });
      } catch (error) {
        log.warn('folder', '新建文件夹失败', {
          accountId: account.id,
          path,
          message: (error as Error).message,
        });
        return fail('FOLDER_CREATE_FAILED', folderWriteErrorMessage((error as Error).message));
      }
    },
  );

  ipcMain.handle(
    IPC.folderRename,
    async (event, request: FolderRenameRequest): Promise<Result<{ path: string }>> => {
      assertTrusted(event, IPC.folderRename);
      const services = getServices();
      const account = services.accounts.get(request?.accountId ?? '');
      if (!account) return fail('NO_ACCOUNT', '账户不存在');
      if (!account.enabled) return fail('ACCOUNT_DISABLED', '账户已禁用，请先在设置中启用');

      const folders = services.folders.list(account.id);
      const folder = folders.find((item) => item.path === request?.path);
      if (!folder) return fail('NOT_FOUND', '文件夹不存在');
      if (isProtectedFolder(folder)) {
        return fail('FOLDER_PROTECTED', '收件箱与系统文件夹不能改名');
      }

      const check = validateFolderName(request?.name ?? '', folder.delimiter);
      if (!check.ok) return fail('BAD_FOLDER_NAME', folderNameErrorText(check.error));

      const newPath = buildFolderPath(
        parentPathOf(folder.path, folder.delimiter),
        folder.delimiter,
        request.name,
      );
      if (newPath === folder.path) return ok({ path: newPath });
      if (folders.some((item) => item.path === newPath)) {
        return fail('FOLDER_EXISTS', `「${newPath}」已存在`);
      }

      try {
        await services.manager.renameFolder(account, folder.path, newPath);
        return ok({ path: newPath });
      } catch (error) {
        log.warn('folder', '重命名文件夹失败', {
          accountId: account.id,
          path: folder.path,
          message: (error as Error).message,
        });
        return fail('FOLDER_RENAME_FAILED', folderWriteErrorMessage((error as Error).message));
      }
    },
  );

  ipcMain.handle(
    IPC.folderMove,
    async (event, request: FolderMoveRequest): Promise<Result<{ path: string }>> => {
      assertTrusted(event, IPC.folderMove);
      const services = getServices();
      const account = services.accounts.get(request?.accountId ?? '');
      if (!account) return fail('NO_ACCOUNT', '账户不存在');
      if (!account.enabled) return fail('ACCOUNT_DISABLED', '账户已禁用，请先在设置中启用');

      const folders = services.folders.list(account.id);
      const folder = folders.find((item) => item.path === request?.path);
      if (!folder) return fail('NOT_FOUND', '文件夹不存在');
      if (isProtectedFolder(folder)) {
        return fail('FOLDER_PROTECTED', '收件箱与系统文件夹不能移动');
      }

      const targetParent = typeof request?.targetParent === 'string' ? request.targetParent.trim() : '';
      // 移到自己或自己的子目录里会造出一个环，服务端也救不回来
      if (targetParent && isSameOrDescendantPath(targetParent, folder.path, folder.delimiter)) {
        return fail('FOLDER_CYCLE', '不能移动到自身或它的子文件夹里');
      }
      if (targetParent && !folders.some((item) => item.path === targetParent)) {
        return fail('NOT_FOUND', '目标文件夹不存在');
      }

      const newPath = buildFolderPath(
        targetParent,
        folder.delimiter,
        leafNameOf(folder.path, folder.delimiter),
      );
      if (newPath === folder.path) return ok({ path: newPath });
      if (folders.some((item) => item.path === newPath)) {
        return fail('FOLDER_EXISTS', `「${newPath}」已存在`);
      }

      try {
        await services.manager.renameFolder(account, folder.path, newPath);
        return ok({ path: newPath });
      } catch (error) {
        const raw = (error as Error).message;
        log.warn('folder', '移动文件夹失败', {
          accountId: account.id,
          path: folder.path,
          target: newPath,
          message: raw,
        });
        return fail('FOLDER_MOVE_FAILED', folderWriteErrorMessage(raw));
      }
    },
  );

  ipcMain.handle(
    IPC.folderDelete,
    async (event, request: FolderDeleteRequest): Promise<Result<FolderDeleteResult>> => {
      assertTrusted(event, IPC.folderDelete);
      const services = getServices();
      const account = services.accounts.get(request?.accountId ?? '');
      if (!account) return fail('NO_ACCOUNT', '账户不存在');
      if (!account.enabled) return fail('ACCOUNT_DISABLED', '账户已禁用，请先在设置中启用');

      const folders = services.folders.list(account.id);
      const folder = folders.find((item) => item.path === request?.path);
      if (!folder) return fail('NOT_FOUND', '文件夹不存在');
      if (isProtectedFolder(folder)) {
        return fail('FOLDER_PROTECTED', '收件箱与系统文件夹不能删除');
      }

      // 带子文件夹的删除在部分服务器上会递归删掉整棵树，这里直接拦住，让用户先处理子文件夹
      const children = folders.filter(
        (item) =>
          item.path !== folder.path && item.path.startsWith(`${folder.path}${folder.delimiter}`),
      );
      if (children.length > 0) {
        return fail(
          'FOLDER_HAS_CHILDREN',
          `「${folder.name}」下还有 ${children.length} 个子文件夹，请先删除或移走它们`,
        );
      }

      try {
        const removed = await services.manager.deleteFolder(account, folder.path);
        return ok({ path: folder.path, folders: removed.folders, emails: removed.emails });
      } catch (error) {
        log.warn('folder', '删除文件夹失败', {
          accountId: account.id,
          path: folder.path,
          message: (error as Error).message,
        });
        return fail('FOLDER_DELETE_FAILED', (error as Error).message);
      }
    },
  );

  ipcMain.handle(
    IPC.folderCopy,
    async (event, request: FolderCopyRequest): Promise<Result<{ path: string; copied: number }>> => {
      assertTrusted(event, IPC.folderCopy);
      const services = getServices();
      const account = services.accounts.get(request?.accountId ?? '');
      if (!account) return fail('NO_ACCOUNT', '账户不存在');
      if (!account.enabled) return fail('ACCOUNT_DISABLED', '账户已禁用，请先在设置中启用');

      const folders = services.folders.list(account.id);
      const folder = folders.find((item) => item.path === request?.path);
      if (!folder) return fail('NOT_FOUND', '文件夹不存在');

      // IMAP 的 COPY 只能复制邮件，子文件夹得自己一个个来；这里先拒绝，避免复制出半个目录树
      const children = folders.filter(
        (item) =>
          item.path !== folder.path && item.path.startsWith(`${folder.path}${folder.delimiter}`),
      );
      if (children.length > 0) {
        return fail('FOLDER_HAS_CHILDREN', `「${folder.name}」下还有子文件夹，暂不支持整体复制`);
      }

      const check = validateFolderName(request?.name ?? '', folder.delimiter);
      if (!check.ok) return fail('BAD_FOLDER_NAME', folderNameErrorText(check.error));

      const target = buildFolderPath(
        parentPathOf(folder.path, folder.delimiter),
        folder.delimiter,
        request.name,
      );
      if (folders.some((item) => item.path === target)) {
        return fail('FOLDER_EXISTS', `「${target}」已存在`);
      }

      try {
        const copied = await services.manager.copyFolder(account, folder.path, target);
        return ok({ path: target, copied });
      } catch (error) {
        log.warn('folder', '复制文件夹失败', {
          accountId: account.id,
          path: folder.path,
          target,
          message: (error as Error).message,
        });
        return fail('FOLDER_COPY_FAILED', folderWriteErrorMessage((error as Error).message));
      }
    },
  );

  ipcMain.handle(
    IPC.folderClear,
    async (event, payload: { accountId: string; folder: string }): Promise<Result<FolderClearResult>> => {
      assertTrusted(event, IPC.folderClear);
      const services = getServices();
      const account = services.accounts.get(payload?.accountId ?? '');
      if (!account) return fail('NO_ACCOUNT', '账户不存在');
      if (!account.enabled) return fail('ACCOUNT_DISABLED', '账户已禁用，请先在设置中启用');

      const folder = services.folders
        .list(account.id)
        .find((item) => item.path === payload?.folder);
      if (!folder) return fail('NOT_FOUND', '文件夹不存在');
      if (folder.total === 0) return ok({ removed: 0, localRemoved: 0 });

      try {
        const removed = await services.manager.clearFolderMessages(account, folder.path);
        const localRemoved = services.emails.clearFolder(account.id, folder.path);
        return ok({ removed, localRemoved });
      } catch (error) {
        log.warn('folder', '清空文件夹失败', {
          accountId: account.id,
          folder: folder.path,
          message: (error as Error).message,
        });
        return fail('FOLDER_CLEAR_FAILED', folderWriteErrorMessage((error as Error).message));
      }
    },
  );

  ipcMain.handle(
    IPC.folderDuplicates,
    (event, payload: { accountId: string; folder: string }): Result<FolderDuplicatesResult> => {
      assertTrusted(event, IPC.folderDuplicates);
      const services = getServices();
      const duplicates = services.emails.findDuplicates(payload?.accountId ?? '', payload?.folder ?? '');
      return ok({ count: duplicates.length });
    },
  );

  ipcMain.handle(
    IPC.folderDedupe,
    async (event, payload: { accountId: string; folder: string }): Promise<Result<{ removed: number }>> => {
      assertTrusted(event, IPC.folderDedupe);
      const services = getServices();
      const account = services.accounts.get(payload?.accountId ?? '');
      if (!account) return fail('NO_ACCOUNT', '账户不存在');
      const folder = payload?.folder ?? '';
      const duplicates = services.emails.findDuplicates(account.id, folder);
      if (duplicates.length === 0) return ok({ removed: 0 });

      try {
        await services.manager.clearFolderMessages(
          account,
          folder,
          duplicates.map((item) => item.uid),
        );
        const removed = services.emails.deleteByIds(
          account.id,
          duplicates.map((item) => item.id),
        );
        return ok({ removed });
      } catch (error) {
        log.warn('folder', '清理重复邮件失败', {
          accountId: account.id,
          folder,
          message: (error as Error).message,
        });
        return fail('FOLDER_DEDUPE_FAILED', folderWriteErrorMessage((error as Error).message));
      }
    },
  );

  ipcMain.handle(IPC.appGetInstanceMode, (event): Result<boolean> => {
    assertTrusted(event, IPC.appGetInstanceMode);
    return ok(readSingleInstanceMode());
  });

  ipcMain.handle(
    IPC.appSetInstanceMode,
    (event, singleInstance: boolean): Result<boolean> => {
      assertTrusted(event, IPC.appSetInstanceMode);
      writeSingleInstanceMode(singleInstance !== false);
      return ok(singleInstance !== false);
    },
  );

  ipcMain.handle(
    IPC.windowOpenFolder,
    (event, payload: { accountId: string; folder: string }): Result<boolean> => {
      assertTrusted(event, IPC.windowOpenFolder);
      const services = getServices();
      const account = services.accounts.get(payload?.accountId ?? '');
      if (!account) return fail('NO_ACCOUNT', '账户不存在');
      const folder = payload?.folder ?? '';
      if (!services.folders.list(account.id).some((item) => item.path === folder)) {
        return fail('NOT_FOUND', '文件夹不存在');
      }
      createFolderWindow(account.id, folder);
      return ok(true);
    },
  );

  ipcMain.handle(
    IPC.mailGetEmail,
    (event, id: string): Result<EmailSummary> => {
      assertTrusted(event, IPC.mailGetEmail);
      const services = getServices();
      const email = services.emails.get(id ?? '');
      if (!email) return fail('NOT_FOUND', '邮件不存在');
      return ok(email);
    },
  );

  ipcMain.handle(
    IPC.windowOpenReader,
    (event, payload: { emailId?: string; compose?: string }): Result<boolean> => {
      assertTrusted(event, IPC.windowOpenReader);
      const services = getServices();
      const emailId = payload?.emailId ?? '';
      const email = services.emails.get(emailId);
      if (!email) return fail('NOT_FOUND', '邮件不存在');
      const composeRaw = payload?.compose;
      const compose =
        composeRaw === 'reply' || composeRaw === 'reply-all' || composeRaw === 'forward'
          ? composeRaw
          : null;
      // 「打开阅读窗口自动全屏」：默认开启（未设置过也按开启处理）。
      const autoFullScreenRow = services.db
        .prepare('SELECT value FROM app_settings WHERE key = ?')
        .get(AUTO_FULL_SCREEN_KEY) as { value?: string } | undefined;
      const autoFullScreen = normalizeAutoFullScreen(autoFullScreenRow?.value ?? null);
      createReaderWindow(emailId, compose ?? undefined, autoFullScreen);
      return ok(true);
    },
  );

  // 写信「全屏」按钮驱动：用「最大化到工作区」替代独占式全屏，
  // 这样 Windows 下不会盖住底部任务栏（独占全屏会覆盖任务栏）。
  // 用 fromWebContents 取调用方所在窗口，避免依赖全局 mainWindow 引用。
  // 只还原「由我们最大化」的窗口，避免用户原本就最大化时被误还原。
  const maximizedByCompose = new Set<number>();
  ipcMain.handle(IPC.windowSetFullScreen, (event, on: boolean): Result<boolean> => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) return fail('NO_WINDOW', '窗口不存在');
    if (on) {
      if (!window.isMaximized()) {
        maximizedByCompose.add(window.id);
        window.maximize();
      }
    } else if (maximizedByCompose.has(window.id)) {
      maximizedByCompose.delete(window.id);
      if (window.isMaximized()) window.unmaximize();
    }
    return ok(true);
  });

  // 把拖入写信界面的本地文件路径暂存为附件（与选择附件复用同一暂存目录与上限）。
  ipcMain.handle(
    IPC.mailStageAttachments,
    async (event, paths: string[]): Promise<Result<ComposeAttachmentInfo[]>> => {
      assertTrusted(event, IPC.mailStageAttachments);
      if (!Array.isArray(paths) || paths.length === 0) return ok([]);
      try {
        return ok(await getServices().composeAttachments.stageFiles(paths.slice(0, 10)));
      } catch (error) {
        log.warn('mail', '拖拽附件暂存失败', { message: (error as Error).message });
        return fail('ATTACHMENT_FAILED', '附件读取失败，请重试');
      }
    },
  );

  ipcMain.handle(
    IPC.folderDetails,
    (event, payload: { accountId: string; folder: string }): Result<FolderDetails> => {
      assertTrusted(event, IPC.folderDetails);
      const services = getServices();
      const accountId = payload?.accountId ?? '';
      const folder = payload?.folder ?? '';
      const view = services.folders.list(accountId).find((item) => item.path === folder);
      if (!view) return fail('NOT_FOUND', '文件夹不存在');
      const state = services.folders.getState(accountId, folder);
      return ok({
        accountId,
        path: view.path,
        name: view.name,
        delimiter: view.delimiter,
        ...(view.specialUse ? { specialUse: view.specialUse } : {}),
        total: view.total,
        unread: view.unread,
        uidValidity: state?.uidValidity ?? 0,
        lastSyncAt: state?.lastSyncAt ?? 0,
        capabilityLevel: state?.capabilityLevel ?? '',
        needsFullResync: state?.needsFullResync ?? false,
      });
    },
  );

  ipcMain.handle(
    IPC.folderMarkRead,
    (event, payload: { accountId: string; folder: string }): Result<{ marked: number }> => {
      assertTrusted(event, IPC.folderMarkRead);
      const services = getServices();
      const account = services.accounts.get(payload?.accountId ?? '');
      if (!account) return fail('NO_ACCOUNT', '账户不存在');
      const folder = payload?.folder ?? '';
      const marked = services.emails.markFolderRead(account.id, folder);
      // 服务端尽力同步：没连接或服务器拒绝都只记录，下次同步以服务端为准
      void services.manager.markFolderRead(account, folder).catch((error: Error) => {
        log.warn('folder', '标记已读同步到服务端失败', {
          accountId: account.id,
          folder,
          message: error.message,
        });
      });
      return ok({ marked });
    },
  );

  ipcMain.handle(IPC.refresh, async (event, accountId?: string): Promise<Result<{ queued: number }>> => {
    assertTrusted(event, IPC.refresh);
    const services = getServices();
    const account = services.accounts.get(accountId ?? services.envAccount?.id ?? '');
    if (!account) return fail('NO_ACCOUNT', '没有可同步的账户');
    if (!account.enabled) return fail('ACCOUNT_DISABLED', '账户已禁用，请先在设置中启用');

    services.manager.prioritize(account);
    void services.manager.refreshAccount(account).catch((error: Error) => {
      log.error('ipc', '手动刷新失败', { accountId: account.id, message: error.message });
    });

    return ok({ queued: 1 });
  });

  ipcMain.handle(
    IPC.openExternal,
    async (event, rawUrl: string): Promise<Result<{ opened: boolean; reason?: string }>> => {
      assertTrusted(event, IPC.openExternal);
      const validation = validateExternalUrl(rawUrl);
      if (!validation.ok) {
        log.warn('security', '拒绝打开链接', { code: validation.code, message: validation.message });
        return fail('URL_REJECTED', validation.message);
      }

      if (validation.isIdn) {
        const parent = getMainWindow();
        const options = {
          type: 'warning' as const,
          buttons: ['取消', '继续打开'],
          defaultId: 0,
          cancelId: 0,
          title: '确认链接地址',
          message: '此链接的域名包含国际化字符',
          detail: `链接将以原始形式打开：\n${validation.displayHost}\n\n请确认这是你信任的站点。`,
          noLink: true,
        };
        const result = parent
          ? await dialog.showMessageBox(parent, options)
          : await dialog.showMessageBox(options);
        if (result.response !== 1) {
          return ok({ opened: false, reason: '用户取消' });
        }
      }

      await shell.openExternal(validation.url.toString());
      log.info('security', '在系统浏览器打开链接', { host: validation.displayHost });
      return ok({ opened: true });
    },
  );

  ipcMain.handle(IPC.getDiagnostics, (event): Result<DiagnosticsData> => {
    assertTrusted(event, IPC.getDiagnostics);
    const services = getServices();
    const security = getSecurityBaseline();

    return ok({
      startupMs: getStartupMs(),
      processCreationMs: processStartedAt(),
      dbPath: services.dbPath,
      logDir: getLogDir(),
      dbEncrypted: services.dbEncrypted,
      keyProtection: services.keyProtection,
      proxy: services.proxy,
      gpuCrashes: faultRecovery.getGpuCrashCount(),
      hardwareAcceleration: getAppFlags().hardwareAcceleration,
      counts: services.emails.counts(),
      security,
      tray: {
        active: services.tray?.active ?? false,
        unread: services.tray?.unreadCount ?? 0,
        settings: services.tray?.settingsSnapshot ?? readTraySettings(services.db),
      },
    });
  });

  ipcMain.handle(IPC.rendererReady, (event, payload: { mountMs?: number }): Result<{ startupMs: number }> => {
    assertTrusted(event, IPC.rendererReady);
    const startupMs = markInteractive(Math.round(payload?.mountMs ?? 0));
    return ok({ startupMs });
  });

  // 从界面（工具栏「文件 → 退出应用」）触发正常退出：走 before-quit 清理，
  // 与托盘「退出」共用同一套数据库/worker/日志落盘流程，不得跳过。
  ipcMain.handle(IPC.quit, (event): void => {
    assertTrusted(event, IPC.quit);
    app.quit();
  });

  ipcMain.handle(IPC.recoveryInfo, (event) => {
    assertTrusted(event, IPC.recoveryInfo);
    return (
      faultRecovery.buildRecoveryInfo(app.getVersion(), process.versions.electron ?? 'unknown') ?? {
        reason: 'unknown',
        exitCode: 0,
        source: 'main-window',
        occurredAt: Date.now(),
        appVersion: app.getVersion(),
        electronVersion: process.versions.electron ?? 'unknown',
        recentLogs: [],
        reloadLabel: '重新加载',
      }
    );
  });

  ipcMain.handle(IPC.recoveryReload, (event): void => {
    assertTrusted(event, IPC.recoveryReload);
    log.info('recovery', '用户点击重新加载');
    getRecoveryWindow()?.destroy();
    const window = getMainWindow();
    if (window) {
      window.reload();
      window.show();
      window.focus();
    } else {
      createMainWindow();
    }
    faultRecovery.clear();
  });

  ipcMain.handle('recovery:quit', (event): void => {
    assertTrusted(event, 'recovery:quit');
    app.quit();
  });

  ipcMain.handle(IPC.mailSearch, (event, request: SearchRequest): Result<SearchResponse> => {
    assertTrusted(event, IPC.mailSearch);
    try {
      return ok(getServices().search.search(request));
    } catch (error) {
      return fail('SEARCH_FAILED', (error as Error).message);
    }
  });

  ipcMain.handle(
    IPC.mailSetPinned,
    (event, payload: { emailId: string; pinned: boolean }): Result<boolean> => {
      assertTrusted(event, IPC.mailSetPinned);
      const emailId = payload?.emailId ?? '';
      if (!emailId) return fail('BAD_REQUEST', '缺少 emailId');
      getServices()
        .db.prepare('UPDATE emails SET pinned = ? WHERE id = ?')
        .run(payload.pinned === true ? 1 : 0, emailId);
      return ok(true);
    },
  );

  // 邮件标志 / 归档 / 删除：服务端成功后本地才落库（演示账户只改本地）
  ipcMain.handle(
    IPC.mailSetFlags,
    async (
      event,
      payload: { emailId: string; patch?: { read?: boolean; starred?: boolean } },
    ): Promise<Result<EmailSummary>> => {
      assertTrusted(event, IPC.mailSetFlags);
      const emailId = payload?.emailId ?? '';
      if (!emailId) return fail('BAD_REQUEST', '缺少 emailId');
      try {
        return ok(await getServices().mailActions.setFlags(emailId, payload.patch ?? {}));
      } catch (error) {
        return mailActionFailure(error);
      }
    },
  );

  ipcMain.handle(
    IPC.mailArchive,
    async (event, payload: { emailId: string }): Promise<Result<{ folder: string }>> => {
      assertTrusted(event, IPC.mailArchive);
      const emailId = payload?.emailId ?? '';
      if (!emailId) return fail('BAD_REQUEST', '缺少 emailId');
      try {
        return ok(await getServices().mailActions.archive(emailId));
      } catch (error) {
        return mailActionFailure(error);
      }
    },
  );

  ipcMain.handle(
    IPC.mailMove,
    async (
      event,
      payload: { emailId: string; folder?: string },
    ): Promise<Result<EmailSummary>> => {
      assertTrusted(event, IPC.mailMove);
      const emailId = payload?.emailId ?? '';
      const folder = payload?.folder ?? '';
      if (!emailId || !folder) return fail('BAD_REQUEST', '缺少 emailId 或目标文件夹');
      try {
        return ok(await getServices().mailActions.moveTo(emailId, folder));
      } catch (error) {
        return mailActionFailure(error);
      }
    },
  );

  ipcMain.handle(
    IPC.mailDelete,
    async (event, payload: { emailId: string }): Promise<Result<{ removed: boolean }>> => {
      assertTrusted(event, IPC.mailDelete);
      const emailId = payload?.emailId ?? '';
      if (!emailId) return fail('BAD_REQUEST', '缺少 emailId');
      try {
        await getServices().mailActions.remove(emailId);
        return ok({ removed: true });
      } catch (error) {
        return mailActionFailure(error);
      }
    },
  );

  ipcMain.handle(IPC.mailPickAttachments, async (event): Promise<Result<ComposeAttachmentInfo[]>> => {
    assertTrusted(event, IPC.mailPickAttachments);
    const parent = getMainWindow();
    const options = {
      title: '选择附件',
      properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
    };
    const picked = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    if (picked.canceled || picked.filePaths.length === 0) return ok([]);
    try {
      return ok(await getServices().composeAttachments.stageFiles(picked.filePaths));
    } catch (error) {
      log.warn('mail', '附件暂存失败', { message: (error as Error).message });
      return fail('ATTACHMENT_FAILED', '附件读取失败，请重试');
    }
  });

  ipcMain.handle(IPC.mailDropAttachment, (event, id: string): Result<boolean> => {
    assertTrusted(event, IPC.mailDropAttachment);
    if (!id) return fail('BAD_REQUEST', '缺少附件 id');
    getServices().composeAttachments.release([id]);
    return ok(true);
  });

  ipcMain.handle(IPC.draftGet, (event, accountId: string): Result<ComposeDraft | null> => {
    assertTrusted(event, IPC.draftGet);
    if (!accountId) return fail('BAD_REQUEST', '缺少账户');
    return ok(getServices().drafts.get(accountId));
  });

  ipcMain.handle(
    IPC.draftSave,
    async (event, input: Omit<ComposeDraft, 'updatedAt'>): Promise<Result<ComposeDraft>> => {
      assertTrusted(event, IPC.draftSave);
      const accountId = input?.accountId ?? '';
      if (!accountId) return fail('BAD_REQUEST', '缺少账户');
      const services = getServices();
      // 保存前先记下旧服务器 uid：本次保存会把 server_uid 重置为 -1，稍后再回填新的
      const previous = services.drafts.get(accountId);
      // 编辑的是「服务器草稿」（本地还没有对应行）时，用入参里的 uid 作为旧副本，
      // 否则保存后会把旧的服务器草稿留在 Drafts 里，越攒越多
      const incomingUid =
        typeof input.serverUid === 'number' && input.serverUid > 0 ? input.serverUid : -1;
      const prevUid = previous?.serverUid ?? incomingUid;
      const draft = services.drafts.save({
        accountId,
        to: Array.isArray(input.to) ? input.to.filter((item) => typeof item === 'string') : [],
        cc: Array.isArray(input.cc) ? input.cc.filter((item) => typeof item === 'string') : [],
        bcc: Array.isArray(input.bcc) ? input.bcc.filter((item) => typeof item === 'string') : [],
        subject: typeof input.subject === 'string' ? input.subject : '',
        body: typeof input.body === 'string' ? input.body : '',
        html: typeof input.html === 'string' ? input.html : '',
        attachments: Array.isArray(input.attachments)
          ? input.attachments.filter(
              (item) => item && typeof item.id === 'string' && typeof item.filename === 'string',
            )
          : [],
      });

      // 非演示账户：把草稿同步到服务器 Drafts 文件夹；失败不影响本地保存。
      // 每次自动保存都会重新 APPEND 一封，因此先删掉上一封，避免服务器草稿越攒越多。
      const account = services.accounts.get(accountId);
      if (account && account.settings.demoMode !== true) {
        try {
          const uid = await services.manager.saveServerDraft(account, draft);
          if (uid > 0) {
            if (prevUid > 0 && prevUid !== uid) {
              try {
                await services.manager.deleteServerDraft(account, prevUid);
              } catch (error) {
                log.warn('ipc', '清理上一封服务器草稿失败', {
                  accountId,
                  message: (error as Error).message,
                });
              }
            }
            services.drafts.setServerUid(accountId, uid);
          }
        } catch (error) {
          log.warn('ipc', '服务器草稿同步失败（本地草稿已保存）', {
            accountId,
            message: (error as Error).message,
          });
        }
      }

      // 保存会改变服务器草稿列表，失效缓存以便下次打开重新读取
      services.manager.invalidateServerDrafts(accountId);
      return ok(draft);
    },
  );

  ipcMain.handle(IPC.draftList, (event): Result<ComposeDraft[]> => {
    assertTrusted(event, IPC.draftList);
    return ok(getServices().drafts.list());
  });

  ipcMain.handle(IPC.draftDelete, async (event, accountId: string, serverGated?: boolean): Promise<Result<boolean>> => {
    assertTrusted(event, IPC.draftDelete);
    if (!accountId) return fail('BAD_REQUEST', '缺少账户');
    const services = getServices();
    const existing = services.drafts.get(accountId);
    const prevUid = existing?.serverUid ?? -1;
    if (prevUid > 0) {
      const account = services.accounts.get(accountId);
      if (account && account.settings.demoMode !== true) {
        try {
          await services.manager.deleteServerDraft(account, prevUid);
        } catch (error) {
          // serverGated 模式：服务器删除失败则保留本地，交由渲染进程回滚显示
          if (serverGated) {
            return fail('DRAFT_SERVER_DELETE_FAILED', `服务器草稿删除失败：${(error as Error).message}`);
          }
          log.warn('ipc', '删除服务器草稿失败（继续删除本地草稿）', {
            accountId,
            message: (error as Error).message,
          });
        }
      }
    }
    // 服务器删除成功（或无服务器副本 / 演示模式 / 非 serverGated）：移除本地草稿
    return ok(services.drafts.remove(accountId));
  });

  ipcMain.handle(
    IPC.draftServerList,
    async (event, force?: boolean): Promise<Result<ComposeDraft[]>> => {
      assertTrusted(event, IPC.draftServerList);
      const services = getServices();
      const drafts: ComposeDraft[] = [];
      for (const account of services.accounts.list()) {
        if (account.settings.demoMode === true) continue;
        try {
          drafts.push(...(await services.manager.listServerDrafts(account, { force: Boolean(force) })));
        } catch (error) {
        log.warn('ipc', '读取账户服务器草稿失败', {
          accountId: account.id,
          message: (error as Error).message,
        });
      }
    }
    return ok(drafts);
  });

  ipcMain.handle(
    IPC.draftServerDelete,
    async (event, accountId: string, uid: number): Promise<Result<boolean>> => {
      assertTrusted(event, IPC.draftServerDelete);
      if (!accountId) return fail('BAD_REQUEST', '缺少账户');
      const services = getServices();
      const account = services.accounts.get(accountId);
      if (!account || account.settings.demoMode === true) return ok(false);
      try {
        await services.manager.deleteServerDraft(account, uid > 0 ? uid : 0);
      } catch (error) {
        log.warn('ipc', '删除服务器草稿失败', {
          accountId,
          message: (error as Error).message,
        });
        return ok(false);
      }
      services.manager.invalidateServerDrafts(accountId);
      return ok(true);
    },
  );

  ipcMain.handle(IPC.contactsSearch, (event, query: string) => {
    assertTrusted(event, IPC.contactsSearch);
    return ok(getServices().contacts.search(query ?? ''));
  });

  // 联系人面板：一次性取一批（默认 200、上限 500），而不是自动补全的前 8 条。
  ipcMain.handle(IPC.contactsList, (event, limit?: number) => {
    assertTrusted(event, IPC.contactsList);
    const requested = Number(limit);
    const safeLimit = Number.isFinite(requested)
      ? Math.min(500, Math.max(1, Math.round(requested)))
      : 200;
    return ok(getServices().contacts.search('', safeLimit));
  });

  ipcMain.handle(
    IPC.mailScheduleSend,
    async (event, request: ScheduleSendRequest): Promise<Result<{ id: string; sendAt: number }>> => {
      assertTrusted(event, IPC.mailScheduleSend);
      const services = getServices();
      const accountId = request?.accountId ?? services.envAccount?.id ?? '';
      if (!accountId) return fail('NO_ACCOUNT', '没有可用的账户');
      const to = (request.to ?? []).map((item) => item.trim()).filter(Boolean);
      if (to.length === 0) return fail('BAD_REQUEST', '至少需要一个收件人');

      const account = services.accounts.get(accountId);
      if (!account) return fail('NOT_FOUND', '账户不存在');
      if (!account.smtp) return fail('NO_SMTP', '该账户未配置 SMTP，无法发送');

      const attachmentIds = (request.attachments ?? []).filter((id) => typeof id === 'string');
      const attachments = services.composeAttachments.resolve(attachmentIds);
      if (attachmentIds.length > 0 && attachments.length === 0) {
        return fail('ATTACHMENT_MISSING', '附件已失效，请重新选择附件');
      }

      // 渲染进程的净化只为止痒；真正发出去的 HTML 必须在这里重新净化（§10.1 唯一权威入口）
      const safeHtml = request.html ? sanitizeComposeHtml(request.html) : '';
      // 正文里粘贴的截图是 data URI，直接发会被 Gmail/Outlook 剥掉：
      // 抽出来变成 CID 内嵌附件，正文改写为 cid: 引用（内联转化失败则原样保留）
      const extracted = extractInlineImages(safeHtml);
      if (extracted.oversized > 0) {
        log.warn('ipc', '正文内嵌图片超过体积上限，按原 data URI 发送', {
          accountId,
          count: extracted.oversized,
        });
      }
      const stagedInline = await services.composeAttachments.stageInlineImages(extracted.images);
      const finalHtml = restoreUnstagedInlineImages(
        extracted.html,
        extracted.images,
        new Set(stagedInline.map((item) => item.cid)),
      );
      const message = {
        to,
        ...(request.cc && request.cc.length ? { cc: request.cc } : {}),
        ...(request.bcc && request.bcc.length
          ? { bcc: request.bcc.map((item) => item.trim()).filter(Boolean) }
          : {}),
        subject: request.subject ?? '',
        text: finalHtml ? htmlToPlainText(finalHtml) : request.body ?? '',
        ...(finalHtml ? { html: finalHtml } : {}),
        ...(attachments.length > 0 || stagedInline.length > 0
          ? {
              attachments: [
                ...attachments,
                ...stagedInline.map((item) => ({
                  filename: item.filename,
                  path: item.path,
                  cid: item.cid,
                  contentType: item.contentType,
                })),
              ],
            }
          : {}),
      };

      // 显式 sendAt → 定时发送；未指定 → 立即发送（不再有 10 秒缓冲倒计时）
      let result: { id: string; sendAt: number };
      if (typeof request.sendAt === 'number' && Number.isFinite(request.sendAt)) {
        result = services.scheduled.scheduleAt(accountId, message, request.sendAt);
      } else if (typeof request.undoDelayMs === 'number' && request.undoDelayMs > 0) {
        result = services.scheduled.schedule(accountId, message, request.undoDelayMs);
      } else {
        result = services.scheduled.scheduleAt(accountId, message, Date.now());
      }

      // 发送计划已建立：若此前草稿已同步到服务器，清理服务器草稿，避免收件箱残留两封
      const priorUid = services.drafts.get(accountId)?.serverUid ?? -1;
      if (priorUid > 0 && account.settings.demoMode !== true) {
        try {
          await services.manager.deleteServerDraft(account, priorUid);
          services.drafts.remove(accountId);
        } catch (error) {
          log.warn('ipc', '发送后清理服务器草稿失败', {
            accountId,
            message: (error as Error).message,
          });
        }
      }

      return ok(result);
    },
  );

  ipcMain.handle(IPC.mailCancelSend, (event, id: string): Result<boolean> => {
    assertTrusted(event, IPC.mailCancelSend);
    return ok(getServices().scheduled.cancel(id));
  });

  ipcMain.handle(IPC.mailScheduledList, (event): Result<ScheduledSendInfo[]> => {
    assertTrusted(event, IPC.mailScheduledList);
    return ok(getServices().scheduled.list());
  });

  registerAttachmentHandlers();
  registerTranslationHandlers();
  registerAiHandlers();
  registerCalendarHandlers();
  registerArchiveHandlers();
  registerSnoozeHandler();
  registerAccountHandlers();
  registerPluginHandlers();
  registerSettingsHandlers();
  registerTrayHandlers();
}

/** 托盘与通知设置（宿主能力）。 */
function registerTrayHandlers(): void {
  ipcMain.handle(IPC.trayGet, (event): Result<TraySettings> => {
    assertTrusted(event, IPC.trayGet);
    const services = getServices();
    return ok(services.tray?.settingsSnapshot ?? readTraySettings(services.db));
  });

  ipcMain.handle(IPC.traySet, (event, payload: Partial<TraySettings>): Result<TraySettings> => {
    assertTrusted(event, IPC.traySet);
    const services = getServices();
    const current = services.tray?.settingsSnapshot ?? readTraySettings(services.db);
    const next: TraySettings = {
      enabled: typeof payload?.enabled === 'boolean' ? payload.enabled : current.enabled,
      closeToTray:
        typeof payload?.closeToTray === 'boolean' ? payload.closeToTray : current.closeToTray,
      minimizeToTray:
        typeof payload?.minimizeToTray === 'boolean' ? payload.minimizeToTray : current.minimizeToTray,
      showUnreadBadge:
        typeof payload?.showUnreadBadge === 'boolean'
          ? payload.showUnreadBadge
          : current.showUnreadBadge,
    };

    if (services.tray) {
      services.tray.applySettings(next); // 内部负责持久化
    } else {
      writeTraySettings(services.db, next);
    }
    log.info('tray', '托盘设置已更新', { ...next });
    return ok(next);
  });

  ipcMain.handle(IPC.notificationsGet, (event): Result<NotificationSettingsView> => {
    assertTrusted(event, IPC.notificationsGet);
    const services = getServices();
    return ok({
      ...readNotificationSettings(services.db),
      dnd: { ...readDndSettings(services.db) },
    });
  });

  ipcMain.handle(
    IPC.notificationsSet,
    (
      event,
      payload: Partial<Omit<NotificationSettingsView, 'dnd'>> & {
        dnd?: Partial<NotificationSettingsView['dnd']>;
      },
    ): Result<NotificationSettingsView> => {
      assertTrusted(event, IPC.notificationsSet);
      const services = getServices();
      const current = readNotificationSettings(services.db);
      const dnd = readDndSettings(services.db);

      const next = {
        mail: typeof payload?.mail === 'boolean' ? payload.mail : current.mail,
        sendResult: typeof payload?.sendResult === 'boolean' ? payload.sendResult : current.sendResult,
        reminders: typeof payload?.reminders === 'boolean' ? payload.reminders : current.reminders,
        reminderMinutes: clampReminderMinutes(
          typeof payload?.reminderMinutes === 'number'
            ? payload.reminderMinutes
            : current.reminderMinutes,
        ),
      };
      const nextDnd = {
        enabled: typeof payload?.dnd?.enabled === 'boolean' ? payload.dnd.enabled : dnd.enabled,
        startHour: clampHour(typeof payload?.dnd?.startHour === 'number' ? payload.dnd.startHour : dnd.startHour),
        endHour: clampHour(typeof payload?.dnd?.endHour === 'number' ? payload.dnd.endHour : dnd.endHour),
      };

      writeNotificationSettings(services.db, next);
      writeDndSettings(services.db, nextDnd);
      log.info('notify', '通知设置已更新', { ...next, dnd: nextDnd });
      return ok({ ...next, dnd: nextDnd });
    },
  );

  ipcMain.handle(IPC.notificationsTest, (event): Result<{ supported: boolean }> => {
    assertTrusted(event, IPC.notificationsTest);
    // 系统不支持时如实回给渲染层（例如某些无通知服务的 Linux 桌面），
    // 由设置页提示用户，而不是假装成功。
    const supported = Notification.isSupported();
    if (supported) {
      getServices().notifications.notifyTest();
    }
    log.info('notify', '已发送测试通知', { supported });
    return ok({ supported });
  });
}

function registerPluginHandlers(): void {
  ipcMain.handle(IPC.pluginsRegistry, (event): Result<PluginRegistrySnapshot> => {
    assertTrusted(event, IPC.pluginsRegistry);
    const services = getServices();
    const snapshot = services.plugins.snapshot();
    return ok({
      ...snapshot,
      plugins: snapshot.plugins.map((plugin) => ({
        ...plugin,
        revokedPermissions: services.capabilities.revokedFor(plugin.id),
      })),
    });
  });

  ipcMain.handle(
    IPC.pluginsSetEnabled,
    (event, payload: { pluginId: string; enabled: boolean }): Result<boolean> => {
      assertTrusted(event, IPC.pluginsSetEnabled);
      const services = getServices();
      const pluginId = payload?.pluginId ?? '';
      const enabled = payload?.enabled === true;
      const plugin = services.plugins.getPlugin(pluginId);
      if (!plugin) return fail('NOT_FOUND', '插件不存在');

      if (!services.plugins.setEnabled(pluginId, enabled)) {
        return fail('NOT_READY', '插件当前不可启用');
      }
      services.pluginsRepo.setEnabled(pluginId, enabled, plugin.signature);
      if (!enabled) services.capabilities.invalidatePlugin(pluginId);
      sendToRenderer(IPC_EVENTS.pluginsChanged, null);
      return ok(true);
    },
  );

  ipcMain.handle(IPC.pluginsThemeCss, async (event, themeId: string) => {
    assertTrusted(event, IPC.pluginsThemeCss);
    return getServices().plugins.getThemeCss(themeId);
  });

  ipcMain.handle(
    IPC.pluginsIcon,
    async (event, payload: { pluginId: string; name: string }): Promise<Result<string | null>> => {
      assertTrusted(event, IPC.pluginsIcon);
      const url = await getServices().plugins.getIcon(payload?.pluginId ?? '', payload?.name ?? '');
      return ok(url);
    },
  );

  ipcMain.handle(
    IPC.pluginsViewSession,
    (
      event,
      payload: { pluginId: string; slot: SlotName; accountId?: string | null },
    ): Result<PluginViewSession | null> => {
      assertTrusted(event, IPC.pluginsViewSession);
      const services = getServices();
      const viewSession = services.plugins.getViewSession(
        payload?.pluginId ?? '',
        payload?.slot ?? 'reader-panel-top',
        payload?.accountId ?? null,
      );
      if (viewSession) {
        ensurePluginProtocolForPartition(viewSession.partition, (pluginId) =>
          services.plugins.pluginDirForProtocol(pluginId),
        );
      }
      return ok(viewSession);
    },
  );

  ipcMain.handle(IPC.pluginsOpenDevtools, (event, pluginId: string): Result<boolean> => {
    assertTrusted(event, IPC.pluginsOpenDevtools);
    if (app.isPackaged) return fail('DISABLED', '生产环境不开放插件 DevTools');
    const prefix = `mailforge-plugin://${pluginId}/`;
    const target = webContents.getAllWebContents().find((contents) => {
      try {
        return contents.getType() === 'webview' && contents.getURL().startsWith(prefix);
      } catch {
        return false;
      }
    });
    if (!target) return fail('NOT_FOUND', '插件视图尚未打开');
    target.openDevTools({ mode: 'detach' });
    return ok(true);
  });

  ipcMain.handle(IPC.pluginsSetActiveEmail, (event, emailId: string | null): Result<unknown> => {
    assertTrusted(event, IPC.pluginsSetActiveEmail);
    const services = getServices();

    if (!emailId) {
      services.plugins.setActiveEmail(null);
      return ok(null);
    }

    const email = services.emails.get(emailId);
    if (!email) return fail('NOT_FOUND', '邮件不存在');

    const stored = services.emails.getBody(emailId);
    const rawHtml = stored?.html ?? '';
    const sanitized = rawHtml ? sanitizeEmailHtml(rawHtml).html : '';
    const attachments = services.attachments.list(emailId).map((item) => ({
      id: item.id,
      filename: item.filename,
      mimeType: item.mimeType,
      size: item.size,
      ext: item.ext,
      riskLevel: item.risk.level,
    }));
    const context = {
      id: email.id,
      subject: email.subject,
      from: email.from,
      body: sanitized,
      text: stored?.text ?? htmlToPlainText(rawHtml),
      hasAttachments: email.hasAttachments,
      attachments,
    };
    services.plugins.setActiveEmail(context);

    for (const session of services.capabilities.activeSessions()) {
      if (!services.capabilities.hasPermission(session, 'read:email-meta')) continue;
      const target = webContents.fromId(session.webContentsId);
      if (!target || target.isDestroyed()) continue;
      target.send('plugin:email-changed', {
        nonce: session.nonce,
        email: {
          id: email.id,
          subject: email.subject,
          from: email.from,
          hasAttachments: email.hasAttachments,
        },
      });
    }

    return ok(context);
  });

  ipcMain.handle(IPC.pluginsCapabilityRevoke, (event, payload: { pluginId: string; permission: PluginPermission; revoked: boolean }): Result<boolean> => {
    assertTrusted(event, IPC.pluginsCapabilityRevoke);
    const services = getServices();
    const pluginId = payload?.pluginId ?? '';
    const permission = payload?.permission;
    if (!pluginId || !permission) return fail('BAD_REQUEST', '缺少参数');
    services.capabilities.setRevoked(pluginId, permission, payload.revoked === true);
    services.pluginsRepo.setCapability(pluginId, permission, payload.revoked !== true);
    return ok(true);
  });

  ipcMain.handle(IPC.pluginsCapabilityList, (event, pluginId: string): Result<PluginPermission[]> => {
    assertTrusted(event, IPC.pluginsCapabilityList);
    return ok(getServices().capabilities.revokedFor(pluginId));
  });

  ipcMain.handle(
    IPC.pluginsAccountOverride,
    (
      event,
      payload: { pluginId: string; accountId: string; enabled: boolean | null },
    ): Result<boolean> => {
      assertTrusted(event, IPC.pluginsAccountOverride);
      const services = getServices();
      const pluginId = payload?.pluginId ?? '';
      const accountId = payload?.accountId ?? '';
      if (!pluginId || !accountId) return fail('BAD_REQUEST', '缺少插件或账户');
      if (!services.plugins.getPlugin(pluginId)) return fail('NOT_FOUND', '插件不存在');
      if (!services.accounts.get(accountId)) return fail('NOT_FOUND', '账户不存在');

      const enabled =
        payload?.enabled === null || payload?.enabled === undefined
          ? null
          : payload.enabled === true;
      services.pluginsRepo.setAccountOverride(pluginId, accountId, enabled);
      services.plugins.setAccountOverrides(services.pluginsRepo.loadAccountOverrides());
      sendToRenderer(IPC_EVENTS.pluginsChanged, null);
      return ok(true);
    },
  );

  ipcMain.handle(IPC.pluginsMenuItems, (event, query: PluginMenuQuery): Result<PluginMenuItem[]> => {
    assertTrusted(event, IPC.pluginsMenuItems);
    const services = getServices();
    const region = query?.region;
    const regions: MenuRegion[] = [
      'main',
      'context:mail-list',
      'context:reader',
      'context:compose',
      'context:account',
    ];
    if (!region || !regions.includes(region)) return fail('BAD_REQUEST', '未知菜单区域');

    const accountId = query?.accountId ?? null;
    if (accountId && !services.accounts.get(accountId)) {
      return fail('NOT_FOUND', '账户不存在');
    }

    const revoked = new Map<string, Set<PluginPermission>>();
    for (const plugin of services.plugins.snapshot().plugins) {
      const list = services.capabilities.revokedFor(plugin.id);
      if (list.length > 0) revoked.set(plugin.id, new Set(list));
    }

    const context: MenuContext = {};
    for (const [key, value] of Object.entries(query?.context ?? {})) {
      if (value === true || value === false) {
        context[key as keyof MenuContext] = value;
      }
    }

    return ok(services.plugins.menuItems(region, context, accountId, revoked));
  });

  ipcMain.handle(
    IPC.pluginsRunCommand,
    (
      event,
      payload: { pluginId: string; commandId: string; accountId?: string | null },
    ): Result<PluginCommandRunResult> => {
      assertTrusted(event, IPC.pluginsRunCommand);
      const services = getServices();
      const pluginId = payload?.pluginId ?? '';
      const commandId = payload?.commandId ?? '';
      const plugin = services.plugins.getPlugin(pluginId);
      if (!plugin || plugin.status !== 'ready' || !plugin.enabled) {
        return fail('NOT_READY', '插件不可用');
      }

      const command = (plugin.manifest.contributes?.commands ?? []).find(
        (item) => item.id === commandId,
      );
      if (!command) return fail('NOT_FOUND', '命令不存在');

      // 菜单项可见性与执行权限分离（§13.3.1）：点击才校验能力
      if (command.requires) {
        const declared = (plugin.manifest.permissions ?? []).includes(command.requires);
        if (!declared || services.capabilities.isRevoked(pluginId, command.requires)) {
          return fail('PERMISSION', `此插件需要 ${command.requires} 权限`);
        }
      }

      const accountId = payload?.accountId ?? null;
      if (accountId && !services.plugins.isEnabledForAccount(pluginId, accountId)) {
        return fail('ACCOUNT_DISABLED', '该插件在此账户已禁用');
      }

      const prefix = `mailforge-plugin://${pluginId}/`;
      let delivered = 0;
      for (const contents of webContents.getAllWebContents()) {
        if (contents.getType() !== 'webview') continue;
        if (!contents.getURL().startsWith(prefix)) continue;
        const session = services.capabilities.getSession(contents.id);
        if (!session) continue;
        contents.send(IPC_EVENTS.pluginCommand, {
          nonce: session.nonce,
          command: { id: commandId, region: command.menu ?? 'main', accountId },
        });
        delivered += 1;
      }
      return ok({ delivered });
    },
  );

  ipcMain.handle(
    IPC.pluginsDraftSet,
    (event, context: unknown): Result<boolean> => {
      assertTrusted(event, IPC.pluginsDraftSet);
      const services = getServices();
      if (context === null || context === undefined) {
        services.plugins.setDraftContext(null);
        return ok(true);
      }
      const normalized = normalizeDraftContext(context);
      if (!normalized) return fail('BAD_REQUEST', '草稿上下文不合法');
      services.plugins.setDraftContext(normalized);

      // 草稿变化通知插件：否则插件写回后再读会拿到旧值
      for (const session of services.capabilities.activeSessions()) {
        if (!services.capabilities.hasPermission(session, 'read:email-body')) continue;
        const target = webContents.fromId(session.webContentsId);
        if (!target || target.isDestroyed()) continue;
        target.send(IPC_EVENTS.draftChanged, { nonce: session.nonce, draft: normalized });
      }
      return ok(true);
    },
  );

  // ---- 插件 webview 专用通道：不适用主窗口 origin 校验，改为来源 URL 校验 ----

  ipcMain.handle(IPC.pluginsHandshake, (event): PluginHandshake => {
    const sender = event.sender;
    if (sender.getType() !== 'webview') {
      throw new Error('仅插件 webview 可进行能力握手');
    }

    const url = sender.getURL();
    const match = /^mailforge-plugin:\/\/([a-z0-9][a-z0-9-]*)\//i.exec(url);
    if (!match?.[1]) {
      throw new Error('插件来源不合法');
    }
    const pluginId = match[1];

    const services = getServices();
    if (!services.plugins.isReady(pluginId)) {
      throw new Error('插件未启用');
    }
    return services.capabilities.handshake(
      sender.id,
      pluginId,
      services.plugins.permissionsFor(pluginId),
    );
  });

  /** 账户视图 → 插件可见摘要（不暴露密钥）。 */
  function toPluginAccountInfo(view: {
    id: string;
    displayName: string;
    email: string;
    protocol: string;
    providerPreset?: string;
    imapHost?: string;
    imapPort?: number;
    imapSecure?: boolean;
    smtpHost?: string;
    smtpPort?: number;
    smtpSecure?: boolean;
    authState: string;
    enabled: boolean;
    unreadCount: number;
    status: string;
  }): PluginAccountInfo {
    return {
      id: view.id,
      displayName: view.displayName,
      email: view.email,
      protocol: view.protocol,
      ...(view.providerPreset ? { providerPreset: view.providerPreset } : {}),
      ...(view.imapHost !== undefined ? { imapHost: view.imapHost } : {}),
      ...(view.imapPort !== undefined ? { imapPort: view.imapPort } : {}),
      ...(view.imapSecure !== undefined ? { imapSecure: view.imapSecure } : {}),
      ...(view.smtpHost !== undefined ? { smtpHost: view.smtpHost } : {}),
      ...(view.smtpPort !== undefined ? { smtpPort: view.smtpPort } : {}),
      ...(view.smtpSecure !== undefined ? { smtpSecure: view.smtpSecure } : {}),
      authState: view.authState,
      enabled: view.enabled,
      unreadCount: view.unreadCount,
      status: view.status,
    };
  }

  ipcMain.handle(IPC.pluginsCall, (event, request: PluginCallRequest): PluginCallResult => {
    const services = getServices();
    const session = services.capabilities.resolve(event.sender.id, request?.nonce ?? '');
    if (!session) {
      return { ok: false, error: '能力句柄已失效，请重新加载插件视图' };
    }
    if (!services.plugins.isReady(session.pluginId)) {
      return { ok: false, error: '插件已禁用' };
    }

    const permission = METHOD_PERMISSIONS[request.method];
    if (permission && !services.capabilities.hasPermission(session, permission)) {
      return { ok: false, error: `缺少权限 ${permission}` };
    }

    switch (request.method) {
      case 'getCurrentEmail':
        return { ok: true, data: services.plugins.getActiveEmail() };
      case 'getCurrentEmailAttachments':
        return {
          ok: true,
          data: (services.plugins.getActiveEmail()?.attachments ?? []).map((item) => ({
            id: item.id,
            filename: item.filename,
            mimeType: item.mimeType,
            size: item.size,
            ext: item.ext,
          })),
        };
      case 'getAttachmentRisk': {
        const attachmentId = String((request.args as { attachmentId?: unknown })?.attachmentId ?? '');
        const active = services.plugins.getActiveEmail();
        const risk = services.attachments
          .list(active?.id ?? '')
          .find((item) => item.id === attachmentId)?.risk;
        return {
          ok: true,
          data: risk ?? { level: 'unknown', reason: '未经安全扫描，请自行判断', tooltip: '' },
        };
      }
      case 'getDraftContext': {
        const draft = services.plugins.getDraftContext();
        if (!draft) return { ok: false, error: '当前没有打开的草稿' };
        return { ok: true, data: draft };
      }
      case 'setDraftContent': {
        const draft = services.plugins.getDraftContext();
        if (!draft) return { ok: false, error: '当前没有打开的草稿' };
        const normalized = normalizeDraftPatch(request.args);
        if (!normalized.ok) return { ok: false, error: normalized.error };
        sendToRenderer(IPC_EVENTS.draftPatch, {
          pluginId: session.pluginId,
          patch: normalized.patch,
        });
        return { ok: true };
      }
      case 'getThemeVariables': {
        // 插件视图在独立 webview 里读不到宿主 DOM，只能按「宿主当前主题」下发变量；
        // 浅色是默认主题，硬编码深色会让浅色界面里弹出一块深色面板。
        const row = services.db
          .prepare('SELECT value FROM app_settings WHERE key = ?')
          .get(THEME_SETTING_KEY) as { value?: string } | undefined;
        return { ok: true, data: themeVariablesFor(row?.value ?? null) };
      }
      case 'getAccounts':
        return { ok: true, data: services.accountService.listViews().map(toPluginAccountInfo) };
      case 'getAccount': {
        const id = String((request.args as { id?: unknown })?.id ?? '');
        const view = id ? services.accountService.getView(id) : null;
        if (!view) return { ok: false, error: '账户不存在' };
        return { ok: true, data: toPluginAccountInfo(view) };
      }
      case 'log': {
        const message = String((request.args as { message?: unknown })?.message ?? '').slice(0, 2000);
        log.info('plugin', message, { pluginId: session.pluginId });
        return { ok: true };
      }
      default:
        return { ok: false, error: '未知方法' };
    }
  });
}

function registerSettingsHandlers(): void {
  ipcMain.handle(IPC.settingsGet, (event, key: string): Result<string | null> => {
    assertTrusted(event, IPC.settingsGet);
    const services = getServices();
    const row = services.db
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return ok(row?.value ?? null);
  });

  ipcMain.handle(
    IPC.settingsSet,
    (event, payload: { key: string; value: string }): Result<boolean> => {
      assertTrusted(event, IPC.settingsSet);
      const services = getServices();
      const key = payload?.key ?? '';
      const value = payload?.value ?? '';
      if (!key) return fail('BAD_REQUEST', '缺少 key');
      services.db
        .prepare(
          `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(key, value, Date.now());
      // 需要跨窗口同步的配置：写入后广播给所有窗口（多窗口要立刻跟上）
      const broadcastChannel = broadcastChannelFor(key);
      if (broadcastChannel) {
        for (const window of BrowserWindow.getAllWindows()) {
          if (window.isDestroyed()) continue;
          try {
            window.webContents.send(broadcastChannel, value);
          } catch {
            // 单个窗口发送失败不影响保存结果
          }
        }
      }
      return ok(true);
    },
  );
}

// ---------------- Phase 3：附件 ----------------

function registerAttachmentHandlers(): void {
  ipcMain.handle(IPC.attachmentsList, (event, emailId: string): Result<AttachmentView[]> => {
    assertTrusted(event, IPC.attachmentsList);
    const id = typeof emailId === 'string' ? emailId : '';
    if (!id) return fail('BAD_REQUEST', '缺少 emailId');
    const services = getServices();
    // 已经内联进正文显示的图（带 Content-ID 且被 cid: 引用）不再重复列进附件条
    const body = services.emails.getBody(id);
    return ok(services.attachments.listVisible(id, body?.html ?? null));
  });

  ipcMain.handle(
    IPC.attachmentsPayload,
    (event, attachmentId: string): Result<AttachmentPayload> => {
      assertTrusted(event, IPC.attachmentsPayload);
      const services = getServices();
      const read = services.attachments.read(attachmentId ?? '');
      if (!read) return fail('NOT_FOUND', '附件内容不可用，请重新打开邮件');

      const view = services.attachments
        .list(read.row.email_id)
        .find((item) => item.id === attachmentId);
      if (!view) return fail('NOT_FOUND', '附件不存在');
      if (view.handling !== 'preview' || view.previewKind === 'none') {
        return fail('NOT_PREVIEWABLE', '此类型不在应用内预览，请使用系统默认程序打开。');
      }

      const payload = buildAttachmentPayload(
        {
          id: view.id,
          filename: view.filename,
          mimeType: view.mimeType,
          previewKind: view.previewKind,
        },
        read.buffer,
      );
      if ('error' in payload) return fail('PREVIEW_FAILED', payload.error);
      return ok(payload);
    },
  );

  ipcMain.handle(
    IPC.attachmentsOpen,
    async (event, attachmentId: string): Promise<Result<{ opened: boolean; reason?: string }>> => {
      assertTrusted(event, IPC.attachmentsOpen);
      const services = getServices();
      const read = services.attachments.read(attachmentId ?? '');
      if (!read) return fail('NOT_FOUND', '附件内容不可用，请重新打开邮件');

      const view = services.attachments
        .list(read.row.email_id)
        .find((item) => item.id === attachmentId);
      if (!view) return fail('NOT_FOUND', '附件不存在');

      // 禁止打开：只告知，不给打开入口
      if (view.handling === 'blocked') {
        // 扫描判恶意和用户配置禁止的提示要分开：前者是证据，后者是策略
        const notice =
          view.blockedBy === 'scan'
            ? buildScanBlockedNotice(view.filename, view.risk)
            : buildBlockedNotice(view.filename, view.ext);
        const parent = getMainWindow();
        if (parent) await dialog.showMessageBox(parent, notice);
        else await dialog.showMessageBox(notice);
        return ok({ opened: false, reason: '已禁止打开' });
      }

      // 提示型：中性确认，默认取消（§11.4）；有扫描结论就把依据一并写进说明
      if (view.handling === 'confirm') {
        const options = buildOpenConfirm(
          view.filename,
          view.ext,
          view.risk.scanSource || view.risk.scanDetail ? view.risk : undefined,
        );
        const parent = getMainWindow();
        const result = parent
          ? await dialog.showMessageBox(parent, options)
          : await dialog.showMessageBox(options);
        if (result.response !== 1) {
          return ok({ opened: false, reason: '用户取消' });
        }
      }

      const staged = await stageForExternalOpen(read.row.local_path as string, view.filename);
      if (!staged.ok) return fail('STAGE_FAILED', staged.reason);
      const error = await openStagedFile(staged.path);
      if (error) return fail('OPEN_FAILED', error);
      return ok({ opened: true });
    },
  );

  ipcMain.handle(
    IPC.attachmentsSave,
    async (event, attachmentId: string): Promise<Result<{ saved: boolean; path?: string }>> => {
      assertTrusted(event, IPC.attachmentsSave);
      const services = getServices();
      const read = services.attachments.read(attachmentId ?? '');
      if (!read) return fail('NOT_FOUND', '附件内容不可用，请重新打开邮件');

      const view = services.attachments
        .list(read.row.email_id)
        .find((item) => item.id === attachmentId);
      if (!view) return fail('NOT_FOUND', '附件不存在');

      const parent = getMainWindow();
      const options = { title: '保存附件', defaultPath: view.filename };
      const picked = parent
        ? await dialog.showSaveDialog(parent, options)
        : await dialog.showSaveDialog(options);
      if (picked.canceled || !picked.filePath) return ok({ saved: false });

      const result = await saveTo(read.row.local_path as string, picked.filePath);
      if (!result.ok) return fail('SAVE_FAILED', result.reason ?? '保存失败');
      return ok({ saved: true, path: picked.filePath });
    },
  );

  // ---- 正文右键菜单：图片复制 / 另存为、文本复制 ----
  ipcMain.handle(
    IPC.readerImageCopy,
    async (event, request: ReaderImageRequest): Promise<Result<{ copied: boolean }>> => {
      assertTrusted(event, IPC.readerImageCopy);
      const src = typeof request?.src === 'string' ? request.src : '';
      try {
        await copyImageToClipboard(src);
        return ok({ copied: true });
      } catch (error) {
        log.warn('reader', '复制图片失败', { message: (error as Error).message });
        return fail('IMAGE_COPY_FAILED', (error as Error).message);
      }
    },
  );

  ipcMain.handle(
    IPC.readerImageSave,
    async (event, request: ReaderImageRequest): Promise<Result<ReaderImageSaveResult>> => {
      assertTrusted(event, IPC.readerImageSave);
      const src = typeof request?.src === 'string' ? request.src : '';
      const alt = typeof request?.alt === 'string' ? request.alt : '';
      try {
        return ok(await saveImageToFile(src, alt, getMainWindow()));
      } catch (error) {
        log.warn('reader', '图片另存为失败', { message: (error as Error).message });
        return fail('IMAGE_SAVE_FAILED', (error as Error).message);
      }
    },
  );

  ipcMain.handle(IPC.readerCopyText, async (event, text: string): Promise<Result<boolean>> => {
    assertTrusted(event, IPC.readerCopyText);
    try {
      await writeClipboardText(typeof text === 'string' ? text : '');
      return ok(true);
    } catch (error) {
      return fail('COPY_FAILED', (error as Error).message);
    }
  });

  ipcMain.handle(IPC.attachmentsScan, (event, emailId: string): Result<{ queued: number }> => {    assertTrusted(event, IPC.attachmentsScan);
    const services = getServices();
    const id = emailId ?? '';
    if (!services.emails.get(id)) return fail('NOT_FOUND', '邮件不存在');
    const attachments = services.attachments
      .list(id)
      .filter((item) => item.sha256 && isScannableRisk(item.risk.level)).length;
    triggerEmailScan(id);
    return ok({ queued: attachments });
  });

  ipcMain.handle(
    IPC.attachmentsScanCancel,
    (event, emailId: string): Result<{ cancelled: boolean }> => {
      assertTrusted(event, IPC.attachmentsScanCancel);
      const services = getServices();
      return ok({ cancelled: services.scanner.cancel(emailId ?? '') });
    },
  );

  ipcMain.handle(IPC.attachmentsScanProviders, (event): Result<ScanProviderStatus[]> => {
    assertTrusted(event, IPC.attachmentsScanProviders);
    return ok(getServices().scanner.providerStatuses());
  });

  ipcMain.handle(IPC.attachmentsExtGet, (event): Result<AttachmentExtensionSettings> => {
    assertTrusted(event, IPC.attachmentsExtGet);
    return ok(getServices().attachments.settings());
  });

  ipcMain.handle(
    IPC.attachmentsExtSet,
    (event, settings: AttachmentExtensionSettings): Result<boolean> => {
      assertTrusted(event, IPC.attachmentsExtSet);
      const sanitize = (value: unknown): string[] =>
        Array.isArray(value)
          ? value
              .filter((item): item is string => typeof item === 'string')
              .map((item) => item.trim().toLowerCase())
              .filter((item) => /^\.?[a-z0-9]{1,12}$/.test(item))
              .map((item) => (item.startsWith('.') ? item : `.${item}`))
          : [];

      const payload = {
        customTextExts: sanitize(settings?.customTextExts),
        customDangerExts: sanitize(settings?.customDangerExts),
        // 完整列表：用户可以删掉默认项，所以这里原样保存（空数组也是有效值）
        ...(Array.isArray(settings?.warnExts) ? { warnExts: sanitize(settings.warnExts) } : {}),
        ...(Array.isArray(settings?.blockExts) ? { blockExts: sanitize(settings.blockExts) } : {}),
        ...(Array.isArray(settings?.dangerousExts)
          ? { dangerousExts: sanitize(settings.dangerousExts) }
          : {}),
      };
      getServices()
        .db.prepare(
          `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run('attachments.extensions', JSON.stringify(payload), Date.now());
      return ok(true);
    },
  );

  ipcMain.handle(IPC.signaturesList, (event, accountId: string): Result<SignatureView[]> => {
    assertTrusted(event, IPC.signaturesList);
    if (!accountId) return fail('BAD_REQUEST', '缺少 accountId');
    return ok(getServices().signatures.list(accountId));
  });

  ipcMain.handle(
    IPC.signaturesCreate,
    (event, payload: { accountId: string; name?: string }): Result<SignatureView> => {
      assertTrusted(event, IPC.signaturesCreate);
      const accountId = payload?.accountId ?? '';
      if (!accountId) return fail('BAD_REQUEST', '缺少 accountId');
      return ok(getServices().signatures.create(accountId, payload?.name));
    },
  );

  ipcMain.handle(
    IPC.signaturesRename,
    (event, payload: { id: string; name: string }): Result<boolean> => {
      assertTrusted(event, IPC.signaturesRename);
      const id = payload?.id ?? '';
      if (!id) return fail('BAD_REQUEST', '缺少 id');
      getServices().signatures.rename(id, payload?.name ?? '');
      return ok(true);
    },
  );

  ipcMain.handle(IPC.signaturesDelete, (event, id: string): Result<boolean> => {
    assertTrusted(event, IPC.signaturesDelete);
    if (!id) return fail('BAD_REQUEST', '缺少 id');
    getServices().signatures.remove(id);
    return ok(true);
  });

  ipcMain.handle(
    IPC.signaturesSave,
    (event, payload: { id: string; html: string }): Result<boolean> => {
      assertTrusted(event, IPC.signaturesSave);
      const id = payload?.id ?? '';
      if (!id) return fail('BAD_REQUEST', '缺少 id');
      getServices().signatures.saveHtml(id, payload?.html ?? '');
      return ok(true);
    },
  );

  ipcMain.handle(
    IPC.signaturesSetDefault,
    (
      event,
      payload: { accountId: string; kind: 'new' | 'reply'; signatureId: string | null },
    ): Result<boolean> => {
      assertTrusted(event, IPC.signaturesSetDefault);
      const accountId = payload?.accountId ?? '';
      if (!accountId) return fail('BAD_REQUEST', '缺少 accountId');
      if (payload?.kind !== 'new' && payload?.kind !== 'reply') {
        return fail('BAD_REQUEST', 'kind 必须是 new 或 reply');
      }
      getServices().signatures.setDefault(accountId, payload.kind, payload?.signatureId ?? null);
      return ok(true);
    },
  );
}

// ---------------- Phase 3：翻译 ----------------

function registerTranslationHandlers(): void {
  ipcMain.handle(IPC.translationGet, async (event): Promise<Result<TranslationSettingsView>> => {
    assertTrusted(event, IPC.translationGet);
    return ok(await getServices().translation.settings());
  });

  ipcMain.handle(
    IPC.translationSet,
    async (event, settings: Partial<TranslationSettingsView> & { apiKey?: string; region?: string }): Promise<Result<boolean>> => {
      assertTrusted(event, IPC.translationSet);
      try {
        await getServices().translation.update(settings ?? {});
        return ok(true);
      } catch (error) {
        return fail('SETTINGS_FAILED', (error as Error).message);
      }
    },
  );

  ipcMain.handle(
    IPC.translationTranslate,
    async (event, request: TranslationRequest): Promise<Result<TranslationOutcome>> => {
      assertTrusted(event, IPC.translationTranslate);
      const services = getServices();
      const emailId = request?.emailId ?? '';
      if (!services.emails.get(emailId)) return fail('NOT_FOUND', '邮件不存在');
      try {
        return ok(
          await services.translation.translateEmail(
            emailId,
            request?.targetLang,
            request?.confirmLong === true,
          ),
        );
      } catch (error) {
        return fail('TRANSLATE_FAILED', (error as Error).message);
      }
    },
  );
}

// ---------------- Phase 3：AI ----------------

function registerAiHandlers(): void {
  ipcMain.handle(IPC.aiGet, async (event): Promise<Result<AiSettingsView>> => {
    assertTrusted(event, IPC.aiGet);
    return ok(await getServices().ai.settings());
  });

  ipcMain.handle(
    IPC.aiSet,
    async (event, settings: Partial<AiSettingsView> & { apiKey?: string }): Promise<Result<boolean>> => {
      assertTrusted(event, IPC.aiSet);
      try {
        await getServices().ai.update(settings ?? {});
        return ok(true);
      } catch (error) {
        return fail('SETTINGS_FAILED', (error as Error).message);
      }
    },
  );

  ipcMain.handle(IPC.aiSummarize, async (event, emailId: string): Promise<Result<AiSummaryResult>> => {
    assertTrusted(event, IPC.aiSummarize);
    try {
      return ok(await getServices().ai.summarize(emailId ?? ''));
    } catch (error) {
      return fail('AI_FAILED', (error as Error).message);
    }
  });

  ipcMain.handle(
    IPC.aiSemanticSearch,
    async (event, payload: { query: string; limit?: number }): Promise<Result<SemanticSearchResult>> => {
      assertTrusted(event, IPC.aiSemanticSearch);
      try {
        return ok(
          await getServices().ai.semanticSearch(
            payload?.query ?? '',
            Math.min(100, Math.max(1, payload?.limit ?? 20)),
          ),
        );
      } catch (error) {
        return fail('AI_FAILED', (error as Error).message);
      }
    },
  );

  ipcMain.handle(IPC.aiPrepareCommand, async (event, input: string): Promise<Result<CommandPreparation>> => {
    assertTrusted(event, IPC.aiPrepareCommand);
    try {
      return ok(await getServices().ai.prepareCommand(input ?? ''));
    } catch (error) {
      return fail('AI_FAILED', (error as Error).message);
    }
  });

  ipcMain.handle(
    IPC.aiConfirmCommand,
    (event, request: CommandConfirmRequest): Result<{ id: string; sendAt: number }> => {
      assertTrusted(event, IPC.aiConfirmCommand);
      const services = getServices();
      const accountId = request?.accountId ?? services.envAccount?.id ?? '';
      if (!accountId) return fail('NO_ACCOUNT', '没有可用的账户');
      const account = services.accounts.get(accountId);
      if (!account) return fail('NOT_FOUND', '账户不存在');
      if (!account.smtp) return fail('NO_SMTP', '该账户未配置 SMTP，无法发送');

      // 渲染进程回传的指令必须重新校验，不能信任客户端
      const outcome = validateParsedCommand(request?.command, {
        now: Date.now(),
        rawInput: request?.command?.raw ?? '',
        requireSendAt: true,
      });
      if (!outcome.ok || !outcome.command) {
        return fail('INVALID_COMMAND', '指令未通过校验，请重新解析。');
      }

      const command: ParsedCommand = outcome.command;
      const recipients = command.recipients
        .map((item) => item.address?.trim())
        .filter((item): item is string => Boolean(item));
      if (recipients.length === 0) return fail('NO_RECIPIENT', '缺少收件人地址');
      if (typeof command.sendAt !== 'number') return fail('NO_TIME', '缺少发送时间');

      const result = services.scheduled.scheduleAt(accountId, {
        to: recipients,
        subject: deriveSubject(command),
        text: command.bodyInstruction.content,
      }, command.sendAt);
      return ok(result);
    },
  );
}

// ---------------- Phase 3：日历 ----------------

function registerCalendarHandlers(): void {
  ipcMain.handle(IPC.calendarList, (event): Result<CalendarAccountView[]> => {
    assertTrusted(event, IPC.calendarList);
    return ok(getServices().calendar.list());
  });

  ipcMain.handle(
    IPC.calendarAdd,
    async (event, input: CalendarAccountInput): Promise<Result<CalendarAccountView>> => {
      assertTrusted(event, IPC.calendarAdd);
      const url = input?.url?.trim() ?? '';
      if (!/^https?:\/\//i.test(url)) return fail('BAD_URL', '请填写 http(s) 地址');
      if (!input?.name?.trim()) return fail('BAD_REQUEST', '请填写名称');
      try {
        return ok(await getServices().calendar.add({ ...input, url }));
      } catch (error) {
        return fail('CALENDAR_ADD_FAILED', (error as Error).message);
      }
    },
  );

  ipcMain.handle(IPC.calendarRemove, async (event, id: string): Promise<Result<boolean>> => {
    assertTrusted(event, IPC.calendarRemove);
    return ok(await getServices().calendar.remove(id ?? ''));
  });

  ipcMain.handle(IPC.calendarSync, async (event, id?: string): Promise<Result<CalendarSyncResult[]>> => {
    assertTrusted(event, IPC.calendarSync);
    try {
      return ok(await getServices().calendar.sync(id));
    } catch (error) {
      return fail('CALENDAR_SYNC_FAILED', (error as Error).message);
    }
  });

  ipcMain.handle(
    IPC.calendarEvents,
    (event, range: { from: number; to: number }): Result<CalendarEventView[]> => {
      assertTrusted(event, IPC.calendarEvents);
      const from = Number(range?.from ?? 0);
      const to = Number(range?.to ?? 0);
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
        return fail('BAD_RANGE', '时间范围不合法');
      }
      return ok(getServices().calendar.events(from, to));
    },
  );

  const EVENT_KINDS: CalendarEventKind[] = ['event', 'meeting', 'anniversary', 'birthday'];

  /**
   * 重复规则归一化：只接受四种频率，间隔夹在 1–99。
   * 放在这里是因为它必须在 IPC 边界上就拦住脏值，service 不做二次防御。
   */
  const normalizeRecurrence = (
    value: CalendarEventInput['rrule'],
  ): CalendarRecurrence | undefined => {
    if (!value) return undefined;
    const freqs: CalendarRecurrence['freq'][] = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];
    if (!freqs.includes(value.freq)) return undefined;
    const interval = Number(value.interval ?? 1);
    return {
      freq: value.freq,
      interval: Number.isFinite(interval) ? Math.min(99, Math.max(1, Math.round(interval))) : 1,
    };
  };

  const EVENT_SCOPES: CalendarEventScope[] = [
    'this',
    'thisAndFuture',
    'all',
    'future',
    'past',
    'pastAndThis',
  ];
  const normalizeScope = (value?: string): CalendarEventScope | undefined =>
    value && EVENT_SCOPES.includes(value as CalendarEventScope)
      ? (value as CalendarEventScope)
      : undefined;

  ipcMain.handle(
    IPC.calendarCreateEvent,
    (event, input: CalendarEventInput): Result<CalendarEventView> => {
      assertTrusted(event, IPC.calendarCreateEvent);
      const summary = typeof input?.summary === 'string' ? input.summary.trim() : '';
      if (!summary) return fail('BAD_REQUEST', '请填写标题');

      const startsAt = Number(input?.startsAt ?? 0);
      if (!Number.isFinite(startsAt) || startsAt <= 0) {
        return fail('BAD_REQUEST', '开始时间不合法');
      }
      if (input?.endsAt !== undefined) {
        const endsAt = Number(input.endsAt);
        if (!Number.isFinite(endsAt) || endsAt < startsAt) {
          return fail('BAD_REQUEST', '结束时间不能早于开始时间');
        }
      }

      const kind = EVENT_KINDS.includes(input.kind) ? input.kind : 'event';
      const rrule = normalizeRecurrence(input.rrule);
      try {
        return ok(
          getServices().calendar.createEvent({
            kind,
            summary,
            startsAt,
            ...(input.endsAt !== undefined ? { endsAt: Number(input.endsAt) } : {}),
            allDay: input.allDay === true,
            ...(typeof input.location === 'string' && input.location
              ? { location: input.location.slice(0, 200) }
              : {}),
            ...(typeof input.description === 'string' && input.description
              ? { description: input.description.slice(0, 2000) }
              : {}),
            ...(rrule ? { rrule } : {}),
          }),
        );
      } catch (error) {
        return fail('CALENDAR_CREATE_FAILED', (error as Error).message);
      }
    },
  );

  ipcMain.handle(
    IPC.calendarUpdateEvent,
    (event, patch: CalendarEventPatch): Result<CalendarEventView> => {
      assertTrusted(event, IPC.calendarUpdateEvent);
      const id = typeof patch?.id === 'string' ? patch.id.trim() : '';
      if (!id) return fail('BAD_REQUEST', '缺少事件 id');

      const summary = typeof patch?.summary === 'string' ? patch.summary.trim() : '';
      if (!summary) return fail('BAD_REQUEST', '请填写标题');

      const startsAt = Number(patch?.startsAt ?? 0);
      if (!Number.isFinite(startsAt) || startsAt <= 0) {
        return fail('BAD_REQUEST', '开始时间不合法');
      }
      if (patch?.endsAt !== undefined) {
        const endsAt = Number(patch.endsAt);
        if (!Number.isFinite(endsAt) || endsAt < startsAt) {
          return fail('BAD_REQUEST', '结束时间不能早于开始时间');
        }
      }

      const kind = EVENT_KINDS.includes(patch.kind) ? patch.kind : 'event';
      const rrule = normalizeRecurrence(patch.rrule);
      const scope = normalizeScope(patch.scope);
      const occurrenceStart =
        typeof patch.occurrenceStart === 'number' && Number.isFinite(patch.occurrenceStart)
          ? patch.occurrenceStart
          : undefined;
      try {
        const updated = getServices().calendar.updateEvent({
          id,
          kind,
          summary,
          startsAt,
          ...(patch.endsAt !== undefined ? { endsAt: Number(patch.endsAt) } : {}),
          allDay: patch.allDay === true,
          ...(typeof patch.location === 'string' && patch.location
            ? { location: patch.location.slice(0, 200) }
            : {}),
          ...(typeof patch.description === 'string' && patch.description
            ? { description: patch.description.slice(0, 2000) }
            : {}),
          ...(rrule ? { rrule } : {}),
          ...(scope ? { scope } : {}),
          ...(occurrenceStart !== undefined ? { occurrenceStart } : {}),
        });
        if (!updated) {
          return fail('CALENDAR_EVENT_NOT_EDITABLE', '该事件来自日历订阅，不能在这里修改');
        }
        return ok(updated);
      } catch (error) {
        return fail('CALENDAR_UPDATE_FAILED', (error as Error).message);
      }
    },
  );

  ipcMain.handle(
    IPC.calendarDeleteEvent,
    (event, request: CalendarEventDeleteRequest): Result<boolean> => {
      assertTrusted(event, IPC.calendarDeleteEvent);
      const id = typeof request?.id === 'string' ? request.id.trim() : '';
      if (!id) return fail('BAD_REQUEST', '缺少事件 id');

      const scope = normalizeScope(request.scope);
      const occurrenceStart =
        typeof request.occurrenceStart === 'number' && Number.isFinite(request.occurrenceStart)
          ? request.occurrenceStart
          : undefined;

      try {
        const deleted = getServices().calendar.deleteEvent({
          id,
          ...(scope ? { scope } : {}),
          ...(occurrenceStart !== undefined ? { occurrenceStart } : {}),
        });
        if (!deleted) {
          return fail('CALENDAR_EVENT_NOT_EDITABLE', '该事件来自日历订阅，不能删除');
        }
        return ok(true);
      } catch (error) {
        return fail('CALENDAR_DELETE_FAILED', (error as Error).message);
      }
    },
  );
}

// ---------------- Phase 3：MBOX / 网络 / 主密码 / METADATA ----------------

function registerArchiveHandlers(): void {
  ipcMain.handle(IPC.mboxImport, async (event, request: { accountId: string; folderName?: string }): Promise<Result<MboxImportResult>> => {
    assertTrusted(event, IPC.mboxImport);
    const services = getServices();
    const accountId = request?.accountId ?? services.envAccount?.id ?? '';
    if (!services.accounts.get(accountId)) return fail('NO_ACCOUNT', '没有可用的账户');

    const parent = getMainWindow();
    const options = {
      title: '选择 MBOX 文件',
      properties: ['openFile' as const],
      filters: [{ name: 'MBOX', extensions: ['mbox', 'mbx', 'txt'] }],
    };
    const picked = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    if (picked.canceled || picked.filePaths.length === 0) {
      return fail('CANCELLED', '已取消导入');
    }

    try {
      return ok(
        await services.mbox.importFile(
          accountId,
          picked.filePaths[0]!,
          request?.folderName?.trim() || 'MBOX 导入',
        ),
      );
    } catch (error) {
      return fail('IMPORT_FAILED', (error as Error).message);
    }
  });

  ipcMain.handle(
    IPC.mboxExport,
    async (event, request: { accountId: string; folder: string }): Promise<Result<MboxExportResult>> => {
      assertTrusted(event, IPC.mboxExport);
      const services = getServices();
      const accountId = request?.accountId ?? '';
      const folder = request?.folder ?? '';
      if (!services.accounts.get(accountId)) return fail('NO_ACCOUNT', '账户不存在');
      if (!folder) return fail('BAD_REQUEST', '缺少文件夹');

      const parent = getMainWindow();
      const confirm = {
        type: 'warning' as const,
        buttons: ['取消', '继续导出'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        title: '导出为明文 MBOX',
        message: '导出的文件是明文邮件归档。',
        detail: '任何能访问该文件的人都可以读取其中的邮件内容。请选择安全的保存位置。',
      };
      const confirmed = parent
        ? await dialog.showMessageBox(parent, confirm)
        : await dialog.showMessageBox(confirm);
      if (confirmed.response !== 1) return fail('CANCELLED', '已取消导出');

      const saveOptions = {
        title: '导出 MBOX',
        defaultPath: `${folder.replace(/[\\/:*?"<>|]/g, '_')}.mbox`,
      };
      const picked = parent
        ? await dialog.showSaveDialog(parent, saveOptions)
        : await dialog.showSaveDialog(saveOptions);
      if (picked.canceled || !picked.filePath) return fail('CANCELLED', '已取消导出');

      try {
        return ok(await services.mbox.exportFolder(accountId, folder, picked.filePath));
      } catch (error) {
        return fail('EXPORT_FAILED', (error as Error).message);
      }
    },
  );

  ipcMain.handle(IPC.dohGet, (event): Result<DohStatus> => {
    assertTrusted(event, IPC.dohGet);
    return ok(dohStatus());
  });

  ipcMain.handle(IPC.dohSet, (event, enabled: boolean): Result<DohStatus> => {
    assertTrusted(event, IPC.dohSet);
    writeDohSetting(enabled === true);
    return ok(dohStatus());
  });

  ipcMain.handle(IPC.masterStatus, (event): Result<MasterPasswordStatus> => {
    assertTrusted(event, IPC.masterStatus);
    return ok({ enabled: masterPasswordEnabled() });
  });

  ipcMain.handle(
    IPC.masterSet,
    async (event, payload: { password: string | null; currentPassword?: string }): Promise<Result<MasterPasswordStatus>> => {
      assertTrusted(event, IPC.masterSet);
      try {
        if (payload?.password === null) {
          await disableMasterPassword(payload?.currentPassword ?? '');
        } else {
          await enableMasterPassword(String(payload?.password ?? ''));
        }
        return ok({ enabled: masterPasswordEnabled() });
      } catch (error) {
        return fail('MASTER_PASSWORD_FAILED', (error as Error).message);
      }
    },
  );

  ipcMain.handle(IPC.metadataStatus, (event): Result<MetadataStatus> => {
    assertTrusted(event, IPC.metadataStatus);
    return ok(getServices().metadata.status());
  });

  ipcMain.handle(
    IPC.metadataSync,
    async (event, request: { accountId: string; direction: 'pull' | 'push' }): Promise<Result<MetadataStatus>> => {
      assertTrusted(event, IPC.metadataSync);
      const services = getServices();
      const accountId = request?.accountId ?? services.envAccount?.id ?? '';
      if (!accountId) return fail('NO_ACCOUNT', '没有可用的账户');
      try {
        const status =
          request?.direction === 'push'
            ? await services.metadata.push(accountId)
            : await services.metadata.pull(accountId);
        return ok(status);
      } catch (error) {
        return fail('METADATA_FAILED', (error as Error).message);
      }
    },
  );
}

// ---------------- Phase 3：Snooze ----------------

function registerSnoozeHandler(): void {
  ipcMain.handle(
    IPC.mailSnooze,
    (event, payload: { emailId: string; until: number | null }): Result<boolean> => {
      assertTrusted(event, IPC.mailSnooze);
      const emailId = payload?.emailId ?? '';
      if (!emailId) return fail('BAD_REQUEST', '缺少 emailId');
      const until = payload?.until === null || payload?.until === undefined ? null : Number(payload.until);
      if (until !== null && !Number.isFinite(until)) return fail('BAD_REQUEST', '时间不合法');
      return ok(getServices().emails.setSnoozed(emailId, until));
    },
  );
}

// ---------------- 账户管理（§7.8） ----------------

function mailActionFailure(error: unknown): { ok: false; error: { code: string; message: string } } {
  if (error instanceof MailActionError) {
    return { ok: false, error: { code: error.code, message: error.message } };
  }
  log.error('mail', '邮件操作失败', { message: (error as Error).message });
  return { ok: false, error: { code: 'MAIL_ACTION_FAILED', message: (error as Error).message } };
}

function accountFailure(error: unknown): { ok: false; error: { code: string; message: string } } {  if (error instanceof AccountOperationError) {
    return { ok: false, error: { code: error.code, message: error.message } };
  }
  log.error('accounts', '账户操作失败', { message: (error as Error).message });
  return { ok: false, error: { code: 'ACCOUNT_FAILED', message: (error as Error).message } };
}

function registerAccountHandlers(): void {
  ipcMain.handle(IPC.accountsList, (event): Result<AccountView[]> => {
    assertTrusted(event, IPC.accountsList);
    return ok(getServices().accountService.listViews());
  });

  ipcMain.handle(
    IPC.accountsAdd,
    async (event, input: AccountInput): Promise<Result<AccountView>> => {
      assertTrusted(event, IPC.accountsAdd);
      try {
        return ok(await getServices().accountService.add(input ?? ({} as AccountInput)));
      } catch (error) {
        return accountFailure(error);
      }
    },
  );

  ipcMain.handle(
    IPC.accountsUpdate,
    async (
      event,
      payload: { id: string; input: AccountInput },
    ): Promise<Result<AccountView>> => {
      assertTrusted(event, IPC.accountsUpdate);
      const id = payload?.id ?? '';
      if (!id) return fail('BAD_REQUEST', '缺少账户 ID');
      try {
        return ok(await getServices().accountService.update(id, payload?.input ?? {}));
      } catch (error) {
        return accountFailure(error);
      }
    },
  );

  ipcMain.handle(
    IPC.accountsSetEnabled,
    async (
      event,
      payload: { id: string; enabled: boolean },
    ): Promise<Result<AccountView>> => {
      assertTrusted(event, IPC.accountsSetEnabled);
      const id = payload?.id ?? '';
      if (!id) return fail('BAD_REQUEST', '缺少账户 ID');
      try {
        return ok(await getServices().accountService.setEnabled(id, payload?.enabled === true));
      } catch (error) {
        return accountFailure(error);
      }
    },
  );

  ipcMain.handle(
    IPC.accountsReauth,
    async (
      event,
      payload: { id: string; password: string },
    ): Promise<Result<AccountView>> => {
      assertTrusted(event, IPC.accountsReauth);
      const id = payload?.id ?? '';
      if (!id) return fail('BAD_REQUEST', '缺少账户 ID');
      try {
        return ok(
          await getServices().accountService.reauthenticate(id, String(payload?.password ?? '')),
        );
      } catch (error) {
        return accountFailure(error);
      }
    },
  );

  ipcMain.handle(IPC.accountsPrioritize, (event, id: string): Result<boolean> => {
    assertTrusted(event, IPC.accountsPrioritize);
    const account = getServices().accounts.get(id ?? '');
    if (!account || !account.enabled) return ok(false);
    getServices().manager.prioritize(account);
    return ok(true);
  });

  // P2P 客户端身份（§24.1.1）：只暴露 clientId 与创建时间，不含任何密钥材料
  ipcMain.handle(IPC.p2pIdentity, (event): Result<P2pClientIdentity> => {
    assertTrusted(event, IPC.p2pIdentity);
    return ok(getServices().p2pIdentity);
  });

  ipcMain.handle(
    IPC.accountsRemove,
    async (event, id: string): Promise<Result<{ removed: boolean; emails?: number }>> => {
      assertTrusted(event, IPC.accountsRemove);
      const services = getServices();
      const account = services.accounts.get(id ?? '');
      if (!account) return fail('NOT_FOUND', '账户不存在');

      // 确认环节由渲染进程的应用内对话框承担（对齐主界面视觉），
      // 主进程不再弹原生 MessageBox 二次打断。
      try {
        const purge = await services.accountService.remove(account.id);
        return ok({ removed: true, emails: purge.deletedEmails });
      } catch (error) {
        return accountFailure(error);
      }
    },
  );
}
