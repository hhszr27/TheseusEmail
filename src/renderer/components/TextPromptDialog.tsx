import { useEffect, useRef, useState } from 'react';
import { t } from '../../shared/i18n';

interface TextPromptDialogProps {
  title: string;
  /** 标题下的一行说明（例如「将创建在「其他文件夹」下」）。 */
  hint?: string;
  placeholder: string;
  confirmLabel: string;
  /** 预填值（重命名时用当前名字）。 */
  initialValue?: string;
  busy?: boolean;
  error?: string | null;
  onSubmit(value: string): void;
  onClose(): void;
}

/** 单行文本输入弹窗（Electron 里没有可用的 window.prompt，只能自绘）。 */
export function TextPromptDialog({
  title,
  hint,
  placeholder,
  confirmLabel,
  initialValue = '',
  busy = false,
  error,
  onSubmit,
  onClose,
}: TextPromptDialogProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = (): void => {
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    onSubmit(trimmed);
  };

  return (
    <div className="overlay" role="presentation" onClick={onClose}>
      <div
        className="dialog-card prompt-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <h3 className="dialog-title">{title}</h3>
        {hint ? <p className="dialog-hint">{hint}</p> : null}
        <input
          ref={inputRef}
          className="prompt-input"
          type="text"
          value={value}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submit();
            }
          }}
        />
        {error ? <p className="dialog-error">{error}</p> : null}
        <div className="dialog-actions">
          <button type="button" className="btn btn-sm" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn-sm primary"
            disabled={!value.trim() || busy}
            onClick={submit}
          >
            {busy ? t('common.saving') : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
