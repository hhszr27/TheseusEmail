import type { ListFilter } from './ipc';
import { t } from './i18n';
import type { PluginRibbonSource } from './types';

/**
 * Ribbon 工具栏的数据模型与纯函数（单一来源，§35 ribbon 可配置化第一步）。
 *
 * 设计约束：
 *  - 模型是「内置默认 + 用户增量覆盖」，与快捷键（mergeBindings/HOST_COMMANDS）同一套思路。
 *    升级带来新的内置按钮时能自动流进用户布局，不会把用户改过的东西打乱。
 *  - 工具只绑定「已注册命令 id」，不承载任意脚本；执行时仍由命令分发层校验权限。
 *  - 内置条目删不掉源码，只能隐藏（hiddenTools/hiddenTabs）；用户自建条目可整条删除。
 *  - 合并与求值全是纯函数，放这里而不是 store/组件里，便于单测与变异证伪。
 */

/** 内置标签页 id（插件贡献的 tab 目标只允许这些或插件自己声明的标签）。 */
export const RIBBON_BUILTIN_TAB_IDS = ['file', 'mail', 'view', 'tools'] as const;

/** ribbon 按钮可用的图标名（与 ActionRibbon 的 ICONS 表共用一份来源）。 */
export const RIBBON_ICON_NAMES = [
  'compose',
  'reply',
  'replyAll',
  'forward',
  'trash',
  'archive',
  'move',
  'read',
  'star',
  'unified',
  'inbox',
  'sent',
  'drafts',
  'clock',
  'filter',
  'refresh',
  'ai',
  'command',
  'plugin',
  'settings',
  'power',
  'quickView',
  'layout',
] as const;

export type RibbonIconName = (typeof RIBBON_ICON_NAMES)[number];

/**
 * 按钮可见/可用条件。封闭集合，不做表达式求值，
 * 保证「用户能拼装界面」与「不能引入任意逻辑」同时成立。
 */
export const RIBBON_WHEN_NAMES = [
  'always',
  /** 邮件视图且已选中一封邮件。 */
  'mailSelected',
  'selectedUnread',
  'selectedStarred',
  'hasAccounts',
  'unified',
  'listAll',
  'listUnread',
  'listStarred',
  /** 当前停留在设置视图。 */
  'viewSettings',
  /** 阅读区当前正在显示（未被「快速视图」隐藏）。 */
  'readerShown',
  /** 列表/正文当前为上下布局（「布局」按钮高亮/切换标签）。 */
  'vertical',
] as const;

export type RibbonWhen = (typeof RIBBON_WHEN_NAMES)[number];

export interface RibbonTool {
  /** 稳定 id：内置用语义 id，用户新增用 `custom:<随机>`。 */
  id: string;
  /** 绑定到 HOST_COMMANDS / 插件命令（`plugin:<pluginId>:<commandId>`）。 */
  commandId: string;
  label: string;
  icon: RibbonIconName;
  when: RibbonWhen;
  /** 命令参数，如移动到哪个文件夹、跳到哪个文件夹/视图。 */
  args?: Record<string, string>;
  danger?: boolean;
  /** 命中时按钮高亮（当前筛选、当前视图、统一收件箱开启等）。 */
  activeWhen?: RibbonWhen;
  /** altWhen 命中时改用这个标签（如「标为未读」↔「标为已读」）。 */
  labelAlt?: string;
  altWhen?: RibbonWhen;
  /** 渲染成文件夹下拉而不是普通按钮（如「移动到」）。 */
  picker?: 'folder';
  /** 点击时把按钮坐标作为 {x, y} 传给命令（供「插件命令」这类要定位菜单的命令用）。 */
  openWithAnchor?: boolean;
  origin: 'builtin' | 'user' | 'plugin';
}

export interface RibbonTab {
  id: string;
  label: string;
  tools: RibbonTool[];
  origin: 'builtin' | 'user' | 'plugin';
}

export interface RibbonConfig {
  version: number;
  tabs: RibbonTab[];
}

