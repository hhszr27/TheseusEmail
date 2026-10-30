import { app, BrowserWindow, dialog, Menu, session, shell, type MenuItemConstructorOptions } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { APP_NAME, APP_USER_MODEL_ID, IPC_EVENTS } from '../shared/constants';
import type { SyncStateView } from '../shared/ipc';
import { closeLogger, log } from './observability/logger';
import { captureCrash, initSentry } from './observability/sentry';
import { faultRecovery } from './observability/fault-state';
import { classifyProcessGone } from './observability/fault-recovery';
import { getAppFlags, loadAppFlags, setHardwareAcceleration } from './app/app-flags';
import { acquireSingleInstance, findMailtoArg, registerMailtoProtocol } from './app/single-instance';
import { initProxy } from './app/proxy';
import { createMainWindow, createRecoveryWindow } from './app/main-window';
import { focusMainWindow, getMainWindow, getRecoveryWindow, sendToRenderer } from './app/app-context';
import { parseMailtoUrl } from './app/mailto';
import { processStartedAt } from './app/startup-perf';
import { loadOrCreateDbKey, keyFilePath, masterPasswordEnabled } from './db/key-manager';
import { databasePath, openEncryptedDatabase, type Db } from './db/open';
import { runMigrations } from './db/migrate';
import { AccountsRepo } from './db/repositories/accounts-repo';
import { FoldersRepo } from './db/repositories/folders-repo';
import { EmailsRepo } from './db/repositories/emails-repo';
import { SecretStore } from './mail/auth/token-store';
import { AccountManager } from './mail/account-manager';
import { AccountService } from './accounts/service';
import { envAccountToAccount, readEnvAccount } from './mail/env-account';
import { setServices, tryGetServices } from './services';
import { readSingleInstanceMode } from './app/instance-mode';
import { registerIpcHandlers } from './ipc';
import { validateExternalUrl } from './security/url-policy';
import { PluginService } from './plugins/service';
import { CapabilityManager } from './plugins/capabilities';
import { PluginsRepo } from './db/repositories/plugins-repo';
import { PLUGIN_SCHEME, ensurePluginProtocolForPartition, registerPluginProtocol, registerPluginScheme } from './plugins/protocol';
import { recordMetric } from './observability/metrics';
import { SearchService } from './search/service';
import { ContactsRepo } from './db/repositories/contacts-repo';
import { MailActionsService } from './mail/actions';
import { ComposeAttachmentStore } from './mail/compose-attachments';
import { DraftsRepo } from './db/repositories/drafts-repo';
import { P2pRepo } from './db/repositories/p2p-repo';
import { loadOrCreateClientIdentity } from './p2p/client-id';
import { RulesRepo } from './rules/repo';
import { ScheduledSendService } from './mail/scheduled-service';
import { SmtpSender } from './mail/smtp-sender';
import { AttachmentStore } from './attachments/store';
import { SignatureStore } from './signatures/store';
import { ScanService } from './attachments/scan';
import { VirusTotalProvider, type ScanProvider } from './security/virustotal';
import { DefenderProvider } from './security/defender';
import { ATTACHMENT_TTL_MS } from '../shared/attachments';
import { cleanupStaleTempFiles } from './attachments/open';
import { TranslationService } from './translation/service';
import { AiService } from './ai/service';
import { CalendarService } from './calendar/service';
import { MboxService } from './mbox/service';
import { MetadataService } from './mail/metadata-service';
import { applyDohSetting, readDohSetting } from './app/doh';
import { promptMasterPassword } from './app/unlock';
import { TrayService } from './app/tray';
import { setTrayService } from './services';
import { NotificationService } from './notifications/service';
import { ReminderService } from './notifications/reminders';
import { handleNewEmails } from './notifications/pipeline';
import {
  readNotificationSettings,
} from './notifications/settings';

app.setName(APP_NAME);
if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

// 插件资源协议必须在 ready 之前注册为特权 scheme
registerPluginScheme();

// DoH 只能在 ready 之前通过命令行开关生效；设置变更后需重启
if (readDohSetting()) {
  applyDohSetting(true);
}

// GPU 连续崩溃后需要禁用的标志必须早于 ready 生效
const flags = loadAppFlags();
if (!flags.hardwareAcceleration) {
  app.disableHardwareAcceleration();
  // 双保险：某些驱动下仅 disableHardwareAcceleration 仍会拉起 GPU 进程
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
}

