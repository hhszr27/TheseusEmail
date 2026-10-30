// @vitest-environment jsdom
/**
 * 阅读区头部地址行：`发件人：名称` / `收件人：名称`，悬停名称弹出联系人名片。
 *
 * 为什么需要它：
 *  - 这两行以前是「发件人只显示名字」+ 硬编码的「收件人：我」，用户明确要求看真实信息；
 *  - 现在又改成「只显示名称 + 悬停名片」，邮箱不再内联，一旦名片挂不上，
 *    界面上就再也看不到收件地址了 —— 这是纯 DOM 接线，只有真渲染才测得出。
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
let copied: string[];

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
    unread: false,
    starred: false,
    pinned: false,
    ...overrides,
  };
}

async function mount(email: EmailSummary, bodyText: string | null = null): Promise<void> {
  await act(async () => {
    root.render(
      createElement(ReaderView, {
        email,
        body: bodyText === null ? null : ({ id: email.id, html: '', text: bodyText, blockedRemoteImages: 0, remoteImages: [], sanitized: true } as never),
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
      }),
    );
  });
}

/** 在元素上派发鼠标事件（React 的 onMouseEnter/Leave 由 mouseover/mouseout 合成）。 */
function fireMouse(element: Element, type: 'mouseover' | 'mouseout', related: Element | null): void {
  act(() => {
    element.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, relatedTarget: related }),
    );
  });
}