/** 用户对 ribbon 的增量修改；与内置默认合并后才是生效配置。 */
export interface RibbonOverrides {
  version: number;
  /** 标签显示顺序；未列出的按默认顺序追加。 */
  tabOrder?: string[];
  /** 隐藏的标签 id（内置标签只能隐藏，不能删）。 */
  hiddenTabs?: string[];
  /** 标签改名覆盖。 */
  tabLabels?: Record<string, string>;
  /** 工具改名覆盖（内置工具也能改，用户要求「修改我们生成的内容」）。 */
  toolLabels?: Record<string, string>;
  /** 每个标签内工具顺序（tabId → toolId 列表）。 */
  toolOrder?: Record<string, string[]>;
  /** 隐藏的工具 id。 */
  hiddenTools?: string[];
  /** 用户新增工具，按目标标签分组（可加到内置标签里）。 */
  addedTools?: Record<string, RibbonTool[]>;
  /** 用户自建标签。 */
  customTabs?: RibbonTab[];
  /**
   * 不显示这些插件的工具栏贡献。
   * 只影响工具栏，不禁用插件本身（插件的视图/菜单/命令照常工作）。
   */
  hiddenPlugins?: string[];
}

export const RIBBON_CONFIG_VERSION = 1;

/** ribbon 覆盖配置在 app_settings 里的 key（与 keybindings 同址，复用通用设置通道）。 */
export const RIBBON_SETTING_KEY = 'ribbon';

