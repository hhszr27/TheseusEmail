import { useEffect, useState } from 'react';
import type { PluginMenuItem } from '../../shared/plugin';
import type { MenuRegion } from '../../shared/types';

interface PluginMenuProps {
  region: MenuRegion;
  x: number;
  y: number;
  accountId: string | null;
  context: Record<string, boolean>;
  onRun(item: PluginMenuItem): void;
  onClose(): void;
}

/**
 * 插件菜单浮层（§13.3.1）。
 * 可见性与执行权限分离：缺少权限的项照样显示，点击时才提示。
 */
export function PluginMenu({
  region,
  x,
  y,
  accountId,
  context,
  onRun,
  onClose,
}: PluginMenuProps): JSX.Element | null {
  const [items, setItems] = useState<PluginMenuItem[] | null>(null);

  useEffect(() => {
    let active = true;
    setItems(null);
    void window.api
      .getPluginMenuItems({ region, accountId, context })
      .then((result) => {
        if (!active) return;
        if (!result.ok) {
          onClose();
          return;
        }
        if (result.data.length === 0) {
          onClose();
          return;
        }
        setItems(result.data);
      });
    return () => {
      active = false;
    };
  }, [region, accountId, context, onClose]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!items) return null;

  const left = Math.min(x, Math.max(0, window.innerWidth - 260));
  const top = Math.min(y, Math.max(0, window.innerHeight - 40 - items.length * 34));

  return (
    <div
      className="plugin-menu-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        className="plugin-menu"
        role="menu"
        aria-label="插件命令"
        style={{ left, top }}
      >
        {items.map((item) => (
          <button
            key={`${item.pluginId}:${item.commandId}`}
            type="button"
            role="menuitem"
            className="plugin-menu-item"
            title={item.description ?? item.label}
            onClick={() => onRun(item)}
          >
            <span className="plugin-menu-label">{item.label}</span>
            <span className="plugin-menu-source">{item.pluginName}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
