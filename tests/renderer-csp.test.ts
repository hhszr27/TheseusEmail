import { describe, expect, it } from 'vitest';
import { buildRendererCsp } from '../electron.vite.config';

/**
 * 渲染进程 CSP 的守卫（§10.1）。
 *
 * 背景：正文 iframe 用 srcdoc 渲染，**会继承父文档 CSP**。父策略曾把 img-src
 * 限死为 `'self' data:`，导致阅读区「显示远程图片」点了也没反应（请求被父级以
 * csp 拦截）。这里锁死两条不变量，防止无意中把图片能力又关回去。
 */
function directives(policy: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of policy.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [name = '', ...sources] = trimmed.split(/\s+/);
    map.set(name, sources.join(' '));
  }
  return map;
}

describe('渲染进程 CSP', () => {
  it.each([
    ['生产', false],
    ['开发', true],
  ])('%s 环境下 img-src 放行 https/http（srcdoc 正文才能显示远程图片）', (_label, isDev) => {
    const imgSrc = directives(buildRendererCsp(isDev)).get('img-src') ?? '';
    const sources = imgSrc.split(/\s+/);
    expect(sources).toContain('https:');
    expect(sources).toContain('http:');
  });

  it('生产环境脚本策略不允许内联脚本，其余默认收紧到 self', () => {
    const policy = buildRendererCsp(false);
    const parsed = directives(policy);
    expect(parsed.get('script-src')).toBe("'self'");
    expect(parsed.get('script-src')).not.toContain('unsafe-inline');
    expect(parsed.get('default-src')).toBe("'self'");
  });

  it('开发环境仍允许 HMR 所需的 localhost WebSocket', () => {
    const parsed = directives(buildRendererCsp(true));
    expect(parsed.get('connect-src')).toContain('ws:');
    expect(parsed.get('connect-src')).toContain('http://localhost:*');
  });
});
