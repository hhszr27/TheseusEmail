import { useEffect, useRef, useState } from 'react';
import type { DiagnosticsData } from '../../shared/ipc';
import { useMailStore } from '../stores/mail-store';
import { applySettingsFilter, collectSettingsSections } from '../lib/settings-search';
import { ShortcutsSettings } from './ShortcutsSettings';
import { NotificationSettings } from './NotificationSettings';
import { Phase3Settings } from './Phase3Settings';
import { AccountSettings } from './AccountSettings';
import { COMPOSE_INCLUDE_QUOTE_KEY } from '../lib/compose';
import {
  AUTO_FULL_SCREEN_KEY,
  MARK_READ_DELAY_KEY,
  readAutoFullScreen,
  readMarkReadDelay,
} from '../lib/reading-settings';
import { normalizeMarkReadDelay } from '../../shared/reading-settings';
import { TIME_FORMAT_KEY, WORK_HOURS_KEY, readTimeFormat, readWorkHours } from '../lib/calendar-settings';
import { broadcastTimeFormat } from '../lib/use-time-format';
import { broadcastTimeZone } from '../lib/use-time-zone';
import { TIMEZONE_KEY, TIMEZONE_SYSTEM, systemTimeZone } from '../../shared/timezone';
import {
  formatWorkHours,
  normalizeTimeFormat,
  normalizeWorkHours,
  type TimeFormat,
  type WorkHours,
} from '../../shared/calendar-settings';

/** 常用时区（值必须是合法的 IANA 名称）。 */
const TIME_ZONE_OPTIONS = [
  { value: 'Asia/Shanghai', label: '中国标准时间（上海）' },
  { value: 'Asia/Hong_Kong', label: '中国香港' },
  { value: 'Asia/Taipei', label: '中国台北' },
  { value: 'Asia/Tokyo', label: '东京' },
  { value: 'Asia/Singapore', label: '新加坡' },
  { value: 'Europe/London', label: '伦敦' },
  { value: 'Europe/Paris', label: '巴黎' },
  { value: 'America/New_York', label: '纽约' },
  { value: 'America/Los_Angeles', label: '洛杉矶' },
  { value: 'UTC', label: 'UTC' },
];

