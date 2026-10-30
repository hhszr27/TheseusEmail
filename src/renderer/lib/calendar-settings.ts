/**
 * 日历设置的渲染进程读取入口。
 * 键名与归一化规则都在 shared/calendar-settings.ts，这里只负责走 IPC 取字符串再归一化。
 *
 * 读取失败一律回落到默认值，绝不抛错：设置读不到不应该让日历打不开。
 */
import {
  DEFAULT_TIME_FORMAT,
  DEFAULT_WORK_HOURS,
  TIME_FORMAT_KEY,
  WORK_HOURS_KEY,
  normalizeTimeFormat,
  normalizeWorkHours,
  type TimeFormat,
  type WorkHours,
} from '../../shared/calendar-settings';

export { TIME_FORMAT_KEY, WORK_HOURS_KEY };
export type { TimeFormat, WorkHours };

/** 时间显示格式（默认 24 小时制）。 */
export async function readTimeFormat(): Promise<TimeFormat> {
  try {
    const result = await window.api.getSetting(TIME_FORMAT_KEY);
    return normalizeTimeFormat(result.ok ? result.data : null);
  } catch {
    return DEFAULT_TIME_FORMAT;
  }
}

/** 工作时间（默认 9:00–18:00）。 */
export async function readWorkHours(): Promise<WorkHours> {
  try {
    const result = await window.api.getSetting(WORK_HOURS_KEY);
    return normalizeWorkHours(result.ok ? result.data : null);
  } catch {
    return { ...DEFAULT_WORK_HOURS };
  }
}
