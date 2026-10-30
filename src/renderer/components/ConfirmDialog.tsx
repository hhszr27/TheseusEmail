import { useEffect, useRef } from 'react';
import { t } from '../../shared/i18n';

interface ConfirmDialogProps {
  title: string;
  message: string;
  /** 补充说明（例如「其中 32 封邮件会一起从本机移除」）。 */
  hint?: string;
  confirmLabel: string;
  /** 危险操作：确认按钮用警示色，默认焦点给「取消」。 */
  danger?: boolean;
  busy?: boolean;
  error?: string | null;
  onConfirm(): void;
  onClose(): void;
}

/** 通用二次确认弹窗（删除文件夹等不可撤销操作）。 */
export function ConfirmDialog({
  title,
  message,
  hint,
  confirmLabel,
  danger = false,
  busy = false,
  error,
  onConfirm,
  onClose,
}: ConfirmDialogProps): JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // 危险操作默认把焦点放在「取消」上，避免回车误触
    (danger ? cancelRef.current : confirmRef.current)?.focus();
  }, [danger]);

  return (
    <div className="overlay overlay-dialog" role="presentation" onClick={onClose}>
      <div
        className="dialog-card"
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
        <p className="dialog-message">{message}</p>
        {hint ? <p className="dialog-hint">{hint}</p> : null}
        {error ? <p className="dialog-error">{error}</p> : null}
        <div className="dialog-actions">
          <button ref={cancelRef} type="button" className="btn btn-sm" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={`btn btn-sm${danger ? ' btn-danger' : ' btn-primary'}`}
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? t('common.saving') : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
