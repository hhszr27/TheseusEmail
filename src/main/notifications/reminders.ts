import type { Db } from '../db/open';
import type { CalendarEventView } from '../../shared/ipc';
import { log } from '../observability/logger';
import { isDndActive, type DndSettings } from './policy';
import { readDndSettings, readNotificationSettings } from './settings';

/**
 * 日程提醒（§16 事件 + §22 通知）。
 *
 * 设计要点：
 *  - 纯函数 selectDueReminders 决定「该提醒谁」，可单测；
 *  - 服务只负责周期扫描、去重与静默判定；
 *  - 去重是内存 Set（事件 id = calendarId|href|startsAt，同步期间稳定），
 *    重启后通过 catchUp 静默追平，不会对历史事件补弹。
 */

export interface ReminderCandidate {
  id: string;
  summary: string;
  startsAt: number;
  endsAt: number;
  allDay: boolean;
}

/** 错过这么久之后不再补提醒（应用未启动/睡眠窗口）。 */
export const REMINDER_GRACE_MS = 5 * 60 * 1000;

/** 全天事件按当地 09:00 提醒；定时事件按开始时间。 */
export function reminderTarget(candidate: ReminderCandidate): number {
  if (!candidate.allDay) return candidate.startsAt;
  const date = new Date(candidate.startsAt);
  date.setHours(9, 0, 0, 0);
  return date.getTime();
}

export interface DueSelection {
  due: ReminderCandidate[];
  /** 已结束或错过太久的：静默标记，不再扫描。 */
  stale: string[];
}

export function selectDueReminders(
  candidates: readonly ReminderCandidate[],
  now: number,
  leadMs: number,
  notified: ReadonlySet<string>,
): DueSelection {
  const due: ReminderCandidate[] = [];
  const stale: string[] = [];
  const lead = Math.max(0, leadMs);

  for (const candidate of candidates) {
    if (notified.has(candidate.id)) continue;
    if (candidate.endsAt < now) {
      stale.push(candidate.id);
      continue;
    }
    const delta = reminderTarget(candidate) - now;
    if (delta > lead) continue; // 还没到提前量窗口
    if (delta < -REMINDER_GRACE_MS) {
      stale.push(candidate.id); // 错过太久，静默
      continue;
    }
    due.push(candidate);
  }

  return { due, stale };
}

export function formatReminderBody(candidate: ReminderCandidate, now: Date): string {
  if (candidate.allDay) return `${candidate.summary} · 全天`;
  const start = new Date(candidate.startsAt);
  const hh = String(start.getHours()).padStart(2, '0');
  const mm = String(start.getMinutes()).padStart(2, '0');
  return `${candidate.summary} · ${hh}:${mm}`;
}

function toCandidate(event: CalendarEventView): ReminderCandidate {
  return {
    id: event.id,
    summary: event.summary,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    allDay: event.allDay,
  };
}

const TICK_MS = 30_000;
/** 扫描窗口：回看 1 小时（覆盖进行中/刚错过的），前探提前量 + 1 小时。 */
const LOOKBACK_MS = 60 * 60 * 1000;
const LOOKAHEAD_MS = 60 * 60 * 1000;

export class ReminderService {
  private readonly notified = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Db,
    private readonly notify: (title: string, body: string) => void,
  ) {}

  /** 启动：静默追平历史事件，然后按周期扫描。 */
  start(): void {
    try {
      this.catchUp(Date.now());
    } catch (error) {
      // 追平失败不阻塞启动：下一次 tick 会自然补齐
      log.warn('notify', '日程提醒追平失败', { message: (error as Error).message });
    }
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * 静默追平：把「已过提醒时点（超过宽限期）或已结束」的事件标记为已处理，
   * 避免每次启动都对今天的历史事件补弹；即将到来的事件保留可提醒状态。
   */
  catchUp(now: number): void {
    for (const candidate of this.candidates(now)) {
      const delta = reminderTarget(candidate) - now;
      if (candidate.endsAt < now || delta < -REMINDER_GRACE_MS) {
        this.notified.add(candidate.id);
      }
    }
  }

  tick(now: number = Date.now()): void {
    try {
      const settings = readNotificationSettings(this.db);
      if (!settings.reminders) return;

      const dnd: DndSettings = readDndSettings(this.db);
      const silent = isDndActive(dnd, new Date(now));
      const leadMs = settings.reminderMinutes * 60 * 1000;

      const candidates = this.candidates(now);
      const { due, stale } = selectDueReminders(candidates, now, leadMs, this.notified);

      for (const id of stale) this.notified.add(id);

      if (silent) {
        // 免打扰：静默标记，不弹窗；开启后超过宽限期的事件也不会补弹。
        for (const candidate of due) this.notified.add(candidate.id);
        return;
      }

      for (const candidate of due) {
        this.notified.add(candidate.id);
        this.notify('日程提醒', formatReminderBody(candidate, new Date(now)));
      }
    } catch (error) {
      // 单次扫描失败（数据库瞬时不可用等）不能中断 30s 周期：
      // timer 回调里的异常会升级为 uncaughtException，且半途退出会
      // 留下「未标记也未通知」的事件，下个周期行为不确定。
      log.warn('notify', '日程提醒扫描失败', { message: (error as Error).message });
    }
  }

  private candidates(now: number): ReminderCandidate[] {
    const from = now - LOOKBACK_MS;
    const to = now + LOOKAHEAD_MS;
    const rows = this.db
      .prepare(
        `SELECT e.id, e.summary, e.starts_at, e.ends_at, e.all_day
           FROM calendar_events e
           JOIN calendar_accounts a ON a.id = e.calendar_id
          WHERE a.enabled = 1 AND e.starts_at IS NOT NULL
            AND e.starts_at < ? AND COALESCE(e.ends_at, e.starts_at) >= ?
          ORDER BY e.starts_at ASC
          LIMIT 2000`,
      )
      .all(to, from) as Array<{
      id: string;
      summary: string | null;
      starts_at: number | null;
      ends_at: number | null;
      all_day: number;
    }>;

    return rows
      .filter((row) => row.starts_at !== null)
      .map((row) => ({
        id: row.id,
        summary: row.summary ?? '（无标题）',
        startsAt: row.starts_at as number,
        endsAt: row.ends_at ?? (row.starts_at as number),
        allDay: row.all_day === 1,
      }));
  }

  /** 测试/诊断用：当前已标记的事件数。 */
  notifiedCount(): number {
    return this.notified.size;
  }

  dispose(): void {
    this.stop();
    this.notified.clear();
    log.info('notify', '日程提醒服务已停止');
  }
}
