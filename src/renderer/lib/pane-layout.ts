/**
 * 三栏布局（侧栏 | 列表 | 阅读区）的宽度约束与折叠/隐藏状态。
 *
 * 默认 220 / 380 / 1fr；两条分割线可拖动：
 *  - 左侧分割线拖到最左 → 侧栏收成「图标模式」（`sidebarCollapsed`）；
 *  - 右侧分割线拖到最右 → 阅读区彻底隐藏（`readerHidden`，对应「快速视图」）；
 *  - 「布局」按钮可把列表/正文从左右改为上下（`vertical`）。
 * 这些布尔状态与连续宽度解耦：收起/隐藏时宽度不再参与正文保护约束。
 * 普通拖动允许正文一直缩到 `READER_HIDE_BELOW`(约 50px) 才隐藏，不再硬性保住大宽度。
 * 纯函数放这里，方便用单测锁死这些约束。
 */

export type PaneEdge = 'sidebar' | 'list';

export interface PaneWidths {
  sidebar: number;
  list: number;
}

/** 完整布局：连续宽度 + 三个布尔状态（收起/隐藏/上下布局，持久化单位）。 */
export interface PaneLayout {
  sidebar: number;
  list: number;
  sidebarCollapsed: boolean;
  readerHidden: boolean;
  /** 列表/正文是否上下排布（false=左右，true=上下）。 */
  vertical: boolean;
}

export const DEFAULT_SIDEBAR_WIDTH = 220;
export const DEFAULT_LIST_WIDTH = 380;
export const MIN_SIDEBAR_WIDTH = 168;
export const MAX_SIDEBAR_WIDTH = 360;
export const MIN_LIST_WIDTH = 280;
export const MAX_LIST_WIDTH = 760;
/** 阅读区最小宽度：只在「普通拖动且未达隐藏阈值」时作软下限参考。 */
export const MIN_READER_WIDTH = 360;
export const PANE_KEYBOARD_STEP = 16;

/** 侧栏收起（图标模式）时的固定宽度。 */
export const ICON_ONLY_SIDEBAR_WIDTH = 56;
/** 侧栏拖到比这更窄就收成图标模式（必须 < MIN_SIDEBAR_WIDTH，留出拖拽余量）。 */
export const SIDEBAR_COLLAPSE_BELOW = 100;
/** 收起后只有拖到比这更宽才展开，避免边界抖动（迟滞）。 */
export const SIDEBAR_EXPAND_ABOVE = 140;
/** 阅读区被拖到「只剩约这么多像素」才彻底隐藏（左右、上下都按这个值）。 */
export const READER_HIDE_BELOW = 50;
/** 隐藏后只有阅读区被拖宽到超过这值才重新显示（迟滞，略大于隐藏阈值）。 */
export const READER_SHOW_ABOVE = 80;
/** 上下布局时列表（上方）的尺寸范围与默认高度。 */
export const DEFAULT_LIST_HEIGHT = 320;
export const MIN_LIST_HEIGHT = 140;
export const MAX_LIST_HEIGHT = 720;

export const DEFAULT_PANE_WIDTHS: PaneWidths = {
  sidebar: DEFAULT_SIDEBAR_WIDTH,
  list: DEFAULT_LIST_WIDTH,
};

export const DEFAULT_PANE_LAYOUT: PaneLayout = {
  sidebar: DEFAULT_SIDEBAR_WIDTH,
  list: DEFAULT_LIST_WIDTH,
  sidebarCollapsed: false,
  readerHidden: false,
  vertical: false,
};

/** 持久化用的设置键（app_settings 键值表）。 */
export const PANE_LAYOUT_KEY = 'layout.panes';

function limits(edge: PaneEdge): { min: number; max: number } {
  return edge === 'sidebar'
    ? { min: MIN_SIDEBAR_WIDTH, max: MAX_SIDEBAR_WIDTH }
    : { min: MIN_LIST_WIDTH, max: MAX_LIST_WIDTH };
}