export const DEFAULT_RIBBON_CONFIG: RibbonConfig = {
  version: RIBBON_CONFIG_VERSION,
  tabs: [
    {
      id: 'file',
      label: t('ribbon.tab.file'),
      origin: 'builtin',
      tools: [
        { id: 'file.compose', commandId: 'mail.compose', label: t('ribbon.tool.file.compose'), icon: 'compose', when: 'always', origin: 'builtin' },
        { id: 'file.settings', commandId: 'view.settings', label: t('ribbon.tool.file.settings'), icon: 'settings', when: 'always', origin: 'builtin' },
        { id: 'file.palette', commandId: 'palette.open', label: t('ribbon.tool.file.palette'), icon: 'command', when: 'always', origin: 'builtin' },
        { id: 'file.quit', commandId: 'app.quit', label: t('ribbon.tool.file.quit'), icon: 'power', when: 'always', danger: true, origin: 'builtin' },
      ],
    },
    {
      id: 'mail',
      label: t('ribbon.tab.mail'),
      origin: 'builtin',
      tools: [
        { id: 'mail.compose', commandId: 'mail.compose', label: t('ribbon.tool.mail.compose'), icon: 'compose', when: 'always', origin: 'builtin' },
        { id: 'mail.reply', commandId: 'mail.reply', label: t('ribbon.tool.mail.reply'), icon: 'reply', when: 'mailSelected', origin: 'builtin' },
        { id: 'mail.replyAll', commandId: 'mail.replyAll', label: t('ribbon.tool.mail.replyAll'), icon: 'replyAll', when: 'mailSelected', origin: 'builtin' },
        { id: 'mail.forward', commandId: 'mail.forward', label: t('ribbon.tool.mail.forward'), icon: 'forward', when: 'mailSelected', origin: 'builtin' },
        {
          id: 'mail.toggleRead',
          commandId: 'mail.toggleRead',
          label: t('ribbon.tool.mail.toggleRead'),
          labelAlt: t('ribbon.tool.mail.toggleRead.alt'),
          altWhen: 'selectedUnread',
          icon: 'read',
          when: 'mailSelected',
          origin: 'builtin',
        },
        {
          id: 'mail.star',
          commandId: 'mail.star',
          label: t('ribbon.tool.mail.star'),
          labelAlt: t('ribbon.tool.mail.star.alt'),
          altWhen: 'selectedStarred',
          icon: 'star',
          when: 'mailSelected',
          activeWhen: 'selectedStarred',
          origin: 'builtin',
        },
        { id: 'mail.archive', commandId: 'mail.archive', label: t('ribbon.tool.mail.archive'), icon: 'archive', when: 'mailSelected', origin: 'builtin' },
        { id: 'mail.moveTo', commandId: 'mail.moveTo', label: t('ribbon.tool.mail.moveTo'), icon: 'move', when: 'mailSelected', picker: 'folder', origin: 'builtin' },
        { id: 'mail.delete', commandId: 'mail.delete', label: t('ribbon.tool.mail.delete'), icon: 'trash', when: 'mailSelected', danger: true, origin: 'builtin' },
      ],
    },
    {
      id: 'view',
      label: t('ribbon.tab.view'),
      origin: 'builtin',
      tools: [
        { id: 'view.unified', commandId: 'view.unified', label: t('ribbon.tool.view.unified'), icon: 'unified', when: 'hasAccounts', activeWhen: 'unified', origin: 'builtin' },
        { id: 'view.inbox', commandId: 'view.inbox', label: t('ribbon.tool.view.inbox'), icon: 'inbox', when: 'always', origin: 'builtin' },
        { id: 'view.sent', commandId: 'view.sent', label: t('ribbon.tool.view.sent'), icon: 'sent', when: 'always', origin: 'builtin' },
        { id: 'view.drafts', commandId: 'view.drafts', label: t('ribbon.tool.view.drafts'), icon: 'drafts', when: 'always', origin: 'builtin' },
        { id: 'view.outbox', commandId: 'view.outbox', label: t('ribbon.tool.view.outbox'), icon: 'clock', when: 'always', origin: 'builtin' },
        { id: 'view.filterAll', commandId: 'list.filter', label: t('ribbon.tool.view.filterAll'), icon: 'filter', when: 'always', activeWhen: 'listAll', args: { filter: 'all' }, origin: 'builtin' },
        { id: 'view.filterUnread', commandId: 'list.filter', label: t('ribbon.tool.view.filterUnread'), icon: 'filter', when: 'always', activeWhen: 'listUnread', args: { filter: 'unread' }, origin: 'builtin' },
        { id: 'view.filterStarred', commandId: 'list.filter', label: t('ribbon.tool.view.filterStarred'), icon: 'star', when: 'always', activeWhen: 'listStarred', args: { filter: 'starred' }, origin: 'builtin' },
        {
          id: 'view.quickView',
          commandId: 'view.toggleReader',
          label: t('ribbon.tool.view.quickView'),
          labelAlt: t('ribbon.tool.view.quickView.alt'),
          altWhen: 'readerShown',
          activeWhen: 'readerShown',
          icon: 'quickView',
          when: 'always',
          origin: 'builtin',
        },
        {
          id: 'view.layout',
          commandId: 'view.toggleLayout',
          label: t('ribbon.tool.view.layout'),
          labelAlt: t('ribbon.tool.view.layout.alt'),
          altWhen: 'vertical',
          activeWhen: 'vertical',
          icon: 'layout',
          when: 'always',
          origin: 'builtin',
        },
      ],
    },
    {
      id: 'tools',
      label: t('ribbon.tab.tools'),
      origin: 'builtin',
      tools: [
        { id: 'tools.compose', commandId: 'mail.compose', label: t('ribbon.tool.tools.compose'), icon: 'compose', when: 'always', origin: 'builtin' },
        { id: 'tools.refresh', commandId: 'mail.refresh', label: t('ribbon.tool.tools.refresh'), icon: 'refresh', when: 'always', origin: 'builtin' },
        { id: 'tools.ai', commandId: 'ai.open', label: t('ribbon.tool.tools.ai'), icon: 'ai', when: 'always', origin: 'builtin' },
        { id: 'tools.palette', commandId: 'palette.open', label: t('ribbon.tool.tools.palette'), icon: 'command', when: 'always', origin: 'builtin' },
        { id: 'tools.plugins', commandId: 'plugins.menu', label: t('ribbon.tool.tools.plugins'), icon: 'plugin', when: 'always', openWithAnchor: true, origin: 'builtin' },
      ],
    },
  ],
};

