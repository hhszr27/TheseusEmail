/**
 * 邮件正文沙箱文档构建（§10.1）。
 *
 * 宿主只注入 CSP 与基础排版样式，正文 HTML 已由主进程净化。
 * iframe 使用 sandbox="allow-same-origin"（不含 allow-scripts），
 * 因此文档内没有任何脚本能执行；链接拦截由宿主在 contentDocument 上挂监听完成。
 */

export interface ReaderTheme {
  background: string;
  text: string;
  secondary: string;
  border: string;
  fontFamily: string;
}

const FALLBACK_THEME: ReaderTheme = {
  background: '#ffffff',
  text: '#1a1a1a',
  secondary: '#555555',
  border: '#e0e0e0',
  fontFamily: 'system-ui, sans-serif',
};

/**
 * 从背景色推断 color-scheme，让阅读区 iframe 在暗色主题下也使用暗色滚动条/原生控件。
 *
 * 原来这里硬编码 `color-scheme: light`，即便正文配色已经跟随暗色主题，iframe 里的
 * 滚动条、<input>/<select> 等原生控件仍是亮色——暗色模式下读信会看到一条突兀的亮色
 * 滚动条。这里按相对亮度（sRGB 相对亮度）判定：背景偏暗就标 dark。
 * 解析失败（非 hex）一律回落 light，避免误判把亮色主题翻成暗色。
 */
export function colorSchemeFor(background: string): 'light' | 'dark' {
  const hex = (background || '').trim();
  // 3 位 / 6 位 hex，大小写均可；命名捕获组拿到的就是 string（noUncheckedIndexedAccess 下也非 undefined）
  const m = /^#(?<digits>[0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
  if (!m?.groups?.digits) return 'light';
  const d = m.groups.digits;
  const full = d.length === 3 ? d.split('').map((c) => c + c).join('') : d;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  const channel = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  return luminance < 0.5 ? 'dark' : 'light';
}

export function readReaderTheme(): ReaderTheme {
  if (typeof window === 'undefined') return FALLBACK_THEME;
  const styles = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string): string => {
    const value = styles.getPropertyValue(name).trim();
    return value || fallback;
  };
  return {
    background: read('--mf-color-reader-bg', FALLBACK_THEME.background),
    text: read('--mf-color-reader-text', FALLBACK_THEME.text),
    secondary: read('--mf-color-reader-secondary', FALLBACK_THEME.secondary),
    border: read('--mf-color-reader-border', FALLBACK_THEME.border),
    fontFamily: read('--mf-font-family', FALLBACK_THEME.fontFamily),
  };
}

export interface ReaderDocumentOptions {
  allowRemoteImages: boolean;
  theme: ReaderTheme;
}

export function buildReaderDocument(html: string, options: ReaderDocumentOptions): string {
  const { theme } = options;
  const imgSrc = options.allowRemoteImages ? 'data: https: http:' : 'data:';
  const csp = [
    "default-src 'none'",
    `img-src ${imgSrc}`,
    "style-src 'unsafe-inline'",
    "script-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "font-src data:",
  ].join('; ');

  const colorScheme = colorSchemeFor(theme.background);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  :root { color-scheme: ${colorScheme}; }
  html, body { margin: 0; padding: 0; background: ${theme.background}; }
  body {
    padding: 20px 24px 32px;
    color: ${theme.text};
    font-family: ${theme.fontFamily};
    font-size: 15px;
    line-height: 1.62;
    overflow-wrap: anywhere;
    -webkit-font-smoothing: antialiased;
  }
  /* 宽阅读区多留白，避免行长过长影响阅读 */
  @media (min-width: 1080px) {
    body { padding: 24px 48px 44px; }
  }
  p { margin: 0 0 13px; }
  h1, h2, h3, h4, h5, h6 { margin: 1.15em 0 0.55em; font-weight: 600; line-height: 1.3; }
  h1 { font-size: 1.5em; }
  h2 { font-size: 1.28em; }
  h3 { font-size: 1.14em; }
  h1:first-child, h2:first-child, h3:first-child, h4:first-child { margin-top: 0; }
  ul, ol { margin: 0 0 13px; padding-left: 22px; }
  li { margin: 3px 0; }
  img { max-width: 100%; height: auto; }
  img[data-mf-placeholder] {
    display: inline-block;
    width: 100%;
    min-height: 56px;
    max-height: 140px;
    object-fit: contain;
    background: #eef1f4;
    border: 1px dashed ${theme.border};
    border-radius: 4px;
  }
  a { color: #0f6cbd; text-decoration: none; }
  a:hover { text-decoration: underline; }
  /* 表格：只做溢出保护，不改邮件自身的单元格间距/对齐（大量邮件用表格排版） */
  table { border-collapse: collapse; max-width: 100%; }
  /* 仅显式声明 border 属性（非 0）的数据表格才画网格线 */
  table[border]:not([border="0"]) td,
  table[border]:not([border="0"]) th {
    border: 1px solid ${theme.border};
    padding: 6px 10px;
  }
  blockquote {
    margin: 14px 0;
    padding: 2px 0 2px 14px;
    border-left: 3px solid ${theme.border};
    color: ${theme.secondary};
  }
  pre {
    padding: 12px 14px;
    background: #f6f8fa;
    border: 1px solid ${theme.border};
    border-radius: 6px;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: "Cascadia Mono", Consolas, monospace;
    font-size: 13px;
  }
  code { font-family: "Cascadia Mono", Consolas, monospace; }
  hr { border: 0; border-top: 1px solid ${theme.border}; margin: 20px 0; }
  /* 搜索命中：宿主在 contentDocument 上注册 Range（CSS Custom Highlight API）。
     只上色、不改 DOM，因此不影响链接拦截、右键菜单与 iframe 自适应高度。 */
  ::highlight(mf-search) {
    background-color: #fde047;
    color: #111111;
  }
</style>
</head>
<body>${html}</body>
</html>`;
}