/**
 * 把期望宽度夹到合法区间。
 * @param other 另一栏当前宽度（拖动侧栏时是列表宽；拖动列表时是侧栏宽）
 * @param available 整个工作区的可用宽度
 */
export function clampPaneWidth(
  edge: PaneEdge,
  desired: number,
  other: number,
  available: number,
): number {
  const { min, max: hardMax } = limits(edge);
  const total = Number.isFinite(available) && available > 0 ? available : 1920;
  // 留给「另一栏 + 阅读区」的空间，就是这一栏的实际上限
  const room = total - other - MIN_READER_WIDTH;
  const max = Math.max(min, Math.min(hardMax, room));
  const value = Number.isFinite(desired) ? desired : min;
  return Math.round(Math.min(max, Math.max(min, value)));
}

/**
 * 解析持久化的宽度。任何脏数据都回落默认值，绝不把界面撑坏。
 */
export function parsePaneWidths(raw: string | null | undefined): PaneWidths {
  if (!raw) return DEFAULT_PANE_WIDTHS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_PANE_WIDTHS;
  }
  if (!parsed || typeof parsed !== 'object') return DEFAULT_PANE_WIDTHS;

  const record = parsed as { sidebar?: unknown; list?: unknown };
  return {
    sidebar: normalizeWidth(
      record.sidebar,
      MIN_SIDEBAR_WIDTH,
      MAX_SIDEBAR_WIDTH,
      DEFAULT_SIDEBAR_WIDTH,
    ),
    list: normalizeWidth(record.list, MIN_LIST_WIDTH, MAX_LIST_WIDTH, DEFAULT_LIST_WIDTH),
  };
}

/**
 * 解析完整布局（宽度 + 折叠/隐藏布尔）。
 * 老数据只有宽度时，布尔回落默认（false，即展开且显示正文）。
 */
export function parsePaneLayout(raw: string | null | undefined): PaneLayout {
  const widths = parsePaneWidths(raw);
  if (!raw) return { ...widths, sidebarCollapsed: false, readerHidden: false, vertical: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...widths, sidebarCollapsed: false, readerHidden: false, vertical: false };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ...widths, sidebarCollapsed: false, readerHidden: false, vertical: false };
  }
  const record = parsed as {
    sidebarCollapsed?: unknown;
    readerHidden?: unknown;
    vertical?: unknown;
  };
  return {
    ...widths,
    sidebarCollapsed: record.sidebarCollapsed === true,
    readerHidden: record.readerHidden === true,
    vertical: record.vertical === true,
  };
}

function normalizeWidth(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.round(Math.min(max, Math.max(min, value)));
}

/**
 * 侧栏分割线拖拽结果：在「收起阈值」内切换图标模式，否则正常夹宽。
 * @param collapsed 进入本次拖拽前是否已经收起
 */
export function resolveSidebarDrag(
  rawDesired: number,
  other: number,
  available: number,
  collapsed: boolean,
): { collapsed: boolean; width: number } {
  if (collapsed) {
    if (rawDesired >= SIDEBAR_EXPAND_ABOVE) {
      return { collapsed: false, width: clampPaneWidth('sidebar', rawDesired, other, available) };
    }
    return { collapsed: true, width: ICON_ONLY_SIDEBAR_WIDTH };
  }
  if (rawDesired <= SIDEBAR_COLLAPSE_BELOW) {
    return { collapsed: true, width: ICON_ONLY_SIDEBAR_WIDTH };
  }
  return { collapsed: false, width: clampPaneWidth('sidebar', rawDesired, other, available) };
}

/**
 * 把列表宽度夹到合法区间，并保住「阅读区至少 `floor` 像素」这才隐藏。
 * 普通拖动时阅读区可一路缩到 `floor`，不再硬性停在 360。
 */
function clampListWidth(rawDesired: number, sidebarWidth: number, total: number, floor: number): number {
  const { min: listMin, max: listMax } = limits('list');
  const maxByReader = total - sidebarWidth - floor;
  const max = Math.max(listMin, Math.min(listMax, maxByReader));
  const value = Number.isFinite(rawDesired) ? rawDesired : listMin;
  return Math.round(Math.min(max, Math.max(listMin, value)));
}

