import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { MenuRegion, PluginPermission, PluginRibbonSource, SlotName } from '../../shared/types';
import {
  BUILTIN_THEMES,
  manifestToRuntime,
  type PluginCommand,
  type PluginKeybinding,
  type PluginRegistrySnapshot,
  type PluginRuleAction,
  type PluginViewSession,
  type ThemeEntry,
} from '../../shared/plugin';
import { log } from '../observability/logger';
import { recordMetric } from '../observability/metrics';
import { loadPlugins, type LoadedPlugin, type PluginDirectory } from './registry';
import { validateThemeCss } from './theme-css';
import { sanitizePluginSvg, svgToDataUrl } from './svg';
import { pluginAssetUrl } from './protocol';
import { isPluginEnabledForAccount, type AccountOverrides } from './access';
import { collectMenuItems, type MenuContext, type MenuItemDescriptor } from './menu-registry';
import type { DraftContextSnapshot } from './draft';

/**
 * 插件服务：注册表快照、主题/图标读取、视图会话、热重载（§13）。
 */

export interface ActiveEmailContext {
  id: string;
  subject: string;
  from: { name?: string; address: string }[];
  body: string;
  text: string;
  hasAttachments: boolean;
  attachments?: Array<{
    id: string;
    filename: string;
    mimeType: string;
    size: number;
    ext: string;
    riskLevel: string;
  }>;
}

export interface PluginServiceOptions {
  userDataDir: string;
  appPath: string;
  isDev: boolean;
  publicKeys?: Record<string, string>;
  disabledIds?: string[];
  onChange?: () => void;
}

export interface ThemeCssResult {
  ok: boolean;
  css?: string;
  reason?: string;
}

export class PluginService {
  private plugins = new Map<string, LoadedPlugin>();
  private warnings: string[] = [];
  private activeEmail: ActiveEmailContext | null = null;
  private draftContext: DraftContextSnapshot | null = null;
  private accountOverrides = new Map<string, AccountOverrides>();
  private readonly iconCache = new Map<string, string>();
  private readonly themeCache = new Map<string, string>();
  private watchers: fs.FSWatcher[] = [];
  private reloadTimer: NodeJS.Timeout | null = null;
  private readonly preloadUrl: string;

  constructor(private readonly options: PluginServiceOptions) {
    this.preloadUrl = pathToFileURL(
      path.join(__dirname, '../preload/plugin-view.js'),
    ).toString();
  }

  async init(): Promise<void> {
    await this.scan();
    this.watch();
  }

  private directories(): PluginDirectory[] {
    const dirs: PluginDirectory[] = [
      { path: path.join(this.options.userDataDir, 'plugins'), source: 'user' },
    ];
    if (this.options.isDev) {
      dirs.push({ path: path.join(this.options.appPath, 'plugins'), source: 'dev' });
    }
    return dirs;
  }

  private async scan(): Promise<void> {
    const started = Date.now();
    const result = await loadPlugins({
      dirs: this.directories(),
      publicKeys: this.options.publicKeys,
      disabledIds: this.options.disabledIds,
      onWarning: (message) => log.warn('plugin', message),
    });

    this.plugins = new Map(result.plugins.map((plugin) => [plugin.manifest.id, plugin]));
    this.warnings = result.warnings;
    this.iconCache.clear();
    this.themeCache.clear();

    let ready = 0;
    for (const plugin of result.plugins) {
      recordMetric('plugin_init', {
        pluginId: plugin.manifest.id,
        status: plugin.status,
        signature: plugin.signature,
        source: plugin.source,
      });
      if (plugin.status === 'ready') ready += 1;
      if (plugin.status !== 'ready') {
        log.warn('plugin', '插件未加载', {
          pluginId: plugin.manifest.id,
          status: plugin.status,
          error: plugin.error,
        });
      }
    }

    log.info('plugin', '插件扫描完成', {
      total: result.plugins.length,
      ready,
      warnings: result.warnings.length,
      durationMs: Date.now() - started,
    });
  }

  private watch(): void {
    if (!this.options.isDev) return;
    for (const directory of this.directories()) {
      try {
        const watcher = fs.watch(directory.path, { recursive: true }, () => {
          if (this.reloadTimer) clearTimeout(this.reloadTimer);
          this.reloadTimer = setTimeout(() => {
            void this.reload();
          }, 400);
        });
        watcher.on('error', () => {
          // 目录可能不存在，忽略
        });
        this.watchers.push(watcher);
      } catch {
        // 目录不存在
      }
    }
  }

  private async reload(): Promise<void> {
    log.info('plugin', '检测到插件目录变化，重新加载');
    await this.scan();
    this.options.onChange?.();
  }

