import { useEffect, useMemo, useState } from 'react';
import type { PluginKeybinding } from '../../shared/plugin';
import {
  HOST_COMMANDS,
  bindingFromEvent,
  detectConflicts,
  formatBinding,
  mergeBindings,
  type BindingSpec,
} from '../../shared/keybindings';
import { KEYBINDINGS_SETTING_KEY } from '../../shared/theme';

interface ShortcutsSettingsProps {
  pluginBindings: PluginKeybinding[];
  onChanged(): void;
  /** 嵌在弹窗里时不渲染自己的 section 与标题。 */
  embedded?: boolean;
}

type Overrides = Record<string, BindingSpec | null>;

export function ShortcutsSettings({
  pluginBindings,
  onChanged,
  embedded = false,
}: ShortcutsSettingsProps): JSX.Element {
  const [overrides, setOverrides] = useState<Overrides>({});
  const [recording, setRecording] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.api.getSetting(KEYBINDINGS_SETTING_KEY).then((result) => {
      if (result.ok && result.data) {
        try {
          setOverrides(JSON.parse(result.data) as Overrides);
        } catch {
          setOverrides({});
        }
      }
    });
  }, []);

  useEffect(() => {
    if (!recording) return;

    const handler = (event: KeyboardEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        setRecording(null);
        return;
      }
      const binding = bindingFromEvent(event);
      if (!binding) return;
      const next = { ...overrides, [recording]: binding };
      setOverrides(next);
      setRecording(null);
      void save(next);
    };

    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, overrides]);

  const save = async (next: Overrides): Promise<void> => {
    const result = await window.api.setSetting(KEYBINDINGS_SETTING_KEY, JSON.stringify(next));
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setError(null);
    onChanged();
  };

  const defaults = HOST_COMMANDS.map((command) => ({
    command: command.id,
    binding: command.defaultKeybinding ?? null,
  }));
  const merged = useMemo(() => mergeBindings(
    defaults.map((entry) => ({
      command: entry.command,
      binding: entry.binding ?? { key: '' },
    })),
    overrides,
  ), [overrides]);

  const labelFor = (commandId: string): string =>
    HOST_COMMANDS.find((command) => command.id === commandId)?.label ?? commandId;

  const hostEntries = HOST_COMMANDS.map((command) => {
    const entry = merged.find((item) => item.command === command.id);
    return { command, binding: entry?.binding && entry.binding.key ? entry.binding : null };
  });

  const conflicts = useMemo(
    () =>
      detectConflicts([
        ...hostEntries
          .filter((entry) => entry.binding)
          .map((entry) => ({ command: entry.command.id, binding: entry.binding as BindingSpec })),
        ...pluginBindings.map((binding) => ({
          command: `插件 ${binding.pluginId}: ${binding.command}`,
          binding,
        })),
      ]),
    [hostEntries, pluginBindings],
  );

  const reset = (commandId: string): void => {
    const next = { ...overrides };
    delete next[commandId];
    setOverrides(next);
    void save(next);
  };

  const body = (
    <>
      {error ? <p className="hint">{error}</p> : null}

      <table className="shortcut-table">
        <thead>
          <tr>
            <th scope="col">命令</th>
            <th scope="col">快捷键</th>
            <th scope="col">操作</th>
          </tr>
        </thead>
        <tbody>
          {hostEntries.map(({ command, binding }) => (
            <tr key={command.id}>
              <td>{command.label}</td>
              <td>
                <code>{formatBinding(binding)}</code>
                {overrides[command.id] !== undefined ? <span className="hint"> · 已自定义</span> : null}
              </td>
              <td className="shortcut-actions">
                <button
                  type="button"
                  className="btn"
                  onClick={() => setRecording(command.id)}
                >
                  {recording === command.id ? '请按组合键…' : '录制'}
                </button>
                <button type="button" className="btn" onClick={() => reset(command.id)}>
                  重置
                </button>
              </td>
            </tr>
          ))}
          {pluginBindings.map((binding) => (
            <tr key={`${binding.pluginId}-${binding.command}`}>
              <td>
                插件 {binding.pluginId}
                <span className="hint"> · {binding.command}</span>
              </td>
              <td>
                <code>{formatBinding(binding)}</code>
              </td>
              <td className="hint">插件声明，只读</td>
            </tr>
          ))}
        </tbody>
      </table>

      {conflicts.length > 0 ? (
        <div className="error-banner" role="alert">
          <div>
            <strong>快捷键冲突</strong>
            <ul>
              {conflicts.map((conflict) => (
                <li key={conflict.signature}>
                  {conflict.signature}：{conflict.commands.map((id) => labelFor(id)).join(' / ')}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : (
        <p className="hint">未检测到冲突。插件声明的快捷键冲突会在此提示。</p>
      )}
    </>
  );

  if (embedded) return <div className="shortcuts-embedded">{body}</div>;

  return (
    <section className="settings-section">
      <h3 className="settings-title">快捷键</h3>
      {body}
    </section>
  );
}

