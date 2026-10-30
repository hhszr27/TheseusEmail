import { useEffect, useMemo, useState, type JSX } from 'react';
import {
  DEFAULT_RIBBON_CONFIG,
  RIBBON_WHEN_NAMES,
  deriveRibbonOverrides,
  mergeRibbonConfig,
  newCustomId,
  parseRibbonConfig,
  type RibbonConfig,
  type RibbonIconName,
  type RibbonOverrides,
  type RibbonTab,
  type RibbonTool,
  type RibbonWhen,
} from '../../shared/ribbon';
import { HOST_COMMANDS } from '../../shared/keybindings';
import type { PluginRibbonSource } from '../../shared/types';
import { t } from '../../shared/i18n';

/**
 * Ribbon 自定义编辑器。
 *
 * 交互模型：直接编辑一份「目标配置」（左侧标签页 / 右侧工具），
 * 保存时用 deriveRibbonOverrides 折算成最小增量落库——
 * 这样界面操作直观，又不会把内置默认整个快照进用户配置（升级才能流进来）。
 *
 * 隐藏语义：内置条目删不掉源码，但可以「隐藏」——从工具栏上消失，
 * 用户随时能在这里取消隐藏拿回来。自建条目则可以整条删除。
 */

export interface RibbonCustomizeDialogProps {
  /** 宿主自有配置（内置默认 + 用户覆盖），不含插件贡献。 */
  config: RibbonConfig;
  /** 用户已保存的增量覆盖；null 表示完全用内置默认。 */
  overrides: RibbonOverrides | null;
  /** 插件对工具栏的贡献（只读展示，不写入 overrides）。 */
  pluginContributions?: PluginRibbonSource[];
  onSave(overridesJson: string): void;
  onClose(): void;
}

/** 编辑器里可选的图标（与 ActionRibbon 的 ICONS 表一致）。 */
const ICON_CHOICES: RibbonIconName[] = [
  'compose',
  'reply',
  'replyAll',
  'forward',
  'trash',
  'archive',
  'move',
  'read',
  'star',
  'unified',
  'inbox',
  'sent',
  'drafts',
  'clock',
  'filter',
  'refresh',
  'ai',
  'command',
  'plugin',
  'settings',
  'power',
  'quickView',
  'layout',
];

const ICON_LABELS: Record<RibbonIconName, string> = {
  compose: t('ribbon.icon.compose'),
  reply: t('ribbon.icon.reply'),
  replyAll: t('ribbon.icon.replyAll'),
  forward: t('ribbon.icon.forward'),
  trash: t('ribbon.icon.trash'),
  archive: t('ribbon.icon.archive'),
  move: t('ribbon.icon.move'),
  read: t('ribbon.icon.read'),
  star: t('ribbon.icon.star'),
  unified: t('ribbon.icon.unified'),
  inbox: t('ribbon.icon.inbox'),
  sent: t('ribbon.icon.sent'),
  drafts: t('ribbon.icon.drafts'),
  clock: t('ribbon.icon.clock'),
  filter: t('ribbon.icon.filter'),
  refresh: t('ribbon.icon.refresh'),
  ai: t('ribbon.icon.ai'),
  command: t('ribbon.icon.command'),
  plugin: t('ribbon.icon.plugin'),
  settings: t('ribbon.icon.settings'),
  power: t('ribbon.icon.power'),
  quickView: t('ribbon.icon.quickView'),
  layout: t('ribbon.icon.layout'),
};

/** 可见性条件的中文说明；顺序与 RIBBON_WHEN_NAMES 对应。 */
const WHEN_LABELS: Record<RibbonWhen, string> = {
  always: t('ribbon.when.always'),
  mailSelected: t('ribbon.when.mailSelected'),
  selectedUnread: t('ribbon.when.selectedUnread'),
  selectedStarred: t('ribbon.when.selectedStarred'),
  hasAccounts: t('ribbon.when.hasAccounts'),
  unified: t('ribbon.when.unified'),
  listAll: t('ribbon.when.listAll'),
  listUnread: t('ribbon.when.listUnread'),
  listStarred: t('ribbon.when.listStarred'),
  viewSettings: t('ribbon.when.viewSettings'),
  readerShown: t('ribbon.when.readerShown'),
  vertical: t('ribbon.when.vertical'),
};

