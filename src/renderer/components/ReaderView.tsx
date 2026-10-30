import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GetBodyResponse } from '../../shared/ipc';
import type { EmailAddress, EmailSummary } from '../../shared/types';
import { buildReaderDocument, readReaderTheme } from '../lib/reader-document';
import { elementFromEvent } from '../lib/reader-events';
import { avatarFor, formatFullDate } from '../lib/format';
import { useTimeFormat } from '../lib/use-time-format';
import { useTimeZone } from '../lib/use-time-zone';
import { findMatchRanges, MAX_MATCHES, parseHighlightTerms } from '../lib/search-highlight';
import { PluginView } from './PluginView';
import { AttachmentList } from './AttachmentList';
import { HighlightedText } from './HighlightedText';
import { ReaderContextMenu, type ReaderMenuTarget } from './ReaderContextMenu';

/** 正文高亮用的 Custom Highlight 名（对应 reader-document.ts 里的 ::highlight）。 */
const BODY_HIGHLIGHT = 'mf-search';

/** 只用到宿主侧访问 iframe 的 Custom Highlight API；缺失时静默降级。 */
interface HighlightApiWindow {
  Highlight?: new (...ranges: Range[]) => unknown;
  CSS?: {
    highlights?: {
      set(name: string, highlight: unknown): void;
      delete(name: string): void;
    };
  };
}

/**
 * 在正文里收集命中区间。
 *
 * 用 Range + CSS Custom Highlight API，而不是往正文插 `<mark>`：不改变 DOM、
 * 不触发重排，因此链接拦截、右键菜单和 iframe 自适应高度都不受影响。
 */
function collectBodyRanges(doc: Document, terms: string[]): Range[] {
  const root = doc.body;
  if (!root || terms.length === 0) return [];

  const ranges: Range[] = [];
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  let node = walker.nextNode();
  let visited = 0;

  while (node && visited < 20000 && ranges.length < MAX_MATCHES) {
    visited += 1;
    const text = node.nodeValue ?? '';
    const tag = node.parentElement?.tagName?.toUpperCase() ?? '';
    const highlightable =
      text.length > 0 && tag !== 'SCRIPT' && tag !== 'STYLE' && tag !== 'NOSCRIPT';
    if (highlightable) {
      for (const match of findMatchRanges(text, terms, MAX_MATCHES - ranges.length)) {
        const range = doc.createRange();
        range.setStart(node, match.start);
        range.setEnd(node, match.end);
        ranges.push(range);
      }
    }
    node = walker.nextNode();
  }

  return ranges;
}

interface ReaderViewProps {
  email: EmailSummary | null;
  body: GetBodyResponse | null;
  loading: boolean;
  allowRemoteImages: boolean;
  readerPluginId: string | null;
  injectionPluginIds: string[];
  accountId?: string | null;
  /** 是否处于搜索态；配合 searchQuery 在标题与正文里标出命中。 */
  searchActive?: boolean;
  searchQuery?: string;
  /**
   * 独立阅读窗口模式：工具栏只保留「回复 / 全部回复 / 转发」与远程图片开关，
   * 其余依赖主列表状态的动作（星标、已读、归档、删除、稍后提醒、置顶）不出现，
   * 避免在弹窗里给出点了没反应或与主窗口不同步的按钮。
   */
  standalone?: boolean;
  onToggleImages(value: boolean): void;
  onTogglePin(): void;
  onSnooze(until: number | null): void;
  /** 账户是否具备归档文件夹；没有时禁用归档按钮，避免点出错误提示。 */
  canArchive: boolean;
  onReply(): void;
  onReplyAll(): void;
  onForward(): void;
  onToggleRead(): void;
  onToggleStar(): void;
  onArchive(): void;
  onDelete(): void;
  /**
   * 空格读到末尾（或正文不足一屏）时切到下一封。仅主窗口提供；
   * 独立阅读窗口没有「下一封」的概念，不传即可（空格只翻页）。
   */
  onNextEmail?: () => void;
}

