import type { CommandDefinition, MenuRegion, PluginPermission } from '../../shared/types';
import { isPluginEnabledForAccount, type AccountOverrides } from './access';

/**
 * 菜单扩展模型（§13.3.1）。
 *
 * 上下文条件 `when` 只支持预定义布尔变量与 `!`/`&&`/`||`/括号，
 * 不求值任意表达式、不调用 eval；未知变量与语法错误一律判定为 false（失败关闭）。
 */

export type MenuContextKey =
  | 'readerView'
  | 'hasSelection'
  | 'hasActiveEmail'
  | 'mailListFocused'
  | 'composeOpen'
  | 'accountEnabled'
  | 'accountDisabled';

export type MenuContext = Partial<Record<MenuContextKey, boolean>>;

type Token =
  | { type: 'ident'; value: string }
  | { type: 'op'; value: '!' | '&&' | '||' | '(' | ')' };

function tokenize(input: string): Token[] | null {
  const tokens: Token[] = [];
  let index = 0;
  while (index < input.length) {
    const char = input[index] as string;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === '&') {
      if (input[index + 1] !== '&') return null;
      tokens.push({ type: 'op', value: '&&' });
      index += 2;
      continue;
    }
    if (char === '|') {
      if (input[index + 1] !== '|') return null;
      tokens.push({ type: 'op', value: '||' });
      index += 2;
      continue;
    }
    if (char === '!' || char === '(' || char === ')') {
      tokens.push({ type: 'op', value: char });
      index += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let end = index + 1;
      while (end < input.length && /[A-Za-z0-9_]/.test(input[end] as string)) end += 1;
      tokens.push({ type: 'ident', value: input.slice(index, end) });
      index = end;
      continue;
    }
    // 其余字符（数字、引号、点号等）一律视为非法
    return null;
  }
  return tokens;
}

interface ParseState {
  tokens: Token[];
  index: number;
}

function peek(state: ParseState): Token | undefined {
  return state.tokens[state.index];
}

function parsePrimary(state: ParseState, context: MenuContext): boolean | null {
  const token = peek(state);
  if (!token) return null;

  if (token.type === 'op' && token.value === '!') {
    state.index += 1;
    const value = parsePrimary(state, context);
    return value === null ? null : !value;
  }

  if (token.type === 'op' && token.value === '(') {
    state.index += 1;
    const value = parseOr(state, context);
    const closing = peek(state);
    if (!closing || closing.type !== 'op' || closing.value !== ')') return null;
    state.index += 1;
    return value;
  }

  if (token.type === 'ident') {
    state.index += 1;
    if (token.value === 'true') return true;
    if (token.value === 'false') return false;
    return context[token.value as MenuContextKey] === true;
  }

  return null;
}

function parseAnd(state: ParseState, context: MenuContext): boolean | null {
  let value = parsePrimary(state, context);
  if (value === null) return null;
  for (;;) {
    const token = peek(state);
    if (!token || token.type !== 'op' || token.value !== '&&') return value;
    state.index += 1;
    const right = parsePrimary(state, context);
    if (right === null) return null;
    value = value && right;
  }
}

function parseOr(state: ParseState, context: MenuContext): boolean | null {
  let value = parseAnd(state, context);
  if (value === null) return null;
  for (;;) {
    const token = peek(state);
    if (!token || token.type !== 'op' || token.value !== '||') return value;
    state.index += 1;
    const right = parseAnd(state, context);
    if (right === null) return null;
    value = value || right;
  }
}

/** 求值 `when` 表达式；缺省视为满足，语法错误/未知变量视为不满足。 */
export function evaluateWhen(expression: string | undefined, context: MenuContext): boolean {
  if (expression === undefined) return true;
  const trimmed = expression.trim();
  if (!trimmed) return false;

  const tokens = tokenize(trimmed);
  if (!tokens || tokens.length === 0) return false;

  const state: ParseState = { tokens, index: 0 };
  const value = parseOr(state, context);
  if (value === null) return false;
  // 必须完整消费，否则视为语法错误
  if (state.index !== tokens.length) return false;
  return value;
}

export interface MenuSourcePlugin {
  id: string;
  name: string;
  enabled: boolean;
  permissions: PluginPermission[];
  commands: CommandDefinition[];
}

export interface MenuItemDescriptor {
  pluginId: string;
  pluginName: string;
  commandId: string;
  label: string;
  description?: string;
  /** 非空表示缺少执行该命令所需能力：菜单项仍显示，点击给出提示。 */
  missingPermission?: PluginPermission;
}

export interface CollectMenuOptions {
  accountId?: string | null;
  overrides?: Map<string, AccountOverrides>;
  revoked?: Map<string, Set<PluginPermission>>;
  context?: MenuContext;
}

/** 命令执行所需能力是否缺失。 */
export function missingPermissionFor(
  command: CommandDefinition,
  permissions: PluginPermission[],
  revoked: Set<PluginPermission> | undefined,
): PluginPermission | undefined {
  if (!command.requires) return undefined;
  if (!permissions.includes(command.requires)) return command.requires;
  if (revoked?.has(command.requires)) return command.requires;
  return undefined;
}

/**
 * 收集某个菜单区域应显示的插件项。
 * - 全局禁用 / 非 ready 的插件由调用方过滤
 * - 除 `main` 外，账户级禁用会隐藏该区域内的菜单项；`main` 不受账户影响
 */
export function collectMenuItems(
  plugins: MenuSourcePlugin[],
  region: MenuRegion,
  options: CollectMenuOptions = {},
): MenuItemDescriptor[] {
  const context = options.context ?? {};
  const accountId = options.accountId ?? null;
  const items: MenuItemDescriptor[] = [];

  for (const plugin of plugins) {
    if (!plugin.enabled) continue;
    const regionAllowsAccount = region !== 'main';
    if (regionAllowsAccount && accountId) {
      const enabledForAccount = isPluginEnabledForAccount(
        true,
        options.overrides?.get(plugin.id),
        accountId,
      );
      if (!enabledForAccount) continue;
    }

    for (const command of plugin.commands) {
      if (command.menu !== region) continue;
      if (!evaluateWhen(command.when, context)) continue;

      const missing = missingPermissionFor(
        command,
        plugin.permissions,
        options.revoked?.get(plugin.id),
      );
      items.push({
        pluginId: plugin.id,
        pluginName: plugin.name,
        commandId: command.id,
        label: command.label,
        ...(command.description ? { description: command.description } : {}),
        ...(missing ? { missingPermission: missing } : {}),
      });
    }
  }

  return items;
}
