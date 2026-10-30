/**
 * 阅读设置的渲染进程读取入口。
 * 键名与归一化规则都在 shared/reading-settings.ts，这里只负责走 IPC 取字符串再归一化。
 *
 * 读取失败一律回落到默认值，绝不抛错：设置读取失败不应该阻断「打开邮件」这条主流程。
 */
import {
  AUTO_FULL_SCREEN_KEY,
  MARK_READ_DELAY_KEY,
  DEFAULT_AUTO_FULL_SCREEN,
  DEFAULT_MARK_READ_DELAY,
  normalizeAutoFullScreen,
  normalizeMarkReadDelay,
} from '../../shared/reading-settings';

export { AUTO_FULL_SCREEN_KEY, MARK_READ_DELAY_KEY };

/** 打开邮件后等待多少秒再标已读（0 = 立即）。 */
export async function readMarkReadDelay(): Promise<number> {
  try {
    const result = await window.api.getSetting(MARK_READ_DELAY_KEY);
    return normalizeMarkReadDelay(result.ok ? result.data : null);
  } catch {
    return DEFAULT_MARK_READ_DELAY;
  }
}

/** 双击 / 打开阅读窗口时是否自动全屏。 */
export async function readAutoFullScreen(): Promise<boolean> {
  try {
    const result = await window.api.getSetting(AUTO_FULL_SCREEN_KEY);
    return normalizeAutoFullScreen(result.ok ? result.data : null);
  } catch {
    return DEFAULT_AUTO_FULL_SCREEN;
  }
}