/** ribbon 求值上下文：只放渲染需要知道的宿主状态，不牵涉 store 本身。 */
export interface RibbonContext {
  activeView: string;
  mailSelected: boolean;
  selectedUnread: boolean;
  selectedStarred: boolean;
  hasAccounts: boolean;
  unified: boolean;
  listFilter: ListFilter;
  /** 当前是否停留在设置视图（供「设置」按钮高亮）。 */
  viewSettings: boolean;
  /** 阅读区当前是否显示（供「快速视图」按钮的标签切换与高亮）。 */
  readerShown: boolean;
  /** 列表/正文当前是否上下布局（供「布局」按钮的标签切换与高亮）。 */
  vertical: boolean;
}

function matchesWhen(when: RibbonWhen, ctx: RibbonContext): boolean {
  switch (when) {
    case 'always':
      return true;
    case 'mailSelected':
      return ctx.mailSelected;
    case 'selectedUnread':
      return ctx.selectedUnread;
    case 'selectedStarred':
      return ctx.selectedStarred;
    case 'hasAccounts':
      return ctx.hasAccounts;
    case 'unified':
      return ctx.unified;
    case 'listAll':
      return ctx.listFilter === 'all';
    case 'listUnread':
      return ctx.listFilter === 'unread';
    case 'listStarred':
      return ctx.listFilter === 'starred';
    case 'viewSettings':
      return ctx.viewSettings;
    case 'readerShown':
      return ctx.readerShown;
    case 'vertical':
      return ctx.vertical;
    default:
      return true;
  }
}

export interface RibbonToolView {
  id: string;
  commandId: string;
  label: string;
  icon: RibbonIconName;
  args?: Record<string, string>;
  disabled: boolean;
  active: boolean;
  danger: boolean;
  picker?: 'folder';
  openWithAnchor?: boolean;
}

export interface RibbonTabView {
  id: string;
  label: string;
  origin: 'builtin' | 'user' | 'plugin';
  tools: RibbonToolView[];
}

/**
 * 求值：when 不命中 → 按钮禁用（仍占位，避免布局跳动）；
 * altWhen 命中 → 换标签；activeWhen 命中 → 高亮。
 */
export function buildRibbonViewModel(config: RibbonConfig, ctx: RibbonContext): RibbonTabView[] {
  return config.tabs.map((tab) => ({
    id: tab.id,
    label: tab.label,
    origin: tab.origin,
    tools: tab.tools.map((tool) => ({
      id: tool.id,
      commandId: tool.commandId,
      label: tool.altWhen && matchesWhen(tool.altWhen, ctx) ? tool.labelAlt ?? tool.label : tool.label,
      icon: tool.icon,
      ...(tool.args ? { args: tool.args } : {}),
      disabled: !matchesWhen(tool.when, ctx),
      active: tool.activeWhen ? matchesWhen(tool.activeWhen, ctx) : false,
      danger: tool.danger === true,
      ...(tool.picker ? { picker: tool.picker } : {}),
      ...(tool.openWithAnchor ? { openWithAnchor: true } : {}),
    })),
  }));
}

function reorderTools(tools: RibbonTool[], order: string[] | undefined): RibbonTool[] {
  if (!order || order.length === 0) return tools;
  const byId = new Map(tools.map((tool) => [tool.id, tool]));
  const ordered: RibbonTool[] = [];
  for (const id of order) {
    const tool = byId.get(id);
    if (tool) {
      ordered.push(tool);
      byId.delete(id);
    }
  }
  // 顺序表里没提到的（升级新增的按钮）按原顺序追加在末尾
  return [...ordered, ...byId.values()];
}

/**
 * 内置默认 + 用户增量 → 生效配置。
 * 幂等：同样的入参永远得到同样的结果；未知 id 一律忽略而不是抛错。
 */
