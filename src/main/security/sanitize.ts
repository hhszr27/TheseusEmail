import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import { ALLOWED_HTML_TAGS, FORBIDDEN_HTML_TAGS } from '../../shared/constants';

/**
 * 邮件 HTML 净化（§10.1）。
 *
 * 唯一允许的净化入口。运行在主进程（jsdom 提供 DOM），渲染进程永远拿不到原始 HTML。
 * 硬约束：
 *  - 仅允许 HTML profile（排除 SVG / MathML）
 *  - 禁止 script / iframe / object / embed / form / input / meta / link / style 标签
 *  - 禁止所有 on* 事件属性
 *  - URI 白名单：http / https / mailto / data:image(光栅)
 *  - 远程内容防火墙：默认阻断所有远程 src / srcset，记录供 UI 提示
 */

const TRANSPARENT_PIXEL =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const RASTER_DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|bmp);base64,[a-z0-9+/=\s]+$/i;
const DANGEROUS_STYLE = /(url\s*\(|expression\s*\(|@import|behavior\s*:)/i;

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://localhost/',
  runScripts: 'outside-only',
});
const purifier = createDOMPurify(
  dom.window as unknown as Parameters<typeof createDOMPurify>[0],
);

interface SanitizeState {
  allowRemoteImages: boolean;
  blockedRemoteImages: number;
  remoteImages: Set<string>;
}

let state: SanitizeState = {
  allowRemoteImages: false,
  blockedRemoteImages: 0,
  remoteImages: new Set(),
};

function attrNameOf(data: { attrName?: string }): string {
  return (data.attrName ?? '').toLowerCase();
}

function isRemoteUrl(value: string): boolean {
  return /^\s*(?:https?:)?\/\//i.test(value);
}

function isRasterDataImage(value: string): boolean {
  return RASTER_DATA_IMAGE.test(value.trim());
}

purifier.addHook('uponSanitizeAttribute', (node, data) => {
  const name = attrNameOf(data);
  const value = String(data.attrValue ?? '');

  // 1) 所有 on* 事件属性：硬拒绝
  if (name.startsWith('on')) {
    data.keepAttr = false;
    return;
  }

  // 2) 内联样式中的远程/可执行内容
  if (name === 'style') {
    if (DANGEROUS_STYLE.test(value)) {
      data.keepAttr = false;
    }
    return;
  }

  // 3) srcset 永远阻断（远程图片变体，难以逐项审计）
  if (name === 'srcset') {
    if (isRemoteUrl(value)) {
      state.blockedRemoteImages += 1;
    }
    data.keepAttr = false;
    return;
  }

  // 4) 远程与 data: 资源
  if (name === 'src' || name === 'href' || name === 'background' || name === 'poster') {
    const tag = node.nodeName.toLowerCase();

    if (name === 'background' || name === 'poster') {
      data.keepAttr = false;
      return;
    }

    if (/^\s*data:/i.test(value)) {
      if (tag === 'img' && name === 'src' && isRasterDataImage(value)) {
        return; // 允许光栅内联图
      }
      data.keepAttr = false;
      return;
    }

    if (isRemoteUrl(value)) {
      if (tag === 'img' && name === 'src') {
        if (state.allowRemoteImages) {
          const absolute = value.startsWith('//') ? `https:${value}` : value;
          state.remoteImages.add(absolute);
          return;
        }
        state.blockedRemoteImages += 1;
        state.remoteImages.add(value.startsWith('//') ? `https:${value}` : value);
        node.setAttribute('data-mf-blocked-src', value);
        data.keepAttr = false;
        return;
      }

      // 链接保持原样，由 afterSanitizeAttributes 做协议校验
      if (name === 'href' && tag === 'a') {
        return;
      }

      data.keepAttr = false;
      return;
    }

    // 相对路径 / cid: / javascript: 等一律丢弃
    if (name === 'src') {
      data.keepAttr = false;
    }
  }
});