export function SettingsView(): JSX.Element {
  const [diagnostics, setDiagnostics] = useState<DiagnosticsData | null>(null);
  /** 程序运行唯一性（null = 还没读到）。 */
  const [singleInstance, setSingleInstance] = useState<boolean | null>(null);
  /** 回复/转发是否保留原邮件引用（null = 还没读到）。 */
  const [includeQuote, setIncludeQuote] = useState<boolean | null>(null);
  /** 打开邮件后多少秒再标已读（0 = 立即；null = 还没读到）。 */
  const [markReadDelay, setMarkReadDelay] = useState<number | null>(null);
  /** 双击 / 打开阅读窗口是否自动全屏（null = 还没读到）。 */
  const [autoFullScreen, setAutoFullScreen] = useState<boolean | null>(null);
  /** 日历工作时间（null = 还没读到）。 */
  const [workHours, setWorkHours] = useState<WorkHours | null>(null);
  /** 时间显示格式（null = 还没读到）。 */
  const [timeFormat, setTimeFormat] = useState<TimeFormat | null>(null);
  /** 时区原始值（'system' 或 IANA 名称；null = 还没读到）。 */
  const [timeZone, setTimeZone] = useState<string | null>(null);
  /** 快捷键编辑弹窗。 */
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pluginSnapshot = useMailStore((state) => state.pluginSnapshot);

  /** 设置搜索：按区块过滤，空串显示全部。 */
  const [query, setQuery] = useState('');
  /** 过滤后可见的区块数（-1 = 未在搜索）。 */
  const [visibleSections, setVisibleSections] = useState(-1);
  const bodyRef = useRef<HTMLDivElement>(null);

  /** 左侧菜单项（由页面里的 `.settings-section` 自动生成）。 */
  const [navItems, setNavItems] = useState<Array<{ index: number; title: string }>>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const navRef = useRef<HTMLElement>(null);

  // 菜单不是手写清单：直接读页面上真实渲染出来的区块标题。
  // 这样新增一个设置区块不需要回来改菜单（子组件异步渲染也能被 MutationObserver 捕获）。
  useEffect(() => {
    const root = bodyRef.current;
    if (!root) return;

    let lastSignature = '';
    const collect = (): void => {
      const items = collectSettingsSections(root);
      // 文案变化（诊断数字刷新等）不算结构变化，别让菜单跟着抖
      const signature = items.map((item) => item.title).join('|');
      if (signature === lastSignature) return;
      lastSignature = signature;
      setNavItems(items);
    };

    collect();
    const observer = new MutationObserver(collect);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  const jumpTo = (index: number): void => {
    const root = bodyRef.current;
    const section = root?.querySelectorAll<HTMLElement>('.settings-section')[index];
    section?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActiveIndex(index);
  };

  // 设置内容会异步到达（诊断、插件、账户），这些变化后要重新过滤一次，
  // 否则新渲染出来的区块会沿用上一次的隐藏状态。
  // 搜索只作用于右侧内容：左侧菜单始终完整显示，否则跳转入口会消失。
  useEffect(() => {
    const root = bodyRef.current;
    if (!root) return;
    setVisibleSections(applySettingsFilter(root, query));
  }, [query, diagnostics, pluginSnapshot, navItems]);
  const loadPlugins = useMailStore((state) => state.loadPlugins);
  const setView = useMailStore((state) => state.setView);

  useEffect(() => {
    let cancelled = false;
    void window.api.getDiagnostics().then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setDiagnostics(result.data);
        setError(null);
      } else {
        setError(result.error.message);
      }
    });
    void loadPlugins();
    void window.api.getInstanceMode().then((result) => {
      if (cancelled || !result.ok) return;
      setSingleInstance(result.data);
    });
    void window.api.getSetting(COMPOSE_INCLUDE_QUOTE_KEY).then((result) => {
      if (cancelled) return;
      // 没设置过或读取失败时默认开启
      setIncludeQuote(!result.ok || result.data !== 'false');
    });
    void readMarkReadDelay().then((value) => {
      if (!cancelled) setMarkReadDelay(value);
    });
    void readAutoFullScreen().then((value) => {
      if (!cancelled) setAutoFullScreen(value);
    });
    void readWorkHours().then((value) => {
      if (!cancelled) setWorkHours(value);
    });
    void readTimeFormat().then((value) => {
      if (!cancelled) setTimeFormat(value);
    });
    void window.api.getSetting(TIMEZONE_KEY).then((result) => {
      if (cancelled) return;
      // 没设置过 = 跟随系统（首次打开由 useTimeZone 把系统时区落库）
      setTimeZone(result.ok && result.data ? result.data : TIMEZONE_SYSTEM);
    });
    return () => {
      cancelled = true;
    };
  }, [loadPlugins]);

  /** 归一化后同时落盘：写入非法组合（如结束早于开始）时回落到默认 9–18。 */
  const saveWorkHours = (next: { start: number; end: number }): void => {
    const normalized = normalizeWorkHours(`${next.start}-${next.end}`);
    setWorkHours(normalized);
    void window.api.setSetting(WORK_HOURS_KEY, formatWorkHours(normalized));
  };

  return (
    <section className="main-view settings-view" aria-label="设置">
      <header className="view-header">
        <div>
          <h1 className="view-title">设置</h1>
          <p className="hint">账户、快捷键、翻译、AI、附件策略、隐私与诊断。主题与插件在右上角工具栏。</p>
        </div>
        <button type="button" className="btn" onClick={() => setView('mail')}>
          返回邮件
        </button>
      </header>

      {error ? <p className="error-banner">{error}</p> : null}

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置分类" ref={navRef}>
          {navItems.map((item) => (
            <button
              key={`${item.index}-${item.title}`}
              type="button"
              className={`settings-nav-item${activeIndex === item.index ? ' is-active' : ''}`}
              onClick={() => jumpTo(item.index)}
            >
              {item.title}
            </button>
          ))}
        </nav>

        <div className="settings-scroll">
          <div className="view-body" ref={bodyRef}>
            <div className="settings-search">
          <input
            className="input"
            type="search"
            placeholder="搜索设置，例如「时区」「通知」「签名」"
            aria-label="搜索设置"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query.trim() ? (
            <span className="hint">
              {visibleSections > 0 ? `找到 ${visibleSections} 个设置区块` : '没有匹配的设置'}
            </span>
          ) : null}
        </div>

        <AccountSettings />

        <NotificationSettings />

        <section className="settings-section">
          <h3 className="settings-title">快捷键</h3>
          <div className="settings-inline">
            <span>按命令查看、录制或重置快捷键</span>
            <button type="button" className="btn" onClick={() => setShortcutsOpen(true)}>
              修改快捷键
            </button>
          </div>
          <p className="hint">快捷键冲突会在这里提示；插件声明的快捷键只读。</p>
        </section>

        <Phase3Settings />

        <section className="settings-section">
          <h3 className="settings-title">写信</h3>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={includeQuote ?? true}
              disabled={includeQuote === null}
              onChange={(event) => {
                const next = event.target.checked;
                setIncludeQuote(next);
                void window.api.setSetting(COMPOSE_INCLUDE_QUOTE_KEY, next ? 'true' : 'false');
              }}
            />
            <span>回复 / 转发时保留原邮件引用</span>
          </label>
          <p className="hint">
            关闭后，回复和转发只带主题与收件人，正文从空白开始，不再在下方附上原邮件内容。
            该设置对主窗口和独立写信窗口都生效。
          </p>
        </section>

        <section className="settings-section">
          <h3 className="settings-title">阅读</h3>
          <div className="settings-checks">
            <label className="settings-inline">
              <input
                className="input"
                type="number"
                min={0}
                max={600}
                step={5}
                style={{ maxWidth: 96 }}
                value={markReadDelay ?? 0}
                disabled={markReadDelay === null}
                onChange={(event) => {
                  const next = normalizeMarkReadDelay(event.target.value);
                  setMarkReadDelay(next);
                  void window.api.setSetting(MARK_READ_DELAY_KEY, String(next));
                }}
              />
              <span>打开邮件后等待这么多秒再标记为已读（0 = 立即）</span>
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={autoFullScreen ?? true}
                disabled={autoFullScreen === null}
                onChange={(event) => {
                  const next = event.target.checked;
                  setAutoFullScreen(next);
                  void window.api.setSetting(AUTO_FULL_SCREEN_KEY, next ? 'true' : 'false');
                }}
              />
              <span>双击邮件或打开阅读窗口时自动全屏</span>
            </label>
          </div>
          <p className="hint">
            延迟标已读适合快速扫列表：停留时间不足就切走，邮件会保持未读。
            自动全屏只作用于阅读窗口，回复 / 转发窗口仍按普通尺寸打开。
            正文里按空格向下翻页，读到末尾再按一次空格会切到下一封。
          </p>
        </section>

        <section className="settings-section">
          <h3 className="settings-title">时间</h3>
          <div className="settings-checks">
            <label className="settings-inline">
              <span>时间格式</span>
              <select
                className="input"
                value={timeFormat ?? '24'}
                disabled={timeFormat === null}
                aria-label="时间格式"
                onChange={(event) => {
                  const next = normalizeTimeFormat(event.target.value);
                  setTimeFormat(next);
                  broadcastTimeFormat(next);
                  void window.api.setSetting(TIME_FORMAT_KEY, next);
                }}
              >
                <option value="24">24 小时制（14:30）</option>
                <option value="12">12 小时制（2:30 PM）</option>
              </select>
            </label>

            <label className="settings-inline">
              <span>时区</span>
              <select
                className="input"
                value={timeZone ?? TIMEZONE_SYSTEM}
                disabled={timeZone === null}
                aria-label="时区"
                onChange={(event) => {
                  const next = event.target.value;
                  setTimeZone(next);
                  broadcastTimeZone(next);
                  void window.api.setSetting(TIMEZONE_KEY, next);
                }}
              >
                <option value={TIMEZONE_SYSTEM}>跟随系统（{systemTimeZone()}）</option>
                {TIME_ZONE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
                {timeZone &&
                timeZone !== TIMEZONE_SYSTEM &&
                !TIME_ZONE_OPTIONS.some((option) => option.value === timeZone) ? (
                  <option value={timeZone}>{timeZone}</option>
                ) : null}
              </select>
            </label>
          </div>
          <p className="hint">
            时间格式影响邮件列表、阅读区与日历的时间显示；时区决定「几点」与「哪一天」——
            跨时区时同一封邮件可能属于不同日期，日历事件也会落到不同的列。
          </p>
        </section>

        <section className="settings-section">
          <h3 className="settings-title">日历</h3>
          <div className="settings-checks">
            <label className="settings-inline">
              <span>工作时间</span>
              <input
                className="input"
                type="number"
                min={0}
                max={24}
                style={{ maxWidth: 80 }}
                value={workHours?.start ?? 9}
                disabled={workHours === null}
                aria-label="工作开始时间"
                onChange={(event) =>
                  saveWorkHours({ start: Number(event.target.value), end: workHours?.end ?? 18 })
                }
              />
              <span>点 至</span>
              <input
                className="input"
                type="number"
                min={0}
                max={24}
                style={{ maxWidth: 80 }}
                value={workHours?.end ?? 18}
                disabled={workHours === null}
                aria-label="工作结束时间"
                onChange={(event) =>
                  saveWorkHours({ start: workHours?.start ?? 9, end: Number(event.target.value) })
                }
              />
              <span>点</span>
            </label>

          </div>
          <p className="hint">
            周视图按小时分格；工作时间之外的小时用灰色显示。修改后切回日历即可看到效果。
          </p>
        </section>

        <section className="settings-section">
          <h3 className="settings-title">程序</h3>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={singleInstance ?? true}
              disabled={singleInstance === null}
              onChange={(event) => {
                const next = event.target.checked;
                setSingleInstance(next);
                void window.api.setInstanceMode(next);
              }}
            />
            <span>只运行一个实例：再次启动时切回已打开的窗口</span>
          </label>
          <p className="hint">
            关闭后可以同时启动多个实例。注意：它们共用同一个本地邮件库和账户连接，托盘图标与通知会重复出现，
            两个窗口也会各自同步；开关在下一次启动时生效。
          </p>
        </section>

        <section className="settings-section">
          <h3 className="settings-title">诊断</h3>
          {diagnostics ? (
            <dl className="kv">
              <dt>数据库加密</dt>
              <dd>{diagnostics.dbEncrypted ? 'SQLCipher（已加密）' : '未加密'}</dd>

              <dt>密钥保护</dt>
              <dd>
                {diagnostics.keyProtection === 'master'
                  ? '主密码（scrypt + AES-256-GCM）'
                  : diagnostics.keyProtection === 'safeStorage'
                    ? 'safeStorage（系统密钥库）'
                    : '弱保护（请配置系统密钥环）'}
              </dd>

              <dt>数据库路径</dt>
              <dd>{diagnostics.dbPath}</dd>

              <dt>日志目录</dt>
              <dd>{diagnostics.logDir}</dd>

              <dt>邮件 / 账户 / 文件夹</dt>
              <dd>
                {diagnostics.counts.emails} / {diagnostics.counts.accounts} /{' '}
                {diagnostics.counts.folders}
              </dd>

              <dt>冷启动（进程 → 可交互）</dt>
              <dd>
                {diagnostics.startupMs === null ? '尚未记录' : `${Math.round(diagnostics.startupMs)} ms`}
              </dd>

              <dt>代理</dt>
              <dd>
                {diagnostics.proxy.enabled
                  ? `${diagnostics.proxy.source === 'env' ? '环境变量' : '系统设置'} · ${diagnostics.proxy.uri ?? ''}`
                  : '直连'}
              </dd>

              <dt>私网直连</dt>
              <dd>{diagnostics.proxy.bypassPrivate ? '启用' : '关闭'}</dd>

              <dt>硬件加速</dt>
              <dd>
                {diagnostics.hardwareAcceleration ? '启用' : '已禁用（GPU 连续崩溃保护）'}
              </dd>

              <dt>GPU 崩溃次数</dt>
              <dd>{diagnostics.gpuCrashes}</dd>

              <dt>系统托盘</dt>
              <dd>
                {diagnostics.tray.active
                  ? `运行中 · 未读 ${diagnostics.tray.unread} · 关闭到托盘 ${
                      diagnostics.tray.settings.closeToTray ? '开' : '关'
                    }`
                  : diagnostics.tray.settings.enabled
                    ? '启用中（图标创建失败）'
                    : '已停用'}
              </dd>

              <dt>窗口安全基线</dt>
              <dd>
                sandbox={String(diagnostics.security.sandbox)} · contextIsolation=
                {String(diagnostics.security.contextIsolation)} · nodeIntegration=
                {String(diagnostics.security.nodeIntegration)} · webviewTag=
                {String(diagnostics.security.webviewTag)}
              </dd>
            </dl>
          ) : (
            <p className="hint">正在读取诊断信息…</p>
          )}
        </section>
          </div>
        </div>
      </div>

      {shortcutsOpen ? (
        <div
          className="overlay"
          role="presentation"
          onMouseDown={(mouseEvent) =>
            mouseEvent.target === mouseEvent.currentTarget && setShortcutsOpen(false)
          }
        >
          <div
            className="modal shortcuts-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="shortcuts-dialog-title"
          >
            <div className="modal-header">
              <h2 className="modal-title" id="shortcuts-dialog-title">
                快捷键
              </h2>
              <button type="button" className="btn" onClick={() => setShortcutsOpen(false)}>
                关闭
              </button>
            </div>
            <div className="modal-body shortcuts-dialog-body">
              <ShortcutsSettings
                embedded
                pluginBindings={pluginSnapshot?.keybindings ?? []}
                onChanged={() => {
                  window.dispatchEvent(new Event('mf:keybindings-changed'));
                }}
              />
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