export function mergeRibbonConfig(
  defaults: RibbonConfig = DEFAULT_RIBBON_CONFIG,
  overrides: RibbonOverrides | null,
): RibbonConfig {
  if (!overrides) return cloneConfig(defaults);

  const hiddenTabs = new Set(overrides.hiddenTabs ?? []);
  const hiddenTools = new Set(overrides.hiddenTools ?? []);
  const tabLabels = overrides.tabLabels ?? {};
  const toolLabels = overrides.toolLabels ?? {};
  const toolOrder = overrides.toolOrder ?? {};
  const addedTools = overrides.addedTools ?? {};

  const merged: RibbonTab[] = [];
  for (const tab of defaults.tabs) {
    if (hiddenTabs.has(tab.id)) continue;
    const kept = tab.tools.filter((tool) => !hiddenTools.has(tool.id));
    // 先合并再排序：这样用户新增的工具也能和内置工具交错排列
    merged.push({
      id: tab.id,
      label: tabLabels[tab.id] ?? tab.label,
      origin: 'builtin',
      tools: applyToolLabels(
        reorderTools([...kept, ...(addedTools[tab.id] ?? [])], toolOrder[tab.id]),
        toolLabels,
      ),
    });
  }

  for (const custom of overrides.customTabs ?? []) {
    if (hiddenTabs.has(custom.id)) continue;
    merged.push({
      id: custom.id,
      label: tabLabels[custom.id] ?? custom.label,
      origin: 'user',
      tools: applyToolLabels(
        reorderTools([...custom.tools, ...(addedTools[custom.id] ?? [])], toolOrder[custom.id]),
        toolLabels,
      ),
    });
  }

  const tabs = reorderTabs(merged, overrides.tabOrder);
  // 兜底：配置损坏到「所有标签都被隐藏」时回落内置默认，别让整条工具栏消失
  if (tabs.length === 0) return cloneConfig(defaults);
  return { version: RIBBON_CONFIG_VERSION, tabs };
}

/**
 * 应用工具改名。用户显式改名后就不再跟随状态切换
 * （例如把「标为未读」改成「标记」，不该在选中未读时变成「标为已读」）。
 */
function applyToolLabels(tools: RibbonTool[], labels: Record<string, string>): RibbonTool[] {
  if (Object.keys(labels).length === 0) return tools;
  return tools.map((tool) => {
    const label = labels[tool.id];
    if (!label || label === tool.label) return tool;
    const next: RibbonTool = { ...tool, label };
    delete next.labelAlt;
    delete next.altWhen;
    return next;
  });
}

function reorderTabs(tabs: RibbonTab[], order: string[] | undefined): RibbonTab[] {
  if (!order || order.length === 0) return tabs;
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const ordered: RibbonTab[] = [];
  for (const id of order) {
    const tab = byId.get(id);
    if (tab) {
      ordered.push(tab);
      byId.delete(id);
    }
  }
  return [...ordered, ...byId.values()];
}

/**
 * 反函数：把「用户想要的目标配置」折算成最小增量覆盖。
 * 编辑器只操作完整配置（好懂、好拖拽），落库时用这个函数转成 overrides，
 * 从而保住「升级新增的内置项能自动流进用户布局」这条性质。
 *
 * 与 mergeRibbonConfig 互为逆运算（对 defaults 派生的 desired 而言）：
 *   mergeRibbonConfig(defaults, deriveRibbonOverrides(defaults, desired)) ≡ desired
 */
