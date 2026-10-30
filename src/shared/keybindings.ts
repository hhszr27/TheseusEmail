/**
 * 集中快捷键注册表与冲突检测（§21.1）。
 * 宿主与插件都通过同一套 signature 规则比较，避免修饰键顺序导致漏检。
 */

export type Modifier = 'ctrl' | 'meta' | 'alt' | 'shift';

/** 与具体命令解耦的组合键描述；command 由注册表另行给出。 */
export interface BindingSpec {
  key: string;
  modifiers?: string[];
  when?: string;
}

export interface HostCommand {
  id: string;
  label: string;
  description?: string;
  defaultKeybinding?: BindingSpec;
  /** 该命令接受的参数名（ribbon 工具可用 args 预填，如移动到哪个文件夹）。 */
  params?: string[];
}

export const HOST_COMMANDS: HostCommand[] = [
  {
    id: 'palette.open',
    label: '打开命令面板',
    defaultKeybinding: { key: 'k', modifiers: ['ctrl'] },
  },
  {
    id: 'mail.compose',
    label: '撰写邮件',
    defaultKeybinding: { key: 'c' },
  },
  {
    id: 'mail.refresh',
    label: '刷新邮件',
    defaultKeybinding: { key: 'r', modifiers: ['ctrl'] },
  },
  {
    id: 'search.focus',
    label: '聚焦搜索框',
    defaultKeybinding: { key: 'f', modifiers: ['ctrl'] },
  },
  {
    id: 'settings.open',
    label: '打开设置',
    defaultKeybinding: { key: ',', modifiers: ['ctrl'] },
  },
  {
    id: 'mail.pin',
    label: '置顶 / 取消置顶当前邮件',
    defaultKeybinding: { key: 'p' },
  },
  {
    id: 'mail.reply',
    label: '回复当前邮件',
    defaultKeybinding: { key: 'r' },
  },
  {
    id: 'mail.star',
    label: '星标 / 取消星标当前邮件',
    defaultKeybinding: { key: 's' },
  },
  {
    id: 'mail.toggleRead',
    label: '标记已读 / 未读',
    defaultKeybinding: { key: 'u' },
  },
  {
    id: 'mail.archive',
    label: '归档当前邮件',
    defaultKeybinding: { key: 'e' },
  },
  {
    id: 'mail.delete',
    label: '删除当前邮件',
    defaultKeybinding: { key: 'delete' },
  },
  {
    id: 'mail.replyAll',
    label: '全部回复当前邮件',
  },
  {
    id: 'mail.forward',
    label: '转发当前邮件',
  },
  {
    id: 'mail.moveTo',
    label: '移动到文件夹',
    params: ['folderPath'],
  },
  {
    id: 'view.unified',
    label: '打开统一收件箱',
  },
  {
    id: 'view.inbox',
    label: '打开收件箱',
  },
  {
    id: 'view.sent',
    label: '打开已发送',
  },
  {
    id: 'view.drafts',
    label: '打开草稿箱',
  },
  {
    id: 'view.outbox',
    label: '打开发件箱',
  },
  {
    id: 'view.folder',
    label: '跳转到指定文件夹',
    params: ['accountId', 'folderPath'],
  },
  {
    id: 'view.settings',
    label: '打开设置',
  },
  {
    id: 'view.theme',
    label: '切换主题',
  },
  {
    id: 'view.plugins',
    label: '管理插件',
  },
  {
    id: 'list.filter',
    label: '筛选邮件列表',
    params: ['filter'],
  },
  {
    id: 'calendar.open',
    label: '打开日历',
  },
  {
    id: 'ai.open',
    label: '打开 AI 指令',
  },
  {
    id: 'plugins.menu',
    label: '打开插件命令菜单',
  },
  {
    id: 'ribbon.customize',
    label: '自定义功能区',
  },
  {
    id: 'app.quit',
    label: '退出应用',
  },
];

const MODIFIER_ORDER: Modifier[] = ['ctrl', 'meta', 'alt', 'shift'];

export function normalizeKey(key: string): string {
  const lower = key.toLowerCase();
  switch (lower) {
    case ' ':
    case 'spacebar':
      return 'space';
    case 'esc':
      return 'escape';
    default:
      return lower;
  }
}

export function bindingSignature(binding: BindingSpec): string {
  const modifiers = [...new Set(binding.modifiers ?? [])]
    .sort((a, b) => MODIFIER_ORDER.indexOf(a as Modifier) - MODIFIER_ORDER.indexOf(b as Modifier))
    .join('+');
  const key = normalizeKey(binding.key);
  return modifiers ? `${modifiers}+${key}` : key;
}

export interface BindingConflict {
  signature: string;
  commands: string[];
}

/** 返回同一组合键被多个命令占用的情况。 */
export function detectConflicts(
  bindings: Array<{ command: string; binding: BindingSpec }>,
): BindingConflict[] {
  const bySignature = new Map<string, string[]>();
  for (const entry of bindings) {
    const signature = bindingSignature(entry.binding);
    const commands = bySignature.get(signature) ?? [];
    if (!commands.includes(entry.command)) commands.push(entry.command);
    bySignature.set(signature, commands);
  }
  return [...bySignature.entries()]
    .filter(([, commands]) => commands.length > 1)
    .map(([signature, commands]) => ({ signature, commands }));
}

export function mergeBindings(
  defaults: Array<{ command: string; binding: BindingSpec }>,
  overrides: Record<string, BindingSpec | null>,
): Array<{ command: string; binding: BindingSpec | null }> {
  const result = defaults.map((entry) => ({
    command: entry.command,
    binding: overrides[entry.command] === null ? null : overrides[entry.command] ?? entry.binding,
  }));
  for (const [command, binding] of Object.entries(overrides)) {
    if (!result.some((entry) => entry.command === command)) {
      result.push({ command, binding });
    }
  }
  return result;
}

export interface KeyboardEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export function matchesKeyboardEvent(binding: BindingSpec, event: KeyboardEventLike): boolean {
  const modifiers = new Set(binding.modifiers ?? []);
  if (modifiers.has('ctrl') !== event.ctrlKey) return false;
  if (modifiers.has('meta') !== event.metaKey) return false;
  if (modifiers.has('alt') !== event.altKey) return false;
  if (modifiers.has('shift') !== event.shiftKey) return false;
  return normalizeKey(binding.key) === normalizeKey(event.key);
}

export function bindingFromEvent(event: KeyboardEventLike): BindingSpec | null {
  const key = normalizeKey(event.key);
  if (['control', 'meta', 'alt', 'shift'].includes(key)) return null;

  const modifiers: Modifier[] = [];
  if (event.ctrlKey) modifiers.push('ctrl');
  if (event.metaKey) modifiers.push('meta');
  if (event.altKey) modifiers.push('alt');
  if (event.shiftKey) modifiers.push('shift');

  return { key, ...(modifiers.length ? { modifiers } : {}) };
}

export function formatBinding(binding: BindingSpec | null): string {
  if (!binding) return '未设置';
  const labels: Record<Modifier, string> = {
    ctrl: 'Ctrl',
    meta: 'Meta',
    alt: 'Alt',
    shift: 'Shift',
  };
  const modifiers = (binding.modifiers ?? []).map(
    (modifier) => labels[modifier as Modifier] ?? modifier,
  );
  const key =
    binding.key === ' ' ? 'Space' : binding.key.length === 1 ? binding.key.toUpperCase() : binding.key;
  return [...modifiers, key].join(' + ');
}
