import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import type { AttachmentPayload, AttachmentView } from '../../shared/ipc';
import { formatScanAge, isScanStale } from '../../shared/attachments';

// pdf.js 体积较大且只在真正预览 PDF 时需要，按需加载避免影响首屏
const PdfViewer = lazy(async () => {
  const module = await import('./PdfViewer');
  return { default: module.PdfViewer };
});

/**
 * 附件列表与风险标记层（§11）。
 * 由宿主渲染：即使插件接管 reader-view，这块区域仍在 webview 之外。
 */

interface AttachmentListProps {
  emailId: string;
  /**
   * 正文是否已就绪。首次打开邮件时附件是在 getBody 里才落库的，
   * 若只在 emailId 变化时取一次列表，真实附件会晚一步出现。
   */
  bodyReady?: boolean;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const RISK_LABEL: Record<AttachmentView['risk']['level'], string> = {
  danger: '可执行文件，打开前请确认来源',
  suspicious: '此类文件可能含自动运行内容',
  unknown: '未经安全扫描，请自行判断',
  safe: '安全',
};

/** 附件图标块：按扩展名映射颜色与文字（§11.3 分层策略的可视化）。 */
const EXT_STYLE: Array<{ match: RegExp; label: string; className: string }> = [
  { match: /^\.pdf$/i, label: 'PDF', className: 'pdf' },
  { match: /^\.(docx?|rtf|odt)$/i, label: 'DOC', className: 'doc' },
  { match: /^\.(xlsx?|csv|ods)$/i, label: 'XLS', className: 'xls' },
  { match: /^\.(exe|msi|bat|cmd|com|scr|js|vbs|jar|ps1)$/i, label: 'EXE', className: 'exe' },
  { match: /^\.(png|jpe?g|gif|webp|bmp)$/i, label: 'IMG', className: 'img' },
  { match: /^\.(zip|rar|7z|gz|tar)$/i, label: 'ZIP', className: 'zip' },
];

function iconFor(ext: string): { label: string; className: string } {
  const matched = EXT_STYLE.find((item) => item.match.test(ext));
  return matched ?? { label: 'FILE', className: 'other' };
}

/** 风险提示的悬停文案：判断依据 + 各家结论 + 结论时间（过期要说明）。 */
function riskTitle(attachment: AttachmentView): string {
  const lines: string[] = [attachment.risk.tooltip || attachment.risk.reason];
  if (attachment.risk.scanDetail) lines.push(attachment.risk.scanDetail);
  if (attachment.scannedAt) {
    const now = Date.now();
    const stale = isScanStale(attachment.risk.level, attachment.scannedAt, now);
    lines.push(
      `扫描于 ${formatScanAge(attachment.scannedAt, now)}${stale ? '（结论已过期，仅供参考）' : ''}`,
    );
  }
  return lines.filter(Boolean).join('\n');
}

export function AttachmentList({ emailId, bodyReady = false }: AttachmentListProps): JSX.Element | null {
  const [attachments, setAttachments] = useState<AttachmentView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<AttachmentPayload | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  /** 扫描进行中：把「打开」置灰，避免与 Defender 的文件独占打架。 */
  const [scanning, setScanning] = useState(false);

  const reload = useCallback(async () => {
    const result = await window.api.listAttachments(emailId);
    if (result.ok) {
      setAttachments(result.data);
      setError(null);
    } else {
      setError(result.error.message);
    }
  }, [emailId]);

  useEffect(() => {
    setAttachments([]);
    setPreview(null);
    setPreviewError(null);
    void reload();
  }, [reload, bodyReady]);

  useEffect(() => {
    // 扫描开始/结束只影响这一封邮件
    const unsubscribe = window.api.onScanProgress?.((progress) => {
      if (progress.emailId !== emailId) return;
      setScanning(progress.phase === 'start');
    });
    return () => unsubscribe?.();
  }, [emailId]);

  useEffect(() => {
    const unsubscribe = window.api.onScanUpdate((update) => {
      if (update.kind !== 'attachment' || !update.attachmentId) return;
      setAttachments((current) =>
        current.map((item) =>
          item.id === update.attachmentId
            ? {
                ...item,
                risk: {
                  ...item.risk,
                  level: update.riskLevel ?? item.risk.level,
                  scanSource: update.result.source,
                  scanDetail: update.result.detail,
                },
                scannedAt: update.result.scannedAt,
              }
            : item,
        ),
      );
    });
    return unsubscribe;
  }, []);

  const openAttachment = async (attachment: AttachmentView): Promise<void> => {
    const result = await window.api.openAttachment(attachment.id);
    if (!result.ok) setError(result.error.message);
  };

  const saveAttachment = async (attachment: AttachmentView): Promise<void> => {
    const result = await window.api.saveAttachment(attachment.id);
    if (!result.ok) setError(result.error.message);
  };

  const showPreview = async (attachment: AttachmentView): Promise<void> => {
    setPreviewLoading(true);
    setPreviewError(null);
    const result = await window.api.getAttachmentPayload(attachment.id);
    setPreviewLoading(false);
    if (!result.ok) {
      setPreviewError(result.error.message);
      setPreview(null);
      return;
    }
    setPreview(result.data);
  };

  if (attachments.length === 0 && !error) return null;

  return (
    <section className="attachments" aria-label="附件">
      <div className="attachments-head">
        <h2 className="attachments-title">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
          {attachments.length} 个附件
        </h2>
        <span className="hint">双击打开；可执行类型会先弹出确认</span>
      </div>

      {error ? <p className="error-banner">{error}</p> : null}

      {scanning ? (
        <div className="att-scanning" role="status">
          <span>正在扫描附件…</span>
          <button
            type="button"
            className="link-button"
            onClick={() => void window.api.cancelScan(emailId)}
          >
            停止
          </button>
        </div>
      ) : null}

      <ul className="attachment-list">
        {attachments.map((attachment) => {
          const icon = iconFor(attachment.ext);
          const risk = attachment.risk.level;
          return (
            <li className="attachment-row" key={attachment.id}>
              <span className={`att-icon ${icon.className}`} aria-hidden="true">
                {icon.label}
              </span>
              <div className="att-body">
                <div className="att-name" title={attachment.filename}>
                  {attachment.filename}
                </div>
                <div className="att-size">{formatSize(attachment.size)}</div>
              </div>

              {risk !== 'safe' ? (
                <span
                  className={`att-risk ${risk}`}
                  title={riskTitle(attachment)}
                >
                  <span className="att-risk-icon">⚠</span>
                  {RISK_LABEL[risk]}
                </span>
              ) : null}

              <div className="att-actions">
                {attachment.handling === 'preview' ? (
                  <button
                    type="button"
                    className="att-btn primary"
                    onClick={() => void showPreview(attachment)}
                  >
                    预览
                  </button>
                ) : null}

                {attachment.handling === 'blocked' ? (
                  <>
                    <button
                      type="button"
                      className="att-btn"
                      disabled
                      title="这类文件已在设置里被禁止打开"
                    >
                      打开
                    </button>
                    <button
                      type="button"
                      className="att-btn"
                      onClick={() => void saveAttachment(attachment)}
                    >
                      另存为
                    </button>
                    <span className="att-blocked-note">
                      {attachment.blockedBy === 'scan' ? '扫描判定恶意' : '已禁止打开'}
                    </span>
                  </>
                ) : attachment.handling === 'confirm' ? (
                  <>
                    <button
                      type="button"
                      className="att-btn"
                      disabled
                      title="这类文件需要确认后才能打开"
                    >
                      打开
                    </button>
                    <button
                      type="button"
                      className="att-btn"
                      onClick={() => void saveAttachment(attachment)}
                    >
                      另存为
                    </button>
                    <button
                      type="button"
                      className="link-button att-still-open"
                      onClick={() => void openAttachment(attachment)}
                    >
                      仍要打开…
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="att-btn"
                      disabled={scanning}
                      title={scanning ? '正在扫描，稍候再打开' : undefined}
                      onClick={() => void openAttachment(attachment)}
                    >
                      {scanning ? '扫描中' : '打开'}
                    </button>
                    <button
                      type="button"
                      className="att-btn"
                      onClick={() => void saveAttachment(attachment)}
                    >
                      另存为
                    </button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {previewError ? <p className="error-banner">{previewError}</p> : null}

      {preview || previewLoading ? (
        <div className="overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setPreview(null)}>
          <div className="modal attachment-preview" role="dialog" aria-modal="true" aria-label="附件预览">
            <div className="modal-header">
              <h2 className="modal-title">{preview?.filename ?? '正在载入…'}</h2>
              <button type="button" className="btn" onClick={() => setPreview(null)}>
                关闭
              </button>
            </div>
            <div className="modal-body">
              {previewLoading ? <p className="hint">正在读取附件…</p> : null}
              {preview?.kind === 'text' ? (
                <>
                  {preview.truncated ? <p className="hint">文件较大，已截断显示前 2 MB。</p> : null}
                  <pre className="attachment-text">{preview.text}</pre>
                </>
              ) : null}
              {preview?.kind === 'image' ? (
                <img
                  className="attachment-image"
                  alt={preview.filename}
                  src={`data:${preview.mimeType};base64,${preview.dataBase64 ?? ''}`}
                />
              ) : null}
              {preview?.kind === 'pdf' ? (
                <Suspense fallback={<p className="hint">正在载入 PDF 渲染器…</p>}>
                  <PdfViewer dataBase64={preview.dataBase64 ?? ''} filename={preview.filename} />
                </Suspense>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
