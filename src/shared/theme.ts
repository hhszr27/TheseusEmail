/**
 * 主题契约的默认值（与 renderer/theme/contract.css 保持一致）。
 * 插件视图读不到宿主 DOM，只能通过 getThemeVariables() 拿到当前主题的变量。
 * 浅色是 v3.3 的默认主题（对应 contract.css 的 :root），插件面板必须跟随，
 * 否则浅色界面里会弹出一块深色面板。
 */
export const LIGHT_THEME_VARIABLES: Record<string, string> = {
  '--mf-color-bg': '#f3f4f6',
  '--mf-color-surface': '#ffffff',
  '--mf-color-surface-raised': '#fafbfc',
  '--mf-color-surface-hover': '#f3f4f6',
  '--mf-color-text': '#1a1a1a',
  '--mf-color-text-secondary': '#6b7280',
  '--mf-color-text-muted': '#9ca3af',
  '--mf-color-accent': '#2563eb',
  '--mf-color-accent-contrast': '#ffffff',
  '--mf-color-border': '#e5e7eb',
  '--mf-color-border-strong': '#d1d5db',
  '--mf-color-danger': '#dc2626',
  '--mf-color-warning': '#ea580c',
  '--mf-color-success': '#16a34a',
  '--mf-font-family':
    '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  '--mf-radius-sm': '4px',
  '--mf-radius-md': '8px',
  '--mf-spacing-unit': '8px',
};

/**
 * 深色变量：`builtin:dark` 使用；插件主题也按深色处理，
 * 因为 renderer/lib/theme.ts 在叠加插件 CSS 前会先切到 data-theme='dark'。
 */
export const DEFAULT_THEME_VARIABLES: Record<string, string> = {
  '--mf-color-bg': '#0f1419',
  '--mf-color-surface': '#161d25',
  '--mf-color-surface-raised': '#1d2732',
  '--mf-color-surface-hover': '#222e3a',
  '--mf-color-text': '#e6edf3',
  '--mf-color-text-secondary': '#9aa7b4',
  '--mf-color-text-muted': '#6b7785',
  '--mf-color-accent': '#4c9aff',
  '--mf-color-accent-contrast': '#0b1220',
  '--mf-color-border': '#26313c',
  '--mf-color-border-strong': '#354454',
  '--mf-color-danger': '#e07a7a',
  '--mf-color-warning': '#d9a441',
  '--mf-color-success': '#58b982',
  '--mf-font-family': 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
  '--mf-radius-sm': '4px',
  '--mf-radius-md': '8px',
  '--mf-spacing-unit': '8px',
};

/**
 * 按当前主题 id 取插件可见的 CSS 变量。
 * - 未设置 / builtin:light → 浅色（v3.3 默认）
 * - builtin:dark 与插件主题 → 深色
 */
export function themeVariablesFor(themeId: string | null | undefined): Record<string, string> {
  if (!themeId || themeId === 'builtin:light') return LIGHT_THEME_VARIABLES;
  return DEFAULT_THEME_VARIABLES;
}

export const THEME_SETTING_KEY = 'theme';
export const KEYBINDINGS_SETTING_KEY = 'keybindings';
export const FTS_LAST_OPTIMIZE_KEY = 'fts.lastOptimizeAt';
