/**
 * 收到的邮件里 multipart/related 内嵌图片的解析（§10 阅读安全 / §11 附件策略）。
 *
 * 为什么要这一层：Outlook / 系统邮件 / 绝大部分 newsletter 都会把 Logo、签名、
 * 粘贴的截图作为独立 MIME part 发出（带 `Content-ID`），正文里用
 * `<img src="cid:xxx">` 引用。解析缺失时，净化器（sanitize.ts）会把既不是
 * http(s) 也不是 data: 的 src 整条删掉，渲染出来就是一张没有 src 的空
 * `<img>` ——用户看到图全丢。
 *
 * 方向与 `inline-images.ts` 正好相反：那里把编辑器里的 data URI 转成 cid 发出去，
 * 这里把收到的 cid 转回 data URI 显示出来。
 *
 * 本模块是纯函数（不碰数据库/文件系统），便于单测与变异验证。
 */

/** 单张内嵌图片上限：超过就不内联，避免超大 part 变成巨大的 data URI 打爆内存。 */
export const MAX_INLINE_PART_BYTES = 5 * 1024 * 1024;

/** 可作为内嵌图显示的 MIME（与净化器 `RASTER_DATA_IMAGE` 白名单保持一致）。 */
const INLINABLE_IMAGE = /^image\/(?:png|jpe?g|gif|webp|bmp)$/i;

/**
 * `<img src="cid:xxx">` 的 src 匹配。
 * 加 `(?<![\w-])` 前缀是为了不误伤 `data-src=` / `x-src=` 之类的自定义属性。
 */
function cidSrcPattern(): RegExp {
  return /(?<![\w-])src\s*=\s*(["'])(cid:[^"'\s]+)\1/gi;
}

/**
 * Content-ID 归一化：去掉尖括号与 `cid:` 前缀，做 Nothing-But-匹配用。
 * 服务器写法不统一（`<x@y>` / `x@y` / 带空格），统一成裸 id 才好对比。
 */
export function normalizeContentId(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  let value = raw.trim();
  if (!value) return null;
  if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1).trim();
  value = value.replace(/^cid:/i, '').trim();
  if (!value) return null;
  // 病态长度的 id 直接放弃，避免被拿来构造超大字符串
  if (value.length > 320) return null;
  return value;
}

/** 扫出正文里所有 cid 引用（去重、保持出现顺序）。 */
export function referencedCids(html: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  if (typeof html !== 'string' || html.length === 0) return result;
  if (!/\bcid:/i.test(html)) return result;

  const pattern = cidSrcPattern();
  let match = pattern.exec(html);
  while (match !== null) {
    const cid = normalizeContentId(match[2]);
    if (cid && !seen.has(cid)) {
      seen.add(cid);
      result.push(cid);
    }
    match = pattern.exec(html);
  }
  return result;
}

/**
 * 判断一个 MIME part 值不值得内联到正文里。
 * 内联 filter 与「是否从附件列表隐藏」共用这一个判断，保证两边口径一致。
 */
export function isInlinablePart(
  mimeType: string,
  size: number,
  maxBytes = MAX_INLINE_PART_BYTES,
): boolean {
  const type = typeof mimeType === 'string' ? mimeType.trim() : '';
  if (!INLINABLE_IMAGE.test(type)) return false;
  const bytes = typeof size === 'number' ? size : Number.NaN;
  return Number.isFinite(bytes) && bytes > 0 && bytes <= maxBytes;
}

/**
 * 正文里直接内嵌的 `data:image/...;base64,...` 图片的**解码后字节数**集合。
 *
 * 为什么需要它：Outlook 等客户端会把同一张图既写进正文的 data URI，又保留一个
 * 同尺寸的 MIME part（没有 Content-ID、正文里也没有 `cid:` 引用）。这类 part
 * 是正文图片的副本，用户不应在附件条里再看到一次。
 */
export function embeddedImageSizes(html: string): Set<number> {
  const sizes = new Set<number>();
  if (typeof html !== 'string' || html.length === 0) return sizes;

  const pattern = /data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=]+)/gi;
  let match = pattern.exec(html);
  while (match !== null) {
    const base64 = match[1] ?? '';
    if (base64) {
      const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
      const bytes = Math.floor((base64.length * 3) / 4) - padding;
      if (bytes > 0) sizes.add(bytes);
    }
    match = pattern.exec(html);
  }
  return sizes;
}