function cloneTab(tab: RibbonTab): RibbonTab {
  return {
    ...tab,
    tools: tab.tools.map((tool) => ({ ...tool, ...(tool.args ? { args: { ...tool.args } } : {}) })),
  };
}

/** 把某 id 在集合里切换。 */
function toggleIn(set: Set<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

function move<T>(list: T[], index: number, delta: number): T[] {
  const target = index + delta;
  if (index < 0 || target < 0 || target >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(index, 1);
  if (item === undefined) return list;
  next.splice(target, 0, item);
  return next;
}

export function RibbonCustomizeDialog({
  config,
  overrides,
  pluginContributions = [],
  onSave,
  onClose,
}: RibbonCustomizeDialogProps): JSX.Element {
  // 草稿 = 全部条目（含被隐藏的），隐藏状态单独放在集合里，
  // 这样用户能看到并恢复「被我隐藏掉的内置项」。
  const [draft, setDraft] = useState<RibbonConfig>(() => ({
    version: config.version,
    tabs: mergeRibbonConfig(DEFAULT_RIBBON_CONFIG, {
      version: config.version,
      ...(overrides ?? {}),
      hiddenTabs: [],
      hiddenTools: [],
    }).tabs.map(cloneTab),
  }));
  const [hiddenTabs, setHiddenTabs] = useState<Set<string>>(
    () => new Set(overrides?.hiddenTabs ?? []),
  );
  const [hiddenTools, setHiddenTools] = useState<Set<string>>(
    () => new Set(overrides?.hiddenTools ?? []),
  );
  /** 被单独关掉工具栏贡献的插件（不禁用插件本身）。 */
  const [hiddenPlugins, setHiddenPlugins] = useState<Set<string>>(
    () => new Set(overrides?.hiddenPlugins ?? []),
  );
  const [activeTabId, setActiveTabId] = useState<string>(
    () => mergeRibbonConfig(DEFAULT_RIBBON_CONFIG, overrides).tabs[0]?.id ?? 'mail',
  );
  const [notice, setNotice] = useState<string | null>(null);
  /** 导入面板：粘贴导出的 JSON 还原一份布局（Electron 没有 window.prompt）。 */
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  /** 正在重命名的标签页 id；Electron 没有 window.prompt，一律用内联输入框。 */
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  /** 正在改名的工具 id（内置工具也允许改名）。 */
  const [renamingToolId, setRenamingToolId] = useState<string | null>(null);
  const [toolRenameValue, setToolRenameValue] = useState('');

  // Esc 关闭对话框（点遮罩之外的第二条退出路径，键盘用户不该被困住）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const activeTab = draft.tabs.find((tab) => tab.id === activeTabId) ?? draft.tabs[0] ?? null;
  const commandOptions = useMemo(
    () => HOST_COMMANDS.map((command) => ({ id: command.id, label: command.label })),
    [],
  );

  const patchTab = (tabId: string, patch: (tab: RibbonTab) => RibbonTab): void => {
    setDraft((current) => ({
      ...current,
      tabs: current.tabs.map((tab) => (tab.id === tabId ? patch(tab) : tab)),
    }));
  };

  const addTab = (): void => {
    const id = newCustomId('tab');
    setDraft((current) => ({
      ...current,
      tabs: [...current.tabs, { id, label: t('ribbon.editor.newTabLabel'), origin: 'user', tools: [] }],
    }));
    setActiveTabId(id);
  };

  const removeTab = (tabId: string): void => {
    setDraft((current) => ({ ...current, tabs: current.tabs.filter((tab) => tab.id !== tabId) }));
    setHiddenTabs((current) => toggleIn(current, tabId));
    setActiveTabId((current) => (current === tabId ? (draft.tabs[0]?.id ?? 'mail') : current));
  };

  const addTool = (commandId: string): void => {
    if (!activeTab) return;
    const command = HOST_COMMANDS.find((item) => item.id === commandId);
    if (!command) return;
    const tool: RibbonTool = {
      id: newCustomId('tool'),
      commandId,
      label: command.label,
      icon: 'command',
      when: 'always',
      origin: 'user',
    };
    patchTab(activeTab.id, (tab) => ({ ...tab, tools: [...tab.tools, tool] }));
  };

  const save = (): void => {
    const visible = draft.tabs.filter((tab) => !hiddenTabs.has(tab.id));
    if (visible.length === 0) {
      setNotice(t('ribbon.editor.atLeastOne'));
      return;
    }
    const desired: RibbonConfig = {
      version: draft.version,
      tabs: visible.map((tab) => ({
        ...tab,
        tools: tab.tools.filter((tool) => !hiddenTools.has(tool.id)),
      })),
    };
    onSave(
      JSON.stringify({
        ...deriveRibbonOverrides(DEFAULT_RIBBON_CONFIG, desired),
        ...(hiddenPlugins.size > 0 ? { hiddenPlugins: [...hiddenPlugins] } : {}),
      }),
    );
  };

  const exportJson = (): void => {
    void navigator.clipboard
      ?.writeText(JSON.stringify(draft, null, 2))
      .then(() => setNotice(t('ribbon.editor.exported')))
      .catch(() => setNotice(t('ribbon.editor.exportFailed')));
  };

  const applyImport = (): void => {
    const parsed = parseRibbonConfig(importText);
    if (!parsed) {
      setImportError(t('ribbon.editor.importError'));
      return;
    }
    setDraft({ version: parsed.version, tabs: parsed.tabs.map(cloneTab) });
    // 导入的配置里可能自带隐藏/改名，统统以「当前可见」为准，避免出现看不见的条目
    setHiddenTabs(new Set());
    setHiddenTools(new Set());
    setActiveTabId(parsed.tabs[0]?.id ?? 'mail');
    setImportOpen(false);
    setImportText('');
    setImportError(null);
    setNotice(t('ribbon.editor.imported', { count: parsed.tabs.length }));
  };

  return (
    <div className="overlay overlay-dialog" role="presentation" onClick={onClose}>
      <div
        className="dialog-card ribbon-editor"
        role="dialog"
        aria-modal="true"
        aria-label={t('ribbon.editor.title')}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="ribbon-editor-head">
          <h2>{t('ribbon.editor.title')}</h2>
          <button type="button" className="link-button" onClick={onClose}>
            {t('ribbon.editor.close')}
          </button>
        </header>

        <p className="ribbon-editor-hint">{t('ribbon.editor.intro')}</p>

        {pluginContributions.length > 0 ? (
          <div className="ribbon-editor-plugins">
            <span className="ribbon-editor-plugins-title">{t('ribbon.editor.pluginsTitle')}</span>
            {pluginContributions.map((item) => {
              const shown = !hiddenPlugins.has(item.pluginId);
              return (
                <label key={item.pluginId} className="ribbon-editor-plugin-row">
                  <input
                    type="checkbox"
                    checked={shown}
                    aria-label={`${t('ribbon.editor.pluginShow')}：${item.pluginName}`}
                    onChange={() => setHiddenPlugins((current) => toggleIn(current, item.pluginId))}
                  />
                  <span className="ribbon-editor-plugin-name">{item.pluginName}</span>
                  <span className="ribbon-editor-plugin-meta">
                    {item.tabs.length} / {item.tools.length}
                  </span>
                </label>
              );
            })}
            <p className="ribbon-editor-plugin-note">{t('ribbon.editor.pluginsHint')}</p>
          </div>
        ) : null}

        <div className="ribbon-editor-body">
          <section className="ribbon-editor-tabs" aria-label={t('ribbon.editor.tabsAria')}>
            {draft.tabs.map((tab, index) => {
              const isHidden = hiddenTabs.has(tab.id);
              return (
                <div
                  key={tab.id}
                  className={`ribbon-editor-tab${tab.id === activeTabId ? ' is-active' : ''}${
                    isHidden ? ' is-hidden' : ''
                  }`}
                >
                  <button
                    type="button"
                    className="ribbon-editor-tab-name"
                    onClick={() => setActiveTabId(tab.id)}
                  >
                    {tab.label}
                    {tab.origin === 'user' ? <span className="ribbon-editor-badge">{t('ribbon.editor.badgeUser')}</span> : null}
                    {isHidden ? <span className="ribbon-editor-badge">{t('ribbon.editor.badgeHidden')}</span> : null}
                  </button>
                  <span className="ribbon-editor-tab-actions">
                    <button
                      type="button"
                      title={isHidden ? t('ribbon.editor.show') : t('ribbon.editor.hide')}
                      aria-label={`${isHidden ? t('ribbon.editor.show') : t('ribbon.editor.hide')} ${tab.label}`}
                      onClick={() => setHiddenTabs((current) => toggleIn(current, tab.id))}
                    >
                      {isHidden ? '◌' : '◉'}
                    </button>
                    <button
                      type="button"
                      title={t('ribbon.editor.moveUp')}
                      aria-label={`${t('ribbon.editor.moveUp')} ${tab.label}`}
                      disabled={index === 0}
                      onClick={() =>
                        setDraft((current) => ({ ...current, tabs: move(current.tabs, index, -1) }))
                      }
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      title={t('ribbon.editor.moveDown')}
                      aria-label={`${t('ribbon.editor.moveDown')} ${tab.label}`}
                      disabled={index === draft.tabs.length - 1}
                      onClick={() =>
                        setDraft((current) => ({ ...current, tabs: move(current.tabs, index, 1) }))
                      }
                    >
                      ↓
                    </button>
                    {renamingTabId === tab.id ? (
                      <span className="ribbon-editor-rename">
                        <input
                          autoFocus
                          value={renameValue}
                          aria-label={t('ribbon.editor.renameTabInput')}
                          onChange={(event) => setRenameValue(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              const value = renameValue.trim();
                              if (value) patchTab(tab.id, (item) => ({ ...item, label: value }));
                              setRenamingTabId(null);
                            }
                            if (event.key === 'Escape') setRenamingTabId(null);
                          }}
                        />
                        <button
                          type="button"
                          title={t('ribbon.editor.confirmRename')}
                          onClick={() => {
                            const value = renameValue.trim();
                            if (value) patchTab(tab.id, (item) => ({ ...item, label: value }));
                            setRenamingTabId(null);
                          }}
                        >
                          ✓
                        </button>
                        <button type="button" title={t('ribbon.editor.cancel')} onClick={() => setRenamingTabId(null)}>
                          ×
                        </button>
                      </span>
                    ) : (
                      <>
                        <button
                          type="button"
                          title={t('ribbon.editor.rename')}
                          aria-label={`${t('ribbon.editor.rename')} ${tab.label}`}
                          onClick={() => {
                            setRenamingTabId(tab.id);
                            setRenameValue(tab.label);
                          }}
                        >
                          ✎
                        </button>
                        {tab.origin === 'user' ? (
                          <button
                            type="button"
                            title={t('ribbon.editor.deleteTab')}
                            aria-label={`${t('ribbon.editor.deleteTab')} · ${tab.label}`}
                            onClick={() => removeTab(tab.id)}
                          >
                            ×
                          </button>
                        ) : null}
                      </>
                    )}
                  </span>
                </div>
              );
            })}
            <button type="button" className="ribbon-editor-add" onClick={addTab}>
              {t('ribbon.editor.newTab')}
            </button>
          </section>

          <section className="ribbon-editor-tools" aria-label={t('ribbon.editor.toolsAria')}>
            {activeTab ? (
              <>
                {activeTab.tools.length === 0 ? (
                  <p className="ribbon-editor-empty">{t('ribbon.editor.emptyTools')}</p>
                ) : (
                  activeTab.tools.map((tool, index) => {
                    const isHidden = hiddenTools.has(tool.id);
                    return (
                      <div
                        key={tool.id}
                        className={`ribbon-editor-tool${isHidden ? ' is-hidden' : ''}`}
                      >
                        {renamingToolId === tool.id ? (
                          <span className="ribbon-editor-rename">
                            <input
                              autoFocus
                              value={toolRenameValue}
                              aria-label={t('ribbon.editor.renameToolInput', { name: tool.label })}
                              onChange={(event) => setToolRenameValue(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                  const value = toolRenameValue.trim();
                                  if (value) {
                                    patchTab(activeTab.id, (tab) => ({
                                      ...tab,
                                      tools: tab.tools.map((item) =>
                                        item.id === tool.id ? { ...item, label: value } : item,
                                      ),
                                    }));
                                  }
                                  setRenamingToolId(null);
                                }
                                if (event.key === 'Escape') setRenamingToolId(null);
                              }}
                            />
                            <button
                              type="button"
                              title={t('ribbon.editor.confirmRename')}
                              onClick={() => {
                                const value = toolRenameValue.trim();
                                if (value) {
                                  patchTab(activeTab.id, (tab) => ({
                                    ...tab,
                                    tools: tab.tools.map((item) =>
                                      item.id === tool.id ? { ...item, label: value } : item,
                                    ),
                                  }));
                                }
                                setRenamingToolId(null);
                              }}
                            >
                              ✓
                            </button>
                            <button type="button" title={t('ribbon.editor.cancel')} onClick={() => setRenamingToolId(null)}>
                              ×
                            </button>
                          </span>
                        ) : (
                          <span className="ribbon-editor-tool-label">{tool.label}</span>
                        )}
                        <span className="ribbon-editor-tool-cmd">{tool.commandId}</span>
                        <span className="ribbon-editor-tool-actions">
                          <button
                            type="button"
                            title={isHidden ? t('ribbon.editor.show') : t('ribbon.editor.hide')}
                            aria-label={`${isHidden ? t('ribbon.editor.show') : t('ribbon.editor.hide')} ${tool.label}`}
                            onClick={() => setHiddenTools((current) => toggleIn(current, tool.id))}
                          >
                            {isHidden ? '◌' : '◉'}
                          </button>
                          <button
                            type="button"
                            title={t('ribbon.editor.moveUp')}
                            aria-label={`上移 ${tool.label}`}
                            disabled={index === 0}
                            onClick={() =>
                              patchTab(activeTab.id, (tab) => ({
                                ...tab,
                                tools: move(tab.tools, index, -1),
                              }))
                            }
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            title={t('ribbon.editor.moveDown')}
                            aria-label={`下移 ${tool.label}`}
                            disabled={index === activeTab.tools.length - 1}
                            onClick={() =>
                              patchTab(activeTab.id, (tab) => ({
                                ...tab,
                                tools: move(tab.tools, index, 1),
                              }))
                            }
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            title={t('ribbon.editor.rename')}
                            aria-label={`${t('ribbon.editor.renameTool')} ${tool.label}`}
                            onClick={() => {
                              setRenamingToolId(tool.id);
                              setToolRenameValue(tool.label);
                            }}
                          >
                            ✎
                          </button>
                          {tool.origin === 'user' ? (
                            <button
                              type="button"
                              title={t('ribbon.editor.deleteTool')}
                              aria-label={`${t('ribbon.editor.deleteTool')} · ${tool.label}`}
                              onClick={() =>
                                patchTab(activeTab.id, (tab) => ({
                                  ...tab,
                                  tools: tab.tools.filter((item) => item.id !== tool.id),
                                }))
                              }
                            >
                              ×
                            </button>
                          ) : (
                            <span className="ribbon-editor-badge">{t('ribbon.editor.badgeBuiltin')}</span>
                          )}
                        </span>
                      </div>
                    );
                  })
                )}

                <div className="ribbon-editor-add-tool">
                  <label htmlFor="ribbon-add-command">{t('ribbon.editor.addTool')}</label>
                  <select
                    id="ribbon-add-command"
                    defaultValue=""
                    onChange={(event) => {
                      if (event.target.value) addTool(event.target.value);
                      event.target.value = '';
                    }}
                  >
                    <option value="">{t('ribbon.editor.pickCommand')}</option>
                    {commandOptions.map((command) => (
                      <option key={command.id} value={command.id}>
                        {command.label}（{command.id}）
                      </option>
                    ))}
                  </select>
                </div>

                {activeTab.tools.some((tool) => tool.origin === 'user') ? (
                  <div className="ribbon-editor-icon-picker">
                    <span>{t('ribbon.editor.properties')}</span>
                    {activeTab.tools
                      .filter((tool) => tool.origin === 'user')
                      .map((tool) => (
                        <span key={tool.id} className="ribbon-editor-icon-row">
                          <span className="ribbon-editor-icon-name">{tool.label}</span>
                          <label>
                            {t('ribbon.editor.icon')}
                            <select
                              value={tool.icon}
                              aria-label={t('ribbon.editor.iconAria', { name: tool.label })}
                              onChange={(event) =>
                                patchTab(activeTab.id, (tab) => ({
                                  ...tab,
                                  tools: tab.tools.map((item) =>
                                    item.id === tool.id
                                      ? { ...item, icon: event.target.value as RibbonIconName }
                                      : item,
                                  ),
                                }))
                              }
                            >
                              {ICON_CHOICES.map((icon) => (
                                <option key={icon} value={icon}>
                                  {ICON_LABELS[icon]}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            {t('ribbon.editor.visible')}
                            <select
                              value={tool.when}
                              aria-label={t('ribbon.editor.whenAria', { name: tool.label })}
                              onChange={(event) =>
                                patchTab(activeTab.id, (tab) => ({
                                  ...tab,
                                  tools: tab.tools.map((item) =>
                                    item.id === tool.id
                                      ? { ...item, when: event.target.value as RibbonWhen }
                                      : item,
                                  ),
                                }))
                              }
                            >
                              {RIBBON_WHEN_NAMES.map((when) => (
                                <option key={when} value={when}>
                                  {WHEN_LABELS[when]}
                                </option>
                              ))}
                            </select>
                          </label>
                        </span>
                      ))}
                  </div>
                ) : null}
              </>
            ) : null}
          </section>
        </div>

        {importOpen ? (
          <div className="ribbon-editor-import">
            <label htmlFor="ribbon-import-text">{t('ribbon.editor.importTitle')}</label>
            <textarea
              id="ribbon-import-text"
              value={importText}
              rows={5}
              spellCheck={false}
              placeholder='{"tabs":[{"id":"mail","label":"邮件","origin":"builtin","tools":[]}]}'
              onChange={(event) => {
                setImportText(event.target.value);
                setImportError(null);
              }}
            />
            {importError ? (
              <p className="ribbon-editor-import-error" role="alert">
                {importError}
              </p>
            ) : null}
            <div className="ribbon-editor-import-actions">
              <button type="button" className="btn" onClick={applyImport}>
                {t('ribbon.editor.importApply')}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setImportOpen(false);
                  setImportText('');
                  setImportError(null);
                }}
              >
                {t('ribbon.editor.importCancel')}
              </button>
            </div>
          </div>
        ) : null}

        {notice ? (
          <p className="ribbon-editor-notice" role="status">
            {notice}
          </p>
        ) : null}

        <footer className="dialog-actions">
          <button type="button" className="btn" onClick={exportJson}>
            {t('ribbon.editor.export')}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setImportOpen((open) => !open);
              setImportError(null);
            }}
            aria-expanded={importOpen}
          >
            {t('ribbon.editor.import')}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setDraft({ version: config.version, tabs: DEFAULT_RIBBON_CONFIG.tabs.map(cloneTab) });
              setHiddenTabs(new Set());
              setHiddenTools(new Set());
              setHiddenPlugins(new Set());
              setNotice(t('ribbon.editor.resetNotice'));
            }}
          >
            {t('ribbon.editor.reset')}
          </button>
          <span className="dialog-actions-spacer" />
          <button type="button" className="btn" onClick={onClose}>
            {t('ribbon.editor.cancel')}
          </button>
          <button type="button" className="btn btn-primary" onClick={save}>
            {t('ribbon.editor.save')}
          </button>
        </footer>
      </div>
    </div>
  );
}