let gpuRecoveryScheduled = false;
let webviewCount = 0;
/**
 * 主窗口尚未创建时（例如主密码解锁窗口关闭的瞬间），
 * 不能因为 window-all-closed 而退出，否则启动流程会被拦腰打断。
 */
let mainWindowCreated = false;

const PLUGIN_PRELOAD_PATH = path.join(__dirname, '../preload/plugin-view.js');

function loadEnvFile(): void {
  const candidates = [path.join(app.getAppPath(), '.env'), path.join(process.cwd(), '.env')];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    dotenv.config({ path: candidate });
    log.info('bootstrap', '已加载 .env', { file: candidate });
    return;
  }
}

function isInternalUrl(url: string): boolean {
  if (!url) return true;
  if (url === 'about:blank' || url === 'about:srcdoc') return true;
  if (url.startsWith('file://') || url.startsWith('devtools://')) return true;
  if (!app.isPackaged) {
    const devBase = process.env.ELECTRON_RENDERER_URL;
    if (devBase && url.startsWith(devBase)) return true;
    if (/^http:\/\/(localhost|127\.0\.0\.1):\d+\//.test(url)) return true;
  }
  return false;
}

function openExternalSafely(url: string): void {
  const validation = validateExternalUrl(url);
  if (!validation.ok) {
    log.warn('security', '拒绝外部导航', { code: validation.code, message: validation.message });
    return;
  }
  void shell.openExternal(validation.url.toString());
}

function installSessionHardening(): void {
  const defaultSession = session.defaultSession;
  defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  defaultSession.setPermissionCheckHandler(() => false);
  defaultSession.setSpellCheckerEnabled(false);

  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      log.warn('security', '拒绝打开新窗口', { url: url.slice(0, 200) });
      openExternalSafely(url);
      return { action: 'deny' };
    });

    // 插件 webview 白名单校验（§13.7）：只允许 mailforge-plugin://<ready-plugin>/
    contents.on('will-attach-webview', (event, webPreferences, params) => {
      const src = (params as { src?: string }).src ?? '';
      const match = /^mailforge-plugin:\/\/([a-z0-9][a-z0-9-]*)\//i.exec(src);
      const services = tryGetServices();
      const pluginId = match?.[1] ?? '';

      if (!services || !pluginId || !services.plugins.isReady(pluginId)) {
        event.preventDefault();
        log.warn('security', '拒绝附加 webview（未通过插件白名单）', { src: src.slice(0, 200) });
        return;
      }

      const partition = (params as { partition?: string }).partition;
      if (partition && partition !== `persist:plugin-${pluginId}`) {
        event.preventDefault();
        log.warn('security', '拒绝 webview 分区不匹配', { pluginId, partition });
        return;
      }

      if ((params as { allowpopups?: string }).allowpopups) {
        event.preventDefault();
        log.warn('security', '拒绝 allowpopups 的插件 webview', { pluginId });
        return;
      }

      // 强制覆盖渲染进程可控制的 webPreferences，防止提权
      webPreferences.nodeIntegration = false;
      webPreferences.nodeIntegrationInSubFrames = false;
      webPreferences.contextIsolation = true;
      webPreferences.sandbox = true;
      webPreferences.webviewTag = false;
      webPreferences.preload = PLUGIN_PRELOAD_PATH;
      delete (webPreferences as { preloadURL?: string }).preloadURL;

      // 独立 partition 的 Session 需要单独注册插件协议
      ensurePluginProtocolForPartition(
        `persist:plugin-${pluginId}`,
        (id) => services.plugins.pluginDirForProtocol(id),
      );
    });

    if (contents.getType() === 'webview') {
      webviewCount += 1;
      recordMetric('webview_count', { count: webviewCount });

      contents.on('did-start-navigation', () => {
        tryGetServices()?.capabilities.invalidate(contents.id);
      });
      contents.on('destroyed', () => {
        tryGetServices()?.capabilities.invalidate(contents.id);
        webviewCount = Math.max(0, webviewCount - 1);
        recordMetric('webview_count', { count: webviewCount });
      });
    }

    contents.on('will-navigate', (event, url) => {
      // 插件 webview 内部同源导航交给 CSP 与协议处理器约束
      if (contents.getType() === 'webview' && url.startsWith(`${PLUGIN_SCHEME}://`)) {
        return;
      }
      if (isInternalUrl(url)) return;
      event.preventDefault();
      log.warn('security', '阻止应用内导航', { url: url.slice(0, 200) });
      openExternalSafely(url);
    });

    contents.on('will-frame-navigate', (event) => {
      const url = (event as unknown as { url?: string }).url ?? '';
      if (!url || isInternalUrl(url)) return;
      if (url.startsWith(`${PLUGIN_SCHEME}://`)) return;
      event.preventDefault();
      log.warn('security', '阻止 iframe 导航', { url: url.slice(0, 200) });
      openExternalSafely(url);
    });
  });
}

function buildApplicationMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const, label: APP_NAME }] : []),
    {
      label: '文件',
      submenu: [
        {
          label: '刷新邮件',
          accelerator: 'CmdOrCtrl+R',
          click: () => {
            const services = tryGetServices();
            if (!services) return;
            for (const account of services.accounts.list()) {
              void services.manager.refreshAccount(account).catch((error: Error) => {
                log.warn('menu', '刷新邮件失败', { message: error.message });
              });
            }
          },
        },
        { type: 'separator' },
        isMac
          ? { role: 'close', label: '关闭窗口' }
          : {
              label: '退出',
              click: () => {
                // 必须经托盘置退出标志：否则「关闭到托盘」会拦截窗口 close，应用退不出去
                const tray = tryGetServices()?.tray;
                if (tray) tray.beginQuit();
                else app.quit();
              },
            },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载界面' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: `关于 ${APP_NAME}`,
          click: () => {
            void dialog.showMessageBox({
              type: 'info',
              title: `关于 ${APP_NAME}`,
              message: `${APP_NAME} ${app.getVersion()}`,
              detail: `Electron ${process.versions.electron ?? ''}\nChromium ${process.versions.chrome ?? ''}\nNode ${process.versions.node ?? ''}`,
              buttons: ['好'],
            });
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

interface StallState {
  dialogOpen: boolean;
  acknowledged: boolean;
  timer: NodeJS.Timeout | null;
}

const stallStates = new Map<number, StallState>();

async function captureJsStack(window: BrowserWindow): Promise<string> {
  const contents = window.webContents;
  if (contents.debugger.isAttached()) return '[debugger 已附加，跳过]';

  const task = (async (): Promise<string> => {
    try {
      contents.debugger.attach('1.3');
      const result = (await contents.debugger.sendCommand('Runtime.evaluate', {
        expression: 'new Error("mailforge-stall").stack',
        returnByValue: true,
      })) as { result?: { value?: string } };
      try {
        contents.debugger.detach();
      } catch {
        // ignore
      }
      return (result.result?.value ?? '[无调用栈]').slice(0, 64_000);
    } catch (error) {
      try {
        contents.debugger.detach();
      } catch {
        // ignore
      }
      return `[无法获取调用栈] ${(error as Error).message}`;
    }
  })();

  const timeout = new Promise<string>((resolve) => {
    setTimeout(() => resolve('[获取调用栈超时]'), 5000);
  });

  return Promise.race([task, timeout]);
}

function handleUnresponsive(window: BrowserWindow): void {
  const id = window.id;
  const existing = stallStates.get(id);
  if (existing?.acknowledged) return;

  const diagnostics = {
    visible: window.isVisible(),
    minimized: window.isMinimized(),
    pid: window.webContents.getOSProcessId(),
    version: app.getVersion(),
    metrics: app.getAppMetrics().map((metric) => ({
      pid: metric.pid,
      type: metric.type,
      cpu: metric.cpu.percentCPUUsage,
      memory: metric.memory.workingSetSize,
    })),
  };

  log.error('fault', '窗口无响应（stall）', diagnostics);

  const state: StallState = existing ?? { dialogOpen: false, acknowledged: false, timer: null };
  stallStates.set(id, state);

  void captureJsStack(window).then((stack) => {
    log.error('fault', 'stall 调用栈', { stack });
  });

  if (state.dialogOpen) return;
  if (state.timer) return; // 已在 10 秒观察窗口内

  state.timer = setTimeout(() => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      if (state.acknowledged || state.dialogOpen) return;
      state.dialogOpen = true;
      void dialog
        .showMessageBox(window, {
          type: 'warning',
          title: '窗口暂时无响应',
          message: '界面已持续 10 秒未响应。',
          detail: '你可以继续等待，或重新加载界面。诊断信息已写入日志。',
          buttons: ['等待', '重新加载界面'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        })
        .then((result) => {
          state.dialogOpen = false;
          if (result.response === 1) {
            window.webContents.reload();
          } else {
            state.acknowledged = true;
          }
        });
    }
  }, 10_000);
}

function wireFaultHandling(window: BrowserWindow): void {
  const contents = window.webContents;

  contents.on('render-process-gone', (_event, details) => {
    if (!classifyProcessGone(details)) return;

    faultRecovery.recordCrash(details, 'main-window');
    log.error('fault', '渲染进程崩溃', details);
    captureCrash('render-process-gone', { ...details });

    window.hide();
    if (!getRecoveryWindow()) {
      createRecoveryWindow();
    } else {
      getRecoveryWindow()?.focus();
    }
  });

  contents.on('unresponsive', () => handleUnresponsive(window));

  contents.on('responsive', () => {
    const state = stallStates.get(window.id);
    if (state?.timer) clearTimeout(state.timer);
    stallStates.delete(window.id);
    log.info('fault', '窗口恢复响应');
  });

  window.on('closed', () => {
    const state = stallStates.get(window.id);
    if (state?.timer) clearTimeout(state.timer);
    stallStates.delete(window.id);
  });
}

function forwardMailto(raw: string): void {
  const parsed = parseMailtoUrl(raw);
  if (!parsed) {
    log.warn('mailto', '无法解析 mailto 链接', { raw: raw.slice(0, 200) });
    return;
  }

  focusMainWindow();
  const window = getMainWindow();
  if (!window) {
    log.warn('mailto', '主窗口不存在，mailto 未送达');
    return;
  }

  if (window.webContents.isLoading()) {
    window.webContents.once('did-finish-load', () => {
      sendToRenderer(IPC_EVENTS.mailto, parsed);
    });
  } else {
    sendToRenderer(IPC_EVENTS.mailto, parsed);
  }
}

function dbStatePath(): string {
  return path.join(app.getPath('userData'), 'db-state.json');
}

function readDbInitialized(): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(dbStatePath(), 'utf8')) as { initialized?: boolean };
    return parsed.initialized === true;
  } catch {
    return false;
  }
}

