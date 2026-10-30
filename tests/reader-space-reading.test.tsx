// @vitest-environment jsdom
/**
 * 空格单键阅读：正文没读完先翻页，读到最后才切下一封。
 *
 * 为什么要测：这是「到底/不足一屏」两条分支的边界，写反了就会变成
 * 「按一下空格直接跳走」或「永远跳不走」。jsdom 里 scrollHeight/clientHeight
 * 都是 0，正好覆盖「内容不足一屏」这条分支；再用 defineProperty 造一个
 * 可滚动的高度，覆盖「先翻页、到底再切」这条分支。
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

function fakeEmail(overrides: Partial<EmailSummary> = {}): EmailSummary {
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
    unread: true,
    starred: false,
    pinned: false,
    ...overrides,
  };
}

function mount(onNextEmail?: () => void): void {
  act(() => {
    root.render(
      createElement(ReaderView, {
        email: fakeEmail(),
        // 不传正文：阅读区仍然渲染，但内容不足一屏
        body: null,
        loading: false,
        allowRemoteImages: false,
        readerPluginId: null,
        injectionPluginIds: [],
        accountId: 'acc-1',
        onToggleImages: () => undefined,
        onTogglePin: () => undefined,
        onSnooze: () => undefined,
        canArchive: true,
        onReply: () => undefined,
        onReplyAll: () => undefined,
        onForward: () => undefined,
        onToggleRead: () => undefined,
        onToggleStar: () => undefined,
        onArchive: () => undefined,
        onDelete: () => undefined,
        ...(onNextEmail ? { onNextEmail } : {}),
      }),
    );
  });
}

function pressSpace(): void {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true }),
    );
  });
}

function readerPane(): HTMLElement {
  const pane = container.querySelector('.reader-pane');
  if (!pane) throw new Error('阅读区没有渲染');
  return pane as HTMLElement;
}

/** 造一个「可滚动到 maxScroll」的阅读区（jsdom 默认高度都是 0）。 */
function makeScrollable(pane: HTMLElement, scrollHeight: number, clientHeight: number): void {
  Object.defineProperty(pane, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(pane, 'clientHeight', { value: clientHeight, configurable: true });
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
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

describe('空格单键阅读', () => {
  it('正文没到底时只翻页，不切下一封', () => {
    let advanced = 0;
    mount(() => {
      advanced += 1;
    });
    const pane = readerPane();
    makeScrollable(pane, 2000, 800);
    pane.scrollTop = 0;

    act(() => pane.focus());
    pressSpace();

    expect(advanced).toBe(0);
  });

  it('已经到底时按空格切下一封', () => {
    let advanced = 0;
    mount(() => {
      advanced += 1;
    });
    const pane = readerPane();
    makeScrollable(pane, 2000, 800);
    pane.scrollTop = 1200; // maxScroll = 2000 - 800

    act(() => pane.focus());
    pressSpace();

    expect(advanced).toBe(1);
  });

  it('内容不足一屏时直接切下一封', () => {
    let advanced = 0;
    mount(() => {
      advanced += 1;
    });
    const pane = readerPane();
    // jsdom 默认 scrollHeight = clientHeight = 0，等价于「不足一屏」

    act(() => pane.focus());
    pressSpace();

    expect(advanced).toBe(1);
  });

  it('独立阅读窗口没有下一封（不传 onNextEmail）时按空格不报错', () => {
    mount(undefined);
    const pane = readerPane();

    act(() => pane.focus());
    expect(() => pressSpace()).not.toThrow();
  });

  it('焦点不在阅读区时空格不翻页（不抢列表/搜索框的空格）', () => {
    let advanced = 0;
    mount(() => {
      advanced += 1;
    });
    // 不聚焦阅读区：activeElement 是 body，不在 .reader-pane 内
    pressSpace();

    expect(advanced).toBe(0);
  });
});
