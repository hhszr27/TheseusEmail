import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { t } from '../../shared/i18n';
import {
  clampPaneWidth,
  paneWidthForKeyboard,
  resolveSidebarDrag,
  resolveListDrag,
  resolveListDragVertical,
  DEFAULT_SIDEBAR_WIDTH,
  DEFAULT_LIST_WIDTH,
  DEFAULT_LIST_HEIGHT,
  PANE_KEYBOARD_STEP,
  MAX_SIDEBAR_WIDTH,
  MAX_LIST_WIDTH,
  MAX_LIST_HEIGHT,
  MIN_SIDEBAR_WIDTH,
  MIN_LIST_WIDTH,
  MIN_LIST_HEIGHT,
  type PaneEdge,
  type PaneWidths,
} from '../lib/pane-layout';

interface PaneResizerProps {
  edge: PaneEdge;
  widths: PaneWidths;
  onChange(edge: PaneEdge, width: number): void;
  /** 拖动结束/键盘调整后落盘。 */
  onCommit(): void;
  /** 双击（或回车）恢复默认宽度。 */
  onReset(): void;
  /** 侧栏是否已收成图标模式（仅 sidebar 分割线需要）。 */
  collapsed?: boolean;
  /** 阅读区是否已隐藏（仅 list 分割线需要）。 */
  readerHidden?: boolean;
  /** 列表/正文是否上下排布（仅 list 分割线需要；true 时这条分割线变横向，控制高度）。 */
  vertical?: boolean;
  /** 拖拽越过阈值时回传侧栏收起状态切换。 */
  onCollapsedChange?(value: boolean): void;
  /** 拖拽越过阈值时回传阅读区隐藏状态切换。 */
  onReaderHiddenChange?(value: boolean): void;
}

/**
 * 分割线拖拽手柄。
 *
 * 平时完全不可见（宽度 0，只留 9px 的透明命中区，正好压在原 1px 边框上），
 * 悬停/拖动时显示一条强调色细线。鼠标事件挂在 window 上而不是元素上，
 * 这样拖出面板甚至拖出窗口也不会丢事件；拖动期间给 iframe 关掉 pointer-events，
 * 否则划到正文上方时事件会被 iframe 吃掉。
 *
 * 越过折叠/隐藏阈值时，回传布尔状态切换（收起侧栏 / 隐藏阅读区）；
 * 宽度与布尔状态解耦，避免在「拖到一半」的区间里宽度和状态打架。
 */
