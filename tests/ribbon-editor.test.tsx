// @vitest-environment jsdom
/**
 * Ribbon 自定义编辑器的 UI 冒烟。
 *
 * 重点守两条真实路径：
 *  1. 隐藏内置项 → 保存 → 落库的 JSON 里带 hiddenTabs / hiddenTools；
 *  2. 加一个自建工具 → 保存 → 落库的 JSON 里带 addedTools。
 * 这两条是「用户能替换/删除我们生成的内容」的唯一入口，必须真渲染才算数。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, createElement } from 'react';
import { RibbonCustomizeDialog } from '../src/renderer/components/RibbonCustomizeDialog';
import { DEFAULT_RIBBON_CONFIG, parseRibbonOverrides } from '../src/shared/ribbon';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let container: HTMLDivElement;
let root: Root;
let saved: string[];

type DialogProps = Parameters<typeof RibbonCustomizeDialog>[0];

function mount(props: Partial<DialogProps> = {}): void {
  act(() => {
    root.render(
      createElement(RibbonCustomizeDialog, {
        config: DEFAULT_RIBBON_CONFIG,
        overrides: null,
        onSave: (json: string) => {
          saved.push(json);
        },
        onClose: () => undefined,
        ...props,
      }),
    );
  });
}

function buttons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button'));
}

function byTitle(title: string): HTMLButtonElement {
  const btn = buttons().find((b) => b.getAttribute('title') === title);
  if (!btn) throw new Error(`没有 title="${title}" 的按钮`);
  return btn;
}

function byAria(label: string): HTMLButtonElement {
  const btn = buttons().find((b) => b.getAttribute('aria-label') === label);
  if (!btn) throw new Error(`没有 aria-label="${label}" 的按钮`);
  return btn;
}

function selectByAria(label: string): HTMLSelectElement {
  const el = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  if (!el) throw new Error(`没有 aria-label="${label}" 的 select`);
  return el;
}

/** 底部操作按钮用可见文字标识（无 title）。 */
function byText(text: string): HTMLButtonElement {
  const btn = buttons().find((b) => (b.textContent ?? '').trim() === text);
  if (!btn) throw new Error(`没有文字为「${text}」的按钮`);
  return btn;
}

function click(el: HTMLElement): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function hasText(text: string): boolean {
  return (container.textContent ?? '').includes(text);
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  saved = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.removeChild(container);
});

