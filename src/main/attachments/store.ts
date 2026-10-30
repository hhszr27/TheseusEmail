import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Db } from '../db/open';
import {
  buildAttachmentRisk,
  classifyAttachment,
  DEFAULT_SCAN_POLICY,
  extensionOf,
  mergeScanVerdict,
  normalizeScanPolicy,
  resolveHandling,
  type ScanPolicySettings,
} from '../../shared/attachments';
import type { AttachmentView } from '../../shared/ipc';
import type { RiskLevel, ScanResult } from '../../shared/types';
import {
  embeddedImageSizes,
  isInlinablePart,
  normalizeContentId,
  referencedCids,
} from '../mail/inline-parts';
import type { InlinePartSource } from '../mail/inline-parts';

/**
 * 附件落盘与索引（§11）。
 * 内容按 SHA-256 去重存放于 userData/attachments，数据库只保存元数据与扫描结论。
 */

export interface IncomingAttachment {
  filename: string;
  mimeType: string;
  size: number;
  content: Uint8Array;
  /**
   * MIME part 的 Content-ID（multipart/related 内嵌图片）。
   * 有值时写的就是 `attachments.content_id`，阅读侧据此把它还原成正文里的图，
   * 而不是当作普通附件列在附件条里。
   */
  contentId?: string;
  /**
   * 正文内嵌图（签名 Logo、正文引用的图片）。落盘保留（cid 还原要用），
   * 但永不作为附件展示。
   */
  inline?: boolean;
}

interface AttachmentRow {
  id: string;
  email_id: string;
  filename: string;
  mime_type: string;
  size: number;
  ext: string;
  sha256: string | null;
  local_path: string | null;
  content_id: string | null;
  /** 1 = 正文内嵌图，不在附件列表里显示。 */
  inline: number;
  scan_verdict: string | null;
  scan_source: string | null;
  scan_detail: string | null;
  scan_at: number | null;
}

export interface AttachmentSettings {
  customTextExts: string[];
  customDangerExts: string[];
  /** 「打开前提示」的完整列表（用户可增删）；缺省时用内置默认。 */
  warnExts?: string[];
  /** 「禁止打开」的完整列表（用户可增删）；缺省时用内置默认。 */
  blockExts?: string[];
  /** 旧字段：等价于 warnExts。 */
  dangerousExts?: string[];
}

const DEFAULT_SETTINGS: AttachmentSettings = { customTextExts: [], customDangerExts: [] };

export function attachmentIdFor(emailId: string, index: number, sha256: string): string {
  return `att-${crypto.createHash('sha256').update(`${emailId}\n${index}`).digest('hex').slice(0, 16)}-${sha256.slice(0, 12)}`;
}

