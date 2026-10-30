import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { t } from '../../shared/i18n';

/** 右键落点与目标文件夹。 */
export interface FolderMenuTarget {
  x: number;
  y: number;
  accountId: string;
  path: string;
  name: string;
}

interface FolderContextMenuProps {
  target: FolderMenuTarget;
  /** 置灰原因：undefined 表示这一项可用。 */
  guards: { rename?: string; move?: string; remove?: string; copy?: string; clear?: string; moveUp?: string; moveDown?: string };
  /** 当前文件夹是否已在收藏夹里。 */
  favorite: boolean;
  onClose(): void;
  onOpenWindow(): void;
  onNewFolder(): void;
  onRename(): void;
  onCopy(): void;
  onMove(): void;
  onRemove(): void;
  onMarkAllRead(): void;
  onCleanup(): void;
  onClear(): void;
  onToggleFavorite(): void;
  onSortAsc(): void;
  onMoveUp(): void;
  onMoveDown(): void;
  onProperties(): void;
}

interface MenuRow {
  key: string;
  label: string;
  /** 不可用原因：置灰并在 title 里说明为什么。 */
  reason?: string;
  run?(): void;
}

/**
 * 文件夹右键菜单（对齐 Windows Mail / Outlook 的分组）。
 *
 * 本机没有服务端文件夹管理能力（改名/复制/移动/删除）与收藏夹、自定义排序，
 * 这些项保留位置并置灰、悬停给出具体原因；能做的三项（新建、全部标为已读、属性）直接可用。
 */
export function FolderContextMenu({
  target,
  guards,
  favorite,
  onClose,
  onOpenWindow,
  onNewFolder,
  onRename,
  onCopy,
  onMove,
  onRemove,
  onMarkAllRead,
  onCleanup,
  onClear,
  onToggleFavorite,
  onSortAsc,
  onMoveUp,
  onMoveDown,
  onProperties,
}: FolderContextMenuProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState({ x: target.x, y: target.y });

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const margin = 8;
    setPosition({
      x: Math.max(margin, Math.min(target.x, window.innerWidth - rect.width - margin)),
      y: Math.max(margin, Math.min(target.y, window.innerHeight - rect.height - margin)),
    });
  }, [target]);

  useEffect(() => {
    firstItemRef.current?.focus();
    const handlePointerDown = (event: PointerEvent): void => {
      if (ref.current?.contains(event.target as Node)) return;
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('blur', onClose);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  const groups: MenuRow[][] = [
    [
      { key: 'open-window', label: t('folder.menu.openWindow'), run: onOpenWindow },
      { key: 'new-folder', label: t('folder.menu.newFolder'), run: onNewFolder },
      { key: 'rename', label: t('folder.menu.rename'), reason: guards.rename, run: onRename },
      { key: 'copy', label: t('folder.menu.copy'), reason: guards.copy, run: onCopy },
      { key: 'move', label: t('folder.menu.move'), reason: guards.move, run: onMove },
      { key: 'delete-folder', label: t('folder.menu.delete'), reason: guards.remove, run: onRemove },
    ],
    [
      { key: 'mark-read', label: t('folder.menu.markAllRead'), run: onMarkAllRead },
      { key: 'cleanup', label: t('folder.menu.cleanup'), run: onCleanup },
      { key: 'delete-all', label: t('folder.menu.deleteAll'), reason: guards.clear, run: onClear },
    ],
    [
      {
        key: 'unfavorite',
        label: favorite ? t('folder.menu.unfavorite') : t('folder.menu.favorite'),
        run: onToggleFavorite,
      },
      { key: 'sort-asc', label: t('folder.menu.sortAsc'), run: onSortAsc },
      { key: 'move-up', label: t('folder.menu.moveUp'), reason: guards.moveUp, run: onMoveUp },
      { key: 'move-down', label: t('folder.menu.moveDown'), reason: guards.moveDown, run: onMoveDown },
    ],
    [{ key: 'properties', label: t('folder.menu.properties'), run: onProperties }],
  ];

  let firstAssigned = false;
  const rows: JSX.Element[] = [];
  groups.forEach((group, groupIndex) => {
    if (groupIndex > 0) rows.push(<div key={`sep-${groupIndex}`} className="filter-menu-sep" role="separator" />);
    for (const row of group) {
      const disabled = Boolean(row.reason);
      const isFirst = !firstAssigned && !disabled;
      if (isFirst) firstAssigned = true;
      rows.push(
        <button
          key={row.key}
          ref={isFirst ? firstItemRef : undefined}
          type="button"
          role="menuitem"
          className="filter-menu-item"
          aria-disabled={disabled || undefined}
          title={row.reason}
          onClick={() => {
            if (disabled || !row.run) return;
            onClose();
            row.run();
          }}
        >
          <span className="filter-menu-label">{row.label}</span>
          {disabled ? <span className="filter-menu-tag">{t('mail.filter.unsupported')}</span> : null}
        </button>,
      );
    }
  });

  return (
    <div
      ref={ref}
      className="folder-menu"
      role="menu"
      aria-label={`${target.name} 的菜单`}
      style={{ left: `${position.x}px`, top: `${position.y}px` }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {rows}
    </div>
  );
}