export function deriveRibbonOverrides(defaults: RibbonConfig, desired: RibbonConfig): RibbonOverrides {
  const defaultTabIds = new Set(defaults.tabs.map((tab) => tab.id));

  const hiddenTabs: string[] = [];
  const tabLabels: Record<string, string> = {};
  const toolLabels: Record<string, string> = {};
  const hiddenTools: string[] = [];
  const toolOrder: Record<string, string[]> = {};
  const addedTools: Record<string, RibbonTool[]> = {};
  const customTabs: RibbonTab[] = [];

  for (const def of defaults.tabs) {
    const want = desired.tabs.find((tab) => tab.id === def.id);
    if (!want) {
      hiddenTabs.push(def.id);
      continue;
    }
    if (want.label !== def.label) tabLabels[def.id] = want.label;

    // 插件贡献不属于用户配置，绝不能折算进 overrides（否则禁用插件后还留在工具栏上）
    const wantTools = want.tools.filter((tool) => tool.origin !== 'plugin');
    const wantIds = wantTools.map((tool) => tool.id);
    for (const defTool of def.tools) {
      if (!wantIds.includes(defTool.id)) hiddenTools.push(defTool.id);
      // 内置工具改名：只记差异，没改的不写进配置
      const wantTool = wantTools.find((tool) => tool.id === defTool.id);
      if (wantTool && wantTool.label !== defTool.label) toolLabels[defTool.id] = wantTool.label;
    }
    const defIds = def.tools.map((tool) => tool.id);
    if (wantIds.join('|') !== defIds.join('|')) toolOrder[def.id] = wantIds;

    const userTools = wantTools.filter((tool) => tool.origin === 'user');
    if (userTools.length > 0) addedTools[def.id] = userTools.map((tool) => ({ ...tool, origin: 'user' }));
  }

  for (const want of desired.tabs) {
    if (defaultTabIds.has(want.id)) continue;
    if (want.origin === 'plugin') continue;
    customTabs.push({
      id: want.id,
      label: want.label,
      origin: 'user',
      tools: want.tools
        .filter((tool) => tool.origin !== 'plugin')
        .map((tool) => ({ ...tool, origin: 'user' })),
    });
  }

  return {
    version: RIBBON_CONFIG_VERSION,
    tabOrder: desired.tabs.map((tab) => tab.id),
    ...(hiddenTabs.length > 0 ? { hiddenTabs } : {}),
    ...(Object.keys(tabLabels).length > 0 ? { tabLabels } : {}),
    ...(Object.keys(toolLabels).length > 0 ? { toolLabels } : {}),
    ...(Object.keys(toolOrder).length > 0 ? { toolOrder } : {}),
    ...(hiddenTools.length > 0 ? { hiddenTools } : {}),
    ...(Object.keys(addedTools).length > 0 ? { addedTools } : {}),
    ...(customTabs.length > 0 ? { customTabs } : {}),
  };
}

/** 单个标签页内联显示的工具上限；超出部分折进「更多」菜单。 */
export const RIBBON_OVERFLOW_AT = 12;

export interface RibbonToolSplit {
  visible: RibbonToolView[];
  overflow: RibbonToolView[];
}

/**
 * 把标签页的工具分成「内联显示」与「折进更多菜单」两组。
 *
 * 文件夹选择器永远留在内联区：它是下拉而不是一次性动作，
 * 塞进二级菜单会变成「菜单里再开菜单」，用起来更糟。
 * 顺序保持不变，只跳过计数，所以不会打乱用户排好的次序。
 */
export function splitRibbonTools(
  tools: RibbonToolView[],
  limit: number = RIBBON_OVERFLOW_AT,
): RibbonToolSplit {
  const visible: RibbonToolView[] = [];
  const overflow: RibbonToolView[] = [];
  let counted = 0;
  for (const tool of tools) {
    if (tool.picker) {
      visible.push(tool);
      continue;
    }
    if (counted < limit) {
      visible.push(tool);
      counted += 1;
    } else {
      overflow.push(tool);
    }
  }
  return { visible, overflow };
}

/**
 * 把插件贡献合并进已生效的配置（C 方案的「扩展层」）。
 *
 * 规则与用户自定义不同——插件只能追加：
 *  - 自建标签页追加到末尾（按 order / 声明顺序稳定排序）；
 *  - 工具挂到目标标签页（内置标签或本插件声明的标签）末尾；
 *  - 目标标签不存在（例如被用户隐藏了）就跳过，不偷偷挪到别处；
 *  - 图标/条件走白名单兜底，防止清单校验之外的脏值漏进来。
 *
 * 纯函数、不修改入参；同一入参永远得到同一结果（插件按 id 排序，保证稳定）。
 */
