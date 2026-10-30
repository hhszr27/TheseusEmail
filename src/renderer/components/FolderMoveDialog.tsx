import { useState } from 'react';
import { t } from '../../shared/i18n';

interface FolderMoveDialogProps {
  folderName: string;
  /** 当前所在父路径（空表示根目录），用于预选。 */
  currentParent: string;
  /** 可选目标：空字符串代表根目录。 */
  candidates: Array<{ path: string; label: string }>;
  busy?: boolean;
  error?: string | null;
  onSubmit(targetParent: string): void;
  onClose(): void;
}

/** 移动文件夹：选一个父文件夹（不能选自己和自己的子目录，调用方已经过滤掉）。 */
export function FolderMoveDialog({
  folderName,
  currentParent,
  candidates,
  busy = false,
  error,
  onSubmit,
  onClose,
}: FolderMoveDialogProps): JSX.Element {
  const [target, setTarget] = useState(currentParent);

  return (
    <div className="overlay overlay-dialog" role="presentation" onClick={onClose}>
      <div
        className="dialog-card"
        role="dialog"
        aria-modal="true"
        aria-label={t('folder.move.title')}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <h3 className="dialog-title">{t('folder.move.titleWith', { name: folderName })}</h3>
        <p className="dialog-hint">{t('folder.move.hint')}</p>
        <select
          className="prompt-input"
          aria-label={t('folder.move.target')}
          value={target}
          onChange={(event) => setTarget(event.target.value)}
        >
          {candidates.map((candidate) => (
            <option key={candidate.path || '__root__'} value={candidate.path}>
              {candidate.label}
            </option>
          ))}
        </select>
        {error ? <p className="dialog-error">{error}</p> : null}
        <div className="dialog-actions">
          <button type="button" className="btn btn-sm" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={busy || target === currentParent}
            onClick={() => onSubmit(target)}
          >
            {busy ? t('common.saving') : t('folder.move.submit')}
          </button>
        </div>
      </div>
    </div>
  );
}
