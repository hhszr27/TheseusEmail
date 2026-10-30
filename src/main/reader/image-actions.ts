import { ClipboardItem, clipboard, dialog, nativeImage, net } from 'electron';
import fs from 'node:fs/promises';
import type { BrowserWindow } from 'electron';
import {
  MAX_IMAGE_BYTES,
  classifyImageSource,
  decodeDataImage,
  extensionForMime,
  normalizeRemoteUrl,
  suggestImageFilename,
} from './image-source';

/**
 * 正文右键菜单里的图片动作（§10.1 正文只读沙箱之外的主进程能力）。
 *
 * 图片可能来自 data:（内联）或 http(s)（远程）。远程图必须由主进程取字节：
 * 渲染进程受 CSP/CORS 限制拿不到像素，剪贴板与磁盘写入也只能在主进程做。
 * 取远程图不带 cookie、不带 referer，且限制 25 MB —— 右键是用户的显式动作，
 * 但也不该顺带泄露会话或被一个大文件拖死。
 */

export interface LoadedImage {
  buffer: Buffer;
  mime: string;
}

async function fetchRemoteImage(src: string): Promise<LoadedImage> {
  const url = normalizeRemoteUrl(src);
  const response = await net.fetch(url, {
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`下载图片失败（HTTP ${response.status}）`);
  }

  const mime = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (!mime.startsWith('image/')) {
    throw new Error('该地址返回的不是图片');
  }

  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
    throw new Error('图片超过 25 MB，已取消');
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength === 0) throw new Error('图片内容为空');
  if (buffer.byteLength > MAX_IMAGE_BYTES) throw new Error('图片超过 25 MB，已取消');
  return { buffer, mime };
}

export async function loadImage(src: string): Promise<LoadedImage> {
  const kind = classifyImageSource(src);
  if (kind === 'invalid') throw new Error('不支持的图片地址');
  if (kind === 'data') {
    const decoded = decodeDataImage(src);
    if (!decoded) throw new Error('图片数据无法解析');
    return decoded;
  }
  return fetchRemoteImage(src);
}

/** 复制到剪贴板：统一转成 PNG 再写，保证系统能贴到任何接受位图的地方。 */
export async function copyImageToClipboard(src: string): Promise<void> {
  const { buffer } = await loadImage(src);
  const image = nativeImage.createFromBuffer(buffer);
  if (image.isEmpty()) {
    throw new Error('这个图片格式无法复制，请改用「图片另存为」');
  }

  // Electron 44 起剪贴板是 W3C 风格的异步 API：写图片要包成 ClipboardItem
  const png = image.toPNG();
  await clipboard.write([
    new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) }),
  ]);
}

export async function saveImageToFile(
  src: string,
  alt: string | null | undefined,
  parent: BrowserWindow | null,
): Promise<{ saved: boolean; path?: string }> {
  const loaded = await loadImage(src);
  const extension = extensionForMime(loaded.mime);
  const options = {
    title: '图片另存为',
    defaultPath: suggestImageFilename(src, alt, loaded.mime),
    filters: [
      { name: '图片', extensions: [extension] },
      { name: '所有文件', extensions: ['*'] },
    ],
  };

  const picked = parent
    ? await dialog.showSaveDialog(parent, options)
    : await dialog.showSaveDialog(options);
  if (picked.canceled || !picked.filePath) return { saved: false };

  await fs.writeFile(picked.filePath, loaded.buffer);
  return { saved: true, path: picked.filePath };
}

export async function writeClipboardText(text: string): Promise<void> {
  // 正文选中文本理论上不会很大，这里仍设上限避免异常输入
  await clipboard.writeText(text.slice(0, 1_000_000));
}
