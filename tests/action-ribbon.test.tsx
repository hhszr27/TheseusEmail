// @vitest-environment jsdom
/**
 * 可折叠带状工具栏（ribbon）的 UI 冒烟：在 jsdom 里真渲染 ActionRibbon，
 * 走「切标签页 → 折叠 → 展开 → 邮件操作禁用态」的真实交互路径。
 *
 * 为什么需要它：ribbon 是纯渲染层组件，逻辑对不对只有真渲染看得出来；
 * 也能守住「条件 return 前不得漏 hook」这类整树白屏问题（React #310）。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, createElement } from 'react';
import type { EmailSummary, FolderView } from '../src/shared/types';
import type { ActionRibbonProps } from '../src/renderer/components/ActionRibbon';
import { ActionRibbon } from '../src/renderer/components/ActionRibbon';
import {
  DEFAULT_RIBBON_CONFIG,
  applyPluginRibbon,
  mergeRibbonConfig,
  type RibbonOverrides,
} from '../src/shared/ribbon';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let commands: Array<{ commandId: string; args?: Record<string, string> }>;
let container: HTMLDivElement;
let root: Root;

function fakeEmail(overrides: Partial<EmailSummary> = {}): EmailSummary {
  return {
    id: 'e1',
    uid: 1,
    folder: 'INBOX',
    accountId: 'acc-1',
    subject: '测试邮件',
    from: [{ address: 'a@example.com' }],
    to: [{ address: 'me@example.com' }],
    date: new Date().toISOString(),
    snippet: 'snippet',
    hasAttachments: false,
    unread: true,
    starred: false,
    pinned: false,
    ...overrides,
  };
}

function fakeFolder(path: string, specialUse?: FolderView['specialUse']): FolderView {
  return {
    accountId: 'acc-1',
    path,
    name: path,
    delimiter: '/',
    ...(specialUse ? { specialUse } : {}),
    unread: 0,
    total: 0,
  };
}

function baseProps(overrides: Partial<ActionRibbonProps> = {}): ActionRibbonProps {
  return {
    config: DEFAULT_RIBBON_CONFIG,
    activeView: 'mail',
    unified: false,
    foldersByAccount: {
      'acc-1': [fakeFolder('INBOX'), fakeFolder('Sent', 'sent'), fakeFolder('Archive', 'archive')],
    },
    selectedEmail: fakeEmail(),
    listFilter: 'all',
    hasAccounts: true,
    onRunCommand: (commandId, args) => {
      commands.push({ commandId, ...(args ? { args } : {}) });
    },
    ...overrides,
  };
}

function mount(props: ActionRibbonProps): void {
  act(() => {
    root.render(createElement(ActionRibbon, props));
  });
}

function btnByTitle(title: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll('button')).find(
    (b) => b.getAttribute('title') === title,
  ) as HTMLButtonElement | undefined;
  if (!btn) throw new Error(`没有 title="${title}" 的按钮`);
  return btn;
}

/** 标签页按钮用可见文字标识（无 title）。 */
function btnByText(text: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll('button')).find(
    (b) => (b.textContent ?? '').trim() === text,
  ) as HTMLButtonElement | undefined;
  if (!btn) throw new Error(`没有文字为「${text}」的按钮`);
  return btn;
}

function click(el: HTMLElement): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function hasButton(label: string): boolean {
  return Array.from(container.querySelectorAll('button')).some((b) =>
    (b.textContent ?? '').includes(label),
  );
}

/** 用可见文字精确匹配按钮。 */
function byText(text: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll('button')).find(
    (b) => (b.textContent ?? '').trim() === text,
  ) as HTMLButtonElement | undefined;
  if (!btn) throw new Error(`没有文字为「${text}」的按钮`);
  return btn;
}

/** 只看标签页按钮（避免「写邮件」这类包含关系的误判）。 */
function hasTab(label: string): boolean {
  return Array.from(container.querySelectorAll('.ribbon-tab')).some(
    (b) => (b.textContent ?? '').trim() === label,
  );
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  commands = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.removeChild(container);
});

