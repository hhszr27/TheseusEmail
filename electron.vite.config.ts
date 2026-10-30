import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

/**
 * 注入渲染进程 CSP。
 * - 生产：禁止内联脚本与远程脚本，只允许本地资源。
 * - 开发：Vite/React Refresh 需要内联引导脚本与 HMR WebSocket，放宽到 localhost。
 *
 * 注意：img-src 必须放行 https/http。邮件正文的 srcdoc iframe 会**继承父文档 CSP**，
 * 父级若只允许 'self' data:，即使 iframe 内文档自己写了 img-src https: http:，
 * 「显示远程图片」也会被父策略以 csp 拦截（图片永远加载不出来）。
 */
export function buildRendererCsp(isDev: boolean): string {
  return isDev
    ? "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: http:; connect-src 'self' ws: wss: http://localhost:*; font-src 'self' data:"
    : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: http:; connect-src 'self'; font-src 'self' data:";
}

function cspPlugin(): Plugin {
  return {
    name: 'mailforge-csp',
    transformIndexHtml(html, ctx) {
      const policy = buildRendererCsp(Boolean(ctx.server));
      const meta = `    <meta http-equiv="Content-Security-Policy" content="${policy}" />\n`;
      return html.replace('</head>', `${meta}  </head>`);
    },
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve('src/shared') },
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          // 账户同步 worker（§7.6：每账户独立 worker 线程）
          'account-worker': resolve('src/main/mail/sync/account-worker.ts'),
          // 日历同步 worker（§16.6：与邮件同步隔离）
          'calendar-worker': resolve('src/main/calendar/calendar-worker.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve('src/shared') },
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          'plugin-view': resolve('src/preload/plugin-view.ts'),
          recovery: resolve('src/preload/recovery.ts'),
          unlock: resolve('src/preload/unlock.ts'),
        },
      },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [react(), cspPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@renderer': resolve('src/renderer'),
      },
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          recovery: resolve('src/renderer/recovery.html'),
          unlock: resolve('src/renderer/unlock.html'),
          reader: resolve('src/renderer/reader.html'),
        },
      },
    },
  },
});
