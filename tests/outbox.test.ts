import { describe, expect, it } from 'vitest';
import type { ScheduledSendInfo } from '../src/shared/ipc';
import {
  nextOutboxSendAt,
  outboxBadgeCount,
  outboxKind,
  visibleOutbox,
} from '../src/renderer/lib/outbox';

function make(patch: Partial<ScheduledSendInfo> = {}): ScheduledSendInfo {
  return {
    id: 'id',
    accountId: 'acc',
    sendAt: 0,
    status: 'pending',
    subject: '主题',
    to: ['a@example.com'],
    retryCount: 0,
    lastError: null,
    ...patch,
  };
}

describe('发件箱状态判定', () => {
  const now = 1_000_000;

  it('定时（未来 1s 以上）与排队中（已到点）区分开', () => {
    expect(outboxKind(make({ sendAt: now + 60_000 }), now)).toBe('scheduled');
    expect(outboxKind(make({ sendAt: now + 500 }), now)).toBe('queued');
    expect(outboxKind(make({ sendAt: now - 1000 }), now)).toBe('queued');
  });

  it('终态优先级高于时间：已发送/失败/发送中/已取消不被时间改写', () => {
    expect(outboxKind(make({ status: 'sent', sendAt: now + 60_000 }), now)).toBe('sent');
    expect(outboxKind(make({ status: 'failed' }), now)).toBe('failed');
    expect(outboxKind(make({ status: 'sending' }), now)).toBe('sending');
    expect(outboxKind(make({ status: 'cancelled' }), now)).toBe('cancelled');
  });
});

describe('发件箱列表', () => {
  it('过滤已取消；待发按发送时间升序，历史按时间倒序', () => {
    const items = [
      make({ id: 'sent-old', status: 'sent', sendAt: 100 }),
      make({ id: 'cancelled', status: 'cancelled', sendAt: 200 }),
      make({ id: 'later', sendAt: 900 }),
      make({ id: 'sent-new', status: 'sent', sendAt: 300 }),
      make({ id: 'sooner', sendAt: 500 }),
      make({ id: 'failed', status: 'failed', sendAt: 400 }),
    ];

    const ids = visibleOutbox(items).map((item) => item.id);
    expect(ids).toEqual(['sooner', 'later', 'failed', 'sent-new', 'sent-old']);
    expect(ids).not.toContain('cancelled');
  });

  it('角标只统计仍在队列里的（pending / sending），不含已发送与失败', () => {
    const items = [
      make({ id: '1', status: 'pending' }),
      make({ id: '2', status: 'sending' }),
      make({ id: '3', status: 'sent' }),
      make({ id: '4', status: 'failed' }),
      make({ id: '5', status: 'cancelled' }),
    ];
    expect(outboxBadgeCount(items)).toBe(2);
  });

  it('下一封只看未来的 pending，忽略已到点与终态', () => {
    const now = 10_000;
    const items = [
      make({ id: 'past', sendAt: now - 5000 }),
      make({ id: 'sent', status: 'sent', sendAt: now + 1000 }),
      make({ id: 'later', sendAt: now + 9000 }),
      make({ id: 'sooner', sendAt: now + 3000 }),
    ];
    expect(nextOutboxSendAt(items, now)).toBe(now + 3000);
    expect(nextOutboxSendAt(items.filter((item) => item.status === 'sent'), now)).toBeNull();
  });
});