describe('Ribbon 自定义编辑器', () => {
  it('渲染内置默认的全部标签页与工具', () => {
    mount();
    for (const label of ['文件', '邮件', '视图', '工具']) {
      expect(hasText(label)).toBe(true);
    }
    expect(hasText('mail.moveTo')).toBe(true);
  });

  it('隐藏内置标签页后保存，落库 JSON 带 hiddenTabs', () => {
    mount();
    click(byAria('隐藏 视图'));
    click(byText('保存'));
    expect(saved.length).toBe(1);
    const parsed = parseRibbonOverrides(saved[0]);
    expect(parsed?.hiddenTabs).toContain('view');
  });

  it('隐藏内置工具后保存，落库 JSON 带 hiddenTools', () => {
    mount();
    click(byText('邮件'));
    click(byAria('隐藏 全部回复'));
    click(byText('保存'));
    const parsed = parseRibbonOverrides(saved[0]);
    expect(parsed?.hiddenTools).toContain('mail.replyAll');
  });

  it('取消隐藏不会写进 hiddenTools', () => {
    mount();
    click(byText('邮件'));
    click(byAria('隐藏 全部回复'));
    click(byAria('取消隐藏 全部回复'));
    click(byText('保存'));
    const parsed = parseRibbonOverrides(saved[0]);
    expect(parsed?.hiddenTools ?? []).not.toContain('mail.replyAll');
  });

  it('添加自建工具后保存，落库 JSON 带 addedTools', () => {
    mount();
    click(byText('邮件'));
    const select = container.querySelector<HTMLSelectElement>('#ribbon-add-command');
    expect(select).toBeTruthy();
    if (!select) return;
    act(() => {
      // 走真实 change 事件路径，而不是直接改 state
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        'value',
      )?.set;
      setter?.call(select, 'calendar.open');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(hasText('打开日历')).toBe(true);
    click(byText('保存'));
    const parsed = parseRibbonOverrides(saved[0]);
    const added = parsed?.addedTools?.mail ?? [];
    expect(added.length).toBe(1);
    expect(added[0]?.commandId).toBe('calendar.open');
  });

  it('重命名内置标签页后保存，落库 JSON 带 tabLabels', () => {
    mount();
    click(byTitle('重命名'));
    const input = container.querySelector<HTMLInputElement>('.ribbon-editor-rename input');
    expect(input).toBeTruthy();
    if (!input) return;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, '收件');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    click(byTitle('确认改名'));
    click(byText('保存'));
    const parsed = parseRibbonOverrides(saved[0]);
    expect(parsed?.tabLabels?.file).toBe('收件');
  });

  it('重命名内置工具后保存，落库 JSON 带 toolLabels', () => {
    mount();
    click(byAria('重命名工具 写邮件'));
    const input = container.querySelector<HTMLInputElement>('.ribbon-editor-rename input');
    expect(input).toBeTruthy();
    if (!input) return;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, '新邮件');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    click(byTitle('确认改名'));
    click(byText('保存'));
    const parsed = parseRibbonOverrides(saved[0]);
    expect(parsed?.toolLabels?.['file.compose']).toBe('新邮件');
  });

  it('自建工具可以设置显示条件并落库', () => {
    mount();
    click(byText('邮件'));
    const select = container.querySelector<HTMLSelectElement>('#ribbon-add-command');
    expect(select).toBeTruthy();
    if (!select) return;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
      setter?.call(select, 'calendar.open');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    // 真的把条件从默认的「始终显示」改成「选中邮件时」
    const whenSelect = selectByAria('显示条件：打开日历');
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
      setter?.call(whenSelect, 'mailSelected');
      whenSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    click(byText('保存'));
    const parsed = parseRibbonOverrides(saved[0]);
    expect(parsed?.addedTools?.mail?.[0]?.when).toBe('mailSelected');
  });

  it('导入配置：合法 JSON 替换草稿并可保存', () => {
    mount();
    click(byText('导入配置'));
    const textarea = container.querySelector<HTMLTextAreaElement>('#ribbon-import-text');
    expect(textarea).toBeTruthy();
    if (!textarea) return;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      setter?.call(
        textarea,
        JSON.stringify({
          tabs: [{ id: 'custom:imp', label: '导入的', origin: 'user', tools: [] }],
        }),
      );
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    click(byText('应用导入'));
    expect(hasText('导入的')).toBe(true);
    click(byText('保存'));
    const parsed = parseRibbonOverrides(saved[0]);
    expect(parsed?.customTabs?.[0]?.id).toBe('custom:imp');
  });

  it('导入配置：坏 JSON 报错且不改动草稿', () => {
    mount();
    click(byText('导入配置'));
    const textarea = container.querySelector<HTMLTextAreaElement>('#ribbon-import-text');
    expect(textarea).toBeTruthy();
    if (!textarea) return;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      setter?.call(textarea, '这不是 json');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    click(byText('应用导入'));
    expect(hasText('无法解析')).toBe(true);
    click(byText('保存'));
    const parsed = parseRibbonOverrides(saved[0]);
    // 草稿仍是内置默认：没有任何自建标签
    expect(parsed?.customTabs).toBeUndefined();
  });

  it('可以单独关掉某个插件的工具栏贡献（不影响插件本身）', () => {
    mount({
      pluginContributions: [
        { pluginId: 'demo', pluginName: 'Demo 插件', tabs: [{ id: 't', label: 'Demo' }], tools: [] },
      ],
    });
    expect(hasText('Demo 插件')).toBe(true);
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox).toBeTruthy();
    if (!checkbox) return;
    expect(checkbox.checked).toBe(true);
    click(checkbox);
    click(byText('保存'));
    expect(parseRibbonOverrides(saved[0])?.hiddenPlugins).toEqual(['demo']);
  });

  it('重新勾选后不再写 hiddenPlugins', () => {
    mount({
      overrides: { version: 1, hiddenPlugins: ['demo'] },
      pluginContributions: [
        { pluginId: 'demo', pluginName: 'Demo 插件', tabs: [], tools: [] },
      ],
    });
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox).toBeTruthy();
    if (!checkbox) return;
    expect(checkbox.checked).toBe(false);
    click(checkbox);
    click(byText('保存'));
    expect(parseRibbonOverrides(saved[0])?.hiddenPlugins).toBeUndefined();
  });

  it('恢复默认后保存，落库 JSON 不含任何隐藏', () => {
    mount();
    click(byAria('隐藏 工具'));
    click(byText('恢复默认'));
    click(byText('保存'));
    const parsed = parseRibbonOverrides(saved[0]);
    expect(parsed?.hiddenTabs).toBeUndefined();
    expect(parsed?.hiddenTools).toBeUndefined();
    expect(parsed?.tabLabels).toBeUndefined();
  });

  it('隐藏全部标签页时拒绝保存并提示', () => {
    mount();
    for (const label of ['文件', '邮件', '视图', '工具']) {
      click(byAria(`隐藏 ${label}`));
    }
    click(byText('保存'));
    expect(saved.length).toBe(0);
    expect(hasText('至少保留一个可见的标签页')).toBe(true);
  });

  it('自建标签页可整条删除', () => {
    mount();
    click(byText('+ 新建标签页'));
    expect(hasText('新标签页')).toBe(true);
    click(byAria('删除此标签页 · 新标签页'));
    expect(hasText('新标签页')).toBe(false);
  });

  it('点遮罩关闭', () => {
    let closed = 0;
    act(() => {
      root.render(
        createElement(RibbonCustomizeDialog, {
          config: DEFAULT_RIBBON_CONFIG,
          overrides: null,
          onSave: () => undefined,
          onClose: () => {
            closed += 1;
          },
        }),
      );
    });
    const overlay = container.querySelector<HTMLElement>('.overlay.overlay-dialog');
    expect(overlay).toBeTruthy();
    if (!overlay) return;
    click(overlay);
    expect(closed).toBe(1);
  });
});
