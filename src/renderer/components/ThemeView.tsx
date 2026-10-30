import { BUILTIN_THEMES } from '../../shared/plugin';
import { useMailStore } from '../stores/mail-store';

export function ThemeView(): JSX.Element {
  const themeId = useMailStore((state) => state.themeId);
  const applyTheme = useMailStore((state) => state.applyTheme);
  const setView = useMailStore((state) => state.setView);
  const themes = useMailStore((state) => state.pluginSnapshot?.themes ?? BUILTIN_THEMES);

  return (
    <section className="main-view" aria-label="主题">
      <header className="view-header">
        <div>
          <h1 className="view-title">主题</h1>
          <p className="hint">切换即时生效，无需重启。插件主题若含 @import 或远程 url() 会被拒绝。</p>
        </div>
        <button type="button" className="btn" onClick={() => setView('mail')}>
          返回邮件
        </button>
      </header>

      <div className="theme-grid">
        {themes.map((theme) => {
          const active = theme.id === themeId;
          // 抬升层级（§美化）：默认轻阴影，选中卡片抬到二级阴影并轻微上浮；
          // 选中态原有的强调描边（inset 环）手动并入，避免被内联 box-shadow 覆盖丢失。
          const elevation = active ? 'var(--mf-shadow-2)' : 'var(--mf-shadow-1)';
          const ring = active ? '0 0 0 1px var(--mf-color-accent) inset' : '';
          return (
            <button
              type="button"
              key={theme.id}
              className={`theme-card${active ? ' theme-card-active' : ''}`}
              aria-pressed={active}
              onClick={() => void applyTheme(theme.id)}
              style={{
                boxShadow: ring ? `${elevation}, ${ring}` : elevation,
                transform: active ? 'translateY(-2px)' : 'none',
                transition: 'box-shadow var(--mf-motion), transform var(--mf-motion)',
              }}
            >
              <span
                className={`theme-preview${
                  theme.id === 'builtin:light' ? ' theme-preview-light' : ''
                }`}
                aria-hidden="true"
              >
                <span className="theme-preview-bar" />
                <span className="theme-preview-line" />
                <span className="theme-preview-line theme-preview-line-short" />
              </span>
              <span className="theme-card-text">
                <strong>{theme.name}</strong>
                <span className="hint">
                  {theme.pluginId ? `插件 · ${theme.pluginId}` : '内置主题'}
                  {active ? ' · 使用中' : ''}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
