/**
 * 正文图片的来源解析（纯函数，可单测）。
 *
 * 邮件 HTML 里可能残留任何协议，这里是「能不能拿去复制/保存」的唯一闸口：
 * 只认 `data:image/*` 与 `http(s)://`，`file:` / `javascript:` 等一律拒绝。
 */

export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

export type ImageSourceKind = 'data' | 'remote' | 'invalid';

export function classifyImageSource(src: string | null | undefined): ImageSourceKind {
  if (typeof src !== 'string') return 'invalid';
  const value = src.trim();
  if (!value) return 'invalid';
  if (/^data:/i.test(value)) {
    return /^data:image\/[a-z0-9.+-]+[;,]/i.test(value) ? 'data' : 'invalid';
  }
  if (/^https?:\/\//i.test(value)) return 'remote';
  // 协议相对地址（//host/x）按 https 处理
  if (/^\/\//.test(value)) return 'remote';
  return 'invalid';
}

export function normalizeRemoteUrl(src: string): string {
  const value = src.trim();
  return value.startsWith('//') ? `https:${value}` : value;
}

export interface DecodedDataImage {
  mime: string;
  buffer: Buffer;
}

/** 解析 `data:image/...;base64,...`；非法或超限返回 null。 */
export function decodeDataImage(src: string): DecodedDataImage | null {
  if (classifyImageSource(src) !== 'data') return null;
  const match = /^data:(image\/[a-z0-9.+-]+)(;[^,]*)?,([\s\S]*)$/i.exec(src.trim());
  if (!match) return null;

  const mime = (match[1] ?? '').toLowerCase();
  const meta = match[2] ?? '';
  const payload = match[3] ?? '';
  if (!payload) return null;

  let buffer: Buffer;
  try {
    buffer = /;base64/i.test(meta)
      ? Buffer.from(payload, 'base64')
      : Buffer.from(decodeURIComponent(payload), 'binary');
  } catch {
    return null;
  }
  if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) return null;
  return { mime, buffer };
}

const MIME_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
};

/** MIME → 扩展名；未知类型回落到 png（最常见的正文内联图）。 */
export function extensionForMime(mime: string): string {
  return MIME_EXTENSION[mime.toLowerCase()] ?? 'png';
}

const KNOWN_IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp|bmp|avif|svg|ico)$/i;
const ILLEGAL_FILENAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;

function sanitizeStem(value: string): string {
  return value
    .replace(ILLEGAL_FILENAME_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .trim();
}

function basenameFromSource(src: string): string {
  const value = src.trim();
  if (!value || /^data:/i.test(value)) return '';
  try {
    const url = new URL(normalizeRemoteUrl(value));
    const last = url.pathname.split('/').filter(Boolean).pop() ?? '';
    return decodeURIComponent(last);
  } catch {
    return '';
  }
}

/**
 * 默认文件名：优先用 alt，其次用地址里的文件名，最后回落「图片」。
 * 一律按实际 MIME 补正确的扩展名，不保留原文件名里的错误后缀。
 */
export function suggestImageFilename(
  src: string,
  alt: string | null | undefined,
  mime: string,
): string {
  const extension = extensionForMime(mime);
  const fromAlt = sanitizeStem(alt ?? '').replace(KNOWN_IMAGE_EXTENSION, '');
  const fromSrc = sanitizeStem(basenameFromSource(src)).replace(KNOWN_IMAGE_EXTENSION, '');
  const stem = (fromAlt || fromSrc || '图片').slice(0, 80).trim() || '图片';
  return `${stem}.${extension}`;
}
