import { useEffect, useMemo, useRef, useState } from 'react';

export type PaletteGroup = 'common' | 'jump' | 'plugin';

export interface PaletteCommand {
  id: string;
  label: string;
  description?: string;
  source?: 'host' | 'plugin';
  group?: PaletteGroup;
  icon?: string;
  run(): void;
}

const GROUP_LABEL: Record<PaletteGroup, string> = {
  common: '常用',
  jump: '跳转',
  plugin: '插件命令',
};

const GROUP_ORDER: PaletteGroup[] = ['common', 'jump', 'plugin'];

interface CommandPaletteProps {
  open: boolean;
  commands: PaletteCommand[];
  onClose(): void;
}

/** 命令面板（§21.3）：Ctrl/Cmd+K 打开，方向键选择，Enter 执行。 */
export function CommandPalette({ open, commands, onClose }: CommandPaletteProps): JSX.Element | null {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matched = !needle
      ? commands
      : commands.filter((command) => {
          const haystack = `${command.label} ${command.description ?? ''} ${command.id}`.toLowerCase();
          return needle.split(/\s+/).every((token) => haystack.includes(token));
        });

    // 按区域分组后展平，保留组内原有顺序（§21.3）
    const ordered: PaletteCommand[] = [];
    for (const group of GROUP_ORDER) {
      ordered.push(...matched.filter((command) => (command.group ?? 'common') === group));
    }
    return ordered;
  }, [commands, query]);

  useEffect(() => {
    if (activeIndex >= filtered.length) setActiveIndex(0);
  }, [filtered.length, activeIndex]);

  if (!open) return null;

  const runAt = (index: number): void => {
    const command = filtered[index];
    if (!command) return;
    onClose();
    command.run();
  };

  return (
    <div className="overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="命令面板">
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="输入命令或文件夹名称…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              onClose();
              return;
            }
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActiveIndex((index) => Math.min(index + 1, Math.max(0, filtered.length - 1)));
              return;
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActiveIndex((index) => Math.max(index - 1, 0));
              return;
            }
            if (event.key === 'Enter') {
              event.preventDefault();
              runAt(activeIndex);
            }
          }}
        />

        <ul className="palette-list" role="listbox" aria-label="命令列表">
          {filtered.map((command, index) => {
            const group = command.group ?? 'common';
            const previous = filtered[index - 1];
            const showGroup = !previous || (previous.group ?? 'common') !== group;
            return (
              <li key={command.id} className="palette-row" role="presentation">
                {showGroup ? (
                  <div className="palette-section" role="presentation">
                    {GROUP_LABEL[group]}
                  </div>
                ) : null}
                <div
                  role="option"
                  aria-selected={index === activeIndex}
                  className="palette-item"
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => runAt(index)}
                >
                  <span className="cmd-icon" aria-hidden="true">
                    {command.icon ?? (command.source === 'plugin' ? '🧩' : '›')}
                  </span>
                  <span className="palette-label">{command.label}</span>
                  {command.description ? (
                    <span className="palette-description">{command.description}</span>
                  ) : null}
                  {command.source === 'plugin' ? <span className="palette-badge">插件</span> : null}
                </div>
              </li>
            );
          })}
          {filtered.length === 0 ? (
            <li className="palette-empty" role="presentation">
              没有匹配的命令
            </li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}
