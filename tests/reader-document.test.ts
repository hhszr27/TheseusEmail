// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  buildReaderDocument,
  colorSchemeFor,
  readReaderTheme,
  type ReaderTheme,
} from '../src/renderer/lib/reader-document';

function cspDirectives(doc: string): Map<string, string> {
  const meta = /content="([^"]+)"/.exec(doc);
  const policy = meta?.[1] ?? '';
  const map = new Map<string, string>();
  for (const part of policy.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [name, ...sources] = trimmed.split(/\s+/);
    if (name) map.set(name, sources.join(' '));
  }
  return map;
}

const LIGHT: ReaderTheme = {
  background: '#ffffff',
  text: '#1a1a1a',
  secondary: '#555555',
  border: '#e0e0e0',
  fontFamily: 'system-ui, sans-serif',
};

const DARK: ReaderTheme = {
  background: '#1a1a1a',
  text: '#e6e6e6',
  secondary: '#aaaaaa',
  border: '#333333',
  fontFamily: 'system-ui, sans-serif',
};

describe('colorSchemeFor — 背景色决定 iframe 的 light/dark', () => {
  it('亮色背景判定为 light（含 3 位缩写与大小写）', () => {
    expect(colorSchemeFor('#ffffff')).toBe('light');
    expect(colorSchemeFor('#fff')).toBe('light');
    expect(colorSchemeFor('#FFFFFF')).toBe('light');
  });

  it('暗色背景判定为 dark（典型邮件正文底色）', () => {
    expect(colorSchemeFor('#000000')).toBe('dark');
    expect(colorSchemeFor('#1a1a1a')).toBe('dark');
  });

  it('中灰（相对亮度 ~0.216 < 0.5）判定为 dark，而不是 light', () => {
    // 若阈值或公式写错，这条会翻成 light
    expect(colorSchemeFor('#808080')).toBe('dark');
  });

  it('非 hex（空串 / 关键字 / rgb()）安全回落 light，不会误判为暗色', () => {
    expect(colorSchemeFor('')).toBe('light');
    expect(colorSchemeFor('inherit')).toBe('light');
    expect(colorSchemeFor('rgb(0,0,0)')).toBe('light');
  });
});

describe('buildReaderDocument — color-scheme 跟随主题（修掉硬编码 light）', () => {
  it('暗色主题 → color-scheme: dark（暗色模式下滚动条/原生控件不再突兀亮色）', () => {
    const doc = buildReaderDocument('<p>hi</p>', { allowRemoteImages: false, theme: DARK });
    expect(doc).toContain(':root { color-scheme: dark; }');
  });

  it('亮色主题 → color-scheme: light', () => {
    const doc = buildReaderDocument('<p>hi</p>', { allowRemoteImages: false, theme: LIGHT });
    expect(doc).toContain(':root { color-scheme: light; }');
  });
});

describe('buildReaderDocument — CSP 安全不变量', () => {
  it('允许远程图片时 img-src 放行 https/http/data:（srcdoc 正文才能显示远程图）', () => {
    const doc = buildReaderDocument('<p>x</p>', { allowRemoteImages: true, theme: LIGHT });
    const sources = (cspDirectives(doc).get('img-src') ?? '').split(/\s+/);
    expect(sources).toContain('https:');
    expect(sources).toContain('http:');
    expect(sources).toContain('data:');
  });

  it('禁止远程图片时 img-src 只剩 data:，不外泄到任何外网源', () => {
    const doc = buildReaderDocument('<p>x</p>', { allowRemoteImages: false, theme: LIGHT });
    const imgSrc = cspDirectives(doc).get('img-src') ?? '';
    expect(imgSrc.trim()).toBe('data:');
  });

  it('iframe 内禁止任何脚本执行（无 allow-scripts、script-src none）', () => {
    const doc = buildReaderDocument('<p>x</p>', { allowRemoteImages: false, theme: LIGHT });
    expect(cspDirectives(doc).get('script-src')).toBe("'none'");
    expect(doc).not.toContain('allow-scripts');
  });

  it('基础策略：style 内联、font 走 data:、default 收紧到 none', () => {
    const doc = buildReaderDocument('<p>x</p>', { allowRemoteImages: false, theme: LIGHT });
    const d = cspDirectives(doc);
    expect(d.get('style-src')).toContain("'unsafe-inline'");
    expect(d.get('font-src')).toContain('data:');
    expect(d.get('default-src')).toBe("'none'");
  });

  it('净化后的正文 HTML 原样注入 body（不二次转义、不被丢）', () => {
    const doc = buildReaderDocument('<p>marker-injected</p>', { allowRemoteImages: false, theme: LIGHT });
    expect(doc).toContain('<body><p>marker-injected</p></body>');
  });
});

describe('readReaderTheme', () => {
  it('从 CSS 自定义属性读取主题色', () => {
    document.documentElement.style.setProperty('--mf-color-reader-bg', '#0b0b0b');
    document.documentElement.style.setProperty('--mf-color-reader-text', '#f2f2f2');
    const theme = readReaderTheme();
    expect(theme.background).toBe('#0b0b0b');
    expect(theme.text).toBe('#f2f2f2');
  });

  it('window 不存在时回落内置浅色主题（非 DOM 环境安全）', () => {
    const original = globalThis.window;
    try {
      vi.stubGlobal('window', undefined);
      const theme = readReaderTheme();
      expect(theme.background).toBe('#ffffff');
      expect(theme.text).toBe('#1a1a1a');
      expect(theme.secondary).toBe('#555555');
      expect(theme.border).toBe('#e0e0e0');
      expect(theme.fontFamily).toBe('system-ui, sans-serif');
    } finally {
      vi.stubGlobal('window', original);
    }
  });
});