function writeDbInitialized(initialized: boolean): void {
  try {
    fs.mkdirSync(path.dirname(dbStatePath()), { recursive: true });
    fs.writeFileSync(dbStatePath(), JSON.stringify({ initialized }, null, 2), 'utf8');
  } catch {
    // 标记写失败不影响主流程
  }
}

/**
 * 密钥无法解密时的恢复策略：
 *  - 本地库尚未写入任何用户数据 → 重建密钥与空库（首次启动后崩溃的窗口期）
 *  - 已有数据 → 直接报错，绝不静默删除
 */
async function loadKeyWithRecovery(
  masterPassword?: string,
): Promise<Awaited<ReturnType<typeof loadOrCreateDbKey>>> {
  try {
    return await loadOrCreateDbKey(masterPassword ? { masterPassword } : {});
  } catch (error) {
    // 主密码启用时绝不重建密钥或数据库：密码错误必须由用户重试
    if (masterPasswordEnabled()) {
      throw error;
    }

    const dbPath = databasePath();
    const initialized = readDbInitialized();

    if (!fs.existsSync(dbPath) || !initialized) {
      log.warn('db', '数据库密钥不可解密且本地库未初始化，重建空库', {
        message: (error as Error).message,
      });
      for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, keyFilePath(), dbStatePath()]) {
        try {
          fs.unlinkSync(file);
        } catch {
          // 文件可能不存在
        }
      }
      return await loadOrCreateDbKey();
    }

    throw new Error('本地数据库密钥无法解密，且库中已有数据。为避免误删，应用已停止启动。');
  }
}

