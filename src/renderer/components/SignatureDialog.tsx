import { useEffect, useRef, useState } from 'react';
import type { AccountView } from '../../shared/types';
import type { SignatureView } from '../../shared/ipc';
import { RichTextEditor } from './RichTextEditor';

const SIGNATURE_TEMPLATE =
  '<p>祝好</p><p><br></p><p>——<br>{姓名} · {部门}<br>📧 {邮箱}</p>';

/**
 * 签名编辑窗口（§ 撰写）。
 * 每个账户可有多套签名；新建邮件与回复/转发可分别指定默认签名。
 * 中间编辑框为富文本（Tiptap，与写信框一致），「保存」落库当前 HTML。
 */
export function SignatureDialog({ onClose }: { onClose(): void }): JSX.Element {
  const [tab, setTab] = useState<'email' | 'stationery'>('email');
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [accountId, setAccountId] = useState<string>('');
  const [signatures, setSignatures] = useState<SignatureView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [html, setHtml] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  /** 当前选中签名「载入时」的 HTML；用于判断切换/关闭前是否需要落盘。 */
  const loadedHtmlRef = useRef('');

  // 启动时拉账户列表；没有账户时签名无从挂靠
  useEffect(() => {
    let active = true;
    void window.api.listAccounts().then((result) => {
      if (!active || !result.ok) return;
      const list = result.data ?? [];
      setAccounts(list);
      const first = list[0];
      if (first) setAccountId(first.id);
    });
    return () => {
      active = false;
    };
  }, []);

  // 切换账户 → 重新拉该账户的签名列表并选中第一套
  useEffect(() => {
    if (!accountId) {
      setSignatures([]);
      setSelectedId(null);
      setHtml('');
      loadedHtmlRef.current = '';
      return;
    }
    let active = true;
    void window.api.listSignatures(accountId).then((result) => {
      if (!active || !result.ok) return;
      const list = result.data ?? [];
      setSignatures(list);
      const first = list[0] ?? null;
      setSelectedId(first?.id ?? null);
      setHtml(first?.html ?? '');
      loadedHtmlRef.current = first?.html ?? '';
    });
    return () => {
      active = false;
    };
  }, [accountId]);

  /** 先把当前编辑框里未落盘的内容存下来（若有改动），再切到目标签名。 */
  const selectSignature = (next: SignatureView | null): void => {
    void (async () => {
      if (selectedId && html.trim() !== '' && html !== loadedHtmlRef.current) {
        await window.api.saveSignature(selectedId, html);
      }
      setSelectedId(next?.id ?? null);
      setHtml(next?.html ?? '');
      loadedHtmlRef.current = next?.html ?? '';
    })();
  };

  /** 关闭前保底落盘，避免切窗口/关窗丢内容。 */
  const close = (): void => {
    void (async () => {
      if (selectedId && html.trim() !== '' && html !== loadedHtmlRef.current) {
        await window.api.saveSignature(selectedId, html);
      }
      onClose();
    })();
  };

  const handleNew = (): void => {
    void (async () => {
      if (selectedId && html.trim() !== '' && html !== loadedHtmlRef.current) {
        await window.api.saveSignature(selectedId, html);
      }
      const created = await window.api.createSignature(accountId);
      if (!created.ok) return;
      const list = await window.api.listSignatures(accountId);
      if (!list.ok) return;
      setSignatures(list.data);
      const next = list.data.find((item) => item.id === created.data.id) ?? null;
      setSelectedId(next?.id ?? null);
      setHtml(next?.html ?? '');
      loadedHtmlRef.current = next?.html ?? '';
    })();
  };

  const handleDelete = (): void => {
    if (!selectedId) return;
    void (async () => {
      if (html.trim() !== '' && html !== loadedHtmlRef.current) {
        await window.api.saveSignature(selectedId, html);
      }
      await window.api.deleteSignature(selectedId);
      const list = await window.api.listSignatures(accountId);
      if (!list.ok) return;
      setSignatures(list.data);
      const first = list.data[0] ?? null;
      setSelectedId(first?.id ?? null);
      setHtml(first?.html ?? '');
      loadedHtmlRef.current = first?.html ?? '';
    })();
  };

  const confirmRename = (): void => {
    if (!renamingId) return;
    void (async () => {
      await window.api.renameSignature(renamingId, renameValue);
      setRenamingId(null);
      const list = await window.api.listSignatures(accountId);
      if (!list.ok) return;
      setSignatures(list.data);
    })();
  };

  const handleSave = (): void => {
    if (!selectedId) return;
    void (async () => {
      await window.api.saveSignature(selectedId, html);
      loadedHtmlRef.current = html;
    })();
  };

  const handleDefault = (kind: 'new' | 'reply', signatureId: string): void => {
    void (async () => {
      await window.api.setDefaultSignature(accountId, kind, signatureId || null);
      const list = await window.api.listSignatures(accountId);
      if (!list.ok) return;
      setSignatures(list.data);
    })();
  };

  const defaultNewId = signatures.find((item) => item.isDefaultNew)?.id ?? '';
  const defaultReplyId = signatures.find((item) => item.isDefaultReply)?.id ?? '';

  const accountLabel = (account: AccountView): string =>
    account.displayName ? `${account.displayName} <${account.email}>` : account.email;

  return (
    <div className="overlay overlay-dialog" role="presentation" onClick={close}>
      <div
        className="dialog-card signature-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="签名和信纸"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            close();
          }
        }}
      >
        <div className="signature-head">
          <h3 className="dialog-title">签名和信纸</h3>
          <div className="signature-head-actions">
            <button type="button" className="icon-btn" title="帮助" onClick={onClose}>
              ?
            </button>
            <button type="button" className="icon-btn" title="关闭" onClick={close}>
              ×
            </button>
          </div>
        </div>

        <div className="signature-tabs" role="tablist">
          <button
            type="button"
            className={`signature-tab${tab === 'email' ? ' is-active' : ''}`}
            onClick={() => setTab('email')}
          >
            电子邮件签名(E)
          </button>
          <button
            type="button"
            className={`signature-tab${tab === 'stationery' ? ' is-active' : ''}`}
            onClick={() => setTab('stationery')}
          >
            个人信纸(P)
          </button>
        </div>

        {tab === 'email' ? (
          <div className="signature-body">
            {accounts.length === 0 ? (
              <p className="hint">请先在「账户」里添加邮箱账户，再回来配置签名。</p>
            ) : (
              <>
                <div className="signature-field">
                  <label className="field-label" htmlFor="sig-account">
                    电子邮件帐户(A):
                  </label>
                  <select
                    id="sig-account"
                    className="input"
                    value={accountId}
                    onChange={(event) => setAccountId(event.target.value)}
                  >
                    {accounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {accountLabel(account)}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="signature-edit-grid">
                  <div className="signature-list-col">
                    <label className="field-label">选择要编辑的签名(C)</label>
                    <div className="signature-list-wrap">
                      <ul className="signature-list">
                        {signatures.length === 0 ? (
                          <li className="signature-list-empty">还没有签名，点「新建」添加</li>
                        ) : (
                          signatures.map((sig) => (
                            <li
                              key={sig.id}
                              className={`signature-list-item${sig.id === selectedId ? ' is-selected' : ''}`}
                              onClick={() => {
                                if (renamingId) return;
                                selectSignature(sig);
                              }}
                            >
                              {renamingId === sig.id ? (
                                <input
                                  autoFocus
                                  className="signature-rename-input"
                                  value={renameValue}
                                  onChange={(event) => setRenameValue(event.target.value)}
                                  onClick={(event) => event.stopPropagation()}
                                  onKeyDown={(event) => {
                                    if (event.key === 'Enter') {
                                      event.preventDefault();
                                      confirmRename();
                                    }
                                    if (event.key === 'Escape') {
                                      event.preventDefault();
                                      setRenamingId(null);
                                    }
                                  }}
                                  onBlur={confirmRename}
                                />
                              ) : (
                                sig.name
                              )}
                            </li>
                          ))
                        )}
                      </ul>
                      <div className="signature-list-scroll">
                        <button type="button" className="icon-btn" title="上移" disabled>
                          ▲
                        </button>
                        <button type="button" className="icon-btn" title="下移" disabled>
                          ▼
                        </button>
                      </div>
                    </div>
                    <div className="signature-list-actions">
                      <button type="button" className="btn btn-sm" onClick={handleNew}>
                        新建(N)
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={!selectedId}
                        onClick={() => {
                          if (!selectedId) return;
                          setRenamingId(selectedId);
                          setRenameValue(
                            signatures.find((item) => item.id === selectedId)?.name ?? '',
                          );
                        }}
                      >
                        重命名(R)
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={!selectedId || signatures.length === 0}
                        onClick={handleDelete}
                      >
                        删除(D)
                      </button>
                    </div>
                  </div>

                  <div className="signature-editor-col">
                    <label className="field-label">编辑签名(I)</label>
                    {selectedId ? (
                      <RichTextEditor
                        value={html}
                        onChange={setHtml}
                        placeholder="在此编辑签名内容…"
                      />
                    ) : (
                      <p className="hint">请先在左侧新建或选择一套签名。</p>
                    )}
                    <div className="signature-editor-foot">
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={!selectedId}
                        onClick={handleSave}
                      >
                        保存(S)
                      </button>
                      <a
                        className="signature-link"
                        href="#"
                        onClick={(event) => {
                          event.preventDefault();
                          if (!selectedId) return;
                          const next = SIGNATURE_TEMPLATE.replace(
                            '{邮箱}',
                            accounts.find((item) => item.id === accountId)?.email ?? '',
                          );
                          setHtml(next);
                        }}
                      >
                        获取签名模板
                      </a>
                    </div>
                  </div>
                </div>

                <div className="signature-defaults">
                  <label className="field-label">选择默认签名</label>
                  <div className="signature-field">
                    <label htmlFor="sig-new">新邮件(M):</label>
                    <select
                      id="sig-new"
                      className="input"
                      value={defaultNewId}
                      onChange={(event) => handleDefault('new', event.target.value)}
                    >
                      <option value="">（不使用签名）</option>
                      {signatures.map((sig) => (
                        <option key={sig.id} value={sig.id}>
                          {sig.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="signature-field">
                    <label htmlFor="sig-reply">答复/转发(F):</label>
                    <select
                      id="sig-reply"
                      className="input"
                      value={defaultReplyId}
                      onChange={(event) => handleDefault('reply', event.target.value)}
                    >
                      <option value="">（不使用签名）</option>
                      {signatures.map((sig) => (
                        <option key={sig.id} value={sig.id}>
                          {sig.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="signature-body">
            <p className="hint">个人信纸功能尚未实现。</p>
          </div>
        )}

        <div className="signature-foot">
          <button type="button" className="btn btn-primary" onClick={close}>
            确定
          </button>
          <button type="button" className="btn" onClick={close}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
