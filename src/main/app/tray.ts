import { app, BrowserWindow, Menu, Tray, nativeImage } from 'electron';
import path from 'node:path';
import { IPC_EVENTS } from '../../shared/constants';
import { log } from '../observability/logger';
import { focusMainWindow, getMainWindow, sendToRenderer } from './app-context';
import {
  normalizeUnread,
  readTraySettings,
  shouldHideOnClose,
  shouldHideOnMinimize,
  trayIconName,
  trayTooltip,
  writeTraySettings,
} from './tray-settings';
import type { TraySettings } from '../../shared/types';
import type { Db } from '../db/open';

/**
 * 系统托盘（宿主能力）。
 *
 * 为什么不走插件：Tray / 窗口控制是主进程原生 API，插件运行在沙箱
 * webview 中只能访问 window.mailAPI 的邮件数据方法（§13.4），拿不到
 * 系统托盘；且托盘菜单要操作 BrowserWindow，必须在主进程完成。
 *
 * 退出语义：托盘「退出」走 beginQuit() → app.quit()，与既有
 * before-quit 清理流程（数据库/worker/日志落盘）完全复用。
 */

function iconFile(name: string): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'icons', name);
  }
  return path.join(app.getAppPath(), 'build', 'icons', name);
}

export class TrayService {
  private tray: Tray | null = null;
  private settings: TraySettings;
  private unread = 0;
  private quitting = false;

  constructor(private readonly db: Db) {
    this.settings = readTraySettings(db);
  }

  get isQuitting(): boolean {
    return this.quitting;
  }

  get settingsSnapshot(): TraySettings {
    return { ...this.settings };
  }

  /** 托盘图标是否存活（诊断与设置 UI 用）。 */
  get active(): boolean {
    return this.tray !== null;
  }

  /** 当前未读数（托盘徽标来源）。 */
  get unreadCount(): number {
    return this.unread;
  }

  /** 开始退出：置位后窗口 close 不再拦截，随后走 app.quit() 正常清理。 */
  beginQuit(): void {
    this.quitting = true;
    app.quit();
  }

  /**
   * 只置退出标志（不触发 quit）。
   * 供 before-quit 使用：app.quit() 的 close 序列开始后，
   * 任何入口（托盘菜单、macOS Cmd+Q、应用菜单）都能正确放行窗口关闭。
   */
  markQuitting(): void {
    this.quitting = true;
  }

  create(): void {
    if (this.tray) return;
    if (!this.settings.enabled) {
      log.info('tray', '托盘已在设置中关闭，跳过创建');
      return;
    }
    try {
      this.tray = new Tray(nativeImage.createFromPath(iconFile(trayIconName(this.settings, this.unread))));
    } catch (error) {
      log.warn('tray', '创建托盘图标失败', { message: (error as Error).message });
      return;
    }
    this.tray.setToolTip(trayTooltip(this.unread));
    this.tray.on('click', () => this.toggleMainWindow());
    this.refreshMenu();
    log.info('tray', '托盘图标已创建');
  }

  destroy(): void {
    if (!this.tray) return;
    this.tray.destroy();
    this.tray = null;
    log.info('tray', '托盘图标已销毁');
  }

  /** 窗口行为：关闭/最小化到托盘（§设置可关）。 */
  installWindowBehavior(window: BrowserWindow): void {
    window.on('close', (event) => {
      if (!shouldHideOnClose(this.settings, this.quitting)) return;
      event.preventDefault();
      window.hide();
    });
    window.on('minimize', () => {
      if (shouldHideOnMinimize(this.settings)) window.hide();
    });
  }

  /** 左键点击：可见则隐藏，隐藏/最小化则恢复（Windows 常见交互）。 */
  private toggleMainWindow(): void {
    const window = getMainWindow();
    if (!window) return;
    if (window.isVisible() && !window.isMinimized()) {
      window.hide();
      return;
    }
    focusMainWindow();
  }

  private refreshMenu(): void {
    if (!this.tray) return;
    const unreadLabel =
      this.unread > 0 ? `未读邮件：${this.unread} 封` : '没有未读邮件';
    const menu = Menu.buildFromTemplate([
      { label: '打开主窗口', click: () => focusMainWindow() },
      { type: 'separator' },
      {
        label: '写新邮件',
        click: () => {
          focusMainWindow();
          sendToRenderer(IPC_EVENTS.trayAction, { action: 'compose' });
        },
      },
      {
        label: '刷新邮件',
        click: () => {
          sendToRenderer(IPC_EVENTS.trayAction, { action: 'refresh' });
        },
      },
      {
        label: '打开发件箱',
        click: () => {
          focusMainWindow();
          sendToRenderer(IPC_EVENTS.trayAction, { action: 'outbox' });
        },
      },
      { type: 'separator' },
      { label: unreadLabel, enabled: false },
      { type: 'separator' },
      { label: '退出', click: () => this.beginQuit() },
    ]);
    this.tray.setContextMenu(menu);
  }

  /** 更新未读数（变化时才换图标、tooltip 与菜单，避免无谓重绘）。 */
  setUnread(unread: number): void {
    const next = normalizeUnread(unread);
    if (next === this.unread) return;
    this.unread = next;
    if (!this.tray) return;
    this.setIcon(trayIconName(this.settings, this.unread));
    this.tray.setToolTip(trayTooltip(this.unread));
    this.refreshMenu();
  }

  private setIcon(name: string): void {
    if (!this.tray) return;
    try {
      this.tray.setImage(nativeImage.createFromPath(iconFile(name)));
    } catch (error) {
      log.warn('tray', '更新托盘图标失败', { name, message: (error as Error).message });
    }
  }

  /** 设置变更：持久化 + 热生效（启用/停用托盘、徽章开关）。 */
  applySettings(next: TraySettings): void {
    const wasEnabled = this.settings.enabled;
    this.settings = next;
    writeTraySettings(this.db, next);

    if (next.enabled && !wasEnabled) this.create();
    if (!next.enabled && wasEnabled) {
      this.destroy();
      return;
    }
    if (!this.tray) return;
    this.setIcon(trayIconName(this.settings, this.unread));
    this.refreshMenu();
  }
}
