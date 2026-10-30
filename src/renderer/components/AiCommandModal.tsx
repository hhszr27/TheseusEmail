import { useEffect, useState } from 'react';
import type { CommandPreparation, SemanticSearchResult } from '../../shared/ipc';
import type { EmailSummary, ParsedCommand } from '../../shared/types';
import { useMailStore } from '../stores/mail-store';
import { formatFullDate } from '../lib/format';
import { useTimeFormat } from '../lib/use-time-format';
import { useTimeZone } from '../lib/use-time-zone';

/**
 * AI 指令与语义搜索（§15.3）：
 * 解析结果先展示确认卡片，用户点击确认后才写入发送队列。
 */

const EXAMPLE_PROMPT = '明天下午3点，发一封邮件给张总，内容是提醒他合同的事';

interface AiCommandModalProps {
  open: boolean;
  onClose(): void;
  onSelectEmail(email: EmailSummary): void;
}

export function AiCommandModal({ open, onClose, onSelectEmail }: AiCommandModalProps): JSX.Element | null {
  const timeFormat = useTimeFormat();
  const timeZone = useTimeZone();
  const bootstrap = useMailStore((state) => state.bootstrap);
  const [tab, setTab] = useState<'command' | 'search'>('command');
  const [input, setInput] = useState('');
  const [prepared, setPrepared] = useState<CommandPreparation | null>(null);
  const [command, setCommand] = useState<ParsedCommand | null>(null);
  const [searchResult, setSearchResult] = useState<SemanticSearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (open) return;
    setPrepared(null);
    setCommand(null);
    setSearchResult(null);
    setError(null);
    setDone(null);
  }, [open]);

  // 首次打开填入示例指令，方便直接看到确认卡片的效果（可自由修改）
  useEffect(() => {
    if (!open) return;
    setInput((current) => (current.trim() ? current : EXAMPLE_PROMPT));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  const parse = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setDone(null);
    const result = await window.api.prepareCommand(input);
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setPrepared(result.data);
    if (result.data.status === 'ready') setCommand(result.data.command);
    else setCommand(result.data.status === 'needs_choice' ? result.data.command : null);
  };

  const confirm = async (): Promise<void> => {
    if (!command) return;
    const accountId = bootstrap?.accounts[0]?.id ?? '';
    if (!accountId) {
      setError('没有可用的账户');
      return;
    }
    setBusy(true);
    const result = await window.api.confirmCommand({ accountId, command });
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setDone(`已写入发送队列：${formatFullDate(new Date(result.data.sendAt).toISOString(), timeFormat, timeZone)}`);
    setPrepared(null);
    setCommand(null);
  };

  const runSearch = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const result = await window.api.semanticSearch(input, 20);
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setSearchResult(result.data);
  };

  const needsChoice = prepared?.status === 'needs_choice' ? prepared.choices : [];

  return (
    <div className="overlay ai-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="ai-panel" role="dialog" aria-modal="true" aria-labelledby="ai-title">
        <div className="ai-panel-header">
          <span className="ai-badge">AI</span>
          <span id="ai-title">用一句话完成任务</span>
          <span className="statusbar-spacer" />
          <button type="button" className="icon-btn icon-btn-sm" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="ai-panel-body">
          <div className="ai-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'command'}
              className={`btn${tab === 'command' ? ' btn-primary' : ''}`}
              onClick={() => setTab('command')}
            >
              自然语言指令
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'search'}
              className={`btn${tab === 'search' ? ' btn-primary' : ''}`}
              onClick={() => setTab('search')}
            >
              语义搜索
            </button>
          </div>

          {error ? <p className="error-banner">{error}</p> : null}
          {done ? <p className="hint">{done}</p> : null}

          <textarea
            className="ai-panel-input"
            rows={3}
            placeholder={
              tab === 'command'
                ? '例如：明天下午3点，发一封邮件给张总，内容：项目进度已更新，请查收。'
                : '例如：上个月讨论预算的邮件'
            }
            value={input}
            onChange={(event) => setInput(event.target.value)}
            aria-label={tab === 'command' ? '指令内容' : '搜索内容'}
          />

          <div className="ai-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !input.trim()}
              onClick={() => void (tab === 'command' ? parse() : runSearch())}
            >
              {busy ? '处理中…' : tab === 'command' ? '解析指令' : '搜索'}
            </button>
            <span className="hint">
              {tab === 'command'
                ? '解析只生成待确认草稿，不会自动发送。'
                : '本地向量索引，不调用外部服务。'}
            </span>
          </div>

          {/* 未配置 AI 时展示示例卡片：明确标注为示例，不冒充真实解析结果 */}
          {tab === 'command' && !prepared && input.trim() === EXAMPLE_PROMPT ? (
            <section className="ai-confirm-card ai-confirm-sample" aria-label="示例解析结果">
              <div className="ai-confirm-title">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                  <path d="m9 11 3 3L22 4" />
                </svg>
                示例：解析结果预览
              </div>
              <div className="ai-confirm-row">
                <span className="lbl">动作</span>
                <span className="val">定时发送</span>
              </div>
              <div className="ai-confirm-row">
                <span className="lbl">发送时间</span>
                <span className="val">明天 15:00</span>
              </div>
              <div className="ai-confirm-row">
                <span className="lbl">收件人</span>
                <span className="val">张总 &lt;zhang@company.cn&gt;</span>
              </div>
              <div className="ai-confirm-row">
                <span className="lbl">发件账户</span>
                <span className="val">
                  {bootstrap?.accounts.find((account) => account.enabled)?.displayName ?? '当前账户'}
                </span>
              </div>
              <div className="ai-confirm-row">
                <span className="lbl">主题</span>
                <span className="val">合同事项提醒</span>
              </div>
              <p className="ai-panel-hint">
                这是内置示例，用于说明确认卡片的结构。配置 AI 提供者后点击「解析指令」，此处会显示真实的解析结果；确认后才会写入发送队列。
              </p>
            </section>
          ) : null}

          {prepared?.status === 'rejected' ? (
            <p className="error-banner">{prepared.message}（尝试 {prepared.attempts} 次）</p>
          ) : null}

          {needsChoice.length > 0 && command ? (
            <section className="ai-card">
              <h3 className="settings-title">请选择收件人</h3>
              {needsChoice.map((choice) => (
                <div className="field" key={choice.index}>
                  <label className="field-label" htmlFor={`choice-${choice.index}`}>
                    {choice.query || `第 ${choice.index + 1} 位收件人`}
                  </label>
                  <select
                    id={`choice-${choice.index}`}
                    className="input"
                    defaultValue=""
                    onChange={(event) => {
                      const address = event.target.value;
                      if (!address) return;
                      const next: ParsedCommand = {
                        ...command,
                        recipients: command.recipients.map((item, index) =>
                          index === choice.index ? { ...item, address } : item,
                        ),
                      };
                      setCommand(next);
                    }}
                  >
                    <option value="">请选择…</option>
                    {choice.candidates.map((candidate) => (
                      <option key={candidate.email} value={candidate.email}>
                        {candidate.displayName ? `${candidate.displayName} <${candidate.email}>` : candidate.email}
                      </option>
                    ))}
                    {choice.candidates.length === 0 ? <option value="">没有匹配的联系人，请手动填写</option> : null}
                  </select>
                </div>
              ))}
              <div className="ai-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy || command.recipients.some((recipient) => !recipient.address)}
                  onClick={() => void confirm()}
                >
                  确认并写入队列
                </button>
              </div>
            </section>
          ) : null}

          {prepared?.status === 'ready' && command ? (
            <section className="ai-confirm-card">
              <div className="ai-confirm-title">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                  <path d="m9 11 3 3L22 4" />
                </svg>
                指令已解析 — 请确认后执行
              </div>
              <div className="ai-confirm-row">
                <span className="lbl">动作</span>
                <span className="val">{command.action === 'schedule_send' ? '定时发送' : '立即发送'}</span>
              </div>
              <div className="ai-confirm-row">
                <span className="lbl">发送时间</span>
                <span className="val">
                  {command.sendAt ? formatFullDate(new Date(command.sendAt).toISOString(), timeFormat, timeZone) : '未指定'}
                </span>
              </div>
              <div className="ai-confirm-row">
                <span className="lbl">收件人</span>
                <span className="val">
                  {command.recipients
                    .map((recipient) => recipient.address ?? recipient.name ?? '')
                    .filter(Boolean)
                    .join('、') || '待补充'}
                </span>
              </div>
              <div className="ai-confirm-row">
                <span className="lbl">发件账户</span>
                <span className="val">
                  {bootstrap?.accounts.find((account) => account.id === bootstrap?.accounts[0]?.id)
                    ?.displayName ?? '未配置'}
                </span>
              </div>
              <div className="ai-confirm-row">
                <span className="lbl">主题</span>
                <span className="val">{command.bodyInstruction.content.split(/\r?\n/)[0]?.slice(0, 80)}</span>
              </div>
              <div className="ai-confirm-row">
                <span className="lbl">置信度</span>
                <span className="val">{command.confidence.toFixed(2)}</span>
              </div>
              {prepared.requiresConfirmation ? (
                <p className="hint">此指令需要你确认后才能发送。</p>
              ) : null}
              <div className="ai-actions">
                <button type="button" className="btn" onClick={() => setPrepared(null)}>
                  取消
                </button>
                <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void confirm()}>
                  确认并写入队列
                </button>
              </div>
            </section>
          ) : null}

          {searchResult ? (
            <section className="ai-card">
              <h3 className="settings-title">语义搜索结果（{searchResult.emails.length}）</h3>
              {searchResult.emails.length === 0 ? <p className="hint">没有匹配的邮件。</p> : null}
              <ul className="ai-results">
                {searchResult.emails.map((email) => {
                  const score = searchResult.scores.find((item) => item.emailId === email.id)?.score ?? 0;
                  return (
                    <li key={email.id}>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => {
                          onSelectEmail(email);
                          onClose();
                        }}
                      >
                        {email.subject || '（无主题）'}
                      </button>
                      <span className="hint">
                        {' '}
                        · {email.from[0]?.address ?? ''} · 相似度 {score.toFixed(2)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
