// @vitest-environment jsdom
/**
 * 联系人必须渲染在右侧主区域，而不是弹窗。
 *
 * 用户要求「联系人也不要弹窗，也是在右侧面板显示」。这里锁住三条：
 *  1) 渲染结果里没有 .overlay / .modal，只有 .main-view.contacts-view；
 *  2) 搜索框能按姓名/邮箱过滤；
 *  3) 「写信」把邮箱交出去并请求返回邮件视图（撰写弹层挂在邮件视图上）。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, createElement } from 'react';
import type { ContactSuggestion } from '../src/shared/ipc';
import { ContactsPanel } from '../src/renderer/components/ContactsPanel';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const CONTACTS: ContactSuggestion[] = [
  { email: 'zhangsan@example.com', displayName: '张三', interactionCount: 12, lastContactedAt: 0 },
  { email: 'lisi@example.com', displayName: '李四', interactionCount: 3, lastContactedAt: 0 },
];

let container: HTMLDivElement;
let root: Root;
let composed: { email: string; displayName: string | null }[];
let backed: number;

async function mount(): Promise<void> {
  await act(async () => {
    root.render(
      createElement(ContactsPanel, {
        onBack: () => {
          backed += 1;
        },
        onCompose: (email: string, displayName: string | null) => {
          composed.push({ email, displayName });
        },
      }),
    );
    // 让 listContacts 的 Promise 结算
    await Promise.resolve();
  });
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  (window as unknown as { api: unknown }).api = {
    listContacts: async () => ({ ok: true, data: CONTACTS }),
  };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  composed = [];
  backed = 0;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('联系人视图', () => {
  it('内嵌在右侧主区域，没有弹窗遮罩', async () => {
    await mount();

    expect(container.querySelector('.overlay')).toBeNull();
    expect(container.querySelector('.modal')).toBeNull();

    const view = container.querySelector('.main-view.contacts-view');
    expect(view).not.toBeNull();
    expect(view?.querySelector('.view-title')?.textContent).toContain('联系人');
    expect(container.querySelectorAll('.contact-row')).toHaveLength(2);
  });

  it('搜索框按姓名过滤', async () => {
    await mount();

    const input = container.querySelector<HTMLInputElement>('.contacts-search');
    expect(input).not.toBeNull();
    act(() => {
      // React 受控 input：走原生 setter 再派发 input 事件
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(input, '李四');
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const rows = container.querySelectorAll('.contact-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('李四');
  });

  it('点「写信」交出邮箱并返回邮件视图', async () => {
    await mount();

    const compose = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '写信',
    );
    expect(compose).toBeTruthy();
    act(() => {
      compose!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(composed[0]).toEqual({
      email: 'zhangsan@example.com',
      displayName: '张三',
    });
    expect(backed).toBe(1);
  });
});