export class AttachmentStore {
  private readonly sessionFiles = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly root: string,
  ) {
    fs.mkdirSync(this.root, { recursive: true });
  }

  settings(): AttachmentSettings {
    const row = this.db
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get('attachments.extensions') as { value: string } | undefined;
    if (!row) return DEFAULT_SETTINGS;
    try {
      const parsed = JSON.parse(row.value) as Partial<AttachmentSettings>;
      return {
        customTextExts: Array.isArray(parsed.customTextExts)
          ? parsed.customTextExts.filter((item): item is string => typeof item === 'string')
          : [],
        customDangerExts: Array.isArray(parsed.customDangerExts)
          ? parsed.customDangerExts.filter((item): item is string => typeof item === 'string')
          : [],
        ...(Array.isArray(parsed.warnExts)
          ? {
              warnExts: parsed.warnExts.filter((item): item is string => typeof item === 'string'),
            }
          : {}),
        ...(Array.isArray(parsed.blockExts)
          ? {
              blockExts: parsed.blockExts.filter((item): item is string => typeof item === 'string'),
            }
          : {}),
        ...(Array.isArray(parsed.dangerousExts)
          ? {
              dangerousExts: parsed.dangerousExts.filter(
                (item): item is string => typeof item === 'string',
              ),
            }
          : {}),
      };
    } catch {
      return DEFAULT_SETTINGS;
    }
  }

  /** 扫描策略：结论怎么处理、扫描源开不开，都由用户决定。 */
  scanPolicy(): ScanPolicySettings {
    const row = this.db
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get('attachments.scan') as { value: string } | undefined;
    if (!row) return DEFAULT_SCAN_POLICY;
    try {
      return normalizeScanPolicy(JSON.parse(row.value));
    } catch {
      return DEFAULT_SCAN_POLICY;
    }
  }

  /** 扫描器只需要路径：别为了传个路径把整个附件读进内存。 */
  localPathOf(id: string): string | null {
    const row = this.db
      .prepare('SELECT local_path FROM attachments WHERE id = ?')
      .get(id) as { local_path: string | null } | undefined;
    const local = row?.local_path;
    return local && this.isInsideRoot(local) ? local : null;
  }

  /** 保存正文抓取得到的附件；重复抓取不会重复占用磁盘。 */
  save(emailId: string, items: IncomingAttachment[]): void {
    const insert = this.db.prepare(
      `INSERT INTO attachments
         (id, email_id, filename, mime_type, size, ext, sha256, local_path, content_id, inline)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         filename = excluded.filename,
         mime_type = excluded.mime_type,
         size = excluded.size,
         ext = excluded.ext,
         sha256 = excluded.sha256,
         local_path = excluded.local_path,
         content_id = excluded.content_id,
         inline = excluded.inline`,
    );

    const tx = this.db.transaction((list: IncomingAttachment[]) => {
      list.forEach((item, index) => {
        const buffer = Buffer.from(item.content);
        const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
        const ext = extensionOf(item.filename);
        const filename = this.safeFilename(ext, sha256);
        const filePath = path.join(this.root, filename);
        if (!fs.existsSync(filePath)) {
          fs.writeFileSync(filePath, buffer, { mode: 0o600 });
        }
        this.sessionFiles.add(filePath);

        insert.run(
          attachmentIdFor(emailId, index, sha256),
          emailId,
          item.filename.slice(0, 255),
          item.mimeType || 'application/octet-stream',
          item.size || buffer.byteLength,
          ext,
          sha256,
          filePath,
          // 以前这里错写成了第二遍 sha256，导致 content_id 被自身哈希污染——
          // 现在 content_id 有了真正的用途（还原内嵌图），必须是 Content-ID 而不是哈希。
          normalizeContentId(item.contentId),
          item.inline ? 1 : 0,
        );
      });
    });

    tx(items);
  }

  private safeFilename(ext: string, sha256: string): string {
    const safeExt = /^\.[a-z0-9]{1,12}$/.test(ext) ? ext : '';
    return `${sha256}${safeExt}`;
  }

  private rows(emailId: string): AttachmentRow[] {
    return this.db
      .prepare('SELECT * FROM attachments WHERE email_id = ? ORDER BY rowid ASC')
      .all(emailId) as AttachmentRow[];
  }

  /**
   * 用户可见的附件：内嵌图（签名/正文图片）永远不列出来。
   * 和阅读区的附件条共用 `listVisible`，避免「界面藏了、插件/扫描还看得见」。
   */
  list(emailId: string): AttachmentView[] {
    const row = this.db
      .prepare('SELECT html FROM email_bodies WHERE email_id = ?')
      .get(emailId) as { html: string | null } | undefined;
    return this.listVisible(emailId, row?.html ?? null);
  }

  /**
   * 取回某封邮件可用于解析 `cid:` 的内嵌 part（带 Content-ID 且是光栅图的那些）。
   * 读不到文件就跳过——宁可那张图不显示，也不能因为一个坏文件让整封邮件打不开。
   */
  inlineParts(emailId: string): InlinePartSource[] {
    const rows = this.rows(emailId).filter(
      (row) => row.content_id && isInlinablePart(row.mime_type, row.size),
    );
    const parts: InlinePartSource[] = [];
    for (const row of rows) {
      if (!row.local_path || !this.isInsideRoot(row.local_path)) continue;
      try {
        parts.push({
          cid: row.content_id as string,
          mimeType: row.mime_type,
          content: new Uint8Array(fs.readFileSync(row.local_path)),
        });
      } catch {
        // 磁盘上的文件可能被清理工具删掉了：跳过这一张
      }
    }
    return parts;
  }

  /**
   * 用户应当看到的附件列表：被正文 `cid:` 引用并已内联显示的 part 要藏起来，
   * 否则一封带签名 Logo 的邮件会在附件条里多出一个谁都没上传过的图片文件。
   * 判断口径与 `resolveInlineImages` 共用 `isInlinablePart`，保证「藏起来的那些」正好就是
   * 「已经内联成功的那些」。
   */
  listVisible(emailId: string, bodyHtml: string | null): AttachmentView[] {
    // 解析时已经标好的内嵌图直接排除；下面的 cid / data URI 判断是给旧数据
    //（inline 列默认为 0）兜底，也覆盖「入库后正文才第一次被缓存」的时序问题。
    const visible = this.rows(emailId).filter((row) => row.inline !== 1);
    const settings = this.settings();
    const scanPolicy = this.scanPolicy();
    if (!bodyHtml || visible.length === 0) {
      return visible.map((row) => this.toView(row, settings, scanPolicy));
    }

    const referenced = new Set(referencedCids(bodyHtml));
    // 有的客户端（典型是 Outlook）把图片既写进正文 data URI，又保留同尺寸 part，
    // 这类副本不该再出现在附件条里。
    const embedded = embeddedImageSizes(bodyHtml);
    if (referenced.size === 0 && embedded.size === 0) {
      return visible.map((row) => this.toView(row, settings, scanPolicy));
    }

    return visible
      .filter((row) => {
        if (embedded.size > 0 && /^image\//i.test(row.mime_type) && embedded.has(row.size)) {
          return false;
        }
        const cid = normalizeContentId(row.content_id);
        return !cid || !referenced.has(cid) || !isInlinablePart(row.mime_type, row.size);
      })
      .map((row) => this.toView(row, settings, scanPolicy));
  }

  private toView(
    row: AttachmentRow,
    settings: AttachmentSettings,
    scanPolicy: ScanPolicySettings,
  ): AttachmentView {
    const policy = classifyAttachment({
      filename: row.filename,
      mimeType: row.mime_type,
      customTextExts: settings.customTextExts,
      customDangerExts: settings.customDangerExts,
      warnExts: settings.warnExts,
      blockExts: settings.blockExts,
      dangerousExts: settings.dangerousExts,
    });

    let level: RiskLevel = policy.risk;
    if (row.scan_verdict) {
      level = mergeScanVerdict(level, row.scan_verdict as ScanResult['verdict']);
    }

    const scanResult: ScanResult | null =
      row.scan_verdict && row.scan_source
        ? {
            verdict: row.scan_verdict as ScanResult['verdict'],
            source: row.scan_source,
            detail: row.scan_detail ?? undefined,
            scannedAt: row.scan_at ?? 0,
          }
        : null;

    // 扩展名规则与扫描结论按严格度合成；扫描结论怎么处理由设置决定
    const resolved = resolveHandling(policy.handling, row.scan_verdict, scanPolicy.actions);

    return {
      id: row.id,
      emailId: row.email_id,
      filename: row.filename,
      mimeType: row.mime_type,
      size: row.size,
      ext: row.ext,
      ...(row.sha256 ? { sha256: row.sha256 } : {}),
      handling: resolved.handling,
      ...(resolved.blockedBy ? { blockedBy: resolved.blockedBy } : {}),
      previewKind: policy.previewKind,
      risk: buildAttachmentRisk(level, scanResult),
      ...(row.scan_at ? { scannedAt: row.scan_at } : {}),
    };
  }

  get(id: string): AttachmentRow | null {
    const row = this.db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as
      | AttachmentRow
      | undefined;
    return row ?? null;
  }

  read(id: string): { row: AttachmentRow; buffer: Buffer } | null {
    const row = this.get(id);
    if (!row?.local_path) return null;
    if (!this.isInsideRoot(row.local_path)) return null;
    try {
      return { row, buffer: fs.readFileSync(row.local_path) };
    } catch {
      return null;
    }
  }

  isInsideRoot(filePath: string): boolean {
    const resolved = path.resolve(filePath);
    const root = path.resolve(this.root);
    return resolved === root || resolved.startsWith(`${root}${path.sep}`);
  }

  recordScan(id: string, result: ScanResult): void {
    this.db
      .prepare(
        `UPDATE attachments
            SET scan_verdict = ?, scan_source = ?, scan_detail = ?, scan_at = ?
          WHERE id = ?`,
      )
      .run(result.verdict, result.source, result.detail ?? null, result.scannedAt, id);
  }

  /** 清理超过 24 小时的附件文件（§11.6）。 */
  cleanupOlderThan(maxAgeMs: number): number {
    let removed = 0;
    const now = Date.now();
    const deleted: string[] = [];
    for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const filePath = path.join(this.root, entry.name);
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > maxAgeMs) {
          fs.unlinkSync(filePath);
          deleted.push(filePath);
          removed += 1;
        }
      } catch {
        // 文件可能被占用
      }
    }
    if (deleted.length > 0) {
      const nullify = this.db.prepare('UPDATE attachments SET local_path = NULL WHERE local_path = ?');
      const tx = this.db.transaction((paths: string[]) => {
        for (const filePath of paths) nullify.run(filePath);
      });
      tx(deleted);
    }
    return removed;
  }

  /** 正常退出时清理本次会话落盘的文件（§11.6）。 */
  cleanupSession(): number {
    let removed = 0;
    const deleted: string[] = [];
    for (const filePath of this.sessionFiles) {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          deleted.push(filePath);
          removed += 1;
        }
      } catch {
        // ignore
      }
    }
    this.sessionFiles.clear();
    // 与 cleanupOlderThan 对齐：文件没了就必须把 local_path 置 NULL。
    // 否则下次打开这些邮件时正文已缓存、不会重新落盘，
    // 用户会一直看到「附件内容不可用，请重新打开邮件」——而重开也没用。
    if (deleted.length > 0) {
      const nullify = this.db.prepare('UPDATE attachments SET local_path = NULL WHERE local_path = ?');
      const tx = this.db.transaction((paths: string[]) => {
        for (const filePath of paths) nullify.run(filePath);
      });
      tx(deleted);
    }
    return removed;
  }
}

/** 供 worker 与主进程共用的字节数格式化。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
