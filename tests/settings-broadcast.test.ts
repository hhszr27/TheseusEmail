import { describe, it, expect } from 'vitest';
import { broadcastChannelFor } from '../src/main/ipc/settings-broadcast';
import { IPC_EVENTS } from '../src/shared/constants';
import { RIBBON_SETTING_KEY } from '../src/shared/ribbon';
import { KEYBINDINGS_SETTING_KEY } from '../src/shared/theme';

/**
 * 跨窗口同步的「哪些配置需要广播」规则。
 *
 * 漏掉一条的表现很隐蔽：单窗口一切正常，只有开了第二个窗口才会看到配置不同步。
 * 所以这里把映射关系锁死。
 */

describe('broadcastChannelFor', () => {
  it('工具栏配置走 ribbon 频道', () => {
    expect(broadcastChannelFor(RIBBON_SETTING_KEY)).toBe(IPC_EVENTS.ribbonChanged);
  });

  it('快捷键配置走 keybindings 频道', () => {
    expect(broadcastChannelFor(KEYBINDINGS_SETTING_KEY)).toBe(IPC_EVENTS.keybindingsChanged);
  });

  it('其余设置不广播（避免无谓的全窗口唤醒）', () => {
    for (const key of ['notifications', 'dnd', 'layout', 'ai', 'proxy', '']) {
      expect(broadcastChannelFor(key)).toBeNull();
    }
  });

  it('两个频道不重复（否则一侧收不到）', () => {
    expect(IPC_EVENTS.ribbonChanged).not.toBe(IPC_EVENTS.keybindingsChanged);
  });
});
