import type { MenuRegion } from '../../shared/types';

/**
 * 插件菜单的统一入口（§13.3.1）。
 *
 * 组件不必各自维护菜单状态：任意位置调用 openPluginMenu 后，
 * 宿主在光标处渲染对应区域（main / context:*）的插件项。
 */

export interface PluginMenuRequestDetail {
  region: MenuRegion;
  x: number;
  y: number;
  accountId: string | null;
  context: Record<string, boolean>;
}

export const PLUGIN_MENU_EVENT = 'mf:plugin-menu';

export function openPluginMenu(
  region: MenuRegion,
  options: {
    x: number;
    y: number;
    accountId?: string | null;
    context?: Record<string, boolean>;
  },
): void {
  const detail: PluginMenuRequestDetail = {
    region,
    x: options.x,
    y: options.y,
    accountId: options.accountId ?? null,
    context: options.context ?? {},
  };
  window.dispatchEvent(new CustomEvent<PluginMenuRequestDetail>(PLUGIN_MENU_EVENT, { detail }));
}
