import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIST_HEIGHT,
  DEFAULT_PANE_WIDTHS,
  ICON_ONLY_SIDEBAR_WIDTH,
  MAX_LIST_HEIGHT,
  MAX_LIST_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_LIST_HEIGHT,
  MIN_LIST_WIDTH,
  MIN_READER_WIDTH,
  MIN_SIDEBAR_WIDTH,
  PANE_KEYBOARD_STEP,
  READER_HIDE_BELOW,
  READER_SHOW_ABOVE,
  SIDEBAR_COLLAPSE_BELOW,
  SIDEBAR_EXPAND_ABOVE,
  clampPaneWidth,
  paneWidthForKeyboard,
  parsePaneLayout,
  parsePaneWidths,
  resolveListDrag,
  resolveListDragVertical,
  resolveSidebarDrag,
} from '../src/renderer/lib/pane-layout';

/**
 * 两条分割线的宽度约束：拖得动，正文能一直缩到隐藏阈值（约 50px）才彻底隐藏。
 * 这些数字是界面的硬约束，改之前先看相关常量。
 */
describe('三栏宽度夹取（pane-layout.ts）', () => {
  it('侧栏：默认区间内原样保留', () => {
    expect(clampPaneWidth('sidebar', 300, 380, 1344)).toBe(300);
  });

  it('侧栏：超过上限被夹到 360', () => {
    expect(clampPaneWidth('sidebar', 500, 380, 1344)).toBe(MAX_SIDEBAR_WIDTH);
  });

  it('侧栏：低于下限被夹到 168', () => {
    expect(clampPaneWidth('sidebar', 100, 380, 1344)).toBe(MIN_SIDEBAR_WIDTH);
  });

  it('阅读区优先：窗口不够宽时，侧栏让位而不是把正文挤没', () => {
    // 1000 - 380(列表) - 360(正文) = 260，小于 360 的硬上限
    expect(clampPaneWidth('sidebar', 500, 380, 1000)).toBe(260);
  });

  it('列表：区间内保留、超上限夹到 760、低于下限夹到 280', () => {
    expect(clampPaneWidth('list', 700, 220, 1344)).toBe(700);
    expect(clampPaneWidth('list', 900, 220, 1344)).toBe(MAX_LIST_WIDTH);
    expect(clampPaneWidth('list', 100, 220, 1344)).toBe(MIN_LIST_WIDTH);
  });

  it('列表：窗口刚好装得下时按剩余空间封顶', () => {
    // 900 - 220(侧栏) - 360(正文) = 320
    expect(clampPaneWidth('list', 900, 220, 900)).toBe(320);
  });

  it('脏数据不把界面撑坏：NaN 回落下限，available 为 0 按 1920 估算', () => {
    expect(clampPaneWidth('list', Number.NaN, 220, 1344)).toBe(MIN_LIST_WIDTH);
    expect(clampPaneWidth('sidebar', 500, 380, 0)).toBe(MAX_SIDEBAR_WIDTH);
  });

  it('任何情况下都给阅读区留够 MIN_READER_WIDTH', () => {
    const available = 1100;
    const sidebar = clampPaneWidth('sidebar', 999, 380, available);
    const list = clampPaneWidth('list', 999, sidebar, available);
    expect(available - sidebar - list).toBeGreaterThanOrEqual(MIN_READER_WIDTH);
  });
});

describe('宽度持久化解析（parsePaneWidths）', () => {
  it('没有存过 / 坏 JSON 一律回落默认', () => {
    expect(parsePaneWidths(null)).toEqual(DEFAULT_PANE_WIDTHS);
    expect(parsePaneWidths(undefined)).toEqual(DEFAULT_PANE_WIDTHS);
    expect(parsePaneWidths('not-json')).toEqual(DEFAULT_PANE_WIDTHS);
    expect(parsePaneWidths('123')).toEqual(DEFAULT_PANE_WIDTHS);
  });

  it('正常读取', () => {
    expect(parsePaneWidths('{"sidebar":300,"list":520}')).toEqual({ sidebar: 300, list: 520 });
  });

  it('越界值被夹回区间，非数字回落各自的默认', () => {
    expect(parsePaneWidths('{"sidebar":10,"list":9999}')).toEqual({
      sidebar: MIN_SIDEBAR_WIDTH,
      list: MAX_LIST_WIDTH,
    });
    expect(parsePaneWidths('{"sidebar":"300","list":null}')).toEqual(DEFAULT_PANE_WIDTHS);
  });

  it('只有一半字段时另一半用默认', () => {
    expect(parsePaneWidths('{"list":500}')).toEqual({ sidebar: 220, list: 500 });
  });
});