purifier.addHook('afterSanitizeAttributes', (node) => {
  const el = node as Element;

  if (el.nodeName.toLowerCase() === 'img') {
    if (!el.getAttribute('src') && el.hasAttribute('data-mf-blocked-src')) {
      el.setAttribute('src', TRANSPARENT_PIXEL);
      el.setAttribute('data-mf-placeholder', '1');
      el.setAttribute('alt', el.getAttribute('alt') ?? '已阻止的远程图片');
    }
    el.removeAttribute('srcset');
    el.removeAttribute('loading');
  }

  if (el.nodeName.toLowerCase() === 'a') {
    const href = el.getAttribute('href');
    if (!href || !/^(?:https?:|mailto:)/i.test(href.trim())) {
      el.removeAttribute('href');
    } else {
      el.setAttribute('rel', 'noopener noreferrer');
      el.removeAttribute('target');
    }
  }

  // 兜底：清除任何残留的事件属性
  for (const attr of Array.from(el.attributes)) {
    if (attr.name.toLowerCase().startsWith('on')) {
      el.removeAttribute(attr.name);
    }
  }
});

export interface SanitizeOptions {
  /** 用户点击"显示图片"后为 true。 */
  allowRemoteImages?: boolean;
}

export interface SanitizeResult {
  html: string;
  blockedRemoteImages: number;
  remoteImages: string[];
}

export function sanitizeEmailHtml(rawHtml: string, options: SanitizeOptions = {}): SanitizeResult {
  state = {
    allowRemoteImages: options.allowRemoteImages === true,
    blockedRemoteImages: 0,
    remoteImages: new Set(),
  };

  const clean = purifier.sanitize(rawHtml, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: [...FORBIDDEN_HTML_TAGS],
    FORBID_ATTR: [
      'srcdoc',
      'formaction',
      'action',
      'ping',
      'background',
      'poster',
      'xlink:href',
      'autofocus',
      'contenteditable',
    ],
    FORBID_CONTENTS: ['script', 'style', 'iframe', 'object', 'embed', 'template'],
    ALLOW_DATA_ATTR: true,
    ALLOW_ARIA_ATTR: true,
    ALLOWED_URI_REGEXP:
      /^(?:(?:https?|mailto):|data:image\/(?:png|jpe?g|gif|webp|bmp);base64,)/i,
    KEEP_CONTENT: true,
    RETURN_TRUSTED_TYPE: false,
  }) as string;

  return {
    html: clean,
    blockedRemoteImages: state.blockedRemoteImages,
    remoteImages: [...state.remoteImages],
  };
}

/** 白名单标签导出，供测试断言使用。 */
export const SANITIZE_ALLOWED_TAGS = ALLOWED_HTML_TAGS;

/**
 * 纯文本预览净化（§11.2）：用同一 DOMPurify 实例去掉所有标签，
 * 再还原被转义的文本实体。仅用于 `<pre>` 只读展示。
 */
export function sanitizePlainText(input: string): string {
  const clean = purifier.sanitize(input, {
    ALLOWED_TAGS: [],
    ALLOWED_ATTR: [],
    KEEP_CONTENT: true,
    FORBID_CONTENTS: ['script', 'style'],
    RETURN_TRUSTED_TYPE: false,
  }) as string;

  return clean
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

/**
 * 外发邮件正文的权威净化（发送前最后一道）。
 *
 * 渲染进程里的 DOMPurify 只负责「立即看到干净结果」，可以被绕过；
 * 真正入队发送的 HTML 必须在这里过一遍——它直接决定收件人收到什么。
 * 与阅读净化共用同一套白名单，但允许远程图片（那是发件人自己的内容，不是第三方跟踪像素）。
 */
export function sanitizeComposeHtml(rawHtml: string): string {
  return sanitizeEmailHtml(rawHtml, { allowRemoteImages: true }).html;
}

/** 纯文本摘要净化：去标签、解实体、压缩空白。 */
export function toPlainSnippet(input: string, maxLength = 180): string {
  return htmlToPlainText(input).slice(0, maxLength);
}

/** 完整纯文本化（用于 FTS 索引与插件正文读取，不做截断）。 */
export function htmlToPlainText(input: string): string {
  const withoutTags = input
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
  const decoded = withoutTags
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  return decoded.replace(/\s+/g, ' ').trim();
}
