import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ComposeAttachmentInfo } from '../../shared/ipc';
import type { InlineImage } from './inline-images';

/**
 * 写信附件暂存（§11 附件策略的发送侧）：
 *  - 渲染进程不碰文件系统，只能拿到 id + 元信息；
 *  - 选中的文件复制到 userData/compose-attachments，发送时按 id 解析出路径；
 *  - 复制而非引用原路径，保证定时发送时原文件被移动/删除也不影响；
 *  - 文件名一律净化，避免路径穿越。
 */

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 10;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.html': 'text/html',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
  '.7z': 'application/x-7z-compressed',
  '.gz': 'application/gzip',
};

export function mimeForFilename(filename: string): string {
  return MIME_BY_EXT[path.extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

/** 只保留基础文件名，去掉路径分隔符与控制字符。 */
export function safeFilename(raw: string): string {
  const base = path.basename(raw).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').trim();
  const trimmed = base.slice(0, 120);
  return trimmed || 'attachment';
}

export interface ResolvedAttachment {
  filename: string;
  path: string;
}

/** 落盘后的内嵌图片：比普通附件多一个 cid，发送时要标 inline。 */
export interface StagedInlineImage {
  id: string;
  filename: string;
  path: string;
  cid: string;
  contentType: string;
}

export class ComposeAttachmentStore {
  constructor(private readonly dir: string) {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private storedName(id: string, filename: string): string {
    return `${id}__${filename}`;
  }

  /** 复制用户选中的文件到暂存目录，返回可展示的元信息。 */
  async stageFiles(filePaths: string[]): Promise<ComposeAttachmentInfo[]> {
    const picked = filePaths.filter(Boolean).slice(0, MAX_FILES);
    const result: ComposeAttachmentInfo[] = [];

    for (const source of picked) {
      const stat = fs.statSync(source);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;

      const filename = safeFilename(path.basename(source));
      const id = randomUUID();
      const target = path.join(this.dir, this.storedName(id, filename));
      await fs.promises.copyFile(source, target);
      result.push({ id, filename, size: stat.size, mimeType: mimeForFilename(filename) });
    }

    return result;
  }

  /** 按 id 找回已暂存文件；找不到的 id 直接忽略（不阻断发送）。 */
  resolve(ids: string[]): ResolvedAttachment[] {
    const resolved: ResolvedAttachment[] = [];
    for (const id of ids.filter((value) => ID_PATTERN.test(value))) {
      const prefix = `${id}__`;
      let entries: string[] = [];
      try {
        entries = fs.readdirSync(this.dir).filter((name) => name.startsWith(prefix));
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(this.dir, entry);
        try {
          if (!fs.statSync(full).isFile()) continue;
        } catch {
          continue;
        }
        resolved.push({ filename: safeFilename(entry.slice(prefix.length)), path: full });
      }
    }
    return resolved;
  }

  /**
   * 把正文里抽出的内嵌图片写入暂存目录，返回可直接进发送队列的附件条目。
   * 单张写失败只跳过这一张（调用方会把它的 `cid:` 还原成 data URI），
   * 不让一个坏文件拖垮整封邮件。
   */
  async stageInlineImages(images: InlineImage[]): Promise<StagedInlineImage[]> {
    const staged: StagedInlineImage[] = [];
    for (const image of images) {
      const id = randomUUID();
      const filename = safeFilename(image.filename);
      const target = path.join(this.dir, this.storedName(id, filename));
      try {
        await fs.promises.writeFile(target, image.content);
      } catch {
        continue;
      }
      staged.push({ id, filename, path: target, cid: image.cid, contentType: image.contentType });
    }
    return staged;
  }

  /** 删除暂存文件（用户移除附件、发送结束或取消定时）。 */
  release(ids: string[]): void {
    for (const id of ids.filter((value) => ID_PATTERN.test(value))) {
      const prefix = `${id}__`;
      try {
        for (const entry of fs.readdirSync(this.dir)) {
          if (!entry.startsWith(prefix)) continue;
          try {
            fs.unlinkSync(path.join(this.dir, entry));
          } catch {
            // 文件可能已被删除
          }
        }
      } catch {
        // 目录不存在
      }
    }
  }

  /** 按绝对路径删除暂存文件（发送终态回调使用）。 */
  releasePaths(paths: string[]): void {
    for (const target of paths) {
      if (!target || !path.resolve(target).startsWith(path.resolve(this.dir))) continue;
      try {
        fs.unlinkSync(target);
      } catch {
        // 已被删除
      }
    }
  }

  /** 清理没有被任何待发送任务引用的残留文件（启动时调用）。 */
  cleanupUnreferenced(referenced: Set<string>): number {
    let removed = 0;
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(this.dir);
    } catch {
      return 0;
    }
    for (const entry of entries) {
      const full = path.join(this.dir, entry);
      if (referenced.has(full)) continue;
      try {
        fs.unlinkSync(full);
        removed += 1;
      } catch {
        // ignore
      }
    }
    return removed;
  }
}