describe('键盘微调（paneWidthForKeyboard）', () => {
  const widths = { sidebar: 300, list: 380 };

  it('左右方向键各走一步', () => {
    expect(paneWidthForKeyboard('sidebar', widths, 'ArrowLeft', 1344)).toBe(
      300 - PANE_KEYBOARD_STEP,
    );
    expect(paneWidthForKeyboard('list', widths, 'ArrowRight', 1344)).toBe(
      380 + PANE_KEYBOARD_STEP,
    );
  });

  it('到边界后停住，不会越界', () => {
    expect(paneWidthForKeyboard('sidebar', { ...widths, sidebar: MAX_SIDEBAR_WIDTH }, 'ArrowRight', 1344)).toBe(
      MAX_SIDEBAR_WIDTH,
    );
    expect(paneWidthForKeyboard('list', { ...widths, list: MIN_LIST_WIDTH }, 'ArrowLeft', 1344)).toBe(
      MIN_LIST_WIDTH,
    );
  });

  it('Home 恢复默认', () => {
    expect(paneWidthForKeyboard('sidebar', widths, 'Home', 1344)).toBe(220);
    expect(paneWidthForKeyboard('list', widths, 'Home', 1344)).toBe(380);
  });

  it('其他键不处理', () => {
    expect(paneWidthForKeyboard('sidebar', widths, 'ArrowUp', 1344)).toBeNull();
    expect(paneWidthForKeyboard('list', widths, 'a', 1344)).toBeNull();
  });
});

describe('侧栏拖拽收起（resolveSidebarDrag）', () => {
  const available = 1344;

  it('拖到比收起阈值更窄 → 收成图标模式，宽度固定为图标宽', () => {
    const res = resolveSidebarDrag(SIDEBAR_COLLAPSE_BELOW - 1, 380, available, false);
    expect(res.collapsed).toBe(true);
    expect(res.width).toBe(ICON_ONLY_SIDEBAR_WIDTH);
  });

  it('常规区间内不收起，宽度正常夹取', () => {
    const res = resolveSidebarDrag(300, 380, available, false);
    expect(res.collapsed).toBe(false);
    expect(res.width).toBe(300);
  });

  it('收起态下拖到展开阈值以上才展开，否则保持收起', () => {
    const stay = resolveSidebarDrag(SIDEBAR_EXPAND_ABOVE - 1, 380, available, true);
    expect(stay.collapsed).toBe(true);
    expect(stay.width).toBe(ICON_ONLY_SIDEBAR_WIDTH);

    const expand = resolveSidebarDrag(SIDEBAR_EXPAND_ABOVE, 380, available, true);
    expect(expand.collapsed).toBe(false);
    // 展开后宽度受常规约束（这里 140 低于下限，夹到 MIN_SIDEBAR_WIDTH）
    expect(expand.width).toBe(clampPaneWidth('sidebar', SIDEBAR_EXPAND_ABOVE, 380, available));
  });
});

