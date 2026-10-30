import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './theme/contract.css';
import './styles.css';
import './theme/elevation.css';
import type { RecoveryInfo } from '../shared/ipc';

/**
 * 独立恢复页面（§25.1）。
 * 渲染进程崩溃后由主进程打开；不自动恢复，必须由用户显式点击重新加载。
 */
function Recovery(): JSX.Element {
  const [info, setInfo] = useState<RecoveryInfo | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    void window.recoveryAPI.getInfo().then(setInfo);
  }, []);

  const handleReload = (): void => {
    setPending(true);
    void window.recoveryAPI.reload();
  };

  const handleQuit = (): void => {
    void window.recoveryAPI.quit();
  };

  return (
    <main className="recovery">
      <h1>界面已停止运行</h1>
      <p className="hint">
        渲染进程发生了崩溃。诊断信息已保留在下方，并写入本地日志。你可以先复制这些信息，再重新加载界面。
      </p>

      <dl className="kv">
        <dt>崩溃原因</dt>
        <dd>{info?.reason ?? '读取中…'}</dd>
        <dt>退出码</dt>
        <dd>{info?.exitCode ?? '—'}</dd>
        <dt>来源</dt>
        <dd>{info?.source ?? '—'}</dd>
        <dt>发生时间</dt>
        <dd>{info ? new Date(info.occurredAt).toLocaleString() : '—'}</dd>
        <dt>版本</dt>
        <dd>
          MailForge {info?.appVersion ?? '—'} · Electron {info?.electronVersion ?? '—'}
        </dd>
      </dl>

      <h2 style={{ fontSize: 16, margin: 0 }}>最近日志（已脱敏）</h2>
      <pre className="recovery-logs" aria-label="最近日志">
        {info && info.recentLogs.length > 0 ? info.recentLogs.join('\n') : '（暂无日志）'}
      </pre>

      <div className="recovery-actions">
        <button type="button" className="btn btn-primary" onClick={handleReload} disabled={pending}>
          {pending ? '正在重新加载…' : info?.reloadLabel ?? '重新加载'}
        </button>
        <button type="button" className="btn" onClick={handleQuit}>
          退出应用
        </button>
      </div>
    </main>
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('恢复页面缺少 #root 节点');

createRoot(container).render(
  <StrictMode>
    <Recovery />
  </StrictMode>,
);
