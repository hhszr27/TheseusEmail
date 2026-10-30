import { useEffect, useState } from 'react';
import type { ComposeDraft } from '../../shared/ipc';
import { htmlToPlainText } from '../lib/compose';
import { RichTextEditor } from './RichTextEditor';
import { t } from '../../shared/i18n';

interface DraftReaderProps {
  draft: ComposeDraft;
  /** 保存成功后回传最新草稿（调用方据此刷新列表与选中项）。 */
  onSaved(draft: ComposeDraft): void;
  /** 在撰写窗口里打开（双击列表或点按钮）。 */
  onOpen(): void;
  onDiscard(): void;
}

/** 收件人输入：逗号 / 分号 / 换行都算分隔符（与写信框口径一致）。 */
function splitAddresses(value: string): string[] {
  return value
    .split(/[,;\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * 右侧草稿阅读/编辑区。
 *
 * 草稿箱里单击 = 在这里看内容、直接改；双击（或「在撰写窗口打开」）= 回到完整写信框。
 * 保存走同一条 `draftSave`（本地加密库 + 服务器 Drafts 同步），附件沿用原草稿。
 */
export function DraftReader({ draft, onSaved, onOpen, onDiscard }: DraftReaderProps): JSX.Element {
  const [to, setTo] = useState(draft.to.join(', '));
  const [cc, setCc] = useState(draft.cc.join(', '));
  const [bcc, setBcc] = useState((draft.bcc ?? []).join(', '));
  const [subject, setSubject] = useState(draft.subject);
  const [html, setHtml] = useState(draft.html || draft.body);
  const [body, setBody] = useState(draft.body);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number>(draft.updatedAt);

  // 换了一封草稿才重新装载；保存后 updatedAt 会变，但不能因此把正在输入的内容清掉
  useEffect(() => {
    setTo(draft.to.join(', '));
    setCc(draft.cc.join(', '));
    setBcc((draft.bcc ?? []).join(', '));
    setSubject(draft.subject);
    setHtml(draft.html || draft.body);
    setBody(draft.body);
    setDirty(false);
    setError(null);
    setSavedAt(draft.updatedAt);
  }, [draft.key]);

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    const result = await window.api.saveDraft({
      accountId: draft.accountId,
      to: splitAddresses(to),
      cc: splitAddresses(cc),
      bcc: splitAddresses(bcc),
      subject,
      body,
      html,
      attachments: draft.attachments,
      // 服务器草稿带 uid：保存后要删掉旧的那封，否则服务器上会攒重复草稿
      ...(typeof draft.serverUid === 'number' && draft.serverUid > 0
        ? { serverUid: draft.serverUid }
        : {}),
    });
    setSaving(false);
    if (!result.ok) {
      setError(t('draft.saveFailed', { reason: result.error.message }));
      return;
    }
    setDirty(false);
    setSavedAt(result.data.updatedAt);
    onSaved(result.data);
  };

  return (
    <section className="reader-pane draft-reader" aria-label="草稿内容">
      <div className="reader-toolbar draft-reader-toolbar">
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={!dirty || saving}
          onClick={() => void save()}
        >
          {saving ? t('draft.saving') : t('draft.save')}
        </button>
        <button type="button" className="btn btn-sm" onClick={onOpen}>
          {t('draft.openInCompose')}
        </button>
        <button type="button" className="btn btn-sm" onClick={onDiscard}>
          {t('draft.discard')}
        </button>
        <span className="draft-reader-state">
          {error ? (
            <span className="draft-reader-error">{error}</span>
          ) : dirty ? (
            t('draft.dirty')
          ) : (
            t('draft.savedAt', {
              time: new Date(savedAt).toLocaleTimeString('zh-CN', { hour12: false }),
            })
          )}
        </span>
      </div>

      <p className="draft-reader-hint">{t('draft.hint')}</p>

      <div className="draft-fields">
        <label className="draft-field">
          <span className="draft-field-label">{t('draft.to')}</span>
          <input
            value={to}
            placeholder="someone@example.com"
            onChange={(event) => {
              setTo(event.target.value);
              setDirty(true);
            }}
          />
        </label>
        <label className="draft-field">
          <span className="draft-field-label">{t('draft.cc')}</span>
          <input
            value={cc}
            onChange={(event) => {
              setCc(event.target.value);
              setDirty(true);
            }}
          />
        </label>
        <label className="draft-field">
          <span className="draft-field-label">{t('draft.bcc')}</span>
          <input
            value={bcc}
            onChange={(event) => {
              setBcc(event.target.value);
              setDirty(true);
            }}
          />
        </label>
        <label className="draft-field">
          <span className="draft-field-label">{t('draft.subject')}</span>
          <input
            value={subject}
            onChange={(event) => {
              setSubject(event.target.value);
              setDirty(true);
            }}
          />
        </label>
      </div>

      <div className="draft-body-editor">
        <RichTextEditor
          id="draft-body"
          value={html}
          placeholder={t('draft.bodyPlaceholder')}
          onChange={(next) => {
            setHtml(next);
            setBody(htmlToPlainText(next));
            setDirty(true);
          }}
        />
      </div>
    </section>
  );
}
