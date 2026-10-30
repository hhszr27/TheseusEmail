import type { BrowserWindow } from 'electron';
import { log } from '../observability/logger';
import { IPC_EVENTS } from '../../shared/constants';

/** 主窗口引用与向渲染进程推送事件的唯一入口。 */

let mainWindow: BrowserWindow | null = null;
let recoveryWindow: BrowserWindow | null = null;

/**
 * 次级窗口（右键「在新窗口中打开」的文件夹窗口）。
 * 它们跑的是同一个渲染页，也会订阅 onSyncState / onAccountsChanged，
 * 所以状态类事件必须扇出给它们，否则那边的列表永远不刷新。
 */
const secondaryWindows = new Set<BrowserWindow>();

/**
 * 需要所有存活窗口都收到的状态类事件。
 * 窗口动作类（托盘动作、mailto、通知点击）仍只发主窗口——
 * 否则点一次托盘「刷新」会让每个文件夹窗口都去刷一遍。
 */
const FANOUT_CHANNELS: ReadonlySet<string> = new Set<string>([
  IPC_EVENTS.syncState,
  IPC_EVENTS.scanResult,
  IPC_EVENTS.accountsChanged,
  IPC_EVENTS.calendarChanged,
  IPC_EVENTS.pluginsChanged,
  IPC_EVENTS.draftPatch,
]);

export function setMainWindow(window: BrowserWindow | null): void {
  mainWindow = window;
}

export function getMainWindow(): BrowserWindow | null {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  return mainWindow;
}

export function setRecoveryWindow(window: BrowserWindow | null): void {
  recoveryWindow = window;
}

export function getRecoveryWindow(): BrowserWindow | null {
  if (!recoveryWindow || recoveryWindow.isDestroyed()) return null;
  return recoveryWindow;
}

/** 注册次级窗口；关闭时自动从扇出列表移除。 */
export function registerSecondaryWindow(window: BrowserWindow): void {
  secondaryWindows.add(window);
  window.on('closed', () => secondaryWindows.delete(window));
}

export function focusMainWindow(): void {
  const window = getMainWindow();
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function sendTo(window: BrowserWindow, channel: string, payload: unknown): void {
  const contents = window.webContents;
  if (contents.isDestroyed()) return;
  try {
    contents.send(channel, payload);
  } catch (error) {
    log.warn('ipc', '向渲染进程发送事件失败', { channel, message: (error as Error).message });
  }
}

export function sendToRenderer(channel: string, payload: unknown): void {
  const main = getMainWindow();
  if (main) sendTo(main, channel, payload);

  if (!FANOUT_CHANNELS.has(channel)) return;
  // 先收一份快照：closed 回调会在遍历中改动集合
  for (const window of [...secondaryWindows]) {
    if (window.isDestroyed()) {
      secondaryWindows.delete(window);
      continue;
    }
    sendTo(window, channel, payload);
  }
}