describe('列表拖拽隐藏正文（resolveListDrag，左右布局）', () => {
  const available = 1344;
  const sidebar = 220;
  const hideAt = available - sidebar - READER_HIDE_BELOW; // 阅读区被压到 ≤50px 时隐藏

  it('拖到阅读区只剩隐藏阈值 → 彻底隐藏', () => {
    const res = resolveListDrag(hideAt + 40, sidebar, available, false);
    expect(res.readerHidden).toBe(true);
    expect(res.width).toBe(available - sidebar - READER_HIDE_BELOW);
  });

  it('常规区间内不隐藏，宽度正常夹取（正文可一路缩到阈值）', () => {
    const res = resolveListDrag(520, sidebar, available, false);
    expect(res.readerHidden).toBe(false);
    expect(res.width).toBe(520);
  });

  it('隐藏态下拖到阅读区宽过显示阈值才重新显示', () => {
    const stay = resolveListDrag(hideAt - 1, sidebar, available, true);
    expect(stay.readerHidden).toBe(true);
    expect(stay.width).toBe(available - sidebar - READER_HIDE_BELOW);

    const show = resolveListDrag(available - sidebar - READER_SHOW_ABOVE, sidebar, available, true);
    expect(show.readerHidden).toBe(false);
    expect(show.width).toBe(
      clampPaneWidth('list', available - sidebar - READER_SHOW_ABOVE, sidebar, available),
    );
  });
});

describe('列表拖拽隐藏正文（resolveListDragVertical，上下布局）', () => {
  const availableHeight = 900;
  const hideAt = availableHeight - READER_HIDE_BELOW; // 阅读区（下方）被压到 ≤50px 时隐藏

  it('拖到阅读区只剩隐藏阈值 → 彻底隐藏（控制的是高度）', () => {
    const res = resolveListDragVertical(hideAt + 30, availableHeight, false);
    expect(res.readerHidden).toBe(true);
    expect(res.height).toBe(availableHeight - READER_HIDE_BELOW);
  });

  it('常规区间内不隐藏，高度正常夹取', () => {
    const res = resolveListDragVertical(420, availableHeight, false);
    expect(res.readerHidden).toBe(false);
    expect(res.height).toBe(420);
  });

  it('高度受 MIN/MAX 夹取', () => {
    expect(resolveListDragVertical(10, availableHeight, false).height).toBe(MIN_LIST_HEIGHT);
    // 默认高度在范围内时原样保留
    expect(resolveListDragVertical(DEFAULT_LIST_HEIGHT, availableHeight, false).height).toBe(
      DEFAULT_LIST_HEIGHT,
    );
  });

  it('隐藏态下拖到阅读区高过显示阈值才重新显示', () => {
    const stay = resolveListDragVertical(hideAt - 1, availableHeight, true);
    expect(stay.readerHidden).toBe(true);
    expect(stay.height).toBe(availableHeight - READER_HIDE_BELOW);

    const show = resolveListDragVertical(availableHeight - READER_SHOW_ABOVE, availableHeight, true);
    expect(show.readerHidden).toBe(false);
    expect(show.height).toBe(
      Math.min(MAX_LIST_HEIGHT, Math.max(MIN_LIST_HEIGHT, availableHeight - READER_SHOW_ABOVE)),
    );
  });
});

describe('完整布局解析（parsePaneLayout）', () => {
  it('没有存过 / 坏 JSON 一律回落默认（含布尔与 vertical）', () => {
    expect(parsePaneLayout(null)).toEqual({
      ...DEFAULT_PANE_WIDTHS,
      sidebarCollapsed: false,
      readerHidden: false,
      vertical: false,
    });
    expect(parsePaneLayout('not-json')).toEqual({
      ...DEFAULT_PANE_WIDTHS,
      sidebarCollapsed: false,
      readerHidden: false,
      vertical: false,
    });
  });

  it('正常读取宽度与布尔状态', () => {
    expect(parsePaneLayout('{"sidebar":300,"list":520,"sidebarCollapsed":true}')).toEqual({
      sidebar: 300,
      list: 520,
      sidebarCollapsed: true,
      readerHidden: false,
      vertical: false,
    });
    expect(parsePaneLayout('{"readerHidden":true,"vertical":true}')).toEqual({
      ...DEFAULT_PANE_WIDTHS,
      sidebarCollapsed: false,
      readerHidden: true,
      vertical: true,
    });
  });

  it('越界宽度被夹回，非布尔的折叠字段回落 false', () => {
    expect(
      parsePaneLayout('{"sidebar":10,"list":9999,"sidebarCollapsed":"yes"}'),
    ).toEqual({
      sidebar: MIN_SIDEBAR_WIDTH,
      list: MAX_LIST_WIDTH,
      sidebarCollapsed: false,
      readerHidden: false,
      vertical: false,
    });
  });
});
