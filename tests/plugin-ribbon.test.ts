import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RIBBON_CONFIG,
  RIBBON_CONFIG_VERSION,
  applyPluginRibbon,
  buildRibbonViewModel,
  deriveRibbonOverrides,
  mergeRibbonConfig,
  type RibbonContext,
} from '../src/shared/ribbon';
import type { PluginRibbonSource } from '../src/shared/types';
import { parseManifest } from '../src/main/plugins/manifest';

/**
 * 插件对工具栏的贡献（C 方案「扩展层」）。
 *
 * 必须守住的性质：
 *  - 只追加：宿主/用户条目绝不被插件改动或删除；
 *  - 命名空间：id 一律 plugin:<pluginId>:...，两个插件同名 id 不会互相覆盖；
 *  - 目标缺失就跳过：用户把目标标签隐藏后，插件按钮不能偷偷出现在别处；
 *  - 脏值兜底：非法图标/条件退回 plugin/always；
 *  - 不污染用户配置：deriveRibbonOverrides 必须忽略 plugin 条目。
 */

function source(overrides: Partial<PluginRibbonSource> = {}): PluginRibbonSource {
  return {
    pluginId: 'demo',
    pluginName: 'Demo 插件',
    tabs: [],
    tools: [],
    ...overrides,
  };
}

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

function toolIdsOf(config: ReturnType<typeof applyPluginRibbon>, tabId: string): string[] {
  return config.tabs.find((tab) => tab.id === tabId)?.tools.map((tool) => tool.id) ?? [];
}

