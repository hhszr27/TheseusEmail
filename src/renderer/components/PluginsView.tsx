import { useEffect, useState } from 'react';
import type { PluginRuntimeInfo } from '../../shared/plugin';
import { useMailStore } from '../stores/mail-store';

const STATUS_LABEL: Record<PluginRuntimeInfo['status'], string> = {
  ready: '就绪',
  disabled: '已禁用',
  invalid: '不可用',
  timeout: '初始化超时',
  incompatible: 'API 不兼容',
};

const SIGNATURE_LABEL: Record<PluginRuntimeInfo['signature'], string> = {
  verified: '签名已验证',
  unsigned: '未签名（来源未知）',
  invalid: '签名无效',
};

export function PluginsView(): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const pluginSnapshot = useMailStore((state) => state.pluginSnapshot);
  const loadPlugins = useMailStore((state) => state.loadPlugins);
  const setView = useMailStore((state) => state.setView);

  useEffect(() => {
    void loadPlugins();
  }, [loadPlugins]);

  const togglePlugin = async (plugin: PluginRuntimeInfo): Promise<void> => {
    const result = await window.api.setPluginEnabled(plugin.id, !plugin.enabled);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    await loadPlugins();
  };

  const revoke = async (
    plugin: PluginRuntimeInfo,
    permission: PluginRuntimeInfo['permissions'][number],
    revoked: boolean,
  ): Promise<void> => {
    const result = await window.api.revokePluginPermission(plugin.id, permission, revoked);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    await loadPlugins();
  };

  return (
    <section className="main-view" aria-label="插件">
      <header className="view-header">
        <div>
          <h1 className="view-title">插件</h1>
          <p className="hint">
            插件从用户数据目录的 plugins/ 加载；开发模式也支持项目根目录 plugins/。
          </p>
        </div>
        <button type="button" className="btn" onClick={() => setView('mail')}>
          返回邮件
        </button>
      </header>

      {error ? <p className="error-banner">{error}</p> : null}

      <div className="view-body">
        {pluginSnapshot?.plugins.length ? (
          pluginSnapshot.plugins.map((plugin) => {
            const revoked = new Set(plugin.revokedPermissions ?? []);
            return (
              <article className="plugin-card" key={plugin.id}>
                <div className="plugin-head">
                  <strong>{plugin.name}</strong>
                  <span className="hint">v{plugin.version}</span>
                  <span className={`badge badge-${plugin.status}`}>{STATUS_LABEL[plugin.status]}</span>
                  <span className={`badge badge-${plugin.signature}`}>
                    {SIGNATURE_LABEL[plugin.signature]}
                  </span>
                  <span className="statusbar-spacer" />
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={plugin.enabled}
                      disabled={plugin.status !== 'ready'}
                      onChange={() => void togglePlugin(plugin)}
                    />
                    启用
                  </label>
                </div>

                <div className="plugin-meta">
                  {plugin.id}
                  {plugin.source === 'dev' ? ' · 开发目录' : ''}
                  {plugin.hasReaderView ? ' · 接管阅读视图' : ''}
                  {plugin.slots.length ? ` · 插槽 ${plugin.slots.join(', ')}` : ''}
                </div>

                {plugin.error ? <p className="hint">{plugin.error}</p> : null}

                {plugin.permissions.length ? (
                  <div className="permission-list">
                    {plugin.permissions.map((permission) => (
                      <label className="checkbox" key={permission}>
                        <input
                          type="checkbox"
                          checked={!revoked.has(permission)}
                          onChange={(event) =>
                            void revoke(plugin, permission, !event.target.checked)
                          }
                        />
                        {permission}
                      </label>
                    ))}
                  </div>
                ) : null}

                <div className="plugin-actions">
                  <button
                    type="button"
                    className="btn"
                    disabled={plugin.status !== 'ready'}
                    onClick={() =>
                      void window.api.openPluginDevtools(plugin.id).then((result) => {
                        if (!result.ok) setError(result.error.message);
                      })
                    }
                  >
                    插件 DevTools
                  </button>
                </div>
              </article>
            );
          })
        ) : (
          <p className="hint">未发现插件。</p>
        )}

        {pluginSnapshot?.warnings.length ? (
          <details className="plugin-warnings">
            <summary>加载警告（{pluginSnapshot.warnings.length}）</summary>
            <ul>
              {pluginSnapshot.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </section>
  );
}
