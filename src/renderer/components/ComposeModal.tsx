import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ComposeAttachmentInfo,
  ComposeDraft,
  ContactSuggestion,
  MailtoRequest,
} from '../../shared/ipc';
import type { EmailAddress } from '../../shared/types';
import { useMailStore } from '../stores/mail-store';
import { t } from '../../shared/i18n';
import { isPluginEnabledForAccount } from '../../shared/plugin-access';
import { PluginView } from './PluginView';
import { RichTextEditor } from './RichTextEditor';
import {
  countdownFor,
  draftMatchesComposeRequest,
  formatCountdown,
  formatFileSize,
  formatSendTime,
  htmlToPlainText,
  parseSendTimeInput,
} from '../lib/compose';

interface ComposeModalProps {
  request: MailtoRequest | null;
  onClose(): void;
  /** 发送成功后的反馈（由宿主显示全局提示）。 */
  onSent?(message: string): void;
  /**
   * inline：作为阅读窗口里的内联写信视图（像 Outlook 的回复窗口），
   * 不渲染遮罩、铺满整个窗口；modal：主窗口里的弹层（默认）。
   */
  variant?: 'modal' | 'inline';
  /** inline 模式顶栏「返回」按钮的文案与提示（写信窗口里是「关闭写信」）。 */
  inlineBackTitle?: string;
}