export function applyPluginRibbon(
  config: RibbonConfig,
  sources: PluginRibbonSource[],
  hiddenPlugins: readonly string[] = [],
): RibbonConfig {
  const hidden = new Set(hiddenPlugins);
  const active = sources.filter((source) => !hidden.has(source.pluginId));
  if (active.length === 0) return config;

  const tabs: RibbonTab[] = config.tabs.map((tab) => ({
    ...tab,
    tools: tab.tools.map((tool) => ({ ...tool })),
  }));
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const ordered = [...active].sort((a, b) => a.pluginId.localeCompare(b.pluginId));

  const ranked = <T extends { order?: number }>(items: T[]): T[] =>
    items
      .map((item, index) => ({ item, index }))
      .sort((a, b) => (a.item.order ?? 0) - (b.item.order ?? 0) || a.index - b.index)
      .map((entry) => entry.item);

  for (const source of ordered) {
    for (const tab of ranked(source.tabs)) {
      const id = `plugin:${source.pluginId}:${tab.id}`;
      if (byId.has(id)) continue;
      const created: RibbonTab = { id, label: tab.label, origin: 'plugin', tools: [] };
      tabs.push(created);
      byId.set(id, created);
    }
  }

  for (const source of ordered) {
    for (const tool of ranked(source.tools)) {
      const target = byId.get(resolvePluginTabId(source.pluginId, tool.tab));
      if (!target) continue;
      const id = `plugin:${source.pluginId}:${tool.id}`;
      if (target.tools.some((item) => item.id === id)) continue;
      target.tools.push({
        id,
        commandId: `plugin:${source.pluginId}:${tool.command}`,
        label: tool.label,
        icon: isRibbonIconName(tool.icon) ? tool.icon : 'plugin',
        when: isRibbonWhen(tool.when) ? tool.when : 'always',
        origin: 'plugin',
      });
    }
  }

  return { version: config.version, tabs };
}

function resolvePluginTabId(pluginId: string, tab: string): string {
  if ((RIBBON_BUILTIN_TAB_IDS as readonly string[]).includes(tab)) return tab;
  return `plugin:${pluginId}:${tab}`;
}

function isRibbonIconName(value: string | undefined): value is RibbonIconName {
  return typeof value === 'string' && (RIBBON_ICON_NAMES as readonly string[]).includes(value);
}

function isRibbonWhen(value: string | undefined): value is RibbonWhen {
  return typeof value === 'string' && (RIBBON_WHEN_NAMES as readonly string[]).includes(value);
}

function cloneConfig(config: RibbonConfig): RibbonConfig {
  return {
    version: config.version,
    tabs: config.tabs.map((tab) => ({
      id: tab.id,
      label: tab.label,
      origin: tab.origin,
      tools: tab.tools.map((tool) => ({ ...tool, ...(tool.args ? { args: { ...tool.args } } : {}) })),
    })),
  };
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function strArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  return items.length > 0 ? items : undefined;
}

function strMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const text = str(item);
    if (text) out[key] = text;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 从任意 JSON 里解析一枚工具；字段缺失就丢掉这枚工具，绝不让脏数据进配置。 */
function parseTool(raw: unknown): RibbonTool | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const id = str(obj.id);
  const commandId = str(obj.commandId);
  const label = str(obj.label);
  const icon = str(obj.icon) as RibbonIconName | undefined;
  if (!id || !commandId || !label || !icon) return null;
  const when = str(obj.when) as RibbonWhen | undefined;
  return {
    id,
    commandId,
    label,
    icon,
    when: when ?? 'always',
    ...(obj.args && typeof obj.args === 'object' && !Array.isArray(obj.args)
      ? { args: strMap(obj.args) ?? {} }
      : {}),
    ...(obj.danger === true ? { danger: true } : {}),
    ...(str(obj.activeWhen) ? { activeWhen: str(obj.activeWhen) as RibbonWhen } : {}),
    ...(str(obj.labelAlt) ? { labelAlt: str(obj.labelAlt) } : {}),
    ...(str(obj.altWhen) ? { altWhen: str(obj.altWhen) as RibbonWhen } : {}),
    ...(obj.picker === 'folder' ? { picker: 'folder' as const } : {}),
    ...(obj.openWithAnchor === true ? { openWithAnchor: true } : {}),
    origin: obj.origin === 'user' ? 'user' : 'builtin',
  };
}

