import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLUGIN_CSP } from '../src/main/plugins/csp';

/**
 * 插件页面与 CSP 的兼容性守卫（§13.7）。
 *
 * 背景：插件的 CSP 是 `script-src 'self'`，**内联 `<script>` 会被静默拦截**——
 * 不抛错、不加载，页面只会停在初始 HTML。2026-10-27 实测：panel-note 的
 * view.html 用了内联脚本，账户面板永远显示「正在加载账户…」，排查了很久。
 *
 * 两条不变量：
 * 1. CSP 的 script-src 必须是 'self'（不允许为了图方便加 'unsafe-inline'）；
 * 2. 仓库里所有插件 HTML 的 `<script>` 必须外链到同目录、真实存在的文件。
 */

const pluginsRoot = path.resolve('plugins');

function listHtmlFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...listHtmlFiles(full));
    else if (entry.isFile() && /\.html?$/i.test(entry.name)) result.push(full);
  }
  return result;
}

function scriptSrcDirective(policy: string): string {
  const directive = policy
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('script-src'));
  return directive ?? '';
}

describe('插件页面 CSP 兼容性', () => {
  it("script-src 保持 'self'，不允许内联脚本", () => {
    const directive = scriptSrcDirective(PLUGIN_CSP);
    expect(directive).toBe("script-src 'self'");
    expect(directive).not.toContain('unsafe-inline');
  });

  it('所有插件 HTML 的 <script> 都外链到同目录存在的文件', () => {
    const files = listHtmlFiles(pluginsRoot);
    expect(files.length).toBeGreaterThan(0);

    const problems: string[] = [];
    for (const file of files) {
      const relativeFile = path.relative(process.cwd(), file);
      // 去掉注释，避免注释里提到的示例代码被误判
      const html = fs.readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '');

      for (const match of html.matchAll(/<script\b([^>]*)>/gi)) {
        const attrs = match[1] ?? '';
        const src = /src\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];

        if (!src) {
          problems.push(`${relativeFile}: 内联 <script> 会被 CSP 静默拦截，请改为外部脚本`);
          continue;
        }
        if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//')) {
          problems.push(`${relativeFile}: 插件脚本不能指向外部地址（${src}）`);
          continue;
        }

        const target = path.resolve(path.dirname(file), src.split(/[?#]/)[0] ?? src);
        if (!fs.existsSync(target)) {
          problems.push(`${relativeFile}: 引用的脚本不存在（${src}）`);
        }
      }
    }

    expect(problems).toEqual([]);
  });
});