function splitAddresses(value: string): string[] {
  return value
    .split(/[,;]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function ComposeModal({
  request,
  onClose,
  onSent,
  variant = 'modal',
  inlineBackTitle = '返回邮件',
}: ComposeModalProps): JSX.Element | null {
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  /** 密送：只用于发送信封，收件人看不到。 */
  const [bcc, setBcc] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  /** 富文本正文（HTML）。body 始终作为它的纯文本镜像，用于发送与落库。 */
  const [html, setHtml] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<{ id: string; sendAt: number } | null>(null);
  const [remaining, setRemaining] = useState(0);
  /** 发送时间输入（datetime-local）；空表示立即发送。 */
  const [sendAtInput, setSendAtInput] = useState('');
  /** 已提交发送（立即或定时到点）的时间戳，用于成功提示。 */
  const [sentAt, setSentAt] = useState<number | null>(null);
  /** 已选附件（文件本体在主进程暂存目录，这里只有元信息）。 */
  const [attachments, setAttachments] = useState<ComposeAttachmentInfo[]>([]);
  /** 拖拽文件悬停在写信窗上方时的视觉提示（计数避免子元素冒泡造成的闪烁）。 */
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);
  /** 最近一次自动保存时间。 */
  const [draftSavedAt, setDraftSavedAt] = useState<number | null>(null);
  const [suggestions, setSuggestions] = useState<ContactSuggestion[]>([]);
  const debounceRef = useRef<number | null>(null);
  /**
   * 撰写窗尺寸：normal（默认 720px）→ max（放大）→ fullscreen（全屏）。
   * 全屏优先于放大；Esc 先退出尺寸模式再关窗。
   */
  const [composeSize, setComposeSize] = useState<'normal' | 'max' | 'fullscreen'>('normal');
  /** 抄送/密送默认收起：写信界面只保留最常用的收件人与主题。 */
  const [showCc, setShowCc] = useState(false);
  /** 定时发送默认收起：点「定时发送」才展开时间选择。 */
  const [showSchedule, setShowSchedule] = useState(false);
  /** 唯一的滚动容器：正文随内容增高，滚轮统一滚这一层。 */
  const bodyRef = useRef<HTMLDivElement>(null);

  // 尺寸模式变化时同步驱动宿主窗口的原生全屏：只有 fullscreen 才真正铺满整屏。
  const composeSizeRef = useRef(composeSize);
  useEffect(() => {
    composeSizeRef.current = composeSize;
  }, [composeSize]);

  const changeSize = useCallback((next: 'normal' | 'max' | 'fullscreen'): void => {
    const prev = composeSizeRef.current;
    if (next === 'fullscreen' && prev !== 'fullscreen') {
      void window.api.windowSetFullScreen(true);
    } else if (prev === 'fullscreen' && next !== 'fullscreen') {
      void window.api.windowSetFullScreen(false);
    }
    setComposeSize(next);
  }, []);

  // 关窗前若处于原生全屏，先退出，避免关窗后主窗口卡在全屏态。
  const requestClose = useCallback((): void => {
    if (composeSizeRef.current === 'fullscreen') void window.api.windowSetFullScreen(false);
    onClose();
  }, [onClose]);


  const activeAccountId = useMailStore((state) => state.activeAccountId);
  const unified = useMailStore((state) => state.unified);
  const bootstrap = useMailStore((state) => state.bootstrap);
  const accounts = useMemo(
    () => (bootstrap?.accounts ?? []).filter((account) => account.enabled),
    [bootstrap],
  );
  const [fromId, setFromId] = useState('');
  const accountEmail = accounts.find((account) => account.id === fromId)?.email ?? '';
  const pluginSnapshot = useMailStore((state) => state.pluginSnapshot);

  // compose-view 整体接管（§13.3）：按发件账户解析，账户级禁用时不接管
  const composePluginId = useMemo(() => {
    const plugin = (pluginSnapshot?.plugins ?? []).find(
      (item) =>
        item.status === 'ready' &&
        item.enabled &&
        item.hasComposeView &&
        isPluginEnabledForAccount(true, item.accountOverrides, fromId),
    );
    return plugin?.id ?? null;
  }, [pluginSnapshot, fromId]);

  // 草稿真值由宿主维护：变化后同步给主进程，供插件 getDraftContext 读取
  useEffect(() => {
    if (!request) return;
    if (!composePluginId || !fromId) {
      void window.api.setPluginDraftContext(null);
      return;
    }
    const toList: EmailAddress[] = splitAddresses(to).map((address) => ({ address }));
    const ccList: EmailAddress[] = splitAddresses(cc).map((address) => ({ address }));
    const timer = window.setTimeout(() => {
      void window.api.setPluginDraftContext({
        accountId: fromId,
        subject,
        to: toList,
        cc: ccList,
        body,
      });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [request, composePluginId, fromId, to, cc, subject, body]);

  // 插件写回草稿：补丁已在主进程校验，这里只做字段合并
  useEffect(() => {
    const unsubscribe = window.api.onDraftPatch(({ pluginId, patch }) => {
      if (!composePluginId || pluginId !== composePluginId) return;
      if (typeof patch.subject === 'string') setSubject(patch.subject);
      if (typeof patch.body === 'string') setBody(patch.body);
      if (Array.isArray(patch.to)) setTo(patch.to.map((item) => item.address).join(', '));
      if (Array.isArray(patch.cc)) setCc(patch.cc.map((item) => item.address).join(', '));
    });
    return unsubscribe;
  }, [composePluginId]);

  useEffect(
    () => () => {
      void window.api.setPluginDraftContext(null);
    },
    [],
  );

  useEffect(() => {
    if (!request) return;
    let cancelled = false;
    void (async () => {
      let preferred =
        request.accountId && accounts.some((account) => account.id === request.accountId)
          ? request.accountId
          : !unified && activeAccountId
            ? activeAccountId
            : '';
      if (!preferred) {
        const saved = await window.api.getSetting('compose.lastAccountId');
        if (saved.ok && saved.data && accounts.some((account) => account.id === saved.data)) {
          preferred = saved.data;
        }
      }
      if (!preferred) {
        preferred =
          accounts.find((account) => account.settings.defaultSendAccount)?.id ??
          accounts[0]?.id ??
          '';
      }
      if (!cancelled) setFromId(preferred);
    })();
    return () => {
      cancelled = true;
    };
  }, [request, unified, activeAccountId, accounts]);

  useEffect(() => {
    if (!request) return;
    setTo(request.to.join(', '));
    setCc(request.cc.join(', '));
    setBcc((request.bcc ?? []).join(', '));
    setSubject(request.subject);
    setBody(request.body);
    setHtml(request.html ?? request.body);
    setError(null);
    setPending(null);
    setSendAtInput('');
    setSentAt(null);
    // 从草稿箱继续编辑时带回已选附件
    setAttachments(request.attachments ?? []);
    setDraftSavedAt(null);
    // 回复/转发带回抄送时自动展开，否则保持干净
    setShowCc(request.cc.length > 0 || (request.bcc?.length ?? 0) > 0);
    setShowSchedule(false);
  }, [request]);

  // 打开写信时从顶部开始（4 行留白 + 引用头可见），不要停在上次滚动位置。
  // 用 scrollTop 赋值而不是 scrollTo：jsdom 没实现后者，测试里会直接抛错。
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [request]);

  // 打开撰写窗口时查一次该账户的本地草稿；不自动覆盖用户输入，交给用户选择
  useEffect(() => {
    if (!request || !fromId) return;
    let cancelled = false;
    void window.api.getDraft(fromId).then((result) => {
      if (cancelled || !result.ok || !result.data) return;
      const draft = result.data;
      const hasContent =
        draft.to.length > 0 ||
        draft.cc.length > 0 ||
        draft.subject.length > 0 ||
        draft.body.length > 0 ||
        draft.attachments.length > 0;
      if (!hasContent) return;
      // 只在「从草稿箱继续编辑」（表单内容与草稿一致）时显示已保存时间；
      // 新建邮件不再提示旧草稿（用户要求：不要在写信时冒出之前的记录）
      if (draftMatchesComposeRequest(draft, request)) setDraftSavedAt(draft.updatedAt);
    });
    return () => {
      cancelled = true;
    };
  }, [request, fromId]);

  // 自动保存（防抖 1.5s）：空白内容不写库，避免刚打开就把草稿删掉
  useEffect(() => {
    if (!request || !fromId || sending || pending !== null || sentAt !== null) return;
    const hasContent =
      to.trim().length > 0 ||
      cc.trim().length > 0 ||
      subject.trim().length > 0 ||
      body.trim().length > 0 ||
      html.trim().length > 0 ||
      attachments.length > 0;
    if (!hasContent) return;

    const timer = window.setTimeout(() => {
      void window.api
        .saveDraft({
          accountId: fromId,
          to: splitAddresses(to),
          cc: splitAddresses(cc),
          bcc: splitAddresses(bcc),
          subject,
          body,
          html,
          attachments,
        })
        .then((result) => {
          if (result.ok) setDraftSavedAt(result.data.updatedAt);
        });
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [request, fromId, to, cc, bcc, subject, body, html, attachments, sending, pending, sentAt]);

  useEffect(() => {
    if (!request) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !sending) {
        // 全屏/放大状态下 Esc 只还原尺寸（含退出原生全屏），再按一次才关窗
        if (composeSize !== 'normal') {
          changeSize('normal');
          return;
        }
        requestClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [request, onClose, sending, composeSize]);

  useEffect(() => {
    if (!pending) return;
    setRemaining(countdownFor(pending.sendAt, Date.now()).remaining);
    const timer = window.setInterval(() => {
      const state = countdownFor(pending.sendAt, Date.now());
      setRemaining(state.remaining);
      if (state.due) {
        // 到点：交给发送队列，界面切到「已发送」，不再停在 0 秒
        window.clearInterval(timer);
        setPending(null);
        setSentAt(pending.sendAt);
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, [pending]);

  const searchContacts = (value: string): void => {
    const last = splitAddresses(value).pop() ?? '';
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      void window.api.searchContacts(last).then((result) => {
        if (result.ok) setSuggestions(result.data);
      });
    }, 180);
  };

  const applySuggestion = (suggestion: ContactSuggestion): void => {
    const parts = splitAddresses(to);
    parts.pop();
    parts.push(suggestion.email);
    setTo(`${parts.join(', ')}, `);
    setSuggestions([]);
  };

  const handleSend = async (): Promise<void> => {
    if (!fromId) {
      setError('没有可用的发件账户');
      return;
    }
    const recipients = splitAddresses(to);
    if (recipients.length === 0) {
      setError('请填写收件人');
      return;
    }

    const parsed = parseSendTimeInput(sendAtInput);
    if (parsed.error) {
      setError(parsed.error);
      return;
    }

    setSending(true);
    setError(null);
    try {
      const result = await window.api.scheduleSend({
        accountId: fromId,
        to: recipients,
        cc: splitAddresses(cc),
        bcc: splitAddresses(bcc),
        subject,
        body,
        html,
        ...(attachments.length > 0 ? { attachments: attachments.map((item) => item.id) } : {}),
        ...(parsed.at ? { sendAt: parsed.at } : {}),
      });

      if (!result.ok) {
        setError(result.error.message);
        return;
      }

      setSuggestions([]);
      void window.api.deleteDraft(fromId);
      setDraftSavedAt(null);
      if (parsed.at) {
        // 定时：进入倒计时条，可在到点前取消
        setPending(result.data);
        setRemaining(Math.max(0, result.data.sendAt - Date.now()));
        setSentAt(null);
        return;
      }
      // 立即发送：与 Outlook 一致，发送成功即关闭弹层并给出全局提示；
      // 之前停在原地只改一行小字，按钮随即变成禁用态，用户会以为「点了没反应」。
      setPending(null);
      setSentAt(Date.now());
      onSent?.('邮件已发送');
      requestClose();
    } catch (cause) {
      // IPC 拒绝时若不复位 sending，按钮会永远停在「正在发送…」且无法再点
      setError((cause as Error)?.message ?? '发送失败，请稍后重试');
    } finally {
      setSending(false);
    }
  };

  const addAttachments = async (): Promise<void> => {
    setError(null);
    const result = await window.api.pickComposeAttachments();
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    if (result.data.length === 0) return;
    setAttachments((previous) => [...previous, ...result.data].slice(0, 10));
  };

  const removeAttachment = async (id: string): Promise<void> => {
    await window.api.dropComposeAttachment(id);
    setAttachments((previous) => previous.filter((item) => item.id !== id));
  };

  /** 把拖入界面的文件（OS 拖拽，dataTransfer.files 带绝对路径）暂存为附件。 */
  const addAttachmentsByPaths = useCallback(
    async (paths: string[]): Promise<void> => {
      const cleaned = paths.filter((value): value is string => typeof value === 'string' && value.length > 0);
      if (cleaned.length === 0) return;
      setError(null);
      const result = await window.api.stageComposeAttachments(cleaned);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      if (result.data.length === 0) return;
      setAttachments((previous) => [...previous, ...result.data].slice(0, 10));
    },
    [],
  );

  // 拖放附件：dragenter/over 阻止默认行为才能触发 drop；用 depth 计数防子元素冒泡闪烁。
  const onDragEnter = useCallback(
    (event: React.DragEvent<HTMLDivElement>): void => {
      if (event.dataTransfer?.types?.includes('Files')) {
        event.preventDefault();
        dragDepth.current += 1;
        setDragOver(true);
      }
    },
    [],
  );

  const onDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>): void => {
      if (event.dataTransfer?.types?.includes('Files')) event.preventDefault();
    },
    [],
  );

  const onDragLeave = useCallback(
    (event: React.DragEvent<HTMLDivElement>): void => {
      event.preventDefault();
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragOver(false);
    },
    [],
  );

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>): void => {
      event.preventDefault();
      dragDepth.current = 0;
      setDragOver(false);
      if (pending !== null || sentAt !== null) return;
      const paths = Array.from(event.dataTransfer?.files ?? []).map(
        (file) => (file as File & { path?: string }).path ?? '',
      );
      void addAttachmentsByPaths(paths);
    },
    [pending, sentAt, addAttachmentsByPaths],
  );

  const cancelSchedule = async (): Promise<void> => {
    if (!pending) return;
    const result = await window.api.cancelScheduledSend(pending.id);
    if (!result.ok || !result.data) {
      setError('取消失败：邮件可能已开始发送');
      return;
    }
    setPending(null);
    setRemaining(0);
    setSentAt(null);
  };

  const changeFrom = (nextId: string): void => {
    const previousSignature = accounts.find((account) => account.id === fromId)?.settings.signature ?? '';
    const nextSignature = accounts.find((account) => account.id === nextId)?.settings.signature ?? '';
    setFromId(nextId);
    void window.api.setSetting('compose.lastAccountId', nextId);
    // 切换发件账户时签名随之切换；用户已写正文则不动
    const trimmed = body.trim();
    if (!trimmed || trimmed === previousSignature.trim()) {
      setBody(nextSignature);
      setHtml(nextSignature.replace(/\n/g, '<br>\n'));
    }
  };

  // 所有 hook 必须在早返回之前声明（否则 request 为空与非空两态的 hook 数量不一致，
  // 会触发 React #310）。放到这里统一兜底。
  if (!request) return null;

  const sendLabel = sending
    ? '正在发送…'
    : sentAt
      ? '已发送'
      : pending
        ? '已定时'
        : sendAtInput.trim()
          ? '定时发送'
          : t('common.send');
  // 方块里只放短文案（2~3 个字），完整状态放在 title / aria-label
  const sendLabelShort = sending
    ? '发送中'
    : sentAt
      ? '已发送'
      : pending
        ? '已定时'
        : sendAtInput.trim()
          ? '定时'
          : t('common.send');

  const card = (
    <div
      className={`modal compose-clean${variant === 'inline' ? ' compose-inline' : ''}${
        composeSize === 'max' ? ' compose-max' : ''
      }${composeSize === 'fullscreen' ? ' compose-fullscreen' : ''}`}
      role="dialog"
      aria-modal={variant === 'inline' ? undefined : true}
      aria-labelledby="compose-title"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
        <div className="compose-topbar">
          {variant === 'inline' ? (
            <button
              type="button"
              className="compose-icon-btn compose-back"
              title={inlineBackTitle}
              aria-label={inlineBackTitle}
              onClick={requestClose}
              disabled={sending}
            >
              ←
            </button>
          ) : null}
          <h2 className="compose-title" id="compose-title">
            {request.kind === 'reply'
              ? '回复'
              : request.kind === 'reply-all'
                ? '全部回复'
                : request.kind === 'forward'
                  ? '转发'
                  : '撰写邮件'}
          </h2>
          {variant === 'inline' && draftSavedAt ? (
            <span className="compose-topbar-saved">
              已保存{' '}
              {new Date(draftSavedAt).toLocaleTimeString('zh-CN', {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          ) : null}
          <span className="compose-topbar-spacer" />
          {variant === 'inline' ? null : (
            <>
              <button
                type="button"
                className="compose-icon-btn"
                title={composeSize === 'max' ? '还原大小' : '放大'}
                aria-label={composeSize === 'max' ? '还原大小' : '放大'}
                aria-pressed={composeSize === 'max'}
                onClick={() => changeSize(composeSize === 'max' ? 'normal' : 'max')}
                disabled={sending}
              >
                {composeSize === 'max' ? '❐' : '⤢'}
              </button>
              <button
                type="button"
                className="compose-icon-btn"
                title={composeSize === 'fullscreen' ? '退出全屏' : '全屏'}
                aria-label={composeSize === 'fullscreen' ? '退出全屏' : '全屏'}
                aria-pressed={composeSize === 'fullscreen'}
                onClick={() =>
                  changeSize(composeSize === 'fullscreen' ? 'normal' : 'fullscreen')
                }
                disabled={sending}
              >
                {composeSize === 'fullscreen' ? '⤢' : '⛶'}
              </button>
              <button
                type="button"
                className="compose-icon-btn compose-close"
                title="关闭"
                aria-label="关闭"
                onClick={requestClose}
                disabled={sending}
              >
                ×
              </button>
            </>
          )}
        </div>

        {dragOver ? (
          <div className="compose-drop-overlay" role="presentation">
            <div className="compose-drop-hint">
              <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <path d="M17 8l-5-5-5 5" />
                <path d="M12 3v12" />
              </svg>
              <span>松开鼠标，把文件作为附件添加</span>
            </div>
          </div>
        ) : null}

        <div className="modal-body compose-body" ref={bodyRef}>
          {variant === 'inline' ? (
            <button
              type="button"
              className="compose-send-side"
              title={sendLabel}
              aria-label={sendLabel}
              onClick={() => void handleSend()}
              disabled={sending || pending !== null || sentAt !== null || !accountEmail}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="m22 2-7 20-4-9-9-4Z" />
                <path d="M22 2 11 13" />
              </svg>
              <span>{sendLabelShort}</span>
            </button>
          ) : null}
          <div className="compose-fields">
            <div className="compose-field-row compose-from">
              <label className="compose-field-label" htmlFor="compose-from">
                发件人
              </label>
              <select
                id="compose-from"
                className="compose-field-input compose-field-select"
                value={fromId}
                onChange={(event) => changeFrom(event.target.value)}
                disabled={pending !== null || accounts.length === 0}
              >
                {accounts.length === 0 ? <option value="">没有启用的账户</option> : null}
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.displayName} &lt;{account.email}&gt;
                  </option>
                ))}
              </select>
            </div>
            {accounts.length === 0 ? (
              <p className="hint compose-fields-hint">请先在「设置 → 账户」添加并启用账户。</p>
            ) : null}
          </div>

          {composePluginId ? (
            <div className="compose-plugin-takeover">
              <p className="compose-plugin-note">
                撰写界面由插件 {composePluginId} 接管，发件与发送仍由宿主控制
              </p>
              <PluginView
                pluginId={composePluginId}
                slot="compose-view"
                accountId={fromId}
                className="compose-plugin-view"
                title="插件撰写视图"
              />
            </div>
          ) : (
            <>
          <div className="compose-fields">
          <div className="compose-field-row compose-to">
            <label className="compose-field-label" htmlFor="compose-to">
              收件人
            </label>
            <input
              id="compose-to"
              className="compose-field-input"
              value={to}
              onChange={(event) => {
                setTo(event.target.value);
                searchContacts(event.target.value);
              }}
              onBlur={() => window.setTimeout(() => setSuggestions([]), 150)}
              autoComplete="off"
              disabled={pending !== null}
            />
            {suggestions.length > 0 && pending === null ? (
              <ul className="contact-suggestions" role="listbox" aria-label="联系人建议">
                {suggestions.map((suggestion) => (
                  <li key={suggestion.email}>
                    <button type="button" onMouseDown={() => applySuggestion(suggestion)}>
                      <span>{suggestion.displayName || suggestion.email}</span>
                      <span className="hint">{suggestion.email}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {pending === null ? (
              <button
                type="button"
                className="compose-cc-toggle"
                aria-pressed={showCc}
                onClick={() => setShowCc((value) => !value)}
              >
                {showCc ? '收起抄送' : '抄送/密送'}
              </button>
            ) : null}
          </div>

          {showCc ? (
          <>
          <div className="compose-field-row">
            <label className="compose-field-label" htmlFor="compose-cc">
              抄送
            </label>
            <input
              id="compose-cc"
              className="compose-field-input"
              value={cc}
              onChange={(event) => setCc(event.target.value)}
              autoComplete="off"
              disabled={pending !== null}
            />
          </div>

          <div className="compose-field-row">
            <label className="compose-field-label" htmlFor="compose-bcc">
              密送
            </label>
            <input
              id="compose-bcc"
              className="compose-field-input"
              value={bcc}
              onChange={(event) => setBcc(event.target.value)}
              autoComplete="off"
              disabled={pending !== null}
            />
          </div>
          </>
          ) : null}

          <div className="compose-field-row compose-subject">
            <label className="compose-field-label" htmlFor="compose-subject">
              主题
            </label>
            <input
              id="compose-subject"
              className="compose-field-input"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              disabled={pending !== null}
            />
          </div>
          </div>

          <div className="field compose-editor-field">
            <RichTextEditor
              id="compose-body"
              value={html}
              disabled={pending !== null}
              placeholder="写信内容…"
              onChange={(next) => {
                setHtml(next);
                setBody(htmlToPlainText(next));
              }}
            />
          </div>

          <div className="compose-tools">
            <button
              type="button"
              className="compose-tool"
              title="添加附件（最多 10 个，单个不超过 25 MB）"
              onClick={() => void addAttachments()}
              disabled={pending !== null || sentAt !== null || attachments.length >= 10}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
              添加附件
            </button>
            <button
              type="button"
              className="compose-tool"
              aria-pressed={showSchedule}
              onClick={() => setShowSchedule((value) => !value)}
              disabled={pending !== null || sentAt !== null}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 2" />
              </svg>
              定时发送
            </button>
            {showSchedule || sendAtInput.trim() ? (
              <input
                id="compose-send-at"
                className="compose-schedule-input"
                type="datetime-local"
                value={sendAtInput}
                onChange={(event) => setSendAtInput(event.target.value)}
                disabled={pending !== null || sentAt !== null}
              />
            ) : null}
          </div>

          {attachments.length > 0 ? (
            <ul className="compose-attachment-chips">
              {attachments.map((item) => (
                <li key={item.id} className="compose-attachment-chip">
                  <span className="name" title={item.filename}>
                    {item.filename}
                  </span>
                  <span className="hint">{formatFileSize(item.size)}</span>
                  <button
                    type="button"
                    title="移除"
                    aria-label={`移除 ${item.filename}`}
                    onClick={() => void removeAttachment(item.id)}
                    disabled={pending !== null || sentAt !== null}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

            </>
          )}

          {error ? <p className="error-banner">{error}</p> : null}

          {pending ? (
            <div className="undo-bar" role="status">
              <span>
                已定时：{formatSendTime(pending.sendAt)} 发送（剩余 {formatCountdown(remaining)}）
              </span>
              <button type="button" className="btn" onClick={() => void cancelSchedule()}>
                取消定时
              </button>
            </div>
          ) : sentAt ? (
            <p className="hint">
              {sendAtInput.trim()
                ? `已加入发送队列，将于 ${formatSendTime(sentAt)} 发送。`
                : '邮件已立即提交发送队列。'}
            </p>
          ) : null}
        </div>

        {variant === 'inline' ? null : (
          <div className="compose-footer">
          <span className="compose-saved">
            {draftSavedAt
              ? `已自动保存 ${new Date(draftSavedAt).toLocaleTimeString('zh-CN', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}`
              : ''}
          </span>
          <span className="compose-footer-spacer" />
          <button type="button" className="btn" onClick={requestClose} disabled={sending}>
            {pending || sentAt ? '关闭' : t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void handleSend()}
            disabled={sending || pending !== null || sentAt !== null || !accountEmail}
          >
            {sendLabel}
          </button>
          </div>
        )}
    </div>
  );

  if (variant === 'inline') {
    return <div className="compose-inline-host">{card}</div>;
  }

  return (
    <div
      className={`overlay${composeSize === 'fullscreen' ? ' compose-overlay-fullscreen' : ''}`}
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && !sending && requestClose()}
    >
      {card}
    </div>
  );
}
