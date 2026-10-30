// @vitest-environment jsdom
/**
 * 查找栏的 UI 接线：在 jsdom 里真渲染一整个 RichTextEditor，
 * 走「点查找按钮 → 看命中计数 → 全部替换」的真实交互路径。
 *
 * 为什么需要它：单测只保证命令对，按钮挂没挂对命令、计数读没读对 storage
 * 只有真渲染才看得出来（上一轮查找替换就是「逻辑绿、界面 FAIL」）。
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, createElement } from 'react';
import { RichTextEditor } from '../src/renderer/components/RichTextEditor';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let container: HTMLDivElement;
let root: Root;

function mount(value: string): void {
  act(() => {
    root.render(
      createElement(RichTextEditor, {
        value,
        onChange: () => undefined,
        id: 'test-editor',
      }),
    );
  });
}

/** 按可见文字找按钮（工具栏里同名按钮很多，这里只在查找栏里找）。 */
function findBar(): HTMLElement {
  const bar = container.querySelector('[aria-label="查找替换"]');
  if (!bar) throw new Error('查找栏没渲染出来');
  return bar as HTMLElement;
}

function clickButton(label: string): void {
  const bar = findBar();
  const btn = Array.from(bar.querySelectorAll('button')).find((b) => b.textContent === label);
  if (!btn) throw new Error(`查找栏里没有「${label}」按钮`);
  act(() => {
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function typeInto(placeholder: string, text: string): void {
  const bar = findBar();
  const input = Array.from(bar.querySelectorAll('input')).find(
    (i) => (i as HTMLInputElement).placeholder === placeholder,
  ) as HTMLInputElement | undefined;
  if (!input) throw new Error(`查找栏里没有 placeholder=${placeholder} 的输入框`);
  act(() => {
    // React 受控输入：改 value 后派发 input 事件（原生 setter 绕开 React 的 value 缓存）
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function countText(): string {
  return (findBar().querySelector('.rich-find-count') as HTMLElement).textContent ?? '';
}

function bodyText(): string {
  return (container.querySelector('.rich-editor') as HTMLElement).textContent ?? '';
}

function highlightCount(): number {
  return container.querySelectorAll('.mf-search-hit').length;
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root.unmount());
});

describe('查找栏 UI', () => {
  it('挂载后能打开查找栏，初始显示无匹配', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mount('<p>重要通知：本周五开会。</p>');

    const toolbarBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.getAttribute('title') === '查找 / 替换',
    );
    expect(toolbarBtn).toBeTruthy();
    act(() => {
      toolbarBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(findBar()).toBeTruthy();
    expect(countText()).toBe('无匹配');
    document.body.removeChild(container);
  });

  it('输入词点查找：计数与高亮都对', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mount('<p>通知 通知</p>');

    const toolbarBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.getAttribute('title') === '查找 / 替换',
    );
    act(() => {
      toolbarBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    typeInto('要找的文字', '通知');
    clickButton('查找');

    expect(countText()).toBe('1/2');
    expect(highlightCount()).toBe(2);
    document.body.removeChild(container);
  });

  it('全部替换：正文与计数同步刷新', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mount('<p>重要通<strong>知</strong>：开会</p>');

    const toolbarBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.getAttribute('title') === '查找 / 替换',
    );
    act(() => {
      toolbarBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    typeInto('要找的文字', '通知');
    typeInto('替换成', '公告');
    clickButton('查找');
    expect(countText()).toBe('1/1');
    clickButton('全部替换');

    expect(bodyText()).toContain('公告');
    expect(bodyText()).not.toContain('通知');
    expect(countText()).toBe('无匹配');
    expect(highlightCount()).toBe(0);
    document.body.removeChild(container);
  });

  it('区分大小写复选框会改命中数', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mount('<p>Mail mail</p>');

    const toolbarBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.getAttribute('title') === '查找 / 替换',
    );
    act(() => {
      toolbarBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    typeInto('要找的文字', 'ail');
    clickButton('查找');
    expect(countText()).toBe('1/2');

    const box = findBar().querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(box.checked).toBe(false);
    act(() => {
      box.click();
    });
    // 复选框是受控的：勾上后必须回显成勾选，否则说明 storage 没同步回去
    expect(
      (findBar().querySelector('input[type="checkbox"]') as HTMLInputElement).checked,
    ).toBe(true);

    // "Mail mail"：不敏感时 2 条，敏感后只剩同形的 1 条
    typeInto('要找的文字', 'Mail');
    clickButton('查找');
    expect(countText()).toBe('1/1');
    document.body.removeChild(container);
  });
});
