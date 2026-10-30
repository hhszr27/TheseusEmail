import { app } from 'electron';
import path from 'node:path';
import { log } from '../observability/logger';

/**
 * 单实例锁与 mailto 协议（§31.1）。
 * 协议处理只允许 mailto:，不接受 file: 或其他 scheme。
 */

export function acquireSingleInstance(onSecondInstance: (argv: string[]) => void): boolean {
  const acquired = app.requestSingleInstanceLock();
  if (!acquired) {
    return false;
  }

  app.on('second-instance', (_event, argv) => {
    log.info('single-instance', '收到第二实例参数', { count: argv.length });
    onSecondInstance(argv);
  });

  return true;
}

export function findMailtoArg(argv: string[]): string | null {
  for (const arg of argv) {
    const trimmed = arg.trim();
    if (/^mailto:/i.test(trimmed)) return trimmed;
  }
  return null;
}

export function registerMailtoProtocol(): void {
  try {
    if (process.defaultApp && process.argv.length >= 2) {
      const entry = process.argv[1] ?? '';
      app.setAsDefaultProtocolClient('mailto', process.execPath, [path.resolve(entry)]);
    } else {
      app.setAsDefaultProtocolClient('mailto');
    }
    log.info('protocol', 'mailto 协议处理已注册');
  } catch (error) {
    log.warn('protocol', '注册 mailto 协议失败', { message: (error as Error).message });
  }
}
