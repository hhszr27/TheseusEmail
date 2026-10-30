import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RIBBON_CONFIG,
  RIBBON_CONFIG_VERSION,
  RIBBON_OVERFLOW_AT,
  buildRibbonViewModel,
  deriveRibbonOverrides,
  mergeRibbonConfig,
  newCustomId,
  parseRibbonConfig,
  parseRibbonOverrides,
  splitRibbonTools,
  type RibbonConfig,
  type RibbonContext,
  type RibbonOverrides,
  type RibbonToolView,
} from '../src/shared/ribbon';
import { t } from '../src/shared/i18n';

/**
 * ribbon 配置模型的纯函数测试。
 *
 * 这些函数是「用户能改界面」的唯一入口，规则必须锁死：
 *  - 合并是幂等的，未知 id 被忽略而不是抛错；
 *  - 升级新增的内置项能流进用户布局（不覆盖用户已删/已改的）；
 *  - 脏数据（坏 JSON / 缺字段 / 类型不对）必须容忍，不能让界面白屏。
 */

function baseCtx(overrides: Partial<RibbonContext> = {}): RibbonContext {
  return {
    activeView: 'mail',
    mailSelected: false,
    selectedUnread: false,
    selectedStarred: false,
    hasAccounts: true,
    unified: false,
    listFilter: 'all',
    viewSettings: false,
    readerShown: true,
    vertical: false,
    ...overrides,
  };
}

function tabIds(config: RibbonConfig): string[] {
  return config.tabs.map((tab) => tab.id);
}

function toolIds(config: RibbonConfig, tabId: string): string[] {
  return config.tabs.find((tab) => tab.id === tabId)?.tools.map((tool) => tool.id) ?? [];
}