async function loadPluginPublicKeys(): Promise<Record<string, string>> {
  const candidates = [
    path.join(app.getPath('userData'), 'plugins', 'public-keys.json'),
    path.join(app.getAppPath(), 'plugins', 'public-keys.json'),
  ];
  for (const file of candidates) {
    try {
      const raw = await fs.promises.readFile(file, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object') return parsed as Record<string, string>;
    } catch {
      // 文件不存在或格式错误
    }
  }
  return {};
}

async function initDatabase(masterPassword?: string): Promise<void> {
  const dbKey = await loadKeyWithRecovery(masterPassword);
  const opened = openEncryptedDatabase(dbKey.hex);

  const migration = await runMigrations(opened.db, {
    keyHex: dbKey.hex,
    dbPath: opened.path,
  });

  const accounts = new AccountsRepo(opened.db);
  const folders = new FoldersRepo(opened.db);
  const emails = new EmailsRepo(opened.db);
  const secrets = new SecretStore();

  const envInput = readEnvAccount();
  let envAccount = null as ReturnType<typeof envAccountToAccount> | null;
  if (envInput) {
    envAccount = envAccountToAccount(envInput);
    accounts.ensure(envAccount);
    const secretRef = envAccount.auth.type === 'password' ? envAccount.auth.secretRef : '';
    if (secretRef && !(await secrets.has(secretRef))) {
      await secrets.set(secretRef, envInput.pass);
      log.info('bootstrap', '已保存 .env 账户凭证到 safeStorage');
    }
  }

  // 记录"本地库是否已有用户数据"：仅用于密钥损坏时的安全恢复判断
  writeDbInitialized(accounts.list().length > 0 || emails.counts().emails > 0);

  // 先在别处无依赖地构造：AccountManager 预取正文时就要用它把附件落库
  const attachments = new AttachmentStore(
    opened.db,
    path.join(app.getPath('userData'), 'attachments'),
  );

  const signatures = new SignatureStore(opened.db);

  const manager = new AccountManager({
    db: opened.db,
    accounts,
    folders,
    emails,
    secrets,
    attachments,
    emitSyncState: (state: SyncStateView) => {
      sendToRenderer(IPC_EVENTS.syncState, state);
      if (!state.syncing) {
        try {
          tryGetServices()?.search.reconcile();
        } catch {
          // 索引维护失败不影响同步结果
        }
      }
    },
    onNewEmails: (account, folder, newEmails, options) => {
      // 依赖解析延迟到邮件到达时：AccountManager 先于部分服务构造，
      // 而同步只可能在 bootstrap 完成（setServices）之后启动。
      const services = tryGetServices();
      if (!services) return;
      handleNewEmails(
        {
          db: services.db,
          rules: services.rules,
          contacts: services.contacts,
          notifications: services.notifications,
          isNotified: (emailId) => services.emails.isNotified(emailId),
          markNotified: (emailId, at) => services.emails.markNotified(emailId, at),
        },
        account,
        folder,
        newEmails,
        options,
      );
    },
  });

  const mailActions = new MailActionsService({ emails, accounts, folders, manager });

  const search = new SearchService(opened.db, emails);
  const contacts = new ContactsRepo(opened.db);
  const p2p = new P2pRepo(opened.db);
  // P2P 客户端身份（§24.1.1）：与 db-key.json 同一配置文件，首次启动生成
  const p2pIdentity = loadOrCreateClientIdentity(keyFilePath());
  const rules = new RulesRepo(opened.db);
  const drafts = new DraftsRepo(opened.db);
  const composeAttachments = new ComposeAttachmentStore(
    path.join(app.getPath('userData'), 'compose-attachments'),
  );
  // 桌面通知（§22）与日程提醒（§16）：提醒的出口走通知服务
  const notifications = new NotificationService();
  const reminders = new ReminderService(opened.db, (title, body) =>
    notifications.notifyReminder(title, body),
  );
  const scheduled = new ScheduledSendService(
    opened.db,
    accounts,
    new SmtpSender(secrets),
    (message, outcome) => {
      composeAttachments.releasePaths((message.attachments ?? []).map((item) => item.path));
      // 发送结果通知（§22）：取消是用户主动行为，不打扰
      if (!readNotificationSettings(opened.db).sendResult) return;
      const subject = message.subject || '（无主题）';
      if (outcome.status === 'sent') {
        notifications.notifySendResult('邮件已发送', subject);
      } else if (outcome.status === 'failed') {
        notifications.notifySendResult('定时发送失败', `${subject}：${outcome.error ?? '未知错误'}`);
      }
    },
  );

  attachments.cleanupOlderThan(ATTACHMENT_TTL_MS);
  await cleanupStaleTempFiles(ATTACHMENT_TTL_MS);

  const envVirusTotal = process.env.VIRUSTOTAL_API_KEY?.trim();
  if (envVirusTotal && !(await secrets.has('virustotal-api-key'))) {
    await secrets.set('virustotal-api-key', envVirusTotal);
  }
  const virustotalKey = await secrets.get('virustotal-api-key');

  // 扫描源：Defender 始终挂上（即使不可用），设置页才能显示"为什么没扫"
  const scanProviders: ScanProvider[] = [new DefenderProvider()];
  if (virustotalKey) scanProviders.push(new VirusTotalProvider({ apiKey: virustotalKey }));

  const scanner = new ScanService(
    opened.db,
    scanProviders,
    (update) => {
      if (update.attachmentId) {
        tryGetServices()?.attachments.recordScan(update.attachmentId, update.result);
      }
      sendToRenderer(IPC_EVENTS.scanResult, update);
    },
    undefined,
    () => attachments.scanPolicy(),
    (progress) => sendToRenderer(IPC_EVENTS.scanProgress, progress),
  );

  const translation = new TranslationService(opened.db, secrets, emails);
  const ai = new AiService(opened.db, secrets, emails, contacts);
  const calendar = new CalendarService(opened.db, secrets, () =>
    sendToRenderer(IPC_EVENTS.calendarChanged, null),
  );
  const metadata = new MetadataService(opened.db, accounts, secrets);
  const mbox = new MboxService({
    db: opened.db,
    accounts,
    folders,
    emails,
    indexEmail: (emailId) => ai.indexEmail(emailId),
    attachments: {
      save: (emailId, items) => attachments.save(emailId, items),
    },
  });

  const accountService = new AccountService({
    db: opened.db,
    accounts,
    emails,
    secrets,
    manager,
    attachmentsRoot: path.join(app.getPath('userData'), 'attachments'),
    clearPartition: async (accountId: string) => {
      const partition = `persist:account-${accountId}`;
      await session.fromPartition(partition).clearStorageData();
    },
    onChanged: () => sendToRenderer(IPC_EVENTS.accountsChanged, null),
  });

  const pluginsRepo = new PluginsRepo(opened.db);
  const capabilities = new CapabilityManager();
  for (const revoked of pluginsRepo.loadRevoked()) {
    capabilities.setRevoked(revoked.pluginId, revoked.permission, true);
  }

  const plugins = new PluginService({
    userDataDir: app.getPath('userData'),
    appPath: app.getAppPath(),
    isDev: !app.isPackaged,
    publicKeys: await loadPluginPublicKeys(),
    disabledIds: pluginsRepo.disabledIds(),
    onChange: () => sendToRenderer(IPC_EVENTS.pluginsChanged, null),
  });

  try {
    await plugins.init();
    for (const plugin of plugins.snapshot().plugins) {
      pluginsRepo.ensure(plugin.id, plugin.signature, plugin.defaultEnabled);
    }
    // 账户级启用覆盖（§7.8.4）：启动时载入内存，供视图/菜单门控使用
    plugins.setAccountOverrides(pluginsRepo.loadAccountOverrides());
  } catch (error) {
    // 插件系统故障不能阻断启动（§13.2）
    log.error('plugin', '插件系统初始化失败，已跳过插件加载', {
      message: (error as Error).message,
    });
  }

  setServices({
    db: opened.db,
    accounts,
    accountService,
    folders,
    emails,
    secrets,
    manager,
    plugins,
    capabilities,
    pluginsRepo,
    search,
    contacts,
    mailActions,
    composeAttachments,
    drafts,
    p2p,
    p2pIdentity,
    rules,
    scheduled,
    attachments,
    scanner,
    signatures,
    translation,
    ai,
    calendar,
    mbox,
    metadata,
    // 托盘在 bootstrap 创建主窗口后注入（需要 app ready 与窗口引用）
    tray: null,
    notifications,
    reminders,
    dbPath: opened.path,
    dbEncrypted: true,
    keyProtection: dbKey.protection,
    proxy: { enabled: false, source: 'none', bypassPrivate: true },
    envAccount,
  });

  // 清掉没有被待发送任务引用的附件暂存文件
  try {
    const referenced = scheduled.attachmentPathsInUse();
    for (const item of composeAttachments.resolve(drafts.attachmentIds())) referenced.add(item.path);
    const removed = composeAttachments.cleanupUnreferenced(referenced);
    if (removed > 0) log.info('mail', '已清理孤儿附件暂存文件', { removed });
  } catch {
    // 清理失败不影响启动
  }

  search.startMaintenance();
  scheduled.start();
  ai.embeddings.ensureIndexed(500);

  log.info('db', '加密数据库已打开', {
    path: opened.path,
    migrations: migration.applied,
    backup: migration.backupPath ?? null,
    keyProtection: dbKey.protection,
    counts: emails.counts(),
  });
}

function startAccounts(): void {
  const services = tryGetServices();
  if (!services) return;

  const accounts = services.accounts.list();
  try {
    const pending = services.db
      .prepare("SELECT COUNT(*) AS c FROM outbox WHERE status = 'pending'")
      .get() as { c: number };
    recordMetric('sync_queue', { pending: pending.c, accounts: accounts.length });
  } catch {
    // 指标失败不影响同步
  }

  void services.accountService
    .retryPendingDeletes()
    .catch((error: Error) => {
      log.error('bootstrap', '重试未完成删除失败', { message: error.message });
    })
    .finally(() => {
      // §7.8.3：并发上限 3，最久未同步优先
      services.manager.startAll(services.accounts.list());
    });
}

/**
 * 后台拉取收件箱。
 *
 * 目前没有做 IMAP IDLE 长连接推送（worker 会为了同步别的文件夹频繁切换 mailbox，
 * IDLE 会被打断，状态机容易出问题），而是定时增量同步 INBOX：
 * 到点自己拉一次，有新邮件就走既有的「新邮件管道」（桌面通知 + 列表刷新）。
 * 间隔可用 MAILFORGE_INBOX_POLL_MS 覆盖，默认 60 秒。
 */
const INBOX_POLL_MS = (() => {
  const raw = Number(process.env.MAILFORGE_INBOX_POLL_MS ?? '');
  return Number.isFinite(raw) && raw >= 10_000 ? raw : 60_000;
})();

function startInboxPolling(): void {
  const timer = setInterval(() => {
    const services = tryGetServices();
    if (!services) return;
    for (const account of services.accounts.list()) {
      if (!account.enabled || account.authState !== 'ok' || account.settings.demoMode === true) continue;
      // 没有 worker 说明还没连上（或已断开），等下一轮，别在这里硬连接
      if (!services.manager.hasWorker(account.id)) continue;
      void services.manager.syncFolder(account, 'INBOX', { quiet: true }).catch((error: Error) => {
        log.warn('sync', '后台拉取收件箱失败', {
          accountId: account.id,
          message: error.message,
        });
      });
    }
  }, INBOX_POLL_MS);
  timer.unref?.();
}

async function bootstrap(): Promise<void> {
  loadEnvFile();
  log.info('bootstrap', '主进程启动', {
    version: app.getVersion(),
    electron: process.versions.electron,
    packaged: app.isPackaged,
    processStartedAt: processStartedAt(),
  });

  try {
    app.setAccessibilitySupportEnabled(true);
  } catch (error) {
    log.warn('bootstrap', '启用无障碍支持失败', { message: (error as Error).message });
  }

  initSentry();

  const proxy = await initProxy();

  registerMailtoProtocol();
  installSessionHardening();

  let masterPassword: string | undefined;
  if (masterPasswordEnabled()) {
    const entered = await promptMasterPassword();
    if (!entered) {
      log.warn('security', '用户取消主密码解锁，应用退出');
      app.quit();
      return;
    }
    masterPassword = entered;
  }

  try {
    await initDatabase(masterPassword);
  } catch (error) {
    log.error('bootstrap', '数据库初始化失败', { message: (error as Error).message });
    dialog.showErrorBox(
      '无法启动 MailForge',
      `本地加密数据库初始化失败：\n${(error as Error).message}\n\n原数据库未被修改。请联系支持或查看日志目录。`,
    );
    process.exitCode = 1;
    app.quit();
    return;
  }

  const initialized = tryGetServices();
  if (initialized) {
    initialized.proxy = proxy;
  }

  // 插件资源协议：只服务已加载且启用的插件目录
  registerPluginProtocol((pluginId) => tryGetServices()?.plugins.pluginDirForProtocol(pluginId) ?? null);

  registerIpcHandlers();
  buildApplicationMenu();

  const window = createMainWindow();
  mainWindowCreated = true;
  wireFaultHandling(window);

  // 系统托盘（宿主能力）：图标、菜单、关闭到托盘、未读徽章
  const bootServices = tryGetServices();
  if (bootServices) {
    const tray = new TrayService(bootServices.db);
    setTrayService(tray);
    tray.create();
    tray.installWindowBehavior(window);

    const refreshTrayUnread = (): void => {
      try {
        tray.setUnread(bootServices.emails.totalUnreadInbox(Date.now()));
      } catch (error) {
        log.warn('tray', '读取未读数失败', { message: (error as Error).message });
      }
    };
    refreshTrayUnread();
    setInterval(refreshTrayUnread, 15_000).unref();

    // 日程提醒（§16 + §22）：启动时静默追平历史事件，之后每 30s 扫描
    bootServices.reminders.start();
  }

  window.webContents.on('did-finish-load', () => {
    log.info('bootstrap', '渲染进程加载完成');
  });

  app.on('child-process-gone', (_event, details) => {
    if (details.type !== 'GPU') return;
    const count = faultRecovery.recordGpuCrash();
    log.error('fault', 'GPU 进程崩溃', { count, reason: details.reason, exitCode: details.exitCode });

    if (count >= 3 && getAppFlags().hardwareAcceleration && !gpuRecoveryScheduled) {
      gpuRecoveryScheduled = true;
      setHardwareAcceleration(false);
      void dialog
        .showMessageBox({
          type: 'warning',
          title: '已禁用硬件加速',
          message: '图形进程在同一会话中连续崩溃 3 次，已禁用硬件加速。',
          detail: '应用将重新启动。你可以在设置中重新启用硬件加速。',
          buttons: ['重新启动'],
          noLink: true,
        })
        .then(() => {
          app.relaunch();
          // 走正常退出流程，确保 Chromium 偏好（含 safeStorage 的 OSCrypt 密钥）落盘
          app.quit();
        });
    }
  });

  const initialMailto = findMailtoArg(process.argv);
  if (initialMailto) {
    setTimeout(() => forwardMailto(initialMailto), 1200);
  }

  // 账户同步不阻塞启动（§2.2）
  setTimeout(startAccounts, 400);
  // 启动 20 秒后开始后台拉取收件箱（避开首轮全量同步的高峰）
  setTimeout(startInboxPolling, 20_000);

  setInterval(() => {
    const usage = process.memoryUsage();
    recordMetric('memory_sample', {
      rssMB: Math.round(usage.rss / 1048576),
      heapMB: Math.round(usage.heapUsed / 1048576),
      webviews: webviewCount,
    });
  }, 60_000).unref();
}

// 「程序运行唯一性」开关在设置里可关：关掉就不抢锁，允许同时跑多个实例。
// 必须在 app.ready 之前决定，所以读的是 userData 下的 instance-mode.json。
const singleInstanceMode = readSingleInstanceMode();
log.info('bootstrap', '单实例模式', { singleInstance: singleInstanceMode });

if (
  singleInstanceMode &&
  !acquireSingleInstance((argv) => {
    focusMainWindow();
    const mailto = findMailtoArg(argv);
    if (mailto) forwardMailto(mailto);
  })
) {
  app.quit();
} else {
  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (/^mailto:/i.test(url)) forwardMailto(url);
  });

  app.whenReady().then(bootstrap).catch((error: Error) => {
    log.error('bootstrap', '启动失败', { message: error.message, stack: error.stack });
    dialog.showErrorBox('无法启动 MailForge', error.message);
    process.exitCode = 1;
    app.quit();
  });
}

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    const window = createMainWindow();
    mainWindowCreated = true;
    wireFaultHandling(window);
    // 重建的窗口同样安装托盘行为：否则 macOS 激活图标重建窗口后，
    // 关闭窗口会直接退出应用，「关闭到托盘」语义对新窗口失效。
    tryGetServices()?.tray?.installWindowBehavior(window);
  }
});