describe('applyPluginRibbon', () => {
  it('无贡献时原样返回（连对象都不复制）', () => {
    const config = mergeRibbonConfig(DEFAULT_RIBBON_CONFIG, null);
    expect(applyPluginRibbon(config, [])).toBe(config);
  });

  it('自建标签页追加到末尾，并标记 plugin 来源', () => {
    const config = applyPluginRibbon(mergeRibbonConfig(DEFAULT_RIBBON_CONFIG, null), [
      source({
        tabs: [{ id: 'helper', label: 'Demo' }],
        tools: [
          { tab: 'helper', id: 'open', label: '打开', command: 'demo.open', icon: 'plugin' },
        ],
      }),
    ]);
    expect(config.tabs.map((tab) => tab.id)).toEqual([
      'file',
      'mail',
      'view',
      'tools',
      'plugin:demo:helper',
    ]);
    const tab = config.tabs[config.tabs.length - 1];
    expect(tab?.origin).toBe('plugin');
    expect(tab?.tools[0]?.commandId).toBe('plugin:demo:demo.open');
    expect(tab?.tools[0]?.origin).toBe('plugin');
  });

  it('可以往内置标签里插工具，且排在宿主工具之后', () => {
    const config = applyPluginRibbon(mergeRibbonConfig(DEFAULT_RIBBON_CONFIG, null), [
      source({
        tools: [
          { tab: 'tools', id: 'extra', label: '插件动作', command: 'demo.act', icon: 'ai' },
        ],
      }),
    ]);
    const ids = toolIdsOf(config, 'tools');
    expect(ids).toContain('plugin:demo:extra');
    expect(ids[ids.length - 1]).toBe('plugin:demo:extra');
    // 宿主原有工具一个都不能少
    expect(ids).toContain('tools.compose');
    expect(ids).toContain('tools.plugins');
  });

  it('目标标签不存在（例如被用户隐藏）时跳过，不挪到别处', () => {
    const hidden = mergeRibbonConfig(DEFAULT_RIBBON_CONFIG, {
      version: RIBBON_CONFIG_VERSION,
      hiddenTabs: ['tools'],
    });
    const config = applyPluginRibbon(hidden, [
      source({ tools: [{ tab: 'tools', id: 'x', label: 'X', command: 'demo.x' }] }),
    ]);
    expect(config.tabs.map((tab) => tab.id)).not.toContain('tools');
    // 关键：这个工具不能出现在任何一个标签里（id 是命名空间后的 plugin:demo:x）
    expect(
      config.tabs.some((tab) => tab.tools.some((tool) => tool.id === 'plugin:demo:x')),
    ).toBe(false);
  });

  it('插件自带的 order 决定同标签内顺序，相同 order 按声明顺序', () => {
    const config = applyPluginRibbon(mergeRibbonConfig(DEFAULT_RIBBON_CONFIG, null), [
      source({
        tabs: [{ id: 'p', label: 'P' }],
        tools: [
          { tab: 'p', id: 'c', label: 'C', command: 'c', order: 20 },
          { tab: 'p', id: 'a', label: 'A', command: 'a', order: 10 },
          { tab: 'p', id: 'b', label: 'B', command: 'b', order: 10 },
        ],
      }),
    ]);
    expect(toolIdsOf(config, 'plugin:demo:p')).toEqual([
      'plugin:demo:a',
      'plugin:demo:b',
      'plugin:demo:c',
    ]);
  });

  it('多个插件按 pluginId 稳定排序，同名 id 因命名空间不冲突', () => {
    const config = applyPluginRibbon(mergeRibbonConfig(DEFAULT_RIBBON_CONFIG, null), [
      source({ pluginId: 'zeta', pluginName: 'Z', tabs: [{ id: 't', label: 'Z' }] }),
      source({ pluginId: 'alpha', pluginName: 'A', tabs: [{ id: 't', label: 'A' }] }),
    ]);
    expect(config.tabs.slice(-2).map((tab) => tab.id)).toEqual([
      'plugin:alpha:t',
      'plugin:zeta:t',
    ]);
    expect(config.tabs.slice(-2).map((tab) => tab.label)).toEqual(['A', 'Z']);
  });

  it('非法图标与非法条件退回默认值', () => {
    const config = applyPluginRibbon(mergeRibbonConfig(DEFAULT_RIBBON_CONFIG, null), [
      source({
        tabs: [{ id: 'p', label: 'P' }],
        tools: [
          {
            tab: 'p',
            id: 'bad',
            label: '坏值',
            command: 'x',
            icon: 'evil-icon',
            when: 'rm -rf /',
          },
        ],
      }),
    ]);
    const tool = config.tabs.find((tab) => tab.id === 'plugin:demo:p')?.tools[0];
    expect(tool?.icon).toBe('plugin');
    expect(tool?.when).toBe('always');
  });

  it('不修改入参配置（纯函数）', () => {
    const base = mergeRibbonConfig(DEFAULT_RIBBON_CONFIG, null);
    const before = JSON.stringify(base);
    applyPluginRibbon(base, [
      source({
        tabs: [{ id: 'p', label: 'P' }],
        tools: [{ tab: 'tools', id: 'x', label: 'X', command: 'x' }],
      }),
    ]);
    expect(JSON.stringify(base)).toBe(before);
  });

  it('重复的标签/工具 id 不会重复添加', () => {
    const config = applyPluginRibbon(mergeRibbonConfig(DEFAULT_RIBBON_CONFIG, null), [
      source({
        tabs: [{ id: 'p', label: 'P' }],
        tools: [
          { tab: 'p', id: 'x', label: 'X', command: 'x' },
          { tab: 'p', id: 'x', label: 'X2', command: 'x' },
        ],
      }),
    ]);
    expect(toolIdsOf(config, 'plugin:demo:p')).toEqual(['plugin:demo:x']);
  });

  it('被单独关掉的插件贡献不出现，其他插件不受影响', () => {
    const config = applyPluginRibbon(
      mergeRibbonConfig(DEFAULT_RIBBON_CONFIG, null),
      [
        source({
          pluginId: 'alpha',
          pluginName: 'A',
          tabs: [{ id: 't', label: 'A' }],
          tools: [{ tab: 'tools', id: 'a', label: 'A 按钮', command: 'a' }],
        }),
        source({
          pluginId: 'beta',
          pluginName: 'B',
          tabs: [{ id: 't', label: 'B' }],
          tools: [{ tab: 'tools', id: 'b', label: 'B 按钮', command: 'b' }],
        }),
      ],
      ['alpha'],
    );

    expect(config.tabs.map((tab) => tab.id)).not.toContain('plugin:alpha:t');
    expect(config.tabs.map((tab) => tab.id)).toContain('plugin:beta:t');
    expect(toolIdsOf(config, 'tools')).toContain('plugin:beta:b');
    expect(toolIdsOf(config, 'tools')).not.toContain('plugin:alpha:a');
  });

  it('屏蔽全部插件时退化为宿主配置', () => {
    const base = mergeRibbonConfig(DEFAULT_RIBBON_CONFIG, null);
    const config = applyPluginRibbon(
      base,
      [source({ tabs: [{ id: 't', label: 'T' }] })],
      ['demo'],
    );
    expect(config).toBe(base);
  });

  it('贡献出来的按钮经 buildRibbonViewModel 后能被 when 正常求值', () => {
    const config = applyPluginRibbon(mergeRibbonConfig(DEFAULT_RIBBON_CONFIG, null), [
      source({
        tabs: [{ id: 'p', label: 'P' }],
        tools: [
          { tab: 'p', id: 'need-selection', label: '需选中', command: 'x', when: 'mailSelected' },
        ],
      }),
    ]);
    const withoutSelection = buildRibbonViewModel(config, baseCtx());
    const withSelection = buildRibbonViewModel(config, baseCtx({ mailSelected: true }));
    const find = (views: ReturnType<typeof buildRibbonViewModel>) =>
      views.find((tab) => tab.id === 'plugin:demo:p')?.tools[0];
    expect(find(withoutSelection)?.disabled).toBe(true);
    expect(find(withSelection)?.disabled).toBe(false);
  });
});