/**
 * 列表分割线拖拽结果（左右布局）：阅读区被拖到只剩 `READER_HIDE_BELOW` 就隐藏，
 * 否则把列表宽度夹到「阅读区至少 `READER_HIDE_BELOW`」——这样正文能一直缩到很窄才消失。
 * @param readerHidden 进入本次拖拽前阅读区是否已经隐藏
 */
export function resolveListDrag(
  rawDesired: number,
  sidebarWidth: number,
  available: number,
  readerHidden: boolean,
): { readerHidden: boolean; width: number } {
  const total = Number.isFinite(available) && available > 0 ? available : 1920;
  const floor = READER_HIDE_BELOW;
  const wideList = total - sidebarWidth - floor;

  if (readerHidden) {
    const reader = total - sidebarWidth - rawDesired;
    if (reader >= READER_SHOW_ABOVE) {
      return { readerHidden: false, width: clampListWidth(rawDesired, sidebarWidth, total, floor) };
    }
    return { readerHidden: true, width: wideList };
  }
  if (total - sidebarWidth - rawDesired <= floor) {
    return { readerHidden: true, width: wideList };
  }
  return { readerHidden: false, width: clampListWidth(rawDesired, sidebarWidth, total, floor) };
}

/** 把列表高度夹到合法区间，并保住「阅读区至少 `floor` 像素」这才隐藏。 */
function clampListHeight(rawDesired: number, total: number, floor: number): number {
  const maxByReader = total - floor;
  const max = Math.max(MIN_LIST_HEIGHT, Math.min(MAX_LIST_HEIGHT, maxByReader));
  const value = Number.isFinite(rawDesired) ? rawDesired : MIN_LIST_HEIGHT;
  return Math.round(Math.min(max, Math.max(MIN_LIST_HEIGHT, value)));
}

/**
 * 列表分割线拖拽结果（上下布局）：此时「列表」是上方那块，尺寸是高度。
 * 阅读区（下方）被拖到只剩 `READER_HIDE_BELOW` 才隐藏，否则夹到「阅读区至少 `floor`」。
 * 上下布局里没有侧栏偏移，阅读区高度 = 总高 - 列表高度。
 * @param readerHidden 进入本次拖拽前阅读区是否已经隐藏
 */
export function resolveListDragVertical(
  rawDesired: number,
  availableHeight: number,
  readerHidden: boolean,
): { readerHidden: boolean; height: number } {
  const total = Number.isFinite(availableHeight) && availableHeight > 0 ? availableHeight : 1080;
  const floor = READER_HIDE_BELOW;
  const tallList = total - floor;

  if (readerHidden) {
    const reader = total - rawDesired;
    if (reader >= READER_SHOW_ABOVE) {
      return { readerHidden: false, height: clampListHeight(rawDesired, total, floor) };
    }
    return { readerHidden: true, height: tallList };
  }
  if (total - rawDesired <= floor) {
    return { readerHidden: true, height: tallList };
  }
  return { readerHidden: false, height: clampListHeight(rawDesired, total, floor) };
}

/** 分割线获得焦点时的键盘操作：左右微调，Home 恢复默认；其余键返回 null。 */
export function paneWidthForKeyboard(
  edge: PaneEdge,
  widths: PaneWidths,
  key: string,
  available: number,
): number | null {
  const current = edge === 'sidebar' ? widths.sidebar : widths.list;
  const other = edge === 'sidebar' ? widths.list : widths.sidebar;

  if (key === 'ArrowLeft') {
    return clampPaneWidth(edge, current - PANE_KEYBOARD_STEP, other, available);
  }
  if (key === 'ArrowRight') {
    return clampPaneWidth(edge, current + PANE_KEYBOARD_STEP, other, available);
  }
  if (key === 'Home') {
    const fallback = edge === 'sidebar' ? DEFAULT_SIDEBAR_WIDTH : DEFAULT_LIST_WIDTH;
    return clampPaneWidth(edge, fallback, other, available);
  }
  return null;
}