app.on('window-all-closed', () => {
  if (!mainWindowCreated) return;
  if (process.platform !== 'darwin') app.quit();
});

let shuttingDown = false;
app.on('before-quit', (event) => {
  const services = tryGetServices();
  // 先置退出标志：before-quit 之后的窗口 close 序列必须放行，
  // 否则「关闭到托盘」会把退出也拦成隐藏（托盘菜单退出/macOS Cmd+Q 都走这里）
  services?.tray?.markQuitting();

  if (shuttingDown) return;
  if (!services) return;

  event.preventDefault();
  shuttingDown = true;
  void (async () => {
    try {
      // 先销毁托盘图标：异步清理（worker 关闭）可能持续数秒，
      // 用户点了「退出」后图标应当立即消失，而不是留到进程退出。
      services.tray?.destroy();
      services.reminders.stop();
      services.notifications.dispose();
      services.search.stop();
      services.scheduled.stop();
      services.translation.cancel();
      services.plugins.dispose();
      services.attachments.cleanupSession();
    } catch {
      // ignore
    }
    try {
      await services.manager.closeAll();
    } catch (error) {
      log.warn('bootstrap', '关闭账户 worker 失败', { message: (error as Error).message });
    }
    try {
      services.db.close();
    } catch {
      // ignore
    }
    closeLogger();
    // 关键：不能在 before-quit 里调用 app.exit()，那会跳过 Chromium 的
    // Local State / OSCrypt 密钥落盘，导致下次启动无法解密数据库密钥。
    app.quit();
  })();
});

process.on('uncaughtException', (error) => {
  log.error('process', 'uncaughtException', { message: error.message, stack: error.stack });
});
process.on('unhandledRejection', (reason) => {
  log.error('process', 'unhandledRejection', { reason: String(reason) });
});