describe('deriveRibbonOverrides 不吞插件条目', () => {
  it('把带插件条目的配置折算成覆盖时，插件条目不会变成用户自建', () => {
    const withPlugin = applyPluginRibbon(mergeRibbonConfig(DEFAULT_RIBBON_CONFIG, null), [
      source({
        tabs: [{ id: 'p', label: 'P' }],
        tools: [{ tab: 'tools', id: 'x', label: 'X', command: 'x' }],
      }),
    ]);
    const overrides = deriveRibbonOverrides(DEFAULT_RIBBON_CONFIG, withPlugin);
    expect(overrides.customTabs ?? []).toEqual([]);
    expect(JSON.stringify(overrides.addedTools ?? {})).not.toContain('plugin:demo');
    expect(JSON.stringify(overrides.toolOrder ?? {})).not.toContain('plugin:demo');
    // 重新合并后，工具栏上只剩宿主条目（插件条目需要重新 applyPluginRibbon）
    const rebuilt = mergeRibbonConfig(DEFAULT_RIBBON_CONFIG, overrides);
    expect(rebuilt.tabs.map((tab) => tab.id)).toEqual(['file', 'mail', 'view', 'tools']);
  });
});

describe('contributes.ribbon 清单校验', () => {
  const base = {
    id: 'demo-plugin',
    name: 'Demo',
    version: '1.0.0',
    apiVersion: 1,
    contributes: {
      commands: [{ id: 'demo.act', label: '动作' }],
    },
  };

  it('接受合法贡献（内置标签 + 自建标签）', () => {
    const result = parseManifest({
      ...base,
      contributes: {
        commands: [{ id: 'demo.act', label: '动作' }],
        ribbon: {
          tabs: [{ id: 'helper', label: 'Demo' }],
          tools: [
            { tab: 'tools', id: 'in-builtin', label: '插内置', command: 'demo.act' },
            { tab: 'helper', id: 'in-own', label: '插自建', command: 'demo.act' },
          ],
        },
      },
    });
    expect(result.ok).toBe(true);
  });

  it('拒绝指向未声明命令的按钮（避免点了没反应的死按钮）', () => {
    const result = parseManifest({
      ...base,
      contributes: {
        commands: [{ id: 'demo.act', label: '动作' }],
        ribbon: {
          tools: [{ tab: 'tools', id: 'ghost', label: '幽灵', command: 'not.declared' }],
        },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('not.declared');
  });

  it('拒绝指向不存在标签的按钮', () => {
    const result = parseManifest({
      ...base,
      contributes: {
        commands: [{ id: 'demo.act', label: '动作' }],
        ribbon: {
          tools: [{ tab: 'no-such-tab', id: 'x', label: 'X', command: 'demo.act' }],
        },
      },
    });
    expect(result.ok).toBe(false);
  });

  it('拒绝白名单之外的图标与条件', () => {
    expect(
      parseManifest({
        ...base,
        contributes: {
          commands: [{ id: 'demo.act', label: '动作' }],
          ribbon: {
            tools: [{ tab: 'tools', id: 'x', label: 'X', command: 'demo.act', icon: 'evil' }],
          },
        },
      }).ok,
    ).toBe(false);
    expect(
      parseManifest({
        ...base,
        contributes: {
          commands: [{ id: 'demo.act', label: '动作' }],
          ribbon: {
            tools: [{ tab: 'tools', id: 'x', label: 'X', command: 'demo.act', when: 'process.exit()' }],
          },
        },
      }).ok,
    ).toBe(false);
  });

  it('拒绝重复的工具 id / 标签 id', () => {
    expect(
      parseManifest({
        ...base,
        contributes: {
          commands: [{ id: 'demo.act', label: '动作' }],
          ribbon: {
            tools: [
              { tab: 'tools', id: 'dup', label: 'A', command: 'demo.act' },
              { tab: 'tools', id: 'dup', label: 'B', command: 'demo.act' },
            ],
          },
        },
      }).ok,
    ).toBe(false);
    expect(
      parseManifest({
        ...base,
        contributes: {
          commands: [{ id: 'demo.act', label: '动作' }],
          ribbon: { tabs: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] },
        },
      }).ok,
    ).toBe(false);
  });

  it('拒绝超出数量上限的贡献', () => {
    const tooMany = Array.from({ length: 21 }, (_, index) => ({
      tab: 'tools',
      id: `t${index}`,
      label: `T${index}`,
      command: 'demo.act',
    }));
    expect(
      parseManifest({
        ...base,
        contributes: {
          commands: [{ id: 'demo.act', label: '动作' }],
          ribbon: { tools: tooMany },
        },
      }).ok,
    ).toBe(false);
  });

  it('拒绝未知字段（防止插件偷塞宿主不认识的配置）', () => {
    expect(
      parseManifest({
        ...base,
        contributes: {
          commands: [{ id: 'demo.act', label: '动作' }],
          ribbon: { tools: [], evil: true },
        },
      }).ok,
    ).toBe(false);
  });
});
