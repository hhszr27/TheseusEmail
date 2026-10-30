import { randomUUID } from 'node:crypto';

/**
 * 正文内嵌图片 → CID 附件（§11 附件策略的发送侧）。
 *
 * 为什么必须有这一步：富文本编辑器里粘贴/插入的图片是 `data:image/*;base64,...`
 * 内联在 HTML 里的。直接发出去有两个硬伤——
 *  1. Gmail / Outlook 会剥掉 `data:` URI 的 <img>，收件人看到的是一片空白；
 *  2. base64 比原始字节大 1/3，且整块塞进正文，容易被服务端按大小拒收。
 * 正确做法是转成 multipart/related 的 CID 内嵌附件：正文里写 `cid:xxx`，
 * 图片本体作为独立 part 带 `Content-ID: <xxx>` 发送。
 *
 * 本模块只做「识别 + 抽出 + 改写 src」这一层纯逻辑，不碰文件系统
 * （落盘由 ComposeAttachmentStore 负责），便于单测与变异验证。
 */

/** 单张内嵌图片上限：超过就保留原 data URI（至少在支持的客户端里还能看到）。 */
export const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
/** 一封邮件内嵌图片总量上限。 */
export const MAX_INLINE_TOTAL_BYTES = 15 * 1024 * 1024;

const EXT_BY_SUBTYPE: Record<string, string> = {
  png: 'png',
  jpg: 'jpg',
  jpeg: 'jpg',
  gif: 'gif',
  webp: 'webp',
  bmp: 'bmp',
};

export interface InlineImage {
  /** 正文里引用的 `cid:` 值（同时作为附件头 Content-ID）。 */
  cid: string;
  /** 原始 data URI，落盘失败时靠它把 src 还原回去。 */
  src: string;
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface InlineImageExtraction {
  html: string;
  /** 已抽出的图片（同一张图在正文里出现多次只产出一份）。 */
  images: InlineImage[];
  /** 超限而保留原 data URI 的张数（调用方用于提示/日志）。 */
  oversized: number;
}

/** 只认光栅图的 base64 data URI，与净化器白名单（`sanitize.ts`）保持一致。 */
function inlineSrcPattern(): RegExp {
  return /(?<![\w-])src\s*=\s*(["'])(data:image\/(png|jpe?g|gif|webp|bmp);base64,[A-Za-z0-9+/=]+)\1/gi;
}

function normalizeContentType(subtype: string): string {
  const lower = subtype.toLowerCase();
  return `image/${lower === 'jpg' ? 'jpeg' : lower}`;
}

function decodeDataImage(src: string): Buffer | null {
  const comma = src.indexOf(',');
  if (comma < 0) return null;
  const body = src.slice(comma + 1).replace(/\s+/g, '');
  if (!body) return null;
  const buffer = Buffer.from(body, 'base64');
  return buffer.length > 0 ? buffer : null;
}

/**
 * 把 HTML 里的内嵌 data URI 图片抽出来，正文改写为 `cid:` 引用。
 * - 同一张图出现多次 → 只产出一份附件，多处共享同一个 cid；
 * - 解不出来 / 超限 → 原样保留 data URI（宁可体积大，也不发一张看不到的图）；
 * - 非图片或不是 data URI 的 src 一律不动。
 */
export function extractInlineImages(
  html: string,
  maxImageBytes = MAX_INLINE_IMAGE_BYTES,
  maxTotalBytes = MAX_INLINE_TOTAL_BYTES,
): InlineImageExtraction {
  const source = typeof html === 'string' ? html : '';
  if (!source || !source.toLowerCase().includes('data:image/')) {
    return { html: source, images: [], oversized: 0 };
  }

  const bySrc = new Map<string, InlineImage>();
  const images: InlineImage[] = [];
  let total = 0;
  let oversized = 0;
  let index = 0;

  const rewritten = source.replace(
    inlineSrcPattern(),
    (match, quote: string, src: string, subtype: string) => {
      const known = bySrc.get(src);
      if (known) return `src=${quote}cid:${known.cid}${quote}`;

      const content = decodeDataImage(src);
      if (!content) return match;
      if (content.length > maxImageBytes || total + content.length > maxTotalBytes) {
        oversized += 1;
        return match;
      }

      index += 1;
      total += content.length;
      const ext = EXT_BY_SUBTYPE[subtype.toLowerCase()] ?? 'png';
      const image: InlineImage = {
        cid: `${randomUUID()}@mailforge.inline`,
        src,
        filename: `inline-${index}.${ext}`,
        contentType: normalizeContentType(subtype),
        content,
      };
      bySrc.set(src, image);
      images.push(image);
      return `src=${quote}cid:${image.cid}${quote}`;
    },
  );

  return { html: rewritten, images, oversized };
}

/**
 * 落盘失败的兜底：把没有真正变成附件的 `cid:` 还原成原来的 data URI。
 * 不变量——正文里出现的每个 `cid:` 都必须有对应 part，否则收件人只会看到一个破图。
 */
export function restoreUnstagedInlineImages(html: string, images: InlineImage[], stagedCids: Set<string>): string {
  let result = typeof html === 'string' ? html : '';
  for (const image of images) {
    if (stagedCids.has(image.cid)) continue;
    result = result.split(`cid:${image.cid}`).join(image.src);
  }
  return result;
}