  dispose(): void {
    for (const watcher of this.watchers) {
      try {
        watcher.close();
      } catch {
        // ignore
      }
    }
    this.watchers = [];
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
  }

  getPlugin(pluginId: string): LoadedPlugin | null {
    return this.plugins.get(pluginId) ?? null;
  }

  isReady(pluginId: string): boolean {
    const plugin = this.plugins.get(pluginId);
    return Boolean(plugin && plugin.status === 'ready' && plugin.enabled);
  }

  snapshot(): PluginRegistrySnapshot {
    const active = [...this.plugins.values()];
    const themes: ThemeEntry[] = [...BUILTIN_THEMES];
    const commands: PluginCommand[] = [];
    const keybindings: PluginKeybinding[] = [];
    const ruleActions: PluginRuleAction[] = [];
    const ribbon: PluginRibbonSource[] = [];

    for (const plugin of active) {
      const contributes = plugin.manifest.contributes;
      if (plugin.status === 'ready' && plugin.enabled && contributes?.theme) {
        themes.push({
          id: plugin.manifest.id,
          name: plugin.manifest.name,
          pluginId: plugin.manifest.id,
          builtin: false,
        });
      }
      if (!plugin.enabled || plugin.status !== 'ready') continue;

      for (const command of contributes?.commands ?? []) {
        commands.push({ ...command, pluginId: plugin.manifest.id });
      }
      for (const binding of contributes?.keybindings ?? []) {
        keybindings.push({ ...binding, pluginId: plugin.manifest.id });
      }
      for (const action of contributes?.ruleActions ?? []) {
        ruleActions.push({ ...action, pluginId: plugin.manifest.id });
      }
      if (contributes?.ribbon) {
        ribbon.push({
          pluginId: plugin.manifest.id,
          pluginName: plugin.manifest.name,
          tabs: contributes.ribbon.tabs ?? [],
          tools: contributes.ribbon.tools ?? [],
        });
      }
    }

    return {
      plugins: active.map((plugin) =>
        manifestToRuntime(plugin.manifest, {
          status: plugin.status,
          enabled: plugin.enabled,
          signature: plugin.signature,
          source: plugin.source,
          ...(plugin.error ? { error: plugin.error } : {}),
          ...(Object.keys(this.accountOverridesFor(plugin.manifest.id)).length > 0
            ? { accountOverrides: this.accountOverridesFor(plugin.manifest.id) }
            : {}),
        }),
      ),
      themes,
      commands,
      keybindings,
      ruleActions,
      ribbon,
      warnings: this.warnings,
    };
  }

  setAccountOverrides(overrides: Map<string, AccountOverrides>): void {
    this.accountOverrides = overrides;
  }

  accountOverridesFor(pluginId: string): AccountOverrides {
    return this.accountOverrides.get(pluginId) ?? {};
  }

  /** 插件在该账户上下文是否生效（账户级禁用只影响上下文，不影响全局能力）。 */
  isEnabledForAccount(pluginId: string, accountId: string | null | undefined): boolean {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return false;
    return isPluginEnabledForAccount(plugin.enabled, this.accountOverridesFor(pluginId), accountId);
  }

  setDraftContext(context: DraftContextSnapshot | null): void {
    this.draftContext = context;
  }

  getDraftContext(): DraftContextSnapshot | null {
    return this.draftContext;
  }

  setEnabled(pluginId: string, enabled: boolean): boolean {
    const plugin = this.plugins.get(pluginId);
    if (!plugin || plugin.status !== 'ready') return false;
    plugin.enabled = enabled;
    return true;
  }

  setActiveEmail(email: ActiveEmailContext | null): void {
    this.activeEmail = email;
  }

  getActiveEmail(): ActiveEmailContext | null {
    return this.activeEmail;
  }

  readerViewPlugin(accountId?: string | null): string | null {
    for (const plugin of this.plugins.values()) {
      if (plugin.status !== 'ready' || !plugin.enabled) continue;
      if (!plugin.manifest.contributes?.readerView) continue;
      if (accountId !== undefined && !this.isEnabledForAccount(plugin.manifest.id, accountId)) {
        continue;
      }
      return plugin.manifest.id;
    }
    return null;
  }

  /** 撰写窗口整体接管（§13.3）：与 reader-view 同规则，一次只生效一个。 */
  composeViewPlugin(accountId?: string | null): string | null {
    for (const plugin of this.plugins.values()) {
      if (plugin.status !== 'ready' || !plugin.enabled) continue;
      if (!plugin.manifest.contributes?.composeView) continue;
      if (accountId !== undefined && !this.isEnabledForAccount(plugin.manifest.id, accountId)) {
        continue;
      }
      return plugin.manifest.id;
    }
    return null;
  }

