import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_PANE_LAYOUT,
  ICON_ONLY_SIDEBAR_WIDTH,
  MIN_LIST_WIDTH,
  MAX_LIST_WIDTH,
  MIN_LIST_HEIGHT,
  MAX_LIST_HEIGHT,
  READER_HIDE_BELOW,
  PANE_LAYOUT_KEY,
  clampPaneWidth,
  parsePaneLayout,
  type PaneEdge,
  type PaneLayout,
  type PaneWidths,
} from './pane-layout';

/**
 * 三栏布局状态：读取上次保存的值、拖动时更新、松手后落盘。
 *
 * 宽度用 ref 与 state 双写：拖动时 onCommit 紧跟在最后一次 onChange 之后，
 * 只读 state 会拿到上一帧的值，必须读 ref。
 * 除了连续宽度，还管两个布尔状态：侧栏是否收成图标模式、阅读区是否隐藏。
 */
export function usePaneWidths(): {
  /** 连续宽度（侧栏/列表），供网格与分割线使用。 */
  widths: PaneWidths;
  sidebarCollapsed: boolean;
  readerHidden: boolean;
  /** 列表/正文是否上下排布。 */
  vertical: boolean;
  setWidth(edge: PaneEdge, value: number): void;
  setSidebarCollapsed(value: boolean): void;
  setReaderHidden(value: boolean): void;
  setVertical(value: boolean): void;
  persist(): void;
  reset(): void;
  /** 窗口尺寸变化后把宽度夹回可用范围（隐藏/收起态下跳过对应的栏，上下布局按高度夹）。 */
  clampTo(available: number): void;
} {
  const [layout, setLayout] = useState<PaneLayout>(DEFAULT_PANE_LAYOUT);
  const latest = useRef<PaneLayout>(DEFAULT_PANE_LAYOUT);

  const apply = useCallback((next: PaneLayout) => {
    latest.current = next;
    setLayout(next);
  }, []);

  const setWidth = useCallback(
    (edge: PaneEdge, value: number) => {
      apply({ ...latest.current, [edge]: value });
    },
    [apply],
  );

  const setSidebarCollapsed = useCallback(
    (value: boolean) => apply({ ...latest.current, sidebarCollapsed: value }),
    [apply],
  );

  const setReaderHidden = useCallback(
    (value: boolean) => apply({ ...latest.current, readerHidden: value }),
    [apply],
  );

  const setVertical = useCallback(
    (value: boolean) => apply({ ...latest.current, vertical: value }),
    [apply],
  );

  const persist = useCallback(() => {
    void window.api.setSetting(PANE_LAYOUT_KEY, JSON.stringify(latest.current));
  }, []);

  const reset = useCallback(() => {
    apply(DEFAULT_PANE_LAYOUT);
    void window.api.setSetting(PANE_LAYOUT_KEY, JSON.stringify(DEFAULT_PANE_LAYOUT));
  }, [apply]);

  const clampTo = useCallback(
    (available: number) => {
      const current = latest.current;
      const sidebar = current.sidebarCollapsed
        ? ICON_ONLY_SIDEBAR_WIDTH
        : clampPaneWidth('sidebar', current.sidebar, current.list, available);
      const list = current.readerHidden
        ? Math.round(
            Math.max(
              MIN_LIST_WIDTH,
              Math.min(MAX_LIST_WIDTH, available - sidebar, current.list),
            ),
          )
        : current.vertical
          ? Math.round(
              Math.max(
                MIN_LIST_HEIGHT,
                Math.min(MAX_LIST_HEIGHT, available - sidebar - READER_HIDE_BELOW, current.list),
              ),
            )
          : clampPaneWidth('list', current.list, sidebar, available);
      if (list !== current.list || sidebar !== current.sidebar) {
        apply({ ...current, sidebar, list });
      }
    },
    [apply],
  );

  useEffect(() => {
    let cancelled = false;
    void window.api.getSetting(PANE_LAYOUT_KEY).then((result) => {
      if (cancelled || !result.ok) return;
      apply(parsePaneLayout(result.data));
    });
    return () => {
      cancelled = true;
    };
  }, [apply]);

  return {
    widths: { sidebar: layout.sidebar, list: layout.list },
    sidebarCollapsed: layout.sidebarCollapsed,
    readerHidden: layout.readerHidden,
    vertical: layout.vertical,
    setWidth,
    setSidebarCollapsed,
    setReaderHidden,
    setVertical,
    persist,
    reset,
    clampTo,
  };
}
