// @vitest-environment jsdom
/**
 * 侧栏底部导航的插件图标（`views['sidebar-item']`）。
 *
 * 为什么需要它：
 *  - `sidebar-item` 以前只是个「声明了但没人渲染」的死槽位，插件写进清单也不会出现；
 *  - 现在接上了，而且**折叠态和展开态是两段独立 JSX** —— 只改一处的话，
 *    用户把侧栏收起来（或展开）图标就消失了，光看代码很难发现；
 *  - 所以这里既真渲染两种形态，也用源码契约钉住「两处都接了」。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, createElement } from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Sidebar } from '../src/renderer/components/Sidebar';
import type { WorkspaceView } from '../src/renderer/stores/mail-store';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const ENTRIES = [{ id: 'demo-plugin', name: '演示插件' }];

let container: HTMLDivElement;
let root: Root;
let opened: string[];

interface MountOptions {
  collapsed?: boolean;
  activeView?: WorkspaceView;
  activePluginId?: string | null;
}

async function mount(options: MountOptions = {}): Promise<void> {
  await act(async () => {
    root.render(
      createElement(Sidebar, {
        accounts: [],
        foldersByAccount: {},
        activeAccountId: null,
        activeFolder: 'INBOX',
        activeView: options.activeView ?? 'mail',
        unified: false,
        collapsed: options.collapsed ?? false,
        onSelectAccount: () => {},
        onSelectUnified: () => {},
        onOpenDrafts: () => {},
        draftCount: 0,
        onOpenOutbox: () => {},
        outboxCount: 0,
        onSelectFolder: () => {},
        onEnsureFolders: () => {},
        onOpenView: () => {},
        onOpenCalendar: () => {},
        onOpenContacts: () => {},
        pluginEntries: ENTRIES,
        activePluginId: options.activePluginId ?? null,
        onOpenPluginView: (id: string) => opened.push(id),
      }),
    );
    // 让两个 getSetting 的 Promise 结算
    await Promise.resolve();
  });
}

function pluginButton(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('button[title="演示插件"]');
}

beforeEach(() => {
  (window as unknown as { api: unknown }).api = {
    getSetting: async () => ({ ok: true, data: null }),
  };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  opened = [];
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('侧栏插件图标', () => {
  it('展开态在底部导航渲染插件图标，点击通知宿主打开该插件视图', async () => {
    await mount({ collapsed: false });

    const button = pluginButton();
    expect(button).not.toBeNull();
    expect(button?.closest('.sidebar-tools')).not.toBeNull();

    act(() => button?.click());
    expect(opened).toEqual(['demo-plugin']);
  });

  it('折叠态（图标栏）同样渲染插件图标', async () => {
    await mount({ collapsed: true });

    const button = pluginButton();
    expect(button).not.toBeNull();
    expect(button?.closest('.sidebar-rail-bottom')).not.toBeNull();
  });

  it('当前打开该插件视图时图标标记为当前项', async () => {
    await mount({ activeView: 'plugin', activePluginId: 'demo-plugin' });
    expect(pluginButton()?.getAttribute('aria-current')).toBe('true');
  });

  it('其他视图下插件图标不是当前项', async () => {
    await mount({ activeView: 'mail' });
    expect(pluginButton()?.getAttribute('aria-current')).not.toBe('true');
  });
});

describe('接线契约', () => {
  it('折叠态与展开态两段 JSX 都渲染插件图标', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'src/renderer/components/Sidebar.tsx'),
      'utf8',
    );
    const mounts = source.match(/pluginEntries\.map\(/g) ?? [];
    expect(mounts.length).toBe(2);
  });

  it('主区域用 sidebar-item 槽渲染插件视图', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'src/renderer/App.tsx'),
      'utf8',
    );
    expect(source).toContain("pluginsForSlot('sidebar-item')");
    expect(source).toContain('slot="sidebar-item"');
  });
});
