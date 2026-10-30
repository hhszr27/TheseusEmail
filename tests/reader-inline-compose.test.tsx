// @vitest-environment jsdom
/**
 * 阅读窗口里的回复（Outlook 式）：
 * 点「回复」后，**同一个窗口**直接切换成内联写信视图，而不是再盖一层弹窗；
 * 点「← 返回邮件」回到正文。这条链路是用户明确要求的交互，必须真渲染才测得出。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, createElement } from 'react';
import { ReaderStandalone } from '../src/renderer/components/ReaderStandalone';
import { useMailStore } from '../src/renderer/stores/mail-store';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const ACCOUNT = {
  id: 'acc-1',
  displayName: '我',
  email: 'me@example.com',
  enabled: true,
  settings: { signature: '', defaultSendAccount: true },
};

const EMAIL = {
  id: 'mail-1',
  uid: 1,
  folder: 'INBOX',
  accountId: 'acc-1',
  subject: '测试邮件',
  from: [{ name: '张三', address: 'z@example.com' }],
  to: [{ name: '我', address: 'me@example.com' }],
  date: new Date('2026-10-28T02:00:00Z').toISOString(),
  snippet: 'snippet',
  hasAttachments: false,
  unread: false,
  starred: false,
  pinned: false,
};

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function mount(): Promise<void> {
  await act(async () => {
    root.render(createElement(ReaderStandalone));
  });
  await flush();
}

/** 设置窗口 URL（阅读窗口靠 query 决定直接打开哪个视图）。 */
function setQuery(query: string): void {
  window.history.replaceState({}, '', `/${query}`);
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  // 阅读窗口靠 ?email=<id> 取目标邮件；jsdom 默认没有 query
  window.history.replaceState({}, '', '/?email=mail-1');

  useMailStore.setState({
    bootstrap: null,
    activeAccountId: null,
    unified: false,
    activeFolder: 'INBOX',
    emails: [],
    total: 0,
    selectedEmailId: null,
    body: null,
    toast: null,
  });

  (window as unknown as { api: unknown }).api = {
    getBootstrap: async () => ({
      ok: true,
      data: {
        accounts: [ACCOUNT],
        folders: [],
        defaultFolder: 'INBOX',
        activeAccountId: 'acc-1',
      },
    }),
    getFolders: async () => ({ ok: true, data: [] }),
    listEmails: async () => ({ ok: true, data: { emails: [], total: 0 } }),
    getEmail: async () => ({ ok: true, data: EMAIL }),
    getBody: async () => ({
      ok: true,
      data: {
        id: 'mail-1',
        html: '',
        text: '正文',
        blockedRemoteImages: 0,
        remoteImages: [],
        sanitized: true,
      },
    }),
    getSetting: async () => ({ ok: false, error: { code: 'NONE', message: 'none' } }),
    listAttachments: async () => ({ ok: true, data: [] }),
    onScanUpdate: () => () => undefined,
    copyText: async () => ({ ok: true, data: true }),
    setPluginDraftContext: async () => ({ ok: true, data: null }),
    onDraftPatch: () => () => undefined,
    getDraft: async () => ({ ok: false, error: { code: 'NONE', message: 'none' } }),
    saveDraft: async () => ({ ok: true, data: { updatedAt: Date.now() } }),
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

describe('阅读窗口：在窗口内回复', () => {
  it('点「回复」后整窗切换成内联写信视图，返回后回到正文', async () => {
    await mount();
    expect(container.querySelector('.reader-pane')).not.toBeNull();

    const reply = Array.from(container.querySelectorAll('.reader-toolbar button')).find(
      (button) => button.textContent?.trim() === '回复',
    ) as HTMLButtonElement | undefined;
    expect(reply).toBeTruthy();
    act(() => {
      reply?.click();
    });
    await flush();

    // 不是遮罩弹层，而是整窗内联写信
    expect(container.querySelector('.compose-inline-host')).not.toBeNull();
    expect(container.querySelector('.overlay')).toBeNull();
    expect(container.querySelector('#compose-to')).not.toBeNull();
    expect((container.querySelector('#compose-to') as HTMLInputElement).value).toContain(
      'z@example.com',
    );
    expect((container.querySelector('#compose-subject') as HTMLInputElement).value).toContain(
      'Re:',
    );

    // 返回：回到正文窗口
    const back = container.querySelector(
      'button[aria-label="返回邮件"]',
    ) as HTMLButtonElement | null;
    expect(back).not.toBeNull();
    act(() => {
      back?.click();
    });
    await flush();

    expect(container.querySelector('.compose-inline-host')).toBeNull();
    expect(container.querySelector('.reader-pane')).not.toBeNull();
  });

  it('主窗口点回复直接打开写信窗口：不显示正文，直接是回复编辑器', async () => {
    setQuery('?email=mail-1&compose=reply');
    await mount();

    expect(container.querySelector('.compose-inline-host')).not.toBeNull();
    expect(container.querySelector('.reader-pane')).toBeNull();
    expect((container.querySelector('#compose-subject') as HTMLInputElement).value).toBe(
      'Re: 测试邮件',
    );
    // 默认保留引用：引用块里有原邮件正文
    expect(container.querySelector('.rich-editor')?.textContent).toContain('正文');
  });

  it('设置关闭「保留引用」后，写信正文不再带原邮件内容', async () => {
    setQuery('?email=mail-1&compose=reply');
    const api = (window as unknown as { api: Record<string, unknown> }).api;
    api.getSetting = async (key: string) =>
      key === 'compose.includeQuote'
        ? { ok: true, data: 'false' }
        : { ok: false, error: { code: 'NONE', message: 'none' } };

    await mount();

    expect(container.querySelector('.compose-inline-host')).not.toBeNull();
    expect((container.querySelector('#compose-subject') as HTMLInputElement).value).toBe(
      'Re: 测试邮件',
    );
    expect(container.querySelector('.rich-editor')?.textContent ?? '').not.toContain('正文');
  });
});
