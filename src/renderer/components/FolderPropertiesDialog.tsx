import { useEffect, useState } from 'react';
import type { FolderDetails } from '../../shared/ipc';
import { SPECIAL_USE_LABELS } from '../../shared/constants';
import type { SpecialUse } from '../../shared/types';
import { t } from '../../shared/i18n';

interface FolderPropertiesDialogProps {
  accountId: string;
  folder: string;
  name: string;
  onClose(): void;
}

const CAPABILITY_LABELS: Record<string, string> = {
  L1_CHANGEDSINCE: 'CONDSTORE 增量同步',
  L2_SEARCH_SINCE: 'SEARCH SINCE 增量同步',
  L3_UIDNEXT: 'UIDNEXT 轮询',
};

function formatTime(ms: number): string {
  if (!ms) return t('folder.props.never');
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

/** 文件夹属性：只读展示本机记录的真实字段（路径、计数、UIDVALIDITY、同步状态）。 */
export function FolderPropertiesDialog({
  accountId,
  folder,
  name,
  onClose,
}: FolderPropertiesDialogProps): JSX.Element {
  const [details, setDetails] = useState<FolderDetails | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.api.getFolderDetails(accountId, folder).then((result) => {
      if (cancelled) return;
      if (result.ok) setDetails(result.data);
      else setError(result.error.message);
    });
    return () => {
      cancelled = true;
    };
  }, [accountId, folder]);

  const rows: Array<[string, string]> = details
    ? [
        [t('folder.props.name'), details.name],
        [t('folder.props.path'), details.path],
        [
          t('folder.props.specialUse'),
          details.specialUse
            ? (SPECIAL_USE_LABELS[details.specialUse as SpecialUse] ?? details.specialUse)
            : t('folder.props.none'),
        ],
        [
          t('folder.props.counts'),
          t('folder.props.countsValue', { total: details.total, unread: details.unread }),
        ],
        [t('folder.props.uidValidity'), details.uidValidity > 0 ? String(details.uidValidity) : '—'],
        [t('folder.props.lastSync'), formatTime(details.lastSyncAt)],
        [
          t('folder.props.capability'),
          CAPABILITY_LABELS[details.capabilityLevel] ?? details.capabilityLevel ?? '—',
        ],
        [t('folder.props.needsResync'), details.needsFullResync ? t('folder.props.yes') : t('folder.props.no')],
      ]
    : [];

  return (
    <div className="overlay overlay-dialog" role="presentation" onClick={onClose}>
      <div
        className="dialog-card props-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('folder.props.title')}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <h3 className="dialog-title">{`${t('folder.props.title')}：${name}`}</h3>
        {error ? (
          <p className="dialog-error">{error}</p>
        ) : details ? (
          <dl className="props-list">
            {rows.map(([label, value]) => (
              <div className="props-row" key={label}>
                <dt>{label}</dt>
                <dd title={value}>{value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="dialog-hint">{t('folder.props.loading')}</p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn btn-sm btn-primary" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
