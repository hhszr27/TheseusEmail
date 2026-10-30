import { afterEach, describe, expect, it } from 'vitest';
import type { BrowserWindow } from 'electron';
import {
  registerSecondaryWindow,
  sendToRenderer,
  setMainWindow,
} from '../src/main/app/app-context';
import { IPC_EVENTS } from '../src/shared/constants';

/**
 * 事件扇出：独立文件夹窗口也必须收到状态类事件。
 *
 * 背景：sendToRenderer 以前只发主窗口。右键「在新窗口中打开」的文件夹窗口
 * 跑的是同一个渲染页、也订阅了 onSyncState，却永远收不到推送——
 * 新邮件、已读状态、账户变化都不更新，用户只能关掉重开。
 */

interface FakeWindow {
  window: BrowserWindow;
  sent: Array<{ channel: string; payload: unknown }>;
  /** 窗口已销毁（Electron 里这时还能摸到 webContents，但发消息会炸）。 */
  winDestroyed: boolean;
  /** webContents 已销毁。 */
  contentsDestroyed: boolean;
}

function fakeWindow(): FakeWindow {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const fake: FakeWindow = {
    sent,
    winDestroyed: false,
    contentsDestroyed: false,
    window: {
      isDestroyed: () => fake.winDestroyed,
      webContents: {
        isDestroyed: () => fake.contentsDestroyed,
        send: (channel: string, payload: unknown) => {
          sent.push({ channel, payload });
        },
      },
      on: () => {},
    } as unknown as BrowserWindow,
  };
  return fake;
}

afterEach(() => {
  setMainWindow(null);
});

describe('sendToRenderer 扇出', () => {
  it('状态类事件同时发给主窗口与文件夹窗口', () => {
    const main = fakeWindow();
    const folder = fakeWindow();
    setMainWindow(main.window);
    registerSecondaryWindow(folder.window);

    sendToRenderer(IPC_EVENTS.syncState, { syncing: false });

    expect(main.sent).toEqual([{ channel: IPC_EVENTS.syncState, payload: { syncing: false } }]);
    expect(folder.sent).toEqual([{ channel: IPC_EVENTS.syncState, payload: { syncing: false } }]);
  });

  it('accountsChanged / scanResult / draftPatch 等状态事件一并扇出', () => {
    const main = fakeWindow();
    const folder = fakeWindow();
    setMainWindow(main.window);
    registerSecondaryWindow(folder.window);

    sendToRenderer(IPC_EVENTS.accountsChanged, null);
    sendToRenderer(IPC_EVENTS.scanResult, { id: 'a' });
    sendToRenderer(IPC_EVENTS.draftPatch, { accountId: 'acc' });

    expect(folder.sent.map((item) => item.channel)).toEqual([
      IPC_EVENTS.accountsChanged,
      IPC_EVENTS.scanResult,
      IPC_EVENTS.draftPatch,
    ]);
  });

  it('窗口动作类事件只发主窗口（避免每个窗口都响应一次托盘）', () => {
    const main = fakeWindow();
    const folder = fakeWindow();
    setMainWindow(main.window);
    registerSecondaryWindow(folder.window);

    sendToRenderer(IPC_EVENTS.trayAction, { action: 'refresh' });
    sendToRenderer(IPC_EVENTS.mailto, { to: ['a@example.com'] });
    sendToRenderer(IPC_EVENTS.notificationOpen, { emailId: 'e1' });

    expect(main.sent).toHaveLength(3);
    expect(folder.sent).toEqual([]);
  });

  it('已销毁的文件夹窗口被跳过，不影响主窗口', () => {
    const main = fakeWindow();
    const folder = fakeWindow();
    setMainWindow(main.window);
    registerSecondaryWindow(folder.window);
    // 只标窗口已销毁：contents 还摸得到——这正是会炸的场景
    folder.winDestroyed = true;

    expect(() => sendToRenderer(IPC_EVENTS.syncState, { syncing: true })).not.toThrow();
    expect(main.sent).toHaveLength(1);
    expect(folder.sent).toEqual([]);
  });

  it('webContents 已销毁时同样跳过', () => {
    const main = fakeWindow();
    const folder = fakeWindow();
    setMainWindow(main.window);
    registerSecondaryWindow(folder.window);
    folder.contentsDestroyed = true;

    sendToRenderer(IPC_EVENTS.syncState, { syncing: true });

    expect(main.sent).toHaveLength(1);
    expect(folder.sent).toEqual([]);
  });

  it('没有主窗口时不崩，文件夹窗口照常收到', () => {
    const folder = fakeWindow();
    registerSecondaryWindow(folder.window);

    expect(() => sendToRenderer(IPC_EVENTS.syncState, { syncing: true })).not.toThrow();
    expect(folder.sent).toHaveLength(1);
  });
});
