import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { disposeImapClient, isSocketClean } from '../src/main/mail/sync/resource-cleanup';

function makeSocket(): EventEmitter & { destroy: () => void } {
  const socket = new EventEmitter() as EventEmitter & { destroy: () => void };
  socket.destroy = vi.fn();
  return socket;
}

describe('IMAP 客户端资源清理（§7.6）', () => {
  it('移除 socket 监听器、清除 IDLE 定时器、销毁压缩流', () => {
    const socket = makeSocket();
    const writeSocket = makeSocket();
    socket.on('data', () => {});
    socket.on('error', () => {});
    socket.on('close', () => {});
    writeSocket.on('drain', () => {});

    const timer = setTimeout(() => {}, 60_000);
    const deflate = { destroy: vi.fn() };

    const client = {
      socket,
      writeSocket,
      idleStartTimer: timer,
      _deflate: deflate,
    };

    const report = disposeImapClient(client);

    expect(isSocketClean(socket)).toBe(true);
    expect(isSocketClean(writeSocket)).toBe(true);
    expect(socket.destroy).toHaveBeenCalled();
    expect(report.socketListenersRemoved).toBeGreaterThanOrEqual(4);
    expect(report.timersCleared).toBe(1);
    expect(report.streamsDestroyed).toBe(1);
    expect(deflate.destroy).toHaveBeenCalled();
    expect(client.idleStartTimer).toBeNull();
    expect(client._deflate).toBeNull();
  });

  it('重复调用是幂等的，不抛异常', () => {
    const client = { socket: makeSocket(), idleStartTimer: null, _deflate: null };
    expect(() => disposeImapClient(client)).not.toThrow();
    expect(() => disposeImapClient(client)).not.toThrow();
  });

  it('空对象与 null 安全返回', () => {
    expect(disposeImapClient(null).socketListenersRemoved).toBe(0);
    expect(disposeImapClient({}).timersCleared).toBe(0);
  });
});