describe('可折叠带状工具栏', () => {
  it('默认展开，显示四个标签页与「邮件」页内容', () => {
    window.localStorage.clear();
    mount(baseProps());
    for (const label of ['文件', '邮件', '视图', '工具']) {
      expect(hasButton(label)).toBe(true);
    }
    expect(hasButton('写信')).toBe(true);
    expect(hasButton('回复')).toBe(true);
  });

  it('切到「视图」页显示文件夹与筛选入口', () => {
    window.localStorage.clear();
    mount(baseProps());
    click(btnByText('视图'));
    expect(hasButton('统一收件箱')).toBe(true);
    expect(hasButton('草稿箱')).toBe(true);
    expect(hasButton('未读')).toBe(true);
  });

  it('切到「工具」页显示常用工具', () => {
    window.localStorage.clear();
    mount(baseProps());
    click(btnByText('工具'));
    expect(hasButton('AI 指令')).toBe(true);
    expect(hasButton('命令面板')).toBe(true);
  });

  it('切到「文件」页显示应用级入口（写邮件/设置/退出）', () => {
    window.localStorage.clear();
    mount(baseProps());
    click(btnByText('文件'));
    expect(hasButton('写邮件')).toBe(true);
    expect(hasButton('设置')).toBe(true);
    expect(hasButton('退出应用')).toBe(true);
  });

  it('折叠后标签页行仍在，右侧箭头翻成向下（展开），无居中把手', () => {
    window.localStorage.clear();
    mount(baseProps());
    click(btnByTitle('折叠工具栏'));
    // 折叠后标签页行仍然可见
    expect(hasButton('文件')).toBe(true);
    expect(hasButton('邮件')).toBe(true);
    // 按钮区被收起
    expect(hasButton('写信')).toBe(false);
    // 旧的居中「工具栏」把手已移除
    expect(hasButton('工具栏')).toBe(false);
    // 折叠按钮翻转为「展开工具栏」
    const handle = btnByTitle('展开工具栏');
    expect(handle).toBeTruthy();
    click(handle);
    expect(hasButton('写信')).toBe(true);
  });

  it('折叠态下点标签页会展开并显示对应按钮区', () => {
    window.localStorage.clear();
    mount(baseProps());
    click(btnByTitle('折叠工具栏'));
    expect(hasButton('写邮件')).toBe(false);
    click(btnByText('文件'));
    expect(hasButton('写邮件')).toBe(true);
  });

  it('未选中邮件时，邮件操作按钮禁用；选中后可点', () => {
    window.localStorage.clear();
    mount(baseProps({ selectedEmail: null }));
    const reply = btnByTitle('回复');
    expect(reply.disabled).toBe(true);

    mount(baseProps({ selectedEmail: fakeEmail() }));
    expect(btnByTitle('回复').disabled).toBe(false);
  });

  it('折叠状态用 localStorage 记住', () => {
    window.localStorage.clear();
    mount(baseProps());
    click(btnByTitle('折叠工具栏'));
    expect(window.localStorage.getItem('mailforge.ribbon.collapsed')).toBe('1');
  });

  it('点击按钮走统一命令分发（与快捷键/命令面板同一入口）', () => {
    window.localStorage.clear();
    mount(baseProps());
    click(btnByTitle('写信'));
    click(btnByTitle('回复'));
    expect(commands.map((entry) => entry.commandId)).toEqual(['mail.compose', 'mail.reply']);
  });

  it('参数化命令带上 args（列表筛选）', () => {
    window.localStorage.clear();
    mount(baseProps());
    click(btnByText('视图'));
    click(btnByTitle('未读'));
    expect(commands).toEqual([{ commandId: 'list.filter', args: { filter: 'unread' } }]);
  });

  it('「移动到」下拉点文件夹时带上目标路径', () => {
    window.localStorage.clear();
    mount(baseProps());
    click(btnByTitle('移动到'));
    const item = Array.from(container.querySelectorAll('.ribbon-move-item')).find(
      (el) => (el.textContent ?? '').trim() === 'Archive',
    );
    expect(item).toBeTruthy();
    click(item as HTMLElement);
    expect(commands).toEqual([{ commandId: 'mail.moveTo', args: { folderPath: 'Archive' } }]);
  });

  it('自定义按钮常驻标签行（折叠按钮旁）并分发 ribbon.customize', () => {
    window.localStorage.clear();
    mount(baseProps());
    // 不需要切到「工具」页：它和折叠按钮并排常驻
    click(btnByTitle('自定义功能区'));
    expect(commands).toEqual([{ commandId: 'ribbon.customize' }]);
    // 「工具」页里不再有「自定义」
    click(btnByText('工具'));
    const stillInTools = Array.from(container.querySelectorAll('button')).some(
      (b) => b.getAttribute('title') === '自定义',
    );
    expect(stillInTools).toBe(false);
  });

  it('工具超过上限时折进「更多」菜单，点菜单项走分发', () => {
    window.localStorage.clear();
    const tools = Array.from({ length: 13 }, (_, index) => ({
      id: `x${index}`,
      commandId: `cmd.${index}`,
      label: `工具${index}`,
      icon: 'command' as const,
      when: 'always' as const,
      origin: 'builtin' as const,
    }));
    const config = {
      version: 1,
      tabs: [{ id: 'big', label: '大页', origin: 'builtin', tools }],
    };
    mount(baseProps({ config }));
    // 第 13 个不在内联区
    expect(hasButton('工具12')).toBe(false);
    click(btnByTitle('更多工具（1 个）'));
    click(byText('工具12'));
    expect(commands).toEqual([{ commandId: 'cmd.12' }]);
  });

  it('标签页支持键盘 ←/→ 与 Home/End 切换', () => {
    window.localStorage.clear();
    mount(baseProps());
    // 默认停在「邮件」
    expect(hasButton('写信')).toBe(true);

    const mailTab = byText('邮件');
    act(() => {
      mailTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(hasButton('统一收件箱')).toBe(true);

    act(() => {
      byText('视图').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    });
    expect(hasButton('AI 指令')).toBe(true);

    act(() => {
      byText('工具').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    });
    expect(hasButton('退出应用')).toBe(true);
  });

  it('「移动到」菜单按 Esc 关闭', () => {
    window.localStorage.clear();
    mount(baseProps());
    click(btnByTitle('移动到'));
    expect(container.querySelector('.ribbon-move-menu')).toBeTruthy();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(container.querySelector('.ribbon-move-menu')).toBeNull();
  });

  it('插件贡献的标签页与按钮走 plugin:<id>:<command> 分发', () => {
    window.localStorage.clear();
    const config = applyPluginRibbon(mergeRibbonConfig(DEFAULT_RIBBON_CONFIG, null), [
      {
        pluginId: 'demo',
        pluginName: 'Demo 插件',
        tabs: [{ id: 'helper', label: 'Demo 插件' }],
        tools: [
          { tab: 'helper', id: 'go', label: '插件动作', command: 'demo.act', icon: 'plugin' },
        ],
      },
    ]);
    mount(baseProps({ config }));
    click(btnByText('Demo 插件'));
    click(btnByTitle('插件动作'));
    expect(commands).toEqual([{ commandId: 'plugin:demo:demo.act' }]);
  });

  it('配置驱动：隐藏内置标签并新增自定义标签后按配置渲染', () => {
    window.localStorage.clear();
    const overrides: RibbonOverrides = {
      version: 1,
      hiddenTabs: ['mail', 'view', 'tools'],
      customTabs: [
        {
          id: 'custom:mine',
          label: '我的',
          origin: 'user',
          tools: [
            {
              id: 'custom:tool-1',
              commandId: 'mail.compose',
              label: '新建邮件',
              icon: 'compose',
              when: 'always',
              origin: 'user',
            },
          ],
        },
      ],
    };
    mount(baseProps({ config: mergeRibbonConfig(DEFAULT_RIBBON_CONFIG, overrides) }));
    expect(hasTab('文件')).toBe(true);
    expect(hasTab('邮件')).toBe(false);
    click(btnByText('我的'));
    expect(hasButton('新建邮件')).toBe(true);
    expect(hasButton('写信')).toBe(false);
  });
});
