/**
 * 阅读行为相关设置的唯一来源（主进程与渲染进程共用）。
 *
 * 两项设置都落在 app_settings 表（字符串键值）：
 *  - reading.markReadDelay：打开邮件后等待多少秒再标已读（0 = 立即）。
 *  - reading.autoFullScreen：双击 / 打开阅读窗口时是否自动全屏（最大化）。
 *
 * 归一化函数放在 shared 层：主进程读写数据库、渲染进程渲染设置页都走同一套规则，
 * 避免两边对「非法值」「空值」的理解不一致（例如把 '' 当成 0 还是默认值）。
 */

export const MARK_READ_DELAY_KEY = 'reading.markReadDelay';
export const AUTO_FULL_SCREEN_KEY = 'reading.autoFullScreen';

/** 默认 0 = 打开即标已读（保持既有行为，用户主动开启延迟才改变）。 */
export const DEFAULT_MARK_READ_DELAY = 0;

/** 默认开启：双击 / 打开阅读窗口即全屏，符合 Outlook「自动全屏阅读」的预期。 */
export const DEFAULT_AUTO_FULL_SCREEN = true;

/** 上限 10 分钟，避免误填一个巨大数字导致邮件长时间不标已读。 */
export const MAX_MARK_READ_DELAY = 600;

/**
 * 把设置里的字符串解析成秒数。
 * 缺失 / 空串 / 非数字 / 负数 / NaN 一律回落到默认值；超过上限则截断。
 */
export function normalizeMarkReadDelay(value: string | null | undefined): number {
  if (value === null || value === undefined) return DEFAULT_MARK_READ_DELAY;
  const trimmed = value.trim();
  if (trimmed === '') return DEFAULT_MARK_READ_DELAY;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return DEFAULT_MARK_READ_DELAY;
  if (parsed < 0) return DEFAULT_MARK_READ_DELAY;
  return Math.min(MAX_MARK_READ_DELAY, Math.round(parsed));
}

/**
 * 布尔设置：只有显式写入 'false' 才视为关闭，其余（缺失、'true'、脏值）按开启处理。
 * 这与「默认开启」的策略一致 —— 用户没改过就应该是开着的。
 */
export function normalizeAutoFullScreen(value: string | null | undefined): boolean {
  return value !== 'false';
}
