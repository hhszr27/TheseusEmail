import { useEffect, useRef, useState } from 'react';
import type { EmailSummary } from '../../shared/types';
import type { GetBodyResponse, MailtoRequest } from '../../shared/ipc';
import { useMailStore } from '../stores/mail-store';
import {
  buildComposeRequest,
  readComposeIncludeQuote,
  type ComposeKind,
} from '../lib/compose';
import { readMarkReadDelay } from '../lib/reading-settings';
import { applyTheme as applyThemeToDocument } from '../lib/theme';
import { THEME_SETTING_KEY } from '../../shared/theme';
import { ReaderView } from './ReaderView';
import { ComposeModal } from './ComposeModal';

/** 从 URL 读取主窗口双击时传入的邮件 id。 */
function emailIdFromQuery(): string {
  return new URLSearchParams(window.location.search).get('email') ?? '';
}

/** 主窗口点「回复/全部回复/转发」时，窗口直接以写信模式打开。 */
function composeKindFromQuery(): 'reply' | 'reply-all' | 'forward' | null {
  const value = new URLSearchParams(window.location.search).get('compose');
  return value === 'reply' || value === 'reply-all' || value === 'forward' ? value : null;
}

/**
 * 独立阅读窗口（真实 OS 窗口）。
 *
 * 由主窗口双击邮件时通过 `window:open-reader` 创建，加载 `reader.html` 并把目标邮件
 * 放在 `?email=<id>` 里。只渲染 ReaderView + ComposeModal，不加载侧栏/列表，
 * 因此打开它不会把整套邮件界面再跑一遍。
 *
 * 回复 / 全部回复 / 转发在本窗口内直接打开写信弹层，正文与收件人取自当前邮件。
 */