  injectionPlugins(slot: SlotName, accountId?: string | null): string[] {
    const result: string[] = [];
    for (const plugin of this.plugins.values()) {
      if (plugin.status !== 'ready' || !plugin.enabled) continue;
      if (!plugin.manifest.contributes?.views?.[slot]) continue;
      if (accountId !== undefined && !this.isEnabledForAccount(plugin.manifest.id, accountId)) {
        continue;
      }
      result.push(plugin.manifest.id);
    }
    return result;
  }

  /** 某个菜单区域应显示的插件项（§13.3.1）；when 在宿主求值。 */
  menuItems(
    region: MenuRegion,
    context: MenuContext,
    accountId: string | null,
    revoked: Map<string, Set<PluginPermission>>,
  ): MenuItemDescriptor[] {
    const sources = [...this.plugins.values()]
      .filter((plugin) => plugin.status === 'ready' && plugin.enabled)
      .map((plugin) => ({
        id: plugin.manifest.id,
        name: plugin.manifest.name,
        enabled: plugin.enabled,
        permissions: plugin.manifest.permissions ?? [],
        commands: plugin.manifest.contributes?.commands ?? [],
      }));

    return collectMenuItems(sources, region, {
      accountId,
      overrides: this.accountOverrides,
      revoked,
      context,
    });
  }

  getViewSession(pluginId: string, slot: SlotName, accountId?: string | null): PluginViewSession | null {
    const plugin = this.plugins.get(pluginId);
    if (!plugin || plugin.status !== 'ready' || !plugin.enabled) return null;
    if (accountId !== undefined && !this.isEnabledForAccount(pluginId, accountId)) return null;

    const contributes = plugin.manifest.contributes;
    const relative =
      slot === 'reader-view'
        ? contributes?.readerView
        : slot === 'compose-view'
          ? contributes?.composeView
          : contributes?.views?.[slot];
    if (!relative) return null;

    return {
      pluginId,
      slot,
      url: pluginAssetUrl(pluginId, relative),
      partition: `persist:plugin-${pluginId}`,
      preloadUrl: this.preloadUrl,
    };
  }

  async getThemeCss(themeId: string): Promise<ThemeCssResult> {
    if (themeId.startsWith('builtin:')) {
      return { ok: true, css: '' };
    }
    const cached = this.themeCache.get(themeId);
    if (cached !== undefined) return { ok: true, css: cached };

    const plugin = this.plugins.get(themeId);
    const relative = plugin?.manifest.contributes?.theme;
    if (!plugin || plugin.status !== 'ready' || !plugin.enabled || !relative) {
      return { ok: false, reason: '主题插件不存在或已禁用' };
    }

    try {
      const css = await fsp.readFile(path.join(plugin.dir, relative), 'utf8');
      const validation = validateThemeCss(css);
      if (!validation.ok) {
        log.warn('plugin', '主题 CSS 被拒绝', { pluginId: themeId, reason: validation.reason });
        return { ok: false, reason: validation.reason ?? 'CSS 安全检查失败' };
      }
      this.themeCache.set(themeId, css);
      return { ok: true, css };
    } catch (error) {
      return { ok: false, reason: (error as Error).message };
    }
  }

  async getIcon(pluginId: string, name: string): Promise<string | null> {
    const key = `${pluginId}:${name}`;
    const cached = this.iconCache.get(key);
    if (cached !== undefined) return cached;

    const plugin = this.plugins.get(pluginId);
    const relative = plugin?.manifest.contributes?.icons?.[name];
    if (!plugin || plugin.status !== 'ready' || !plugin.enabled || !relative) return null;

    try {
      const raw = await fsp.readFile(path.join(plugin.dir, relative), 'utf8');
      const sanitized = sanitizePluginSvg(raw);
      if (!sanitized.ok) {
        log.warn('plugin', '图标 SVG 被拒绝', { pluginId, name, reason: sanitized.reason });
        return null;
      }
      const dataUrl = svgToDataUrl(sanitized.svg);
      this.iconCache.set(key, dataUrl);
      return dataUrl;
    } catch {
      return null;
    }
  }

  pluginDirForProtocol(pluginId: string): string | null {
    const plugin = this.plugins.get(pluginId);
    if (!plugin || plugin.status !== 'ready' || !plugin.enabled) return null;
    return plugin.dir;
  }

  permissionsFor(pluginId: string): PluginPermission[] {
    return this.plugins.get(pluginId)?.manifest.permissions ?? [];
  }
}
