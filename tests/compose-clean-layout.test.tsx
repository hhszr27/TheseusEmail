// @vitest-environment jsdom
/**
 * 写信界面（创建 / 回复 / 转发共用）的 clean 布局：
 *  - 用 42px 的薄顶栏，而不是原来那个带大标题 + 两个按钮 + 「关闭」的 modal-header；
 *  - 抄送/密送、定时发送默认收起，界面只留最常用的字段；
 *  - 正文编辑器仍然在（#compose-body），工具行里仍有「添加附件」。
 *
 * 为什么需要它：这些是纯 DOM 接线，类型检查看不出「字段被藏错/按钮没挂上」。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, createElement } from 'react';
import { ComposeModal } from '../src/renderer/components/ComposeModal';
import type { MailtoRequest } from '../src/shared/ipc';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const REQUEST: MailtoRequest = {
  to: ['a@example.com'],
  cc: [],
  subject: '测试主题',
  body: '正文',
  html: '<p>正文</p>',
  raw: '',
  kind: 'new',
};

let container: HTMLDivElement;
let root: Root;

async function mount(
  variant: 'modal' | 'inline' = 'modal',
  onClose: () => void = () => undefined,
): Promise<void> {
  await act(async () => {
    root.render(createElement(ComposeModal, { request: REQUEST, onClose, variant }));
  });
}

function buttonByText(text: string): HTMLButtonElement | null {
  return (
    (Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === text,
    ) as HTMLButtonElement | undefined) ?? null
  );
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  (window as unknown as { api: unknown }).api = {
    setPluginDraftContext: async () => ({ ok: true, data: null }),
    onDraftPatch: () => () => undefined,
    getSetting: async () => ({ ok: false, error: { code: 'NONE', message: 'none' } }),
    getDraft: async () => ({ ok: false, error: { code: 'NONE', message: 'none' } }),
    setSetting: async () => ({ ok: true, data: true }),
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('写信界面 clean 布局', () => {
  it('用薄顶栏而不是 modal-header，常用字段与正文都还在', async () => {
    await mount();

    expect(container.querySelector('.compose-topbar')).not.toBeNull();
    expect(container.querySelector('.modal-header')).toBeNull();
    expect(container.querySelector('#compose-from')).not.toBeNull();
    expect(container.querySelector('#compose-to')).not.toBeNull();
    expect(container.querySelector('#compose-subject')).not.toBeNull();
    expect(container.querySelector('#compose-body')).not.toBeNull();
    // 弹层形态仍保留底部操作行
    expect(container.querySelector('.compose-footer')).not.toBeNull();
  });

  it('抄送/密送默认收起，点「抄送/密送」后才出现', async () => {
    await mount();
    expect(container.querySelector('#compose-cc')).toBeNull();
    expect(container.querySelector('#compose-bcc')).toBeNull();

    const toggle = buttonByText('抄送/密送');
    expect(toggle).not.toBeNull();
    act(() => {
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.querySelector('#compose-cc')).not.toBeNull();
    expect(container.querySelector('#compose-bcc')).not.toBeNull();
  });

  it('定时发送默认收起，工具行里仍有「添加附件」', async () => {
    await mount();
    expect(container.querySelector('#compose-send-at')).toBeNull();

    const tools = container.querySelector('.compose-tools');
    expect(tools?.textContent).toContain('添加附件');

    const schedule = Array.from(tools?.querySelectorAll('button') ?? []).find((button) =>
      button.textContent?.includes('定时发送'),
    );
    expect(schedule).toBeTruthy();
    act(() => {
      schedule?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.querySelector('#compose-send-at')).not.toBeNull();
  });
});

describe('阅读窗口里的内联写信视图（Outlook 式）', () => {
  it('铺满窗口、无遮罩；只有「返回邮件」而不是关闭/放大/全屏', async () => {
    let closed = 0;
    await mount('inline', () => {
      closed += 1;
    });

    expect(container.querySelector('.compose-inline-host')).not.toBeNull();
    expect(container.querySelector('.modal.compose-clean.compose-inline')).not.toBeNull();
    expect(container.querySelector('.overlay')).toBeNull();
    expect(container.querySelector('button[aria-label="返回邮件"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="放大"]')).toBeNull();
    expect(container.querySelector('button[aria-label="全屏"]')).toBeNull();
    expect(container.querySelector('button[aria-label="关闭"]')).toBeNull();
    // 发送按钮在地址区右上角（发件人行右侧），不在标题栏、也不占底部行
    expect(container.querySelector('.compose-footer')).toBeNull();
    const send = container.querySelector('.compose-send-side');
    expect(send).not.toBeNull();
    // 正方形文字按钮：保留「发送」二字，方块尺寸由 CSS 的 60×60 决定
    expect(send?.textContent?.trim()).toBe('发送');
    expect(send?.getAttribute('aria-label')).toContain('发送');
    expect(container.querySelector('.compose-topbar .compose-send-top')).toBeNull();

    act(() => {
      (container.querySelector('button[aria-label="返回邮件"]') as HTMLButtonElement).click();
    });
    expect(closed).toBe(1);
  });
});
