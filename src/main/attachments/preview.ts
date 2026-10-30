import { sanitizePlainText } from '../security/sanitize';
import type { AttachmentPayload } from '../../shared/ipc';
import { extensionOf } from '../../shared/attachments';

/**
 * 附件预览载荷构造（§11.2）。
 * 主进程只返回净化后的文本或受限的二进制数据，渲染进程不接触文件路径。
 */

export const TEXT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
export const IMAGE_PREVIEW_MAX_BYTES = 15 * 1024 * 1024;
export const PDF_PREVIEW_MAX_BYTES = 30 * 1024 * 1024;


export interface TextPreview {
  text: string;
  truncated: boolean;
}

export function prepareTextPreview(buffer: Buffer): TextPreview {
  const truncated = buffer.byteLength > TEXT_PREVIEW_MAX_BYTES;
  const slice = truncated ? buffer.subarray(0, TEXT_PREVIEW_MAX_BYTES) : buffer;
  let raw = slice.toString('utf8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);

  // 先把脚本/样式块整体移除，再做标签剥离；剩余标签只作为文本展示
  const withoutBlocks = raw
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '');

  const text = sanitizePlainText(withoutBlocks).replace(/\u0000/g, '');
  return { text, truncated };
}

export function buildAttachmentPayload(
  input: {
    id: string;
    filename: string;
    mimeType: string;
    previewKind: 'text' | 'image' | 'pdf' | 'none';
  },
  buffer: Buffer,
): AttachmentPayload | { error: string } {
  if (input.previewKind === 'text') {
    const preview = prepareTextPreview(buffer);
    return {
      id: input.id,
      kind: 'text',
      filename: input.filename,
      mimeType: input.mimeType,
      text: preview.text,
      truncated: preview.truncated,
    };
  }

  if (input.previewKind === 'image') {
    if (buffer.byteLength > IMAGE_PREVIEW_MAX_BYTES) {
      return { error: '图片过大，无法在应用内预览。' };
    }
    return {
      id: input.id,
      kind: 'image',
      filename: input.filename,
      mimeType: input.mimeType,
      dataBase64: buffer.toString('base64'),
      truncated: false,
    };
  }

  if (input.previewKind === 'pdf') {
    if (buffer.byteLength > PDF_PREVIEW_MAX_BYTES) {
      return { error: 'PDF 过大，无法在应用内预览。' };
    }
    return {
      id: input.id,
      kind: 'pdf',
      filename: input.filename,
      mimeType: 'application/pdf',
      dataBase64: buffer.toString('base64'),
      truncated: false,
    };
  }

  return { error: '此类型不支持应用内预览。' };
}

/** SVG 永远不进内部预览（可能含脚本），走系统默认程序。 */
export function isSvg(filename: string, mimeType: string): boolean {
  return extensionOf(filename) === '.svg' || mimeType.toLowerCase() === 'image/svg+xml';
}
