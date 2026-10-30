/**
 * 时区换算的唯一来源（主进程与渲染进程共用）。
 *
 * 只依赖 `Intl`，不引入时区库。核心是两件事：
 *  - `zonedParts`：把一个时间戳按目标时区拆成「年月日时分」——
 *    同一个时间戳在 Asia/Shanghai 和 UTC 下可能属于不同的**日期**，日历分列、邮件列表分组都靠它。
 *  - `zonedTimeToUtc`：把「某时区的某天某时」换算成时间戳（新建事件时用）。
 *
 * 存储永远是 UTC 时间戳；时区只影响显示与输入解释。
 */

export const TIMEZONE_KEY = 'calendar.timezone';

/** 设置里表示「跟随系统」。 */
export const TIMEZONE_SYSTEM = 'system';

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** 系统时区（IANA 名称）。取不到时退回 UTC。 */
export function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * 把设置里的原始值解析成可用的 IANA 名称。
 * `'system'` / 空 / 非法名称一律回落到系统时区 —— 绝不让一个脏值时区把整个日历打空。
 */
export function normalizeTimeZone(value: string | null | undefined): string {
  if (!value || value === TIMEZONE_SYSTEM) return systemTimeZone();
  try {
    // 构造一次即可校验名称合法性
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return value;
  } catch {
    return systemTimeZone();
  }
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

/** 时间戳 → 目标时区的年月日时分。 */
export function zonedParts(timestamp: number, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(timestamp));
  const get = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    // en-US + hour12:false 在部分实现里把 0 点写成 24，统一归一
    hour: get('hour') % 24,
    minute: get('minute'),
  };
}

/** 目标时区下的「当天第几分钟」，用于周视图事件定位。 */
export function zonedMinutesOfDay(timestamp: number, timeZone: string): number {
  const parts = zonedParts(timestamp, timeZone);
  return parts.hour * 60 + parts.minute;
}

/** 目标时区下的日期键（与日历格子一致：`2026-9-29`）。 */
export function zonedDayKey(timestamp: number, timeZone: string): string {
  const parts = zonedParts(timestamp, timeZone);
  return `${parts.year}-${parts.month - 1}-${parts.day}`;
}

/** 用 Intl 计算某时区在给定本地时间的 UTC 偏移，避免引入时区库。 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const read = (timestamp: number): number => {
    const parts = formatter.formatToParts(new Date(timestamp));
    const get = (type: string): number =>
      Number(parts.find((part) => part.type === type)?.value ?? 0);
    return Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour') % 24,
      get('minute'),
      get('second'),
    );
  };

  const first = read(guess);
  const offset = first - guess;
  const adjusted = guess - offset;
  const secondPass = read(adjusted) - adjusted;
  return secondPass === offset ? adjusted : guess - secondPass;
}