/**
 * 判断一个 MIME part 是否属于「正文内嵌图」，不应出现在附件列表里。
 *
 * 规则（只针对图片，PDF/文本等内联 part 仍保留附件入口，避免用户失去打开方式）：
 *  - 正文里已有同字节数的 data URI 图片 → 重复 part（Outlook 的常见写法）；
 *  - `Content-Disposition: inline` → 内嵌图（有些客户端甚至不写 Content-ID）；
 *  - 带 Content-ID 且正文用 `cid:` 引用了它 → 内嵌图（有的客户端把签名图错写成 attachment）；
 *  - 其余图片（明确 attachment、正文没引用）→ 真实图片附件，照常列出。
 */
export function isInlineAttachment(
  part: {
    mimeType?: string | null;
    contentDisposition?: string | null;
    contentId?: string | null;
    size?: number | null;
  },
  referenced: ReadonlySet<string>,
  embeddedSizes?: ReadonlySet<number>,
): boolean {
  const mime = typeof part.mimeType === 'string' ? part.mimeType.trim() : '';
  if (!/^image\//i.test(mime)) return false;

  const size = typeof part.size === 'number' ? part.size : Number.NaN;
  if (embeddedSizes && Number.isFinite(size) && size > 0 && embeddedSizes.has(size)) {
    return true;
  }

  const disposition =
    typeof part.contentDisposition === 'string'
      ? part.contentDisposition.trim().toLowerCase()
      : '';
  if (disposition === 'inline') return true;

  const cid = normalizeContentId(part.contentId);
  return Boolean(cid && referenced.has(cid));
}

/** 可用于解析 cid 的一张内嵌 part。 */
export interface InlinePartSource {
  cid: string;
  mimeType: string;
  /** 原始字节（来自附件落盘文件）。 */
  content: Uint8Array;
}

export interface InlineResolution {
  /** 改写后的正文（未命中的 cid 保持原样）。 */
  html: string;
  /** 成功内联的 Content-ID；调用方据此把它们从附件列表里隐藏。 */
  usedCids: string[];
  /** 引用了但没能内联的数量（缺 part / 非光栅图 / 超限），用于日志。 */
  skipped: number;
}

/**
 * 把正文里的 `cid:` 引用改写为 data URI。
 * - 只动 `<img src="cid:...">`，其它属性一律不碰；
 * - 找不到对应 part、不是光栅图、或体积超限时保留原样（宁缺勿错，不伪造图片）；
 * - 同一张图在正文里多处引用 → 只算一次 usedCids。
 */
export function resolveInlineImages(
  html: string,
  parts: InlinePartSource[],
  maxBytes = MAX_INLINE_PART_BYTES,
): InlineResolution {
  const source = typeof html === 'string' ? html : '';
  const usedCids: string[] = [];
  const referenced = referencedCids(source);
  if (!source || parts.length === 0 || referenced.length === 0) {
    return { html: source, usedCids, skipped: referenced.length };
  }

  const byCid = new Map<string, InlinePartSource>();
  for (const part of parts) {
    const cid = normalizeContentId(part?.cid);
    if (cid && !byCid.has(cid)) byCid.set(cid, part);
  }

  let skipped = 0;
  const rewritten = source.replace(cidSrcPattern(), (match, quote: string, raw: string) => {
    const cid = normalizeContentId(raw);
    if (!cid) return match;
    const part = byCid.get(cid);
    if (!part) {
      skipped += 1;
      return match;
    }
    const bytes = part.content instanceof Uint8Array ? part.content : null;
    if (!bytes) {
      skipped += 1;
      return match;
    }
    if (!isInlinablePart(part.mimeType, bytes.byteLength, maxBytes)) {
      skipped += 1;
      return match;
    }
    if (!usedCids.includes(cid)) usedCids.push(cid);
    const base64 = Buffer.from(bytes).toString('base64');
    return `src=${quote}data:${part.mimeType};base64,${base64}${quote}`;
  });

  return { html: rewritten, usedCids, skipped };
}
