import { describe, expect, it } from 'vitest';
import {
  REMINDER_GRACE_MS,
  ReminderService,
  formatReminderBody,
  reminderTarget,
  selectDueReminders,
  type ReminderCandidate,
} from '../src/main/notifications/reminders';
import type { Db } from '../src/main/db/open';

/**
 * 日程提醒（§16 + §22）纯逻辑：
 *  - 全天事件按当地 09:00 提醒；
 *  - 提前量窗口内才提醒，错过宽限期（5 分钟）后静默；
 *  - 已结束事件静默标记；已提醒过的不重复。
 */

function timed(patch: Partial<ReminderCandidate> = {}): ReminderCandidate {
  return {
    id: 'cal-1|event.ics|1000',
    summary: '周会',
    startsAt: 1_000_000,
    endsAt: 1_003_600,
    allDay: false,
    ...patch,
  };
}

/** 当地 09:00 的时间戳（用于全天事件断言）。 */
function localNine(day: Date): number {
  const date = new Date(day);
  date.setHours(9, 0, 0, 0);
  return date.getTime();
}

describe('reminderTarget', () => {
  it('定时事件按开始时间', () => {
    const candidate = timed({ startsAt: 1_700_000_000_000 });
    expect(reminderTarget(candidate)).toBe(1_700_000_000_000);
  });

  it('全天事件按当地 09:00', () => {
    const midnight = new Date(2026, 9, 22, 0, 0, 0, 0).getTime();
    const candidate = timed({ startsAt: midnight, allDay: true, endsAt: midnight + 86_400_000 });
    expect(reminderTarget(candidate)).toBe(localNine(new Date(2026, 9, 22)));
  });
});

describe('selectDueReminders', () => {
  const now = 1_700_000_000_000;
  const lead = 10 * 60 * 1000;

  it('提前量窗口内的事件该提醒', () => {
    const soon = timed({ startsAt: now + 5 * 60 * 1000, endsAt: now + 65 * 60 * 1000 });
    const edge = timed({
      id: 'edge',
      startsAt: now + lead,
      endsAt: now + lead + 3_600_000,
    });
    const { due, stale } = selectDueReminders([soon, edge], now, lead, new Set());
    expect(due.map((item) => item.id)).toEqual([soon.id, 'edge']);
    expect(stale).toEqual([]);
  });

  it('超出提前量窗口不提醒', () => {
    const later = timed({ startsAt: now + lead + 1000, endsAt: now + 2 * 3_600_000 });
    const { due } = selectDueReminders([later], now, lead, new Set());
    expect(due).toEqual([]);
  });

  it('准时提醒（提前量 0）只在开始后宽限内触发', () => {
    const justStarted = timed({ startsAt: now - 60_000, endsAt: now + 3_600_000 });
    const notStarted = timed({ id: 'future', startsAt: now + 60_000, endsAt: now + 3_600_000 });
    const { due } = selectDueReminders([justStarted, notStarted], now, 0, new Set());
    expect(due.map((item) => item.id)).toEqual([justStarted.id]);
  });

  it('错过宽限期后静默标记，不再补提醒', () => {
    const missed = timed({ startsAt: now - REMINDER_GRACE_MS - 1000, endsAt: now + 3_600_000 });
    const { due, stale } = selectDueReminders([missed], now, lead, new Set());
    expect(due).toEqual([]);
    expect(stale).toEqual([missed.id]);
  });

  it('宽限期内错过（刚开会）仍提醒一次', () => {
    const justMissed = timed({ startsAt: now - REMINDER_GRACE_MS + 1000, endsAt: now + 3_600_000 });
    const { due } = selectDueReminders([justMissed], now, lead, new Set());
    expect(due.map((item) => item.id)).toEqual([justMissed.id]);
  });

  it('已结束的事件静默标记', () => {
    const ended = timed({ startsAt: now - 2 * 3_600_000, endsAt: now - 3_600_000 });
    const { due, stale } = selectDueReminders([ended], now, lead, new Set());
    expect(due).toEqual([]);
    expect(stale).toEqual([ended.id]);
  });

  it('已提醒过的事件跳过（不重复、不再标记）', () => {
    const soon = timed({ startsAt: now + 60_000, endsAt: now + 3_600_000 });
    const { due, stale } = selectDueReminders([soon], now, lead, new Set([soon.id]));
    expect(due).toEqual([]);
    expect(stale).toEqual([]);
  });

  it('多个事件混合时分类正确', () => {
    const dueSoon = timed({ id: 'due', startsAt: now + 60_000, endsAt: now + 3_600_000 });
    const later = timed({ id: 'later', startsAt: now + 3_600_000, endsAt: now + 7_200_000 });
    const ended = timed({ id: 'ended', startsAt: now - 7_200_000, endsAt: now - 3_600_000 });
    const missed = timed({ id: 'missed', startsAt: now - 3_600_000, endsAt: now + 60_000 });
    const seen = timed({ id: 'seen', startsAt: now + 120_000, endsAt: now + 3_600_000 });

    const { due, stale } = selectDueReminders(
      [dueSoon, later, ended, missed, seen],
      now,
      lead,
      new Set(['seen']),
    );
    expect(due.map((item) => item.id)).toEqual(['due']);
    expect(stale.sort()).toEqual(['ended', 'missed']);
  });

  it('负提前量按 0 处理', () => {
    const soon = timed({ startsAt: now + 60_000, endsAt: now + 3_600_000 });
    const { due } = selectDueReminders([soon], now, -5000, new Set());
    expect(due).toEqual([]);
  });
});

describe('formatReminderBody', () => {
  it('定时事件带本地时分', () => {
    const start = new Date(2026, 9, 22, 14, 5, 0, 0);
    const candidate = timed({
      summary: '设计评审',
      startsAt: start.getTime(),
      endsAt: start.getTime() + 3_600_000,
    });
    expect(formatReminderBody(candidate, start)).toBe('设计评审 · 14:05');
  });

  it('全天事件标注全天', () => {
    const midnight = new Date(2026, 9, 22, 0, 0, 0, 0).getTime();
    const candidate = timed({
      summary: '团建',
      startsAt: midnight,
      endsAt: midnight + 86_400_000,
      allDay: true,
    });
    expect(formatReminderBody(candidate, new Date(midnight))).toBe('团建 · 全天');
  });
});

describe('ReminderService 容错', () => {
  /** 一访问就抛异常的库：模拟数据库瞬时不可用。 */
  const brokenDb = {
    prepare: () => {
      throw new Error('db gone');
    },
  } as unknown as Db;

  it('tick 中数据库异常不抛出，周期扫描不中断', () => {
    const notified: string[] = [];
    const service = new ReminderService(brokenDb, (title) => notified.push(title));
    expect(() => service.tick(1_700_000_000_000)).not.toThrow();
    expect(notified).toEqual([]);
  });

  it('start 的追平失败不阻塞启动，定时器仍可正常停止', () => {
    const service = new ReminderService(brokenDb, () => {});
    expect(() => service.start()).not.toThrow();
    service.stop();
    expect(service.notifiedCount()).toBe(0);
  });
});
