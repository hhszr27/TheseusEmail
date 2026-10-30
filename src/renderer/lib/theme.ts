/**
 * 渲染进程主题应用（§13.5）。
 * 内置主题通过 data-theme 切换；插件主题通过 <style> 热替换，不重启。
 */

const STYLE_ID = 'mf-plugin-theme';

function styleElement(): HTMLStyleElement {
  let element = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!element) {
    element = document.createElement('style');
    element.id = STYLE_ID;
    document.head.appendChild(element);
  }
  return element;
}

export function applyBuiltinTheme(themeId: string): void {
  const root = document.documentElement;
  // v3.3：浅色是默认主题，深色通过 data-theme='dark' 覆盖变量
  if (themeId === 'builtin:dark') {
    root.dataset.theme = 'dark';
  } else {
    delete root.dataset.theme;
  }
  styleElement().textContent = '';
}

export interface ApplyThemeResult {
  ok: boolean;
  reason?: string;
}

/** 应用主题；插件 CSS 未通过安全检查时返回失败，由调用方回退。 */
export async function applyTheme(themeId: string): Promise<ApplyThemeResult> {
  if (themeId === 'builtin:dark' || themeId === 'builtin:light') {
    applyBuiltinTheme(themeId);
    return { ok: true };
  }

  const result = await window.api.getPluginTheme(themeId);
  if (!result.ok) {
    return { ok: false, reason: result.reason ?? '主题不可用' };
  }

  // 插件主题通常覆盖深色变量；先回到内置暗色，再叠加插件 CSS
  document.documentElement.dataset.theme = 'dark';
  styleElement().textContent = result.css ?? '';
  return { ok: true };
}
