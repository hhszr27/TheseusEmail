import { IPC_EVENTS } from '../../shared/constants';
import { RIBBON_SETTING_KEY } from '../../shared/ribbon';
import { KEYBINDINGS_SETTING_KEY } from '../../shared/theme';

/**
 * `settings:set` 之后是否需要广播、广播到哪个频道（跨窗口同步）。
 *
 * 抽成纯函数是为了可测：主进程 handler 里那段只负责「查表 + 遍历窗口发送」，
 * 「哪个 key 对应哪个事件」这条规则单独锁住，避免漏掉某类配置的同步。
 *
 * 注意：这里只放「确实需要多窗口一致」的配置。
 * 大多数设置（通知、代理、AI…）只在当前窗口即时生效，不必广播。
 */
export function broadcastChannelFor(key: string): string | null {
  if (key === RIBBON_SETTING_KEY) return IPC_EVENTS.ribbonChanged;
  if (key === KEYBINDINGS_SETTING_KEY) return IPC_EVENTS.keybindingsChanged;
  return null;
}
