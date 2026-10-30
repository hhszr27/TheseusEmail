/**
 * IMAP 客户端资源清理（§7.6）。
 *
 * 不能只依赖 logout()：socket 上的事件监听器、IDLE watchdog 定时器、
 * compression stream 都需要显式释放，否则长驻进程内存持续增长。
 */

export interface CleanupReport {
  socketListenersRemoved: number;
  timersCleared: number;
  streamsDestroyed: number;
}

interface SocketLike {
  removeAllListeners?: () => void;
  listenerCount?: (event: string) => number;
  eventNames?: () => Array<string | symbol>;
  destroy?: () => void;
}

interface ClientLike {
  socket?: SocketLike | null;
  writeSocket?: SocketLike | null;
  idleStartTimer?: NodeJS.Timeout | null;
  _deflate?: { destroy?: () => void } | null;
  [key: string]: unknown;
}

function listenerTotal(socket: SocketLike): number {
  if (typeof socket.eventNames !== 'function' || typeof socket.listenerCount !== 'function') {
    return 0;
  }
  try {
    return socket.eventNames().reduce((sum, name) => sum + (socket.listenerCount?.(String(name)) ?? 0), 0);
  } catch {
    return 0;
  }
}

export function disposeImapClient(client: unknown): CleanupReport {
  const report: CleanupReport = {
    socketListenersRemoved: 0,
    timersCleared: 0,
    streamsDestroyed: 0,
  };

  if (!client || typeof client !== 'object') return report;
  const target = client as ClientLike;

  for (const key of ['socket', 'writeSocket'] as const) {
    const socket = target[key] as SocketLike | null | undefined;
    if (!socket || typeof socket !== 'object') continue;

    report.socketListenersRemoved += listenerTotal(socket);
    try {
      socket.removeAllListeners?.();
    } catch {
      // ignore
    }
    try {
      socket.destroy?.();
    } catch {
      // ignore
    }
  }

  if (target.idleStartTimer) {
    try {
      clearTimeout(target.idleStartTimer);
      report.timersCleared += 1;
    } catch {
      // ignore
    }
    target.idleStartTimer = null;
  }

  if (target._deflate) {
    try {
      target._deflate.destroy?.();
      report.streamsDestroyed += 1;
    } catch {
      // ignore
    }
    target._deflate = null;
  }

  return report;
}

/** 判断一个 socket 是否已清理干净（供测试断言）。 */
export function isSocketClean(socket: SocketLike): boolean {
  return listenerTotal(socket) === 0;
}
