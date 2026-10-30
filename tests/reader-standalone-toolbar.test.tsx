// @vitest-environment jsdom
/**
 * 独立阅读窗口（双击邮件打开的原生窗口）工具栏：
 * 只保留「回复 / 全部回复 / 转发」与远程图片开关；星标、已读、归档、删除、
 * 稍后提醒、置顶都不出现——这些动作依赖主窗口的列表状态，在弹窗里点了
 * 要么没反应、要么与主窗口不同步。
 *
 * 为什么需要它：用户明确要求双击后弹出的窗口里要有这三个按钮；
 * 而 standalone 分支一旦写错，按钮会整体消失或退回成整套图标工具条，
 * 只有真渲染才看得出来。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, createElement } from 'react';
import type { EmailSummary } from '../src/shared/types';
import { ReaderView } from '../src/renderer/components/ReaderView';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let container: HTMLDivElement;
let root: Root;
let calls: { reply: number; replyAll: number; forward: number };

function fakeEmail(): EmailSummary {
  return {
    id: 'e1',
    uid: 1,
    folder: 'INBOX',
    accountId: 'acc-1',
    subject: '测试邮件',
    from: [{ name: '张三', address: 'zhangsan@example.com' }],
    to: [{ name: '李四', address: 'lisi@example.com' }],
    date: new Date('2026-10-23T09:00:00Z').toISOString(),
    snippet: 'snippet',
    hasAttachments: false,
    unread: false,
    starred: false,
    pinned: false,
  };
}

async function mount(standalone: boolean): Promise<void> {
  await act(async () => {
    root.render(
      createElement(ReaderView, {
        email: fakeEmail(),
        body: null,
        loading: false,
        allowRemoteImages: false,
        readerPluginId: null,
        injectionPluginIds: [],
        accountId: 'acc-1',
        standalone,
        onToggleImages: () => undefined,
        onTogglePin: () => undefined,
        onSnooze: () => undefined,
        canArchive: true,
        onReply: () => {
          calls.reply += 1;
        },
        onReplyAll: () => {
          calls.replyAll += 1;
        },
        onForward: () => {
          calls.forward += 1;
        },
        onToggleRead: () => undefined,
        onToggleStar: () => undefined,
        onArchive: () => undefined,
        onDelete: () => undefined,
      }),
    );
  });
}

function toolbarButton(text: string): HTMLButtonElement | null {
  const buttons = Array.from(container.querySelectorAll('.reader-toolbar button'));
  return (
    (buttons.find((button) => button.textContent?.trim() === text) as
      | HTMLButtonElement
      | undefined) ?? null
  );
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  calls = { reply: 0, replyAll: 0, forward: 0 };
  // ReaderView 的附件区在挂载时会查附件；jsdom 下没有 preload，这里给最小桩。
  (window as unknown as { api: unknown }).api = {
    listAttachments: async () => ({ ok: true, data: [] }),
    onScanUpdate: () => () => undefined,
    copyText: async () => ({ ok: true, data: true }),
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('独立阅读窗口工具栏', () => {
  it('提供回复 / 全部回复 / 转发三个按钮', async () => {
    await mount(true);

    expect(toolbarButton('回复')).not.toBeNull();
    expect(toolbarButton('全部回复')).not.toBeNull();
    expect(toolbarButton('转发')).not.toBeNull();
  });

  it('三个按钮分别触发对应回调', async () => {
    await mount(true);

    act(() => {
      toolbarButton('回复')?.click();
    });
    act(() => {
      toolbarButton('全部回复')?.click();
    });
    act(() => {
      toolbarButton('转发')?.click();
    });

    expect(calls).toEqual({ reply: 1, replyAll: 1, forward: 1 });
  });

  it('不出现依赖主列表状态的动作（归档/删除/星标/置顶/稍后提醒）', async () => {
    await mount(true);

    expect(container.querySelector('button[aria-label="归档"]')).toBeNull();
    expect(container.querySelector('button[aria-label="删除"]')).toBeNull();
    expect(container.querySelector('button[aria-label="加星标"]')).toBeNull();
    expect(container.querySelector('button[aria-label="置顶"]')).toBeNull();
    expect(container.querySelector('.icon-select')).toBeNull();
  });

  it('主界面（非独立模式）仍保留完整工具栏', async () => {
    await mount(false);

    expect(container.querySelector('button[aria-label="归档"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="删除"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="回复"]')).not.toBeNull();
  });
});