function card(): HTMLElement | null {
  return container.querySelector('.reader-address-card') as HTMLElement | null;
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  copied = [];
  (window as unknown as { api: unknown }).api = {
    listAttachments: async () => ({ ok: true, data: [] }),
    onScanUpdate: () => () => undefined,
    copyText: async (text: string) => {
      copied.push(text);
      return { ok: true, data: true };
    },
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('阅读区头部地址行', () => {
  it('发件人只显示名称，不再内联邮箱', async () => {
    await mount(fakeEmail());

    const from = container.querySelector('.reader-meta-from');
    expect(from).not.toBeNull();
    expect(from?.textContent).toContain('发件人：');
    expect(from?.textContent).toContain('张三');
    expect(from?.textContent).not.toContain('zhangsan@example.com');
  });

  it('收件人只显示名称，且不再出现「我」', async () => {
    await mount(fakeEmail({ to: [{ name: '李四', address: 'lisi@example.com' }] }));

    const to = container.querySelector('.reader-meta-to');
    expect(to?.textContent).toContain('收件人：');
    expect(to?.textContent).toContain('李四');
    expect(to?.textContent).not.toContain('lisi@example.com');
    expect(container.querySelector('.reader-header')?.textContent).not.toContain('我');
  });

  it('悬停发件人名称弹出名片，显示姓名、身份与邮箱', async () => {
    await mount(fakeEmail());
    expect(card()).toBeNull();

    const address = container.querySelector('.reader-meta-from .reader-address');
    expect(address).not.toBeNull();
    fireMouse(address as Element, 'mouseover', null);

    const popup = card();
    expect(popup).not.toBeNull();
    expect(popup?.textContent).toContain('张三');
    expect(popup?.textContent).toContain('发件人');
    expect(popup?.textContent).toContain('zhangsan@example.com');
  });

  it('悬停收件人名称弹出名片，身份标为收件人', async () => {
    await mount(fakeEmail());
    const address = container.querySelector('.reader-meta-to .reader-address');
    fireMouse(address as Element, 'mouseover', null);

    const popup = card();
    expect(popup?.textContent).toContain('李四');
    expect(popup?.textContent).toContain('收件人');
    expect(popup?.textContent).toContain('lisi@example.com');
  });

  it('鼠标移开后名片消失', async () => {
    await mount(fakeEmail());
    const address = container.querySelector('.reader-meta-from .reader-address') as Element;
    fireMouse(address, 'mouseover', null);
    expect(card()).not.toBeNull();

    fireMouse(address, 'mouseout', document.body);
    expect(card()).toBeNull();
  });

  it('键盘聚焦名称同样能看到名片，Esc 关闭', async () => {
    await mount(fakeEmail());
    const button = container.querySelector(
      '.reader-meta-to .reader-address-name',
    ) as HTMLButtonElement;

    act(() => button.focus());
    expect(card()?.textContent).toContain('lisi@example.com');

    act(() => {
      button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(card()).toBeNull();
  });

  it('双击名片里的邮箱自动复制并给出反馈（不再有复制按钮）', async () => {
    await mount(fakeEmail());
    const address = container.querySelector('.reader-meta-from .reader-address') as Element;
    fireMouse(address, 'mouseover', null);

    const popup = card();
    expect(popup).not.toBeNull();
    // 按钮已移除：名片里不该再有任何 button
    expect(popup?.querySelectorAll('button').length).toBe(0);

    const value = popup?.querySelector('.reader-address-card-value') as HTMLElement;
    expect(value.textContent).toBe('zhangsan@example.com');

    // 单击不复制
    act(() => {
      value.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(copied).toEqual([]);

    await act(async () => {
      value.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });

    expect(copied).toEqual(['zhangsan@example.com']);
    expect(card()?.textContent).toContain('已复制');
  });

  it('翻译后切「显示原文」展示完整正文，而不是列表摘要', async () => {
    (window as unknown as { api: { translateEmail: unknown } }).api.translateEmail =
      async () => ({ ok: true, data: { status: 'ok', text: '这是译文' } });

    // 摘要只是列表里那一行，正文则长得多
    await mount(fakeEmail({ snippet: '摘要片段' }), '第一段。\n第二段完整正文。');

    await act(async () => {
      container
        .querySelector('button[aria-label="翻译"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const section = container.querySelector('.reader-translation');
    expect(section?.textContent).toContain('这是译文');

    // 切到原文
    await act(async () => {
      Array.from(section?.querySelectorAll('button') ?? [])
        .find((node) => node.textContent === '显示原文')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const body = container.querySelector('.reader-translation .reader-ai-body');
    expect(body?.textContent).toContain('第二段完整正文。');
    expect(body?.textContent).not.toBe('摘要片段');
  });

  it('名片里的邮箱可键盘复制：聚焦后按回车即写入剪贴板', async () => {
    await mount(fakeEmail());
    const address = container.querySelector('.reader-meta-from .reader-address') as Element;
    fireMouse(address, 'mouseover', null);

    const value = card()?.querySelector('.reader-address-card-value') as HTMLElement;
    expect(value.getAttribute('role')).toBe('button');
    expect(value.getAttribute('tabindex')).toBe('0');

    await act(async () => {
      value.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(copied).toEqual(['zhangsan@example.com']);
    expect(card()?.textContent).toContain('已复制');
  });

  it('名片里的邮箱空格键也能复制', async () => {
    await mount(fakeEmail());
    const address = container.querySelector('.reader-meta-from .reader-address') as Element;
    fireMouse(address, 'mouseover', null);

    const value = card()?.querySelector('.reader-address-card-value') as HTMLElement;
    await act(async () => {
      value.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    });

    expect(copied).toEqual(['zhangsan@example.com']);
  });

  it('没有姓名时内联显示邮箱（否则这一行没有可识别内容）', async () => {
    await mount(fakeEmail({ to: [{ address: 'wangwu@example.com' }] }));

    const to = container.querySelector('.reader-meta-to');
    expect(to?.textContent).toContain('wangwu@example.com');
  });

  it('多个收件人各自可悬停，没有收件人时整行不渲染', async () => {
    await mount(
      fakeEmail({
        to: [
          { name: '李四', address: 'lisi@example.com' },
          { name: '王五', address: 'wangwu@example.com' },
        ],
      }),
    );
    const addresses = container.querySelectorAll('.reader-meta-to .reader-address');
    expect(addresses).toHaveLength(2);
    fireMouse(addresses[1] as Element, 'mouseover', null);
    expect(card()?.textContent).toContain('wangwu@example.com');

    await mount(fakeEmail({ to: [] }));
    expect(container.querySelector('.reader-meta-to')).toBeNull();
    expect(container.querySelector('.reader-meta-from')?.textContent).toContain('发件人：');
  });

  it('没有发件人时保留占位，前缀仍可见', async () => {
    await mount(fakeEmail({ from: [] }));

    const from = container.querySelector('.reader-meta-from');
    expect(from?.textContent).toContain('发件人：');
    expect(from?.textContent).toContain('（未知发件人）');
  });
});
