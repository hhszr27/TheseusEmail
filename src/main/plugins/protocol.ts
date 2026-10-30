import { protocol, session } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolvePluginAsset } from './manifest';
import { PLUGIN_CSP, PLUGIN_SCHEME } from './csp';

export { PLUGIN_CSP, PLUGIN_SCHEME };

/**
 * 插件资源协议（§13.7）。
 * 使用独立 scheme，避免 file:// 权限扩散；只服务已加载插件的目录内文件。
 */

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

function injectCsp(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${PLUGIN_CSP}">`;
  if (/<head[\s>]/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>${meta}`);
  }
  return `${meta}${html}`;
}

export function registerPluginScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PLUGIN_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: false,
        corsEnabled: false,
        stream: true,
      },
    },
  ]);
}

type AssetResolver = (pluginId: string) => string | null;

function createHandler(getPluginDir: AssetResolver): (request: Request) => Promise<Response> {
  return async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response('bad request', { status: 400 });
    }

    const pluginId = url.hostname;
    const dir = getPluginDir(pluginId);
    if (!dir) {
      return new Response('plugin not available', { status: 404 });
    }

    const relative = decodeURIComponent(url.pathname.replace(/^\/+/, '')) || 'index.html';
    const file = resolvePluginAsset(dir, relative);
    if (!file) {
      return new Response('forbidden', { status: 403 });
    }

    try {
      const data = await fs.readFile(file);
      const extension = path.extname(file).toLowerCase();
      const contentType = MIME_TYPES[extension] ?? 'application/octet-stream';
      const headers: Record<string, string> = {
        'Content-Type': contentType,
        'Content-Security-Policy': PLUGIN_CSP,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      };

      if (extension === '.html' || extension === '.htm') {
        return new Response(injectCsp(data.toString('utf8')), { headers });
      }

      return new Response(new Uint8Array(data), { headers });
    } catch {
      return new Response('not found', { status: 404 });
    }
  };
}

/** 注册协议处理器；getPluginDir 只对 ready + enabled 的插件返回目录。 */
export function registerPluginProtocol(getPluginDir: AssetResolver): void {
  protocol.handle(PLUGIN_SCHEME, createHandler(getPluginDir));
}

const registeredPartitions = new Set<string>();

/**
 * 插件 webview 使用独立 partition，协议必须在对应 Session 上再注册一次，
 * 否则 Chromium 会把 mailforge-plugin:// 当作外部协议交给操作系统。
 */
export function ensurePluginProtocolForPartition(
  partition: string,
  getPluginDir: AssetResolver,
): void {
  if (registeredPartitions.has(partition)) return;
  try {
    const target = session.fromPartition(partition);
    target.protocol.handle(PLUGIN_SCHEME, createHandler(getPluginDir));
    registeredPartitions.add(partition);
  } catch {
    // 重复注册或 session 不可用时忽略，下次视图请求会重试
  }
}

export function pluginAssetUrl(pluginId: string, relative: string): string {
  const clean = relative.replace(/^\/+/, '');
  return `${PLUGIN_SCHEME}://${pluginId}/${clean}`;
}