/** 名片里的身份标签。 */
const ADDRESS_ROLE_LABEL: Record<'from' | 'to', string> = {
  from: '发件人',
  to: '收件人',
};

/** 名片卡片宽度（与 styles.css 的 .reader-address-card 保持一致，用于判断左右贴边）。 */
const ADDRESS_CARD_WIDTH = 268;

/**
 * 联系人名片：悬停/聚焦名称时弹出，显示姓名、身份与完整邮箱。
 *
 * 收件人一行不再内联显示邮箱（用户要求只显示名称），所以邮箱本身要能取走：
 * 双击名片里的邮箱地址即复制（不再放一个占位置的按钮）。
 */
function AddressCard({
  address,
  role,
  alignRight,
}: {
  address: EmailAddress;
  role: 'from' | 'to';
  alignRight: boolean;
}): JSX.Element {
  const avatar = avatarFor([address]);
  const title = address.name?.trim() || address.address;
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const copy = async (): Promise<void> => {
    const result = await window.api.copyText(address.address);
    if (!result.ok) return;
    setCopied(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      className={`reader-address-card${alignRight ? ' align-right' : ''}`}
      role="dialog"
      aria-label={`${title} 的联系人信息`}
    >
      <div className="reader-address-card-head">
        <span
          className="mail-avatar reader-address-card-avatar"
          style={{ backgroundColor: avatar.color }}
          aria-hidden="true"
        >
          {avatar.initial}
        </span>
        <div className="reader-address-card-id">
          <strong>{title}</strong>
          <span className="reader-address-card-role">{ADDRESS_ROLE_LABEL[role]}</span>
        </div>
      </div>
      <div className="reader-address-card-row">
        <span className="reader-address-card-label">邮箱</span>
        {/*
          鼠标双击复制；键盘用户 Tab 到这里按回车/空格同样能复制——
          没有这条通路，纯键盘用户就永远拿不到这个地址（名片里也没有别的出口）。
        */}
        <span
          className="reader-address-card-value"
          role="button"
          tabIndex={0}
          title="双击或按回车复制邮箱"
          onDoubleClick={() => void copy()}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              void copy();
            }
          }}
        >
          {address.address}
        </span>
        {copied ? (
          <span className="reader-address-card-copied" role="status">
            已复制
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 地址行：`标签：名称`，多个地址用逗号分隔；名称悬停/聚焦弹出联系人名片。
 *
 * 名称缺失时显示邮箱（否则这一行没有可识别的东西）；地址为空时用 emptyText 占位，
 * 没给 emptyText 就整行不渲染（例如没有收件人时不必留一个空标签）。
 */
function AddressLine({
  label,
  addresses,
  className,
  role,
  emptyText,
}: {
  label: string;
  addresses: EmailAddress[];
  className: string;
  role: 'from' | 'to';
  emptyText?: string;
}): JSX.Element | null {
  const [open, setOpen] = useState<{ key: string; alignRight: boolean } | null>(null);

  if (addresses.length === 0) {
    if (!emptyText) return null;
    return (
      <div className={className}>
        <span className="reader-meta-label">{label}</span>
        {emptyText}
      </div>
    );
  }

  /** 贴右边缘时改为右对齐，避免名片被阅读区裁掉。 */
  const openAt = (element: HTMLElement, key: string): void => {
    const rect = element.getBoundingClientRect();
    const pane = element.closest('.reader-pane');
    const rightEdge = pane ? pane.getBoundingClientRect().right : window.innerWidth;
    setOpen({ key, alignRight: rect.left + ADDRESS_CARD_WIDTH > rightEdge - 16 });
  };

  const closeAt = (key: string): void => {
    setOpen((current) => (current?.key === key ? null : current));
  };

  return (
    <div className={className}>
      <span className="reader-meta-label">{label}</span>
      {addresses.map((item, index) => {
        const key = `${item.address}-${index}`;
        const isOpen = open?.key === key;
        const name = item.name?.trim();
        return (
          <span
            className="reader-address"
            key={key}
            onMouseEnter={(event) => openAt(event.currentTarget, key)}
            onMouseLeave={() => closeAt(key)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') closeAt(key);
            }}
            onBlur={(event) => {
              // 焦点移到名片里的按钮（仍在同一个包裹层内）时不关闭
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) closeAt(key);
            }}
          >
            <button
              type="button"
              className="reader-address-name"
              aria-haspopup="dialog"
              aria-expanded={isOpen}
              onFocus={(event) => {
                const wrapper = event.currentTarget.parentElement;
                openAt(wrapper ?? event.currentTarget, key);
              }}
            >
              {name ? <strong>{name}</strong> : item.address}
            </button>
            {index < addresses.length - 1 ? ', ' : null}
            {isOpen && open ? (
              <AddressCard address={item} role={role} alignRight={open.alignRight} />
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

export function ReaderView({
  email,
  body,
  loading,
  allowRemoteImages,
  readerPluginId,
  injectionPluginIds,
  accountId,
  searchActive = false,
  searchQuery = '',
  standalone = false,
  onToggleImages,
  onTogglePin,
  onSnooze,
  canArchive,
  onReply,
  onReplyAll,
  onForward,
  onToggleRead,
  onToggleStar,
  onArchive,
  onDelete,
  onNextEmail,
}: ReaderViewProps): JSX.Element {
  const timeFormat = useTimeFormat();
  const timeZone = useTimeZone();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const readerPaneRef = useRef<HTMLElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  /** 用 ref 保存回调，让空格监听保持稳定，避免每次渲染都重新挂监听。 */
  const onNextEmailRef = useRef(onNextEmail);
  useEffect(() => {
    onNextEmailRef.current = onNextEmail;
  }, [onNextEmail]);

  const [translation, setTranslation] = useState<string | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [translationBusy, setTranslationBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryBusy, setSummaryBusy] = useState(false);
  /** 正文右键菜单的落点；null 表示不显示。 */
  const [menu, setMenu] = useState<ReaderMenuTarget | null>(null);

  /**
   * 空格单键阅读：先向下翻一屏；已经到底（或内容不足一屏）就交给 onNextEmail。
   * 正文在 iframe 里时按键事件不会冒泡到父窗口，所以还要在 contentDocument 上单独监听。
   */
  const handleSpace = useCallback((event: KeyboardEvent): void => {
    if (event.key !== ' ' && event.code !== 'Space') return;

    // 输入框 / 按钮 / 链接里的空格交给控件自己处理
    const target = event.target as HTMLElement | null;
    if (target) {
      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return;
      if (tag === 'BUTTON' || tag === 'A') return;
    }

    const pane = readerPaneRef.current;
    if (!pane) return;

    const maxScroll = pane.scrollHeight - pane.clientHeight;
    const atBottom = maxScroll <= 4 || pane.scrollTop >= maxScroll - 4;

    // 无论翻页还是切下一封都拦下默认行为，避免同时滚动外层容器
    event.preventDefault();

    if (atBottom) {
      onNextEmailRef.current?.();
      return;
    }

    const step = Math.max(120, pane.clientHeight - 64);
    if (typeof pane.scrollBy === 'function') {
      pane.scrollBy({ top: step, behavior: 'smooth' });
    } else {
      pane.scrollTop = Math.min(maxScroll, pane.scrollTop + step);
    }
  }, []);

  // 切邮件时把阅读区滚回顶部：否则空格读完上一封会停在下一封的中间
  useEffect(() => {
    const pane = readerPaneRef.current;
    if (pane) pane.scrollTop = 0;
  }, [email?.id]);

  // 焦点在阅读区（工具栏 / 空白处）时也能用空格翻页；焦点在列表或搜索框时不动
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const pane = readerPaneRef.current;
      if (!pane) return;
      const active = document.activeElement;
      if (active !== pane && !(active instanceof Node && pane.contains(active))) return;
      handleSpace(event);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleSpace]);

  useEffect(() => {
    setTranslation(null);
    setShowOriginal(false);
    setNotice(null);
    setSummary(null);
  }, [email?.id]);

  // 正文重载（切邮件 / 切换远程图片）后，旧的右键落点已经失效
  useEffect(() => {
    setMenu(null);
  }, [body, allowRemoteImages, email?.id]);

  const translate = useCallback(async (confirmLong = false) => {
    if (!email) return;
    setTranslationBusy(true);
    setNotice(null);
    const result = await window.api.translateEmail({ emailId: email.id, confirmLong });
    setTranslationBusy(false);
    if (!result.ok) {
      setNotice(result.error.message);
      return;
    }
    const outcome = result.data;
    if (outcome.status === 'ok') {
      setTranslation(outcome.text);
      setShowOriginal(false);
      if (outcome.cached) setNotice('已使用本地翻译缓存，未重复消耗额度。');
      return;
    }
    if (outcome.status === 'needs_confirm') {
      setNotice(outcome.message);
      if (window.confirm(outcome.message)) await translate(true);
      return;
    }
    if (outcome.status === 'skipped') {
      setNotice(outcome.reason === 'same-language' ? '正文已经是目标语言，无需翻译。' : '正文为空，无法翻译。');
      return;
    }
    setNotice(outcome.message);
  }, [email]);

  const summarize = useCallback(async () => {
    if (!email) return;
    setSummaryBusy(true);
    setNotice(null);
    const result = await window.api.summarizeEmail(email.id);
    setSummaryBusy(false);
    if (!result.ok) {
      setNotice(result.error.message);
      return;
    }
    setSummary(result.data.summary);
  }, [email]);

  const documentHtml = useMemo(() => {
    if (!body) return '';
    return buildReaderDocument(body.html, {
      allowRemoteImages,
      theme: readReaderTheme(),
    });
  }, [body, allowRemoteImages]);

  // 命中词只解析一次；非搜索态为空数组，标题与正文都不做标记
  const searchTerms = useMemo(
    () => (searchActive && searchQuery ? parseHighlightTerms(searchQuery) : []),
    [searchActive, searchQuery],
  );

  /**
   * 正文命中高亮：用 iframe 的 CSS Custom Highlight API。
   * 不修改正文 DOM，因此不影响链接拦截、右键菜单与自适应高度；
   * 旧内核没有该 API 时静默跳过（列表与标题仍然高亮）。
   */
  const applyBodyHighlight = useCallback((): void => {
    const frame = iframeRef.current;
    if (!frame) return;

    try {
      const win = frame.contentWindow as unknown as HighlightApiWindow | null;
      const doc = frame.contentDocument;
      if (!win || !doc) return;

      const registry = win.CSS?.highlights;
      registry?.delete(BODY_HIGHLIGHT);
      if (!registry || typeof win.Highlight !== 'function' || searchTerms.length === 0) return;

      const ranges = collectBodyRanges(doc, searchTerms);
      if (ranges.length === 0) return;
      registry.set(BODY_HIGHLIGHT, new win.Highlight(...ranges));
    } catch {
      // 跨 realm 访问失败 / 内核不支持：保持正文原样
    }
  }, [searchTerms]);

  /**
   * 链接拦截（§10.1）：iframe 无 allow-scripts，因此由宿主在 contentDocument
   * 上挂监听（allow-same-origin 使父文档可访问）。所有点击交给主进程解析。
   */
  const attachLinkGuard = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;

    const frame = iframeRef.current;
    if (!frame) return;

    let frameDocument: Document | null = null;
    try {
      frameDocument = frame.contentDocument;
    } catch {
      frameDocument = null;
    }
    if (!frameDocument) return;

    const handler = (event: Event): void => {
      // 注意：正文 iframe 属于另一个 realm，不能用 instanceof Element 判断
      const target = elementFromEvent(event);
      if (!target) return;
      const anchor = target.closest('a');
      if (!anchor) return;

      event.preventDefault();
      event.stopPropagation();

      const href = anchor.getAttribute('href');
      if (!href) return;

      void window.api.openExternal(href).then((result) => {
        if (!result.ok) {
          // 只记录，不向正文注入任何 UI
          console.warn('链接被拒绝：', result.error.message);
        }
      });
    };

    frameDocument.addEventListener('click', handler, true);
    frameDocument.addEventListener('auxclick', handler, true);

    // 正文右键：图片可复制/另存为，空白处可复制选中文本（iframe 无脚本，只能在宿主侧监听）
    const doc = frameDocument;
    const handleContextMenu = (event: MouseEvent): void => {
      event.preventDefault();
      const target = elementFromEvent(event);
      if (!target) return;

      const imageElement = target.closest('img');
      const frameRect = frame.getBoundingClientRect();

      let selection = '';
      try {
        selection = frame.contentWindow?.getSelection()?.toString() ?? '';
      } catch {
        selection = '';
      }

      let image: ReaderMenuTarget['image'] = null;
      if (imageElement) {
        // 被拦截的远程图片只挂着 1px 透明占位，src 不能拿去复制/保存
        const blocked = imageElement.getAttribute('data-mf-placeholder') === '1';
        image = {
          src: blocked ? '' : (imageElement.getAttribute('src') ?? ''),
          blockedSrc: blocked ? (imageElement.getAttribute('data-mf-blocked-src') ?? '') : '',
          alt: imageElement.getAttribute('alt') ?? '',
        };
      }

      setMenu({
        x: frameRect.left + event.clientX,
        y: frameRect.top + event.clientY,
        image,
        selection,
        hasBlockedImages: doc.querySelectorAll('img[data-mf-placeholder="1"]').length > 0,
      });
    };
    doc.addEventListener('contextmenu', handleContextMenu);

    // 空格单键阅读：焦点在正文里时，按键事件只在 iframe 内部冒泡，
    // 父窗口收不到，必须在正文文档上单独挂监听。
    const handleFrameKeyDown = (event: KeyboardEvent): void => {
      handleSpace(event);
    };
    doc.addEventListener('keydown', handleFrameKeyDown);

    // 让 iframe 高度贴合正文：沙箱允许 same-origin，父文档可读 scrollHeight
    const fitHeight = (): void => {
      try {
        const doc = frame.contentDocument;
        if (!doc) return;
        const measured = doc.documentElement.scrollHeight;
        if (measured <= 0) return;
        // 逐次 +4px 直到内容不再溢出，避免出现内层滚动条
        let target = Math.max(320, measured + 12);
        frame.style.height = `${Math.min(4000, target)}px`;
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const overflow = doc.documentElement.scrollHeight;
          if (overflow <= target) break;
          target = overflow + 4;
          frame.style.height = `${Math.min(4000, target)}px`;
        }
        // 已按内容撑满时关掉内层滚动，外层统一由阅读区滚动
        if (target <= 4000) doc.documentElement.style.overflowY = 'hidden';
      } catch {
        // 文档不可访问时保持默认高度
      }
    };
    fitHeight();
    const fitTimer = window.setTimeout(fitHeight, 300);

    // 正文每次重新加载（换邮件 / 允许远程图片）都要重新标命中
    applyBodyHighlight();

    cleanupRef.current = () => {
      window.clearTimeout(fitTimer);
      try {
        frameDocument?.removeEventListener('click', handler, true);
        frameDocument?.removeEventListener('auxclick', handler, true);
        frameDocument?.removeEventListener('contextmenu', handleContextMenu);
        frameDocument?.removeEventListener('keydown', handleFrameKeyDown);
      } catch {
        // 文档可能已卸载
      }
    };
  }, [applyBodyHighlight, handleSpace]);

  useEffect(() => {
    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, []);

  // 搜索词变化（或正文重建）时刷新高亮；iframe 未加载完时由 onLoad 兜底
  useEffect(() => {
    applyBodyHighlight();
  }, [applyBodyHighlight, documentHtml]);

  /** 右键「全选」：选区在 iframe 文档里，宿主只能通过 contentWindow 操作。 */
  const handleSelectAll = useCallback((): void => {
    const frame = iframeRef.current;
    try {
      const doc = frame?.contentDocument;
      const win = frame?.contentWindow;
      if (!doc || !win || !doc.body) return;
      const range = doc.createRange();
      range.selectNodeContents(doc.body);
      const selection = win.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    } catch {
      // 文档不可访问时忽略
    }
  }, []);

  if (!email) {
    return (
      <section className="reader-pane" aria-label="阅读区域">
        <div className="reader-placeholder">
          <p>选择左侧的一封邮件查看正文。</p>
          <p className="hint">邮件 HTML 会在主进程净化后，注入无脚本沙箱 iframe 渲染。</p>
        </div>
      </section>
    );
  }

  const blocked = body?.blockedRemoteImages ?? 0;
  const avatar = avatarFor(email.from);
  /** 翻译对照用的「原文」：完整正文纯文本，没取到正文才退化成列表摘要。 */
  const originalText = body?.text?.trim() ? body.text : email.snippet;

  return (
    <section
      className="reader-pane"
      aria-label="阅读区域"
      ref={readerPaneRef}
      tabIndex={-1}
      onClick={(event) => {
        // 点阅读区空白处时把焦点交给阅读区，空格才能翻页（不抢按钮/链接）
        if (event.target === event.currentTarget) event.currentTarget.focus();
      }}
    >
      {injectionPluginIds.length > 0 ? (
        <div className="plugin-injections" aria-label="插件面板">
          {injectionPluginIds.map((pluginId) => (
            <div className="plugin-injection" key={pluginId}>
              <PluginView
                pluginId={pluginId}
                slot="reader-panel-top"
                accountId={accountId ?? null}
              />
            </div>
          ))}
        </div>
      ) : null}

      <div className="reader-toolbar">
        {standalone ? (
          <>
            {!allowRemoteImages && blocked > 0 ? (
              <button type="button" className="btn btn-sm" onClick={() => onToggleImages(true)}>
                显示远程图片（{blocked}）
              </button>
            ) : null}
            {allowRemoteImages ? (
              <button type="button" className="btn btn-sm" onClick={() => onToggleImages(false)}>
                阻止远程图片
              </button>
            ) : null}
            {loading ? <span className="hint">正在获取正文…</span> : null}
            <span className="reader-toolbar-spacer" />
            <button type="button" className="btn btn-sm" onClick={onReply}>
              回复
            </button>
            <button type="button" className="btn btn-sm" onClick={onReplyAll}>
              全部回复
            </button>
            <button type="button" className="btn btn-sm" onClick={onForward}>
              转发
            </button>
          </>
        ) : (
          <>
        <button type="button" className="icon-btn" title="回复" aria-label="回复" onClick={onReply}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M9 17H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h14" />
            <path d="m9 17-5-5 5-5" />
            <path d="M21 7v4a4 4 0 0 1-4 4h-8" />
          </svg>
        </button>
        <button
          type="button"
          className="icon-btn"
          title="全部回复"
          aria-label="全部回复"
          onClick={onReplyAll}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M7 17H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h13" />
            <path d="m7 17-4-4 4-4" />
            <path d="M12 17H9a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h13" />
            <path d="m12 17-4-4 4-4" />
          </svg>
        </button>
        <button
          type="button"
          className="icon-btn"
          title="转发"
          aria-label="转发"
          onClick={onForward}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M15 17h4a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2H5" />
            <path d="m15 17 5-5-5-5" />
            <path d="M3 7v4a4 4 0 0 0 4 4h8" />
          </svg>
        </button>
        <span className="reader-toolbar-divider" aria-hidden="true" />

        <button
          type="button"
          className="icon-btn"
          title={email.starred ? '取消星标' : '加星标'}
          aria-label={email.starred ? '取消星标' : '加星标'}
          aria-pressed={email.starred}
          onClick={onToggleStar}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill={email.starred ? 'currentColor' : 'none'}
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z" />
          </svg>
        </button>
        <button
          type="button"
          className="icon-btn"
          title={email.unread ? '标记为已读' : '标记为未读'}
          aria-label={email.unread ? '标记为已读' : '标记为未读'}
          onClick={onToggleRead}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="2" y="5" width="20" height="14" rx="2" />
            <path d="m2 7 10 7 10-7" />
          </svg>
        </button>
        <button
          type="button"
          className="icon-btn"
          title={canArchive ? '归档' : '该账户没有归档文件夹'}
          aria-label="归档"
          disabled={!canArchive}
          onClick={onArchive}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="2" y="4" width="20" height="5" rx="1" />
            <path d="M4 9v10a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9" />
            <path d="M10 13h4" />
          </svg>
        </button>
        <button
          type="button"
          className="icon-btn icon-btn-danger"
          title="删除"
          aria-label="删除"
          onClick={onDelete}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 6h18" />
            <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
            <path d="M19 6v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6" />
            <path d="M10 11v6M14 11v6" />
          </svg>
        </button>
        <span className="reader-toolbar-divider" aria-hidden="true" />

        {!allowRemoteImages && blocked > 0 ? (
          <button
            type="button"
            className="icon-btn"
            title={`显示远程图片（${blocked}）`}
            aria-label="显示远程图片"
            onClick={() => onToggleImages(true)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <path d="m21 15-5-5L5 21" />
            </svg>
          </button>
        ) : null}

        {allowRemoteImages ? (
          <button
            type="button"
            className="icon-btn"
            title="阻止远程图片"
            aria-label="阻止远程图片"
            onClick={() => onToggleImages(false)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="m3 3 18 18" />
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
            </svg>
          </button>
        ) : null}

        <button
          type="button"
          className="icon-btn"
          title={translation ? '重新翻译' : '翻译'}
          aria-label="翻译"
          onClick={() => void translate()}
          disabled={translationBusy}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="m5 8 6 6" />
            <path d="m4 14 6-6 2-3" />
            <path d="M2 5h12" />
            <path d="M7 2h1" />
            <path d="m22 22-5-10-5 10" />
            <path d="M14 18h6" />
          </svg>
        </button>

        <button
          type="button"
          className="icon-btn"
          title="AI 摘要"
          aria-label="AI 摘要"
          onClick={() => void summarize()}
          disabled={summaryBusy}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 3v3M12 18v3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M3 12h3M18 12h3M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
            <circle cx="12" cy="12" r="3.2" />
          </svg>
        </button>

        <label className="icon-select" title="稍后提醒">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </svg>
          <select
            aria-label="稍后提醒"
            value=""
            onChange={(event) => {
              const value = event.target.value;
              if (!value) return;
              const now = Date.now();
              if (value === 'hour') onSnooze(now + 60 * 60 * 1000);
              else if (value === 'tomorrow') onSnooze(now + 24 * 60 * 60 * 1000);
              else if (value === 'week') onSnooze(now + 7 * 24 * 60 * 60 * 1000);
              else if (value === 'unsnooze') onSnooze(null);
              event.target.value = '';
            }}
          >
            <option value="">稍后提醒</option>
            <option value="hour">1 小时后</option>
            <option value="tomorrow">明天此时</option>
            <option value="week">下周此时</option>
            {email.snoozedUntil ? <option value="unsnooze">取消提醒</option> : null}
          </select>
        </label>

        <button
          type="button"
          className={`icon-btn${email.pinned ? ' icon-btn-active' : ''}`}
          title={email.pinned ? '取消置顶' : '置顶'}
          aria-label={email.pinned ? '取消置顶' : '置顶'}
          aria-pressed={email.pinned}
          onClick={onTogglePin}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill={email.pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2">
            <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 16.8 5.8 21.3l2.4-7.4L2 9.4h7.6z" />
          </svg>
        </button>

        <span className="reader-toolbar-spacer" />
        {loading ? <span className="hint">正在获取正文…</span> : null}
        {!loading && blocked > 0 && !allowRemoteImages ? (
          <button type="button" className="reader-image-consent" onClick={() => onToggleImages(true)}>
            已阻止 {blocked} 张远程图片，点击显示
          </button>
        ) : null}
          </>
        )}
      </div>

      {notice ? <p className="reader-notice">{notice}</p> : null}

      <header className="reader-header">
        <h1 className="reader-subject">
          <HighlightedText text={email.subject} terms={searchTerms} />
        </h1>
        <div className="reader-meta">
          <span className="mail-avatar reader-avatar" style={{ backgroundColor: avatar.color }} aria-hidden="true">
            {avatar.initial}
          </span>
          <div className="reader-meta-body">
            <AddressLine
              label="发件人："
              addresses={email.from}
              className="reader-meta-from"
              role="from"
              emptyText="（未知发件人）"
            />
            <AddressLine
              label="收件人："
              addresses={email.to}
              className="reader-meta-to"
              role="to"
            />
          </div>
          <time className="reader-meta-date" dateTime={email.date}>
            {formatFullDate(email.date, timeFormat, timeZone)}
          </time>
        </div>
      </header>

      {summary ? (
        <section className="reader-ai" aria-label="AI 摘要">
          <div className="reader-ai-head">
            <strong>AI 摘要</strong>
            <span className="statusbar-spacer" />
            <button type="button" className="btn btn-sm" onClick={() => setSummary(null)}>
              收起
            </button>
          </div>
          <pre className="reader-ai-body">{summary}</pre>
        </section>
      ) : null}

      {translation ? (
        <section className="reader-translation" aria-label="翻译">
          <div className="reader-ai-head">
            <strong>{showOriginal ? '原文' : '译文'}</strong>
            <span className="statusbar-spacer" />
            <button type="button" className="btn btn-sm" onClick={() => setShowOriginal(!showOriginal)}>
              {showOriginal ? '显示译文' : '显示原文'}
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setTranslation(null)}>
              关闭
            </button>
          </div>
          {/* 原文必须是完整正文，不是列表里那一行摘要：
              否则用户点「显示原文」只看到一截片段，反而更困惑。 */}
          <pre className="reader-ai-body">{showOriginal ? originalText : translation}</pre>
        </section>
      ) : null}

      {readerPluginId ? (
        <PluginView
          pluginId={readerPluginId}
          slot="reader-view"
          className="reader-frame plugin-reader"
          title="插件阅读视图"
          accountId={accountId ?? null}
        />
      ) : body ? (
        <iframe
          ref={iframeRef}
          className="reader-frame"
          title="邮件正文（沙箱）"
          // 硬约束：不含 allow-scripts
          sandbox="allow-same-origin"
          referrerPolicy="no-referrer"
          srcDoc={documentHtml}
          onLoad={attachLinkGuard}
        />
      ) : (
        <div className="reader-placeholder">{loading ? '正在载入正文…' : '暂无正文内容。'}</div>
      )}

      {/* 宿主附件与风险标记层：始终在插件 webview 之外（§11.5） */}
      <AttachmentList emailId={email.id} bodyReady={Boolean(body)} />

      {menu ? (
        <ReaderContextMenu
          target={menu}
          onClose={() => setMenu(null)}
          onSelectAll={handleSelectAll}
          onShowRemoteImages={() => {
            setMenu(null);
            onToggleImages(true);
          }}
        />
      ) : null}
    </section>
  );
}
