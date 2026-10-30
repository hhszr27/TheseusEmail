import { createElement, useEffect, useState } from 'react';
import type { PluginViewSession } from '../../shared/plugin';
import type { SlotName } from '../../shared/types';

interface PluginViewProps {
  pluginId: string;
  slot: SlotName;
  className?: string;
  title?: string;
  /** 账户上下文：账户级禁用时不加载该视图（§7.8.4）。 */
  accountId?: string | null;
}

/**
 * 插件视图宿主（§13.3、§13.7）。
 * 使用 <webview> 而不是 dangerouslySetInnerHTML；preload / partition 由主进程校验。
 */
export function PluginView({
  pluginId,
  slot,
  className,
  title,
  accountId,
}: PluginViewProps): JSX.Element {
  const [session, setSession] = useState<PluginViewSession | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setSession(null);
    setError(null);

    void window.api.getPluginView(pluginId, slot, accountId ?? null).then((result) => {
      if (!active) return;
      if (result.ok && result.data) {
        setSession(result.data);
      } else if (result.ok) {
        setError('插件未提供该视图');
      } else {
        setError(result.error.message);
      }
    });

    return () => {
      active = false;
    };
  }, [pluginId, slot, accountId]);

  if (error) {
    return (
      <div className={className ?? 'plugin-view'} role="note">
        <p className="hint">插件视图不可用：{error}</p>
      </div>
    );
  }

  if (!session) {
    return (
      <div className={className ?? 'plugin-view'} role="note">
        <p className="hint">正在加载插件视图…</p>
      </div>
    );
  }

  return createElement('webview', {
    key: `${session.pluginId}-${session.slot}-${session.url}`,
    className: className ?? 'plugin-view',
    src: session.url,
    partition: session.partition,
    preload: session.preloadUrl,
    nodeintegration: 'false',
    webpreferences: 'contextIsolation=yes, sandbox=yes',
    title: title ?? `${pluginId} 插件视图`,
  });
}