describe('mergeRibbonConfig', () => {
  it('无覆盖时返回与内置默认等价但独立的副本', () => {
    const merged = mergeRibbonConfig(DEFAULT_RIBBON_CONFIG, null);
    expect(tabIds(merged)).toEqual(['file', 'mail', 'view', 'tools']);
    // 改副本不能污染默认配置（深拷贝验证）
    const first = merged.tabs[0];
    expect(first).toBeDefined();
    if (first) first.label = '被改动';
    expect(DEFAULT_RIBBON_CONFIG.tabs[0]?.label).toBe('文件');
  });

  it('内置默认的按钮与命令绑定符合预期', () => {
    const merged = mergeRibbonConfig(DEFAULT_RIBBON_CONFIG, null);
    expect(toolIds(merged, 'mail')).toEqual([
      'mail.compose',
      'mail.reply',
      'mail.replyAll',
      'mail.forward',
      'mail.toggleRead',
      'mail.star',
      'mail.archive',
      'mail.moveTo',
      'mail.delete',
    ]);
    expect(toolIds(merged, 'file')).toEqual([
      'file.compose',
      'file.settings',
      'file.palette',
      'file.quit',
    ]);
  });

  it('隐藏标签后该标签不再出现', () => {
    const merged = mergeRibbonConfig(DEFAULT_RIBBON_CONFIG, {
      version: RIBBON_CONFIG_VERSION,
      hiddenTabs: ['view', 'tools'],
    });
    expect(tabIds(merged)).toEqual(['file', 'mail']);
  });

  it('隐藏工具后只影响那一个按钮', () => {
    const merged = mergeRibbonConfig(DEFAULT_RIBBON_CONFIG, {
      version: RIBBON_CONFIG_VERSION,
      hiddenTools: ['mail.reply', 'mail.replyAll'],
    });
    expect(toolIds(merged, 'mail')).not.toContain('mail.reply');
    expect(toolIds(merged, 'mail')).not.toContain('mail.replyAll');
    expect(toolIds(merged, 'mail')).toContain('mail.forward');
  });

  it('标签改名只改被指定的那个', () => {
    const merged = mergeRibbonConfig(DEFAULT_RIBBON_CONFIG, {
      version: RIBBON_CONFIG_VERSION,
      tabLabels: { mail: '邮件操作' },
    });
    expect(merged.tabs.find((tab) => tab.id === 'mail')?.label).toBe('邮件操作');
    expect(merged.tabs.find((tab) => tab.id === 'view')?.label).toBe('视图');
  });

  it('标签排序生效，未列出的按默认顺序追加', () => {
    const merged = mergeRibbonConfig(DEFAULT_RIBBON_CONFIG, {
      version: RIBBON_CONFIG_VERSION,
      tabOrder: ['tools', 'file'],
    });
    expect(tabIds(merged)).toEqual(['tools', 'file', 'mail', 'view']);
  });

  it('工具排序生效，未列出的（升级新增）追加在末尾', () => {
    const merged = mergeRibbonConfig(DEFAULT_RIBBON_CONFIG, {
      version: RIBBON_CONFIG_VERSION,
      toolOrder: { mail: ['mail.delete', 'mail.compose'] },
    });
    expect(toolIds(merged, 'mail').slice(0, 2)).toEqual(['mail.delete', 'mail.compose']);
    // 其余按钮仍在，且排在显式排序之后
    expect(toolIds(merged, 'mail')).toContain('mail.reply');
    expect(toolIds(merged, 'mail').length).toBe(9);
  });

  it('用户工具可追加进内置标签', () => {
    const merged = mergeRibbonConfig(DEFAULT_RIBBON_CONFIG, {
      version: RIBBON_CONFIG_VERSION,
      addedTools: {
        view: [
          {
            id: 'custom:view-calendar',
            commandId: 'calendar.open',
            label: '日历',
            icon: 'clock',
            when: 'always',
            origin: 'user',
          },
        ],
      },
    });
    const tools = merged.tabs.find((tab) => tab.id === 'view')?.tools ?? [];
    expect(tools[tools.length - 1]?.id).toBe('custom:view-calendar');
    expect(tools[tools.length - 1]?.origin).toBe('user');
  });

  it('用户自建标签按配置追加，并可整条隐藏', () => {
    const overrides: RibbonOverrides = {
      version: RIBBON_CONFIG_VERSION,
      customTabs: [
        {
          id: 'custom:mine',
          label: '我的',
          origin: 'user',
          tools: [
            {
              id: 'custom:mine-1',
              commandId: 'mail.compose',
              label: '新建邮件',
              icon: 'compose',
              when: 'always',
              origin: 'user',
            },
          ],
        },
      ],
    };
    const withCustom = mergeRibbonConfig(DEFAULT_RIBBON_CONFIG, overrides);
    expect(tabIds(withCustom)).toEqual(['file', 'mail', 'view', 'tools', 'custom:mine']);
    expect(withCustom.tabs[4]?.origin).toBe('user');

    const hidden = mergeRibbonConfig(DEFAULT_RIBBON_CONFIG, {
      ...overrides,
      hiddenTabs: ['custom:mine'],
    });
    expect(tabIds(hidden)).not.toContain('custom:mine');
  });

  it('未知 id 一律忽略，不抛错也不产生空条目', () => {
    const merged = mergeRibbonConfig(DEFAULT_RIBBON_CONFIG, {
      version: RIBBON_CONFIG_VERSION,
      hiddenTabs: ['no-such-tab'],
      hiddenTools: ['no-such-tool'],
      tabLabels: { 'no-such-tab': '无效' },
      tabOrder: ['no-such-tab', 'mail'],
      toolOrder: { mail: ['no-such-tool', 'mail.compose'] },
      addedTools: { 'no-such-tab': [] },
    });
    expect(tabIds(merged)).toEqual(['mail', 'file', 'view', 'tools']);
    expect(toolIds(merged, 'mail')[0]).toBe('mail.compose');
    expect(toolIds(merged, 'mail').length).toBe(9);
  });

  it('合并是幂等的：同样入参得到同样结果', () => {
    const overrides: RibbonOverrides = {
      version: RIBBON_CONFIG_VERSION,
      hiddenTabs: ['tools'],
      tabOrder: ['view', 'file', 'mail'],
      toolOrder: { mail: ['mail.delete'] },
      hiddenTools: ['mail.reply'],
    };
    const a = mergeRibbonConfig(DEFAULT_RIBBON_CONFIG, overrides);
    const b = mergeRibbonConfig(DEFAULT_RIBBON_CONFIG, overrides);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('升级新增的内置按钮会流进用户已有布局，且用户删过的不被加回', () => {
    // 升级后的默认（含新按钮 mail.forward）+ 用户在旧版上留下的增量
    const overrides: RibbonOverrides = {
      version: RIBBON_CONFIG_VERSION,
      toolOrder: { mail: ['mail.delete'] },
    };
    const merged = mergeRibbonConfig(DEFAULT_RIBBON_CONFIG, overrides);
    // 用户的排序被保留，新按钮自动出现在末尾
    expect(toolIds(merged, 'mail')[0]).toBe('mail.delete');
    expect(toolIds(merged, 'mail')).toContain('mail.forward');
    expect(toolIds(merged, 'mail').length).toBe(9);

    // 用户在旧版删掉的按钮，升级后不能悄悄回来
    const kept = mergeRibbonConfig(DEFAULT_RIBBON_CONFIG, {
      ...overrides,
      hiddenTools: ['mail.forward'],
    });
    expect(toolIds(kept, 'mail')).not.toContain('mail.forward');
    expect(toolIds(kept, 'mail').length).toBe(8);
  });
});

describe('buildRibbonViewModel', () => {
  it('when 不命中时按钮禁用但仍占位', () => {
    const views = buildRibbonViewModel(DEFAULT_RIBBON_CONFIG, baseCtx());
    const mail = views.find((tab) => tab.id === 'mail');
    const reply = mail?.tools.find((tool) => tool.id === 'mail.reply');
    const compose = mail?.tools.find((tool) => tool.id === 'mail.compose');
    expect(reply?.disabled).toBe(true);
    expect(compose?.disabled).toBe(false);
  });

  it('altWhen 命中时切换标签文字', () => {
    const config = mergeRibbonConfig(DEFAULT_RIBBON_CONFIG, null);
    const unread = buildRibbonViewModel(config, baseCtx({ mailSelected: true, selectedUnread: true }));
    const read = buildRibbonViewModel(config, baseCtx({ mailSelected: true, selectedUnread: false }));
    const find = (views: ReturnType<typeof buildRibbonViewModel>) =>
      views.find((tab) => tab.id === 'mail')?.tools.find((tool) => tool.id === 'mail.toggleRead');
    expect(find(unread)?.label).toBe('标为已读');
    expect(find(read)?.label).toBe('标为未读');
  });

  it('activeWhen 命中时按钮高亮', () => {
    const config = mergeRibbonConfig(DEFAULT_RIBBON_CONFIG, null);
    const views = buildRibbonViewModel(config, baseCtx({ listFilter: 'unread' }));
    const filterUnread = views
      .find((tab) => tab.id === 'view')
      ?.tools.find((tool) => tool.id === 'view.filterUnread');
    const filterAll = views
      .find((tab) => tab.id === 'view')
      ?.tools.find((tool) => tool.id === 'view.filterAll');
    expect(filterUnread?.active).toBe(true);
    expect(filterAll?.active).toBe(false);
  });

  it('参数与危险标记、文件夹选择器都透传到视图模型', () => {
    const views = buildRibbonViewModel(DEFAULT_RIBBON_CONFIG, baseCtx());
    const filterUnread = views
      .find((tab) => tab.id === 'view')
      ?.tools.find((tool) => tool.id === 'view.filterUnread');
    expect(filterUnread?.args).toEqual({ filter: 'unread' });
    const del = views.find((tab) => tab.id === 'mail')?.tools.find((tool) => tool.id === 'mail.delete');
    expect(del?.danger).toBe(true);
    const move = views.find((tab) => tab.id === 'mail')?.tools.find((tool) => tool.id === 'mail.moveTo');
    expect(move?.picker).toBe('folder');
  });

  it('保留配置里的标签顺序与用户来源', () => {
    const merged = mergeRibbonConfig(DEFAULT_RIBBON_CONFIG, {
      version: RIBBON_CONFIG_VERSION,
      tabOrder: ['tools', 'file', 'mail', 'view'],
    });
    const views = buildRibbonViewModel(merged, baseCtx());
    expect(views.map((tab) => tab.id)).toEqual(['tools', 'file', 'mail', 'view']);
  });
});

describe('parseRibbonOverrides', () => {
  it('空值/坏 JSON/非对象一律回退 null', () => {
    expect(parseRibbonOverrides(null)).toBeNull();
    expect(parseRibbonOverrides('')).toBeNull();
    expect(parseRibbonOverrides('{不是 json')).toBeNull();
    expect(parseRibbonOverrides('[1,2,3]')).toBeNull();
    expect(parseRibbonOverrides('42')).toBeNull();
  });

  it('缺字段的工具被丢掉，不让脏数据进配置', () => {
    const raw = JSON.stringify({
      addedTools: {
        view: [
          { id: 'ok', commandId: 'calendar.open', label: '日历', icon: 'clock', when: 'always' },
          { id: 'no-command', label: '缺命令', icon: 'clock' },
          { commandId: 'calendar.open', label: '缺 id', icon: 'clock' },
          { id: 'bad-icon', commandId: 'calendar.open', label: '缺图标' },
          '我不是对象',
        ],
      },
    });
    const parsed = parseRibbonOverrides(raw);
    expect(parsed?.addedTools?.view?.map((tool) => tool.id)).toEqual(['ok']);
  });

  it('合法覆盖被完整解析', () => {
    const raw = JSON.stringify({
      tabOrder: ['tools', 'file'],
      hiddenTabs: ['view'],
      tabLabels: { mail: '邮件操作' },
      toolOrder: { mail: ['mail.delete'] },
      hiddenTools: ['mail.reply'],
      customTabs: [{ id: 'custom:mine', label: '我的', origin: 'user', tools: [] }],
    });
    const parsed = parseRibbonOverrides(raw);
    expect(parsed?.tabOrder).toEqual(['tools', 'file']);
    expect(parsed?.hiddenTabs).toEqual(['view']);
    expect(parsed?.tabLabels).toEqual({ mail: '邮件操作' });
    expect(parsed?.toolOrder).toEqual({ mail: ['mail.delete'] });
    expect(parsed?.hiddenTools).toEqual(['mail.reply']);
    expect(parsed?.customTabs?.length).toBe(1);
  });

  it('解析结果可直接用于合并，得到一致界面', () => {
    const raw = JSON.stringify({ hiddenTabs: ['view', 'tools'] });
    const merged = mergeRibbonConfig(DEFAULT_RIBBON_CONFIG, parseRibbonOverrides(raw));
    expect(tabIds(merged)).toEqual(['file', 'mail']);
  });

  it('类型不对的字段被忽略而不抛错', () => {
    const raw = JSON.stringify({
      tabOrder: 'tools',
      hiddenTabs: [1, 2, 'view'],
      tabLabels: [1, 2],
      toolOrder: { mail: 'nope' },
      addedTools: { view: 'nope' },
      customTabs: { id: 'x' },
    });
    const parsed = parseRibbonOverrides(raw);
    expect(parsed?.tabOrder).toBeUndefined();
    expect(parsed?.hiddenTabs).toEqual(['view']);
    expect(parsed?.tabLabels).toBeUndefined();
    expect(parsed?.toolOrder).toBeUndefined();
    expect(parsed?.addedTools).toBeUndefined();
    expect(parsed?.customTabs).toBeUndefined();
  });
});

describe('newCustomId', () => {
  it('带统一前缀且不重复', () => {
    const a = newCustomId('tool');
    const b = newCustomId('tool');
    expect(a.startsWith('custom:tool-')).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe('deriveRibbonOverrides（与 merge 互为逆运算）', () => {
  /** 把配置压成可比较的骨架（id/label/tool id/order）。 */
  function skeleton(config: RibbonConfig) {
    return config.tabs.map((tab) => ({
      id: tab.id,
      label: tab.label,
      origin: tab.origin,
      tools: tab.tools.map((tool) => tool.id),
    }));
  }

  function roundTrip(desired: RibbonConfig): void {
    const overrides = deriveRibbonOverrides(DEFAULT_RIBBON_CONFIG, desired);
    const merged = mergeRibbonConfig(DEFAULT_RIBBON_CONFIG, overrides);
    expect(skeleton(merged)).toEqual(skeleton(desired));
  }

  it('原样返回时产生空增量', () => {
    const overrides = deriveRibbonOverrides(DEFAULT_RIBBON_CONFIG, DEFAULT_RIBBON_CONFIG);
    expect(overrides.hiddenTabs).toBeUndefined();
    expect(overrides.hiddenTools).toBeUndefined();
    expect(overrides.tabLabels).toBeUndefined();
    expect(overrides.customTabs).toBeUndefined();
    expect(overrides.addedTools).toBeUndefined();
    // 只剩顺序表（顺序与默认一致，等于显式声明）
    expect(overrides.tabOrder).toEqual(['file', 'mail', 'view', 'tools']);
  });

  it('隐藏标签页可往返', () => {
    roundTrip({
      version: RIBBON_CONFIG_VERSION,
      tabs: DEFAULT_RIBBON_CONFIG.tabs.filter((tab) => tab.id !== 'view'),
    });
  });

  it('隐藏工具可往返', () => {
    const tabs = DEFAULT_RIBBON_CONFIG.tabs.map((tab) =>
      tab.id === 'mail'
        ? { ...tab, tools: tab.tools.filter((tool) => tool.id !== 'mail.replyAll') }
        : tab,
    );
    roundTrip({ version: RIBBON_CONFIG_VERSION, tabs });
  });

  it('改标签名可往返', () => {
    const tabs = DEFAULT_RIBBON_CONFIG.tabs.map((tab) =>
      tab.id === 'view' ? { ...tab, label: '浏览' } : tab,
    );
    roundTrip({ version: RIBBON_CONFIG_VERSION, tabs });
  });

  it('重排标签页与工具可往返', () => {
    const reorderedTabs = [...DEFAULT_RIBBON_CONFIG.tabs].reverse();
    const tabs = reorderedTabs.map((tab) =>
      tab.id === 'mail' ? { ...tab, tools: [...tab.tools].reverse() } : tab,
    );
    roundTrip({ version: RIBBON_CONFIG_VERSION, tabs });
  });

  it('新增自建工具（与内置交错）可往返', () => {
    const mailTab = DEFAULT_RIBBON_CONFIG.tabs.find((tab) => tab.id === 'mail');
    if (!mailTab) throw new Error('默认配置缺少 mail 标签');
    const custom = {
      id: 'custom:cal',
      commandId: 'calendar.open',
      label: '日历',
      icon: 'clock' as const,
      when: 'always' as const,
      origin: 'user' as const,
    };
    // 插在「回复」之后，与内置工具交错
    const tools = [...mailTab.tools];
    tools.splice(2, 0, custom);
    const tabs = DEFAULT_RIBBON_CONFIG.tabs.map((tab) =>
      tab.id === 'mail' ? { ...tab, tools } : tab,
    );
    roundTrip({ version: RIBBON_CONFIG_VERSION, tabs });
  });

  it('新增自建标签页（含工具）可往返', () => {
    roundTrip({
      version: RIBBON_CONFIG_VERSION,
      tabs: [
        ...DEFAULT_RIBBON_CONFIG.tabs,
        {
          id: 'custom:mine',
          label: '我的',
          origin: 'user',
          tools: [
            {
              id: 'custom:mine-1',
              commandId: 'calendar.open',
              label: '日历',
              icon: 'clock',
              when: 'always',
              origin: 'user',
            },
          ],
        },
      ],
    });
  });

  it('组合操作可往返，且不破坏升级流动性', () => {
    const tabs = DEFAULT_RIBBON_CONFIG.tabs
      .filter((tab) => tab.id !== 'tools')
      .map((tab) =>
        tab.id === 'view'
          ? {
              ...tab,
              label: '浏览',
              tools: [
                ...tab.tools.filter((tool) => tool.id !== 'view.filterStarred'),
                {
                  id: 'custom:cal',
                  commandId: 'calendar.open',
                  label: '日历',
                  icon: 'clock' as const,
                  when: 'always' as const,
                  origin: 'user' as const,
                },
              ],
            }
          : tab,
      );
    const desired: RibbonConfig = { version: RIBBON_CONFIG_VERSION, tabs };
    const overrides = deriveRibbonOverrides(DEFAULT_RIBBON_CONFIG, desired);

    // 增量里只记「差异」，不把整套内置默认快照进去
    expect(overrides.hiddenTabs).toEqual(['tools']);
    expect(overrides.hiddenTools).toEqual(['view.filterStarred']);
    expect(overrides.tabLabels).toEqual({ view: '浏览' });
    expect(Object.keys(overrides.addedTools ?? {})).toEqual(['view']);

    roundTrip(desired);
  });
});

describe('splitRibbonTools（溢出折叠）', () => {
  function view(id: string, picker?: 'folder'): RibbonToolView {
    return {
      id,
      commandId: id,
      label: id,
      icon: 'command',
      disabled: false,
      active: false,
      danger: false,
      ...(picker ? { picker } : {}),
    };
  }

  it('不超过上限时全部内联，没有溢出', () => {
    const tools = Array.from({ length: RIBBON_OVERFLOW_AT }, (_, i) => view(`t${i}`));
    const split = splitRibbonTools(tools);
    expect(split.visible.length).toBe(RIBBON_OVERFLOW_AT);
    expect(split.overflow.length).toBe(0);
  });

  it('超出上限时多出来的进溢出，且顺序不变', () => {
    const tools = Array.from({ length: RIBBON_OVERFLOW_AT + 3 }, (_, i) => view(`t${i}`));
    const split = splitRibbonTools(tools);
    expect(split.visible.map((tool) => tool.id)).toEqual(
      tools.slice(0, RIBBON_OVERFLOW_AT).map((tool) => tool.id),
    );
    expect(split.overflow.map((tool) => tool.id)).toEqual(
      tools.slice(RIBBON_OVERFLOW_AT).map((tool) => tool.id),
    );
  });

  it('文件夹选择器不占用内联名额，也永远不会被折进菜单', () => {
    const tools = Array.from({ length: RIBBON_OVERFLOW_AT }, (_, i) => view(`t${i}`));
    // 把选择器插在中间
    tools.splice(3, 0, view('move', 'folder'));
    const split = splitRibbonTools(tools);
    expect(split.overflow.length).toBe(0);
    expect(split.visible.some((tool) => tool.id === 'move')).toBe(true);
    // 12 个普通工具仍然全部可见（选择器不计数）
    expect(split.visible.filter((tool) => tool.picker !== 'folder').length).toBe(RIBBON_OVERFLOW_AT);
  });

  it('选择器与溢出同时存在时，两者都在正确的位置', () => {
    const tools = Array.from({ length: RIBBON_OVERFLOW_AT + 2 }, (_, i) => view(`t${i}`));
    tools.splice(5, 0, view('move', 'folder'));
    const split = splitRibbonTools(tools);
    expect(split.overflow.map((tool) => tool.id)).toEqual(['t12', 't13']);
    expect(split.visible.map((tool) => tool.id)).toContain('move');
  });

  it('是否溢出与按钮的禁用状态无关（禁用的按钮照样占位）', () => {
    const tools = Array.from({ length: RIBBON_OVERFLOW_AT + 1 }, (_, i) => ({
      ...view(`t${i}`),
      disabled: true,
    }));
    const split = splitRibbonTools(tools);
    expect(split.visible.length).toBe(RIBBON_OVERFLOW_AT);
    expect(split.overflow.length).toBe(1);
  });
});

describe('工具改名（toolLabels）', () => {
  it('合并时应用改名，且不再跟随状态切换标签', () => {
    const merged = mergeRibbonConfig(DEFAULT_RIBBON_CONFIG, {
      version: RIBBON_CONFIG_VERSION,
      toolLabels: { 'mail.toggleRead': '标记已读状态' },
    });
    const tool = merged.tabs
      .find((tab) => tab.id === 'mail')
      ?.tools.find((item) => item.id === 'mail.toggleRead');
    expect(tool?.label).toBe('标记已读状态');
    // 改名后 alt 标签被清掉，选中未读也不会变成「标为已读」
    expect(tool?.labelAlt).toBeUndefined();
    expect(tool?.altWhen).toBeUndefined();

    const unreadView = buildRibbonViewModel(merged, baseCtx()).find((tab) => tab.id === 'mail');
    expect(unreadView?.tools.find((item) => item.id === 'mail.toggleRead')?.label).toBe(
      '标记已读状态',
    );
    const selected = buildRibbonViewModel(
      merged,
      baseCtx({ mailSelected: true, selectedUnread: true }),
    ).find((tab) => tab.id === 'mail');
    expect(selected?.tools.find((item) => item.id === 'mail.toggleRead')?.label).toBe(
      '标记已读状态',
    );
  });

  it('派生增量时把内置工具改名记进 toolLabels，未改的不写', () => {
    const tabs = DEFAULT_RIBBON_CONFIG.tabs.map((tab) =>
      tab.id === 'file'
        ? {
            ...tab,
            tools: tab.tools.map((tool) =>
              tool.id === 'file.quit' ? { ...tool, label: '关闭程序' } : tool,
            ),
          }
        : tab,
    );
    const overrides = deriveRibbonOverrides(DEFAULT_RIBBON_CONFIG, {
      version: RIBBON_CONFIG_VERSION,
      tabs,
    });
    expect(overrides.toolLabels).toEqual({ 'file.quit': '关闭程序' });
  });

  it('改名可往返：派生 → 合并后标签一致', () => {
    const tabs = DEFAULT_RIBBON_CONFIG.tabs.map((tab) =>
      tab.id === 'view'
        ? {
            ...tab,
            tools: tab.tools.map((tool) =>
              tool.id === 'view.filterUnread' ? { ...tool, label: '只看未读' } : tool,
            ),
          }
        : tab,
    );
    const desired: RibbonConfig = { version: RIBBON_CONFIG_VERSION, tabs };
    const merged = mergeRibbonConfig(DEFAULT_RIBBON_CONFIG, deriveRibbonOverrides(DEFAULT_RIBBON_CONFIG, desired));
    const tool = merged.tabs
      .find((tab) => tab.id === 'view')
      ?.tools.find((item) => item.id === 'view.filterUnread');
    expect(tool?.label).toBe('只看未读');
  });

  it('改回原名时不再记录改名（不留下陈旧增量）', () => {
    const overrides = deriveRibbonOverrides(DEFAULT_RIBBON_CONFIG, DEFAULT_RIBBON_CONFIG);
    expect(overrides.toolLabels).toBeUndefined();
  });
});

describe('极端配置兜底', () => {
  it('所有标签都被隐藏时回落到内置默认，不让工具栏整条消失', () => {
    const merged = mergeRibbonConfig(DEFAULT_RIBBON_CONFIG, {
      version: RIBBON_CONFIG_VERSION,
      hiddenTabs: ['file', 'mail', 'view', 'tools'],
    });
    expect(merged.tabs.map((tab) => tab.id)).toEqual(['file', 'mail', 'view', 'tools']);
  });

  it('只隐藏一部分时正常生效（兜底不能顺手把正常配置改掉）', () => {
    const merged = mergeRibbonConfig(DEFAULT_RIBBON_CONFIG, {
      version: RIBBON_CONFIG_VERSION,
      hiddenTabs: ['file', 'view', 'tools'],
    });
    expect(merged.tabs.map((tab) => tab.id)).toEqual(['mail']);
  });
});

describe('parseRibbonConfig（导入用）', () => {
  it('合法配置按原样解析', () => {
    const raw = JSON.stringify({
      tabs: [
        {
          id: 'custom:imp',
          label: '导入的',
          origin: 'user',
          tools: [
            { id: 'custom:imp-1', commandId: 'mail.compose', label: '写信', icon: 'compose', when: 'always' },
          ],
        },
      ],
    });
    const parsed = parseRibbonConfig(raw);
    expect(parsed?.tabs.length).toBe(1);
    expect(parsed?.tabs[0]?.id).toBe('custom:imp');
    expect(parsed?.tabs[0]?.tools[0]?.commandId).toBe('mail.compose');
  });

  it('坏 JSON / 缺 tabs / 空 tabs 一律返回 null', () => {
    expect(parseRibbonConfig(null)).toBeNull();
    expect(parseRibbonConfig('')).toBeNull();
    expect(parseRibbonConfig('不是 json')).toBeNull();
    expect(parseRibbonConfig('{"foo":1}')).toBeNull();
    expect(parseRibbonConfig('[]')).toBeNull();
    expect(parseRibbonConfig('{"tabs":[]}')).toBeNull();
    expect(parseRibbonConfig('{"tabs":[{"label":"没有 id"}]}')).toBeNull();
  });

  it('字段不全的条目被丢掉，不会让整份配置失败', () => {
    const raw = JSON.stringify({
      tabs: [
        { id: 'ok', label: '好的', tools: [] },
        { label: '缺 id' },
        {
          id: 'ok2',
          label: '工具不全',
          tools: [
            { id: 'a', commandId: 'x', label: 'A', icon: 'command' },
            { id: 'b', label: '缺命令' },
          ],
        },
      ],
    });
    const parsed = parseRibbonConfig(raw);
    expect(parsed?.tabs.map((tab) => tab.id)).toEqual(['ok', 'ok2']);
    expect(parsed?.tabs[1]?.tools.map((tool) => tool.id)).toEqual(['a']);
  });
});

describe('内置文案走 i18n 目录', () => {
  it('每个内置标签页与工具的文字都来自目录（不是硬编码）', () => {
    for (const tab of DEFAULT_RIBBON_CONFIG.tabs) {
      expect(tab.label).toBe(t(`ribbon.tab.${tab.id}`));
      for (const tool of tab.tools) {
        expect(tool.label).toBe(t(`ribbon.tool.${tool.id}`));
        if (tool.labelAlt) {
          expect(tool.labelAlt).toBe(t(`ribbon.tool.${tool.id}.alt`));
        }
      }
    }
  });

  it('目录里 key 齐全（t 不会回退成 key 本身）', () => {
    expect(t('ribbon.tab.mail')).toBe('邮件');
    expect(t('ribbon.tool.mail.reply')).toBe('回复');
    expect(t('ribbon.collapse')).toBe('折叠工具栏');
    expect(t('ribbon.more.title', { count: 3 })).toBe('更多工具（3 个）');
    expect(t('ribbon.editor.imported', { count: 2 })).toBe('已导入 2 个标签页，记得保存');
  });
});

describe('默认配置的文案来源（源码级守卫）', () => {
  it('DEFAULT_RIBBON_CONFIG 里不允许写死中文标签，必须走 t()', () => {
    const file = path.resolve(__dirname, '../src/shared/ribbon.ts');
    const source = fs.readFileSync(file, 'utf8');
    const start = source.indexOf('export const DEFAULT_RIBBON_CONFIG');
    const end = source.indexOf('/** ribbon 求值上下文', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = source.slice(start, end);

    // 值断言分辨不出「写死成和目录一样」的情况，这里守结构：
    // 不允许 label/labelAlt 直接跟字符串字面量。
    expect(block).not.toMatch(/label(Alt)?:\s*'/);

    // 每个工具与每个标签各有一处 label，必须都是 t(...)
    const commandCount = (block.match(/commandId:/g) ?? []).length;
    const tabCount = (block.match(/id: '(file|mail|view|tools)',/g) ?? []).length;
    expect((block.match(/label: t\(/g) ?? []).length).toBe(commandCount + tabCount);
    // labelAlt 也必须走 t()，且不允许出现字面量
    expect((block.match(/labelAlt: '/g) ?? []).length).toBe(0);
  });
});
