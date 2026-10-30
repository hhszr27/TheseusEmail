import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { setMainWindow, setRecoveryWindow, registerSecondaryWindow } from './app-context';
import { restoreWindowBounds, trackWindowState } from './window-state';

function isDev(): boolean {
  return !app.isPackaged && Boolean(process.env.ELECTRON_RENDERER_URL);
}

/**
 * §36 安全基线的唯一来源：窗口创建与诊断页共用同一份常量，避免配置漂移。
 * webviewTag 自 Phase 2 起开启，但所有 webview 都必须在
 * will-attach-webview 中通过插件白名单校验（§13.7），不允任意页面。
 */
const SECURITY_BASELINE = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webviewTag: true,
} as const;

export function getSecurityBaseline(): {
  sandbox: boolean;
  contextIsolation: boolean;
  nodeIntegration: boolean;
  webviewTag: boolean;
} {
  return {
    sandbox: SECURITY_BASELINE.sandbox,
    contextIsolation: SECURITY_BASELINE.contextIsolation,
    nodeIntegration: SECURITY_BASELINE.nodeIntegration,
    webviewTag: SECURITY_BASELINE.webviewTag,
  };
}

function loadRenderer(
  window: BrowserWindow,
  page: 'index' | 'recovery' | 'unlock' | 'reader',
  query?: Record<string, string>,
): void {
  if (isDev()) {
    const base = process.env.ELECTRON_RENDERER_URL as string;
    const url = page === 'index' ? base : `${base}/${page}.html`;
    const search = query ? `?${new URLSearchParams(query).toString()}` : '';
    void window.loadURL(`${url}${search}`);
  } else {
    void window.loadFile(path.join(__dirname, `../renderer/${page}.html`), query ? { query } : {});
  }
}

/**
 * 在独立窗口里打开某个文件夹（右键「在新窗口中打开」）。
 *
 * 与主窗口同一套安全基线；**不接管 getMainWindow**（对话框仍落在主窗口），
 * 也不参与窗口状态持久化——关掉它不影响主窗口，主窗口隐藏到托盘时它照常存在。
 */
export function createFolderWindow(accountId: string, folder: string): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0f1419',
    title: 'MailForge',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      ...SECURITY_BASELINE,
      spellcheck: false,
      devTools: !app.isPackaged,
      safeDialogs: true,
      enableWebSQL: false,
    },
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  // 让 syncState / accountsChanged 等状态事件也扇出到这个窗口，
  // 否则它加载完就再也不刷新，只能重开。
  registerSecondaryWindow(window);

  loadRenderer(window, 'index', { folder: `${accountId}|${folder}` });
  return window;
}

/**
 * 独立阅读窗口（双击邮件时打开）：真实 OS 窗口，与主窗口共享主进程与同一套安全基线。
 * 加载独立的 reader 渲染入口，通过 ?email=<id> 把目标邮件传进去；
 * 不接管 getMainWindow，也不参与主窗口状态持久化。
 */
/** 已打开的阅读窗口：同一封邮件只保留一个，再次双击时聚焦已有窗口。 */
const readerWindows = new Map<string, BrowserWindow>();

export function createReaderWindow(
  emailId: string,
  compose?: 'reply' | 'reply-all' | 'forward',
  /** 纯阅读窗口打开时是否直接最大化（回复/转发窗口忽略此项）。 */
  autoFullScreen = false,
): BrowserWindow {
  // 阅读窗口与「回复/转发」写信窗口是两类窗口：同一封邮件可以各开一个
  const key = compose ? `${emailId}|${compose}` : emailId;
  const existing = readerWindows.get(key);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return existing;
  }

  const window = new BrowserWindow({
    width: 1000,
    height: 760,
    minWidth: 720,
    minHeight: 560,
    show: false,
    backgroundColor: '#0f1419',
    title: 'MailForge',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      ...SECURITY_BASELINE,
      spellcheck: false,
      devTools: !app.isPackaged,
      safeDialogs: true,
      enableWebSQL: false,
    },
  });

  readerWindows.set(key, window);

  window.once('ready-to-show', () => {
    // 只有纯阅读窗口自动全屏；回复/转发窗口保持普通尺寸，方便同时对照原邮件。
    if (autoFullScreen && !compose) window.maximize();
    window.show();
  });

  window.on('closed', () => {
    if (readerWindows.get(key) === window) readerWindows.delete(key);
  });

  registerSecondaryWindow(window);

  loadRenderer(window, 'reader', {
    email: emailId,
    ...(compose ? { compose } : {}),
  });
  return window;
}

/**
 * 主窗口。硬约束（§36）：sandbox + contextIsolation + 无 nodeIntegration。
 * Phase 1 不启用 webviewTag；Phase 2 引入插件视图时按 §13.7 开启并校验。
 */
export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#0f1419',
    title: 'MailForge',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      ...SECURITY_BASELINE,
      spellcheck: false,
      devTools: !app.isPackaged,
      safeDialogs: true,
      enableWebSQL: false,
    },
  });

  restoreWindowBounds(window);
  trackWindowState(window);
  setMainWindow(window);

  window.once('ready-to-show', () => {
    window.show();
  });

  window.on('closed', () => {
    setMainWindow(null);
  });

  loadRenderer(window, 'index');
  return window;
}

/** 渲染进程崩溃后的独立恢复页（§25.1）：不自动重载，只展示诊断信息。 */
export function createRecoveryWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 880,
    height: 680,
    minWidth: 720,
    minHeight: 560,
    show: false,
    backgroundColor: '#0f1419',
    title: 'MailForge — 诊断信息',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/recovery.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      spellcheck: false,
      devTools: false,
    },
  });

  setRecoveryWindow(window);

  window.once('ready-to-show', () => window.show());
  window.on('closed', () => setRecoveryWindow(null));

  loadRenderer(window, 'recovery');
  return window;
}

/** 主密码解锁窗口（§6.6）：唯一职责是收集密码，不加载任何邮件数据。 */
export function createUnlockWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 460,
    height: 340,
    resizable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    backgroundColor: '#12161c',
    title: '解锁 MailForge',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/unlock.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      spellcheck: false,
      devTools: false,
    },
  });

  window.once('ready-to-show', () => window.show());
  loadRenderer(window, 'unlock');
  return window;
}
