/**
 * 日历工作时间的唯一来源（主进程与渲染进程共用）。
 *
 * 存储格式：`app_settings['calendar.workHours'] = "9-18"`（24 小时制，起止小时）。
 * 周视图把这段时间之外的小时灰掉，帮助一眼看出哪些时间不属于工作范围。
 *
 * 归一化放在 shared 层：设置页写入与周视图读取必须用同一套规则，
 * 否则会出现「设置页显示 9–18、日历却按别的值灰」这种对不上的状态。
 */

export const WORK_HOURS_KEY = 'calendar.workHours';

/** 时间显示格式：24 小时制（14:30）/ 12 小时制（2:30 PM）。 */
export const TIME_FORMAT_KEY = 'calendar.timeFormat';

export type TimeFormat = '24' | '12';

/** 默认 24 小时制（与中文环境的习惯一致）。 */
export const DEFAULT_TIME_FORMAT: TimeFormat = '24';

/** 只有显式写入 '12' 才切到 12 小时制，其余（缺失、脏值）按 24 小时。 */
export function normalizeTimeFormat(value: string | null | undefined): TimeFormat {
  return value === '12' ? '12' : '24';
}

/** 时间轴整点标签：24h → `14:00`；12h → `2 PM`。 */
export function formatHourLabel(hour: number, format: TimeFormat): string {
  if (format === '24') return `${String(hour).padStart(2, '0')}:00`;
  const suffix = hour < 12 ? 'AM' : 'PM';
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display} ${suffix}`;
}

/** 具体时刻：24h → `14:30`；12h → `2:30 PM`。 */
export function formatClock(minutesSinceMidnight: number, format: TimeFormat): string {
  const total = ((minutesSinceMidnight % 1440) + 1440) % 1440;
  const hour = Math.floor(total / 60);
  const minute = total % 60;
  if (format === '24') {
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }
  const suffix = hour < 12 ? 'AM' : 'PM';
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display}:${String(minute).padStart(2, '0')} ${suffix}`;
}

export interface WorkHours {
  /** 开始小时（0–24，含）。 */
  start: number;
  /** 结束小时（0–24，不含）。 */
  end: number;
}

/** 默认 9:00–18:00。 */
export const DEFAULT_WORK_HOURS: WorkHours = { start: 9, end: 18 };

function clampHour(value: number): number {
  return Math.min(24, Math.max(0, Math.round(value)));
}

/**
 * 解析 `"9-18"`。
 * 缺失 / 格式不对 / 起止颠倒 / 起止相同 一律回落到默认值：
 * 宁可回到 9–18，也不要出现「整周全灰」或「整周全白」这种看不出原因的界面。
 */
export function normalizeWorkHours(value: string | null | undefined): WorkHours {
  if (value === null || value === undefined) return { ...DEFAULT_WORK_HOURS };
  const match = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(value);
  if (!match) return { ...DEFAULT_WORK_HOURS };
  const start = clampHour(Number(match[1]));
  const end = clampHour(Number(match[2]));
  if (end <= start) return { ...DEFAULT_WORK_HOURS };
  return { start, end };
}

export function formatWorkHours(hours: WorkHours): string {
  return `${hours.start}-${hours.end}`;
}

/** 某个整点小时是否属于工作时间（end 不含）。 */
export function isWorkHour(hour: number, hours: WorkHours): boolean {
  return hour >= hours.start && hour < hours.end;
}
