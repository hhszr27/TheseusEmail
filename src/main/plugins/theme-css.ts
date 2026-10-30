/**
 * 插件主题 CSS 安全检查（§13.5）。
 * 插件主题只允许覆盖 --mf-* 变量与常规样式，但必须阻断外部资源加载与旧式可执行 CSS。
 */

export interface CssValidation {
  ok: boolean;
  reason?: string;
}

const MAX_CSS_BYTES = 200 * 1024;

const FORBIDDEN: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /@import/i, reason: 'CSS 不允许 @import' },
  { pattern: /url\(\s*['"]?https?:/i, reason: 'CSS 不允许加载远程资源（url(http…)）' },
  { pattern: /url\(\s*['"]?\/\//i, reason: 'CSS 不允许协议相对 URL（url(//…)）' },
  { pattern: /expression\s*\(/i, reason: 'CSS 不允许 expression()' },
  { pattern: /javascript\s*:/i, reason: 'CSS 不允许 javascript: URL' },
  { pattern: /behavior\s*:/i, reason: 'CSS 不允许 behavior 属性' },
  { pattern: /-moz-binding/i, reason: 'CSS 不允许 -moz-binding' },
  { pattern: /<\/?script/i, reason: 'CSS 中不允许出现 script 标签片段' },
  { pattern: /<\/style/i, reason: 'CSS 中不允许出现 </style' },
];

export function validateThemeCss(css: string): CssValidation {
  if (Buffer.byteLength(css, 'utf8') > MAX_CSS_BYTES) {
    return { ok: false, reason: '主题 CSS 超过 200 KB 上限' };
  }

  // 注释中的示例文本不应触发规则（例如说明"不含 @import"）
  const effective = css.replace(/\/\*[\s\S]*?\*\//g, '');

  for (const rule of FORBIDDEN) {
    if (rule.pattern.test(effective)) {
      return { ok: false, reason: rule.reason };
    }
  }
  return { ok: true };
}

/** 只允许覆盖契约变量，供设置页展示主题可控范围（不强制）。 */
export function extractThemeVariables(css: string): string[] {
  const names = new Set<string>();
  const pattern = /--mf-[a-z0-9-]+\s*:/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(css)) !== null) {
    names.add((match[0] ?? '').replace(/\s*:$/, ''));
  }
  return [...names];
}