export function PaneResizer({
  edge,
  widths,
  onChange,
  onCommit,
  onReset,
  collapsed = false,
  readerHidden = false,
  vertical = false,
  onCollapsedChange,
  onReaderHiddenChange,
}: PaneResizerProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    startSize: number;
    other: number;
    available: number;
  } | null>(null);

  const isVerticalList = edge === 'list' && vertical;

  // 监听器只挂一次，回调通过 ref 读最新值，避免每帧重建监听
  const latest = useRef({ widths, onChange, onCommit, collapsed, readerHidden, vertical });
  latest.current = { widths, onChange, onCommit, collapsed, readerHidden, vertical };

  const measure = useCallback((): number => {
    const parent = ref.current?.parentElement;
    return parent && parent.clientWidth > 0 ? parent.clientWidth : window.innerWidth;
  }, []);

  const measureHeight = useCallback((): number => {
    const parent = ref.current?.parentElement;
    return parent && parent.clientHeight > 0 ? parent.clientHeight : window.innerHeight;
  }, []);

  useEffect(() => {
    if (!dragging) return;

    const finish = (): void => {
      if (!dragRef.current) return;
      dragRef.current = null;
      setDragging(false);
      latest.current.onCommit();
    };

    const handleMove = (event: PointerEvent): void => {
      const drag = dragRef.current;
      if (!drag) return;
      // 鼠标在窗口外松开时收不到 pointerup，用 buttons 兜底结束拖动
      if (event.buttons === 0) {
        finish();
        return;
      }
      const vList = latest.current.vertical && edge === 'list';
      const desired = vList
        ? drag.startSize + (event.clientY - drag.startY)
        : drag.startSize + (event.clientX - drag.startX);
      if (edge === 'sidebar') {
        const res = resolveSidebarDrag(desired, drag.other, drag.available, latest.current.collapsed);
        if (res.collapsed !== latest.current.collapsed) onCollapsedChange?.(res.collapsed);
        latest.current.onChange(edge, res.width);
      } else if (vList) {
        const res = resolveListDragVertical(desired, drag.available, latest.current.readerHidden);
        if (res.readerHidden !== latest.current.readerHidden) onReaderHiddenChange?.(res.readerHidden);
        latest.current.onChange(edge, res.height);
      } else {
        const res = resolveListDrag(desired, drag.other, drag.available, latest.current.readerHidden);
        if (res.readerHidden !== latest.current.readerHidden) onReaderHiddenChange?.(res.readerHidden);
        latest.current.onChange(edge, res.width);
      }
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('blur', finish);
    document.body.classList.add('is-resizing');
    if (isVerticalList) document.body.classList.add('is-resizing-row');

    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('blur', finish);
      document.body.classList.remove('is-resizing');
      document.body.classList.remove('is-resizing-row');
    };
  }, [dragging, edge, isVerticalList, onCollapsedChange, onReaderHiddenChange]);

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    const vList = vertical && edge === 'list';
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      startSize: edge === 'sidebar' ? widths.sidebar : widths.list,
      other: edge === 'sidebar' ? widths.list : vList ? 0 : widths.sidebar,
      available: vList ? measureHeight() : measure(),
    };
    setDragging(true);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      onReset();
      return;
    }
    // 收起态下用方向键展开/收起，比「夹到最小宽度」更直观
    if (edge === 'sidebar' && collapsed) {
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        event.stopPropagation();
        onCollapsedChange?.(false);
        onChange(edge, DEFAULT_SIDEBAR_WIDTH);
        onCommit();
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }
    if (edge === 'list' && readerHidden) {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        event.stopPropagation();
        onReaderHiddenChange?.(false);
        onChange(edge, clampPaneWidth('list', DEFAULT_LIST_WIDTH, widths.sidebar, measure()));
        onCommit();
        return;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }
    // 上下布局：方向键改的是列表「高度」
    if (isVerticalList) {
      let next: number | null = null;
      if (event.key === 'ArrowDown') {
        next = Math.round(
          Math.min(MAX_LIST_HEIGHT, Math.max(MIN_LIST_HEIGHT, widths.list + PANE_KEYBOARD_STEP)),
        );
      } else if (event.key === 'ArrowUp') {
        next = Math.round(
          Math.min(MAX_LIST_HEIGHT, Math.max(MIN_LIST_HEIGHT, widths.list - PANE_KEYBOARD_STEP)),
        );
      } else if (event.key === 'Home') {
        next = DEFAULT_LIST_HEIGHT;
      }
      if (next === null) return;
      event.preventDefault();
      event.stopPropagation();
      onChange(edge, next);
      onCommit();
      return;
    }
    const next = paneWidthForKeyboard(edge, widths, event.key, measure());
    if (next === null) return;
    // 方向键在列表里是「上下选邮件」，这里必须拦住，别让全局快捷键跟着动
    event.preventDefault();
    event.stopPropagation();
    onChange(edge, next);
    onCommit();
  };

  const value = edge === 'sidebar' ? widths.sidebar : widths.list;
  const label = edge === 'sidebar' ? t('layout.resizeSidebar') : t('layout.resizeList');

  return (
    <div
      ref={ref}
      className={`pane-resizer pane-resizer-${edge}${isVerticalList ? ' vertical' : ''}${
        dragging ? ' is-dragging' : ''
      }`}
      role="separator"
      aria-orientation={isVerticalList ? 'horizontal' : 'vertical'}
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={edge === 'sidebar' ? MIN_SIDEBAR_WIDTH : MIN_LIST_WIDTH}
      aria-valuemax={edge === 'sidebar' ? MAX_SIDEBAR_WIDTH : MAX_LIST_WIDTH}
      aria-valuetext={t('layout.resizeValue', { width: value })}
      tabIndex={0}
      title={t('layout.resizeHint')}
      onPointerDown={startDrag}
      onKeyDown={handleKeyDown}
      onDoubleClick={onReset}
    />
  );
}