function parseTab(raw: unknown): RibbonTab | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const id = str(obj.id);
  const label = str(obj.label);
  if (!id || !label) return null;
  const tools = Array.isArray(obj.tools)
    ? obj.tools.map(parseTool).filter((tool): tool is RibbonTool => tool !== null)
    : [];
  return { id, label, tools, origin: obj.origin === 'user' ? 'user' : 'builtin' };
}

/** 解析一份完整配置（导入用）：字段不全的标签/工具被丢弃，解析不出来回 null。 */
export function parseRibbonConfig(raw: string | null): RibbonConfig | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.tabs)) return null;
  const tabs = obj.tabs.map(parseTab).filter((tab): tab is RibbonTab => tab !== null);
  if (tabs.length === 0) return null;
  return { version: RIBBON_CONFIG_VERSION, tabs };
}

/** 容忍脏数据：解析失败回退「无覆盖」，绝不抛异常（与 parseNotificationSettings 同风格）。 */
export function parseRibbonOverrides(raw: string | null): RibbonOverrides | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;

  const addedToolsRaw =
    obj.addedTools && typeof obj.addedTools === 'object' && !Array.isArray(obj.addedTools)
      ? (obj.addedTools as Record<string, unknown>)
      : undefined;
  const addedTools: Record<string, RibbonTool[]> = {};
  for (const [tabId, list] of Object.entries(addedToolsRaw ?? {})) {
    if (!Array.isArray(list)) continue;
    const tools = list.map(parseTool).filter((tool): tool is RibbonTool => tool !== null);
    if (tools.length > 0) addedTools[tabId] = tools;
  }

  const customTabs = Array.isArray(obj.customTabs)
    ? obj.customTabs.map(parseTab).filter((tab): tab is RibbonTab => tab !== null)
    : [];

  const tabOrder = strArray(obj.tabOrder);
  const toolOrderRaw =
    obj.toolOrder && typeof obj.toolOrder === 'object' && !Array.isArray(obj.toolOrder)
      ? (obj.toolOrder as Record<string, unknown>)
      : undefined;
  const toolOrder: Record<string, string[]> = {};
  for (const [tabId, list] of Object.entries(toolOrderRaw ?? {})) {
    const ids = strArray(list);
    if (ids) toolOrder[tabId] = ids;
  }

  return {
    version: RIBBON_CONFIG_VERSION,
    ...(tabOrder ? { tabOrder } : {}),
    ...(strArray(obj.hiddenTabs) ? { hiddenTabs: strArray(obj.hiddenTabs) } : {}),
    ...(strMap(obj.tabLabels) ? { tabLabels: strMap(obj.tabLabels) } : {}),
    ...(strMap(obj.toolLabels) ? { toolLabels: strMap(obj.toolLabels) } : {}),
    ...(Object.keys(toolOrder).length > 0 ? { toolOrder } : {}),
    ...(strArray(obj.hiddenTools) ? { hiddenTools: strArray(obj.hiddenTools) } : {}),
    ...(strArray(obj.hiddenPlugins) ? { hiddenPlugins: strArray(obj.hiddenPlugins) } : {}),
    ...(Object.keys(addedTools).length > 0 ? { addedTools } : {}),
    ...(customTabs.length > 0 ? { customTabs } : {}),
  };
}

/** 用户自建条目 id：统一前缀，便于和内置 id 区分、避免撞号。 */
export function newCustomId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `custom:${prefix}-${random}`;
}