export function ReaderStandalone(): JSX.Element {
  const emailId = emailIdFromQuery();
  /** 主窗口点回复/转发打开的是「写信窗口」：关掉写信就关窗，而不是回到正文。 */
  const initialCompose = composeKindFromQuery();
  const initialComposeHandled = useRef(false);
  const [email, setEmail] = useState<EmailSummary | null>(null);
  const [body, setBody] = useState<GetBodyResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [allowRemoteImages, setAllowRemoteImages] = useState(false);
  const [compose, setCompose] = useState<MailtoRequest | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** 发送成功等提示走 store 的全局 toast；独立窗口也要把它显示出来。 */
  const toast = useMailStore((state) => state.toast);

  // 窗口标题：写信时显示回复/转发主题，回到阅读时显示原邮件主题
  useEffect(() => {
    const subject = compose?.subject || email?.subject;
    document.title = subject ? `${subject} — MailForge` : 'MailForge — 阅读';
  }, [compose, email]);

  /**
   * 账户列表供写信选择「发件人」；主题单独应用。
   * reloadBootstrap 只取数据、不处理主题（主题在主界面 init 里应用），
   * 所以这里补一次 applyTheme，独立窗口才能跟随主窗口的浅色/深色。
   */
  useEffect(() => {
    void (async () => {
      await useMailStore.getState().reloadBootstrap();
      const saved = await window.api.getSetting(THEME_SETTING_KEY);
      const themeId = saved.ok && saved.data ? saved.data : 'builtin:light';
      await applyThemeToDocument(themeId);
    })().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!emailId) {
      setLoadError('缺少邮件参数，无法打开阅读窗口。');
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void (async () => {
      const summary = await window.api.getEmail(emailId);
      if (cancelled) return;
      if (!summary.ok) {
        setLoadError(summary.error.message);
        setLoading(false);
        return;
      }
      setEmail(summary.data);
      const result = await window.api.getBody({ emailId, allowRemoteImages });
      if (cancelled) return;
      if (result.ok) setBody(result.data);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [emailId, allowRemoteImages]);

  /**
   * 打开阅读窗口即已读（与主窗口同一套延迟设置）。
   * 依赖 email 对象而不是 loading：切换远程图片会重跑正文加载，但不应重复标已读。
   */
  useEffect(() => {
    if (!emailId || !email || !email.unread) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    void readMarkReadDelay().then((delaySeconds) => {
      if (cancelled) return;
      if (delaySeconds === 0) {
        void window.api.setEmailFlags(emailId, { read: true });
        return;
      }
      timer = setTimeout(() => {
        if (!cancelled) void window.api.setEmailFlags(emailId, { read: true });
      }, delaySeconds * 1000);
    });
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [emailId, email]);

  const close = (): void => window.close();

  // Esc 关闭窗口；写信弹层打开时让 ComposeModal 自己处理 Esc
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !compose) close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [compose]);

  /** 用当前窗口的邮件与正文构造回复 / 全部回复 / 转发草稿。 */
  const openCompose = async (
    kind: ComposeKind,
    sourceEmail: EmailSummary,
    sourceBody: GetBodyResponse | null,
  ): Promise<void> => {
    // 设置里可以关闭「保留原邮件引用」：关闭后正文从空白开始
    const includeQuote = await readComposeIncludeQuote();
    const selfEmail = useMailStore
      .getState()
      .bootstrap?.accounts.find((account) => account.id === sourceEmail.accountId)?.email;
    setCompose(
      buildComposeRequest(
        kind,
        {
          from: sourceEmail.from,
          to: sourceEmail.to,
          subject: sourceEmail.subject,
          date: sourceEmail.date,
          text: sourceBody?.text ?? null,
          html: sourceBody?.html ?? null,
        },
        {
          ...(selfEmail ? { selfAddress: selfEmail } : {}),
          accountId: sourceEmail.accountId,
          text: sourceBody?.text ?? null,
          html: sourceBody?.html ?? null,
          includeQuote,
        },
      ),
    );
  };

  const handleReply = (kind: ComposeKind): void => {
    if (!email) return;
    void openCompose(kind, email, body);
  };

  // 主窗口点「回复/转发」直接打开本窗口时：邮件与正文就绪后立刻进入写信视图
  useEffect(() => {
    if (!initialCompose || initialComposeHandled.current || loading || !email) return;
    initialComposeHandled.current = true;
    void openCompose(initialCompose, email, body);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCompose, loading, email, body]);

  /**
   * 关闭写信：从主窗口直接打开的「写信窗口」关闭整个窗口（Outlook 行为）；
   * 从正文窗口里点的回复则回到正文。
   */
  const closeCompose = (): void => {
    if (initialCompose) {
      window.close();
      return;
    }
    setCompose(null);
  };

  return (
    <div className="reader-standalone">
      {compose ? (
        <ComposeModal
          variant="inline"
          inlineBackTitle={initialCompose ? '关闭写信' : '返回邮件'}
          request={compose}
          onClose={closeCompose}
          onSent={(message) => {
            useMailStore.getState().showToast(message);
            void useMailStore.getState().loadOutbox();
          }}
        />
      ) : loadError ? (
        <div className="reader-placeholder">
          <div className="reader-placeholder-inner">
            <p>{loadError}</p>
          </div>
        </div>
      ) : initialCompose ? (
        // 写信窗口不要先闪一下正文：正文取回前只显示加载态
        <div className="reader-placeholder">
          <div className="reader-placeholder-inner">
            <p>正在打开写信窗口…</p>
          </div>
        </div>
      ) : !email ? (
        <div className="reader-placeholder">
          <div className="reader-placeholder-inner">
            <p>正在加载邮件…</p>
          </div>
        </div>
      ) : (
        <ReaderView
          email={email}
          body={body}
          loading={loading}
          allowRemoteImages={allowRemoteImages}
          readerPluginId={null}
          injectionPluginIds={[]}
          accountId={email?.accountId ?? null}
          standalone
          onReply={() => handleReply('reply')}
          onReplyAll={() => handleReply('reply-all')}
          onForward={() => handleReply('forward')}
          onToggleImages={setAllowRemoteImages}
          onTogglePin={() => undefined}
          onSnooze={() => undefined}
          canArchive={false}
          onToggleRead={() => undefined}
          onToggleStar={() => undefined}
          onArchive={() => undefined}
          onDelete={() => undefined}
        />
      )}

      {toast ? (
        <div className="toast" role="status" aria-live="polite">
          {toast}
        </div>
      ) : null}
    </div>
  );
}
