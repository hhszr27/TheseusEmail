import fs from 'node:fs';
import type { Db } from '../db/open';
import type { AccountsRepo } from '../db/repositories/accounts-repo';
import type { FoldersRepo } from '../db/repositories/folders-repo';
import type { EmailsRepo } from '../db/repositories/emails-repo';
import { emailIdFor } from '../db/repositories/emails-repo';
import { htmlToPlainText, sanitizeEmailHtml } from '../security/sanitize';
import { buildMbox, splitMbox } from './mbox';
import { simpleParser } from 'mailparser';
import { embeddedImageSizes, isInlineAttachment, referencedCids } from '../mail/inline-parts';
import { log } from '../observability/logger';
import { recordMetric } from '../observability/metrics';
import type { MboxExportResult, MboxImportResult } from '../../shared/ipc';
import type { EmailAddress } from '../../shared/types';

/**
 * MBOX 导入导出（§32.1）：
 * 导入的邮件同样经过净化后入库，并写入 FTS 索引；导出为明文，必须显式确认。
 */

export interface MboxServiceDeps {
  db: Db;
  accounts: AccountsRepo;
  folders: FoldersRepo;
  emails: EmailsRepo;
  indexEmail: (emailId: string) => void;
  attachments?: {
    save: (emailId: string, items: Array<{ filename: string; mimeType: string; size: number; content: Uint8Array }>) => void;
  };
}

function toAddresses(value: unknown): EmailAddress[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  const addresses: EmailAddress[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const record = item as { name?: string; address?: string; value?: Array<{ name?: string; address?: string }> };
    if (Array.isArray(record.value)) {
      addresses.push(...toAddresses(record.value));
      continue;
    }
    if (typeof record.address === 'string' && record.address) {
      addresses.push({
        ...(record.name ? { name: record.name } : {}),
        address: record.address,
      });
    }
  }
  return addresses;
}

export class MboxService {
  constructor(private readonly deps: MboxServiceDeps) {}

  async importFile(accountId: string, filePath: string, folderName = 'MBOX 导入'): Promise<MboxImportResult> {
    const account = this.deps.accounts.get(accountId);
    if (!account) throw new Error('账户不存在');

    const raw = await fs.promises.readFile(filePath, 'utf8');
    const messages = splitMbox(raw);
    if (messages.length === 0) throw new Error('文件中没有可导入的邮件');

    this.deps.folders.upsertFolder(accountId, {
      path: folderName,
      name: folderName,
      delimiter: '/',
    });

    let uid = this.deps.emails.maxUid(accountId, folderName);
    let imported = 0;
    let errors = 0;

    for (const source of messages) {
      try {
        const parsed = await simpleParser(source);
        uid += 1;
        const emailId = emailIdFor(accountId, folderName, uid);
        const html = typeof parsed.html === 'string' ? parsed.html : null;
        const text = parsed.text ?? (html ? htmlToPlainText(html) : '');
        // 内嵌图（签名/正文图片）不算附件：与 IMAP 同步共用同一套判定
        const referenced = new Set(referencedCids(html ?? ''));
        const embedded = embeddedImageSizes(html ?? '');
        const parsedAttachments = (parsed.attachments ?? []).map((attachment) => {
          const rawCid = typeof attachment.contentId === 'string' ? attachment.contentId.trim() : '';
          const contentId = rawCid
            ? rawCid.replace(/^<(.*)>$/, '$1').replace(/^cid:/i, '').trim() || undefined
            : undefined;
          const mimeType = attachment.contentType ?? 'application/octet-stream';
          const size = attachment.size ?? attachment.content.byteLength;
          const inline = isInlineAttachment(
            {
              mimeType,
              contentDisposition: attachment.contentDisposition,
              contentId: rawCid,
              size,
            },
            referenced,
            embedded,
          );
          return {
            filename: attachment.filename ?? 'attachment',
            mimeType,
            size,
            content: new Uint8Array(attachment.content),
            ...(contentId ? { contentId } : {}),
            ...(inline ? { inline: true } : {}),
          };
        });
        const subject = parsed.subject ?? '（无主题）';
        const from = toAddresses(parsed.from);
        const to = toAddresses(parsed.to);
        const dateMs = parsed.date ? parsed.date.getTime() : Date.now();
        const sanitized = html ? sanitizeEmailHtml(html).html : null;

        this.deps.emails.upsertMany(accountId, folderName, 0, [
          {
            uid,
            messageId: parsed.messageId ?? null,
            subject,
            from,
            to,
            dateMs,
            snippet: (text || htmlToPlainText(html ?? '')).slice(0, 180),
            hasAttachments: parsedAttachments.some((item) => !item.inline),
            unread: false,
            starred: false,
          },
        ]);

        this.deps.emails.saveBody(emailId, sanitized, text || null);

        if (sanitized || text) {
          try {
            this.deps.indexEmail(emailId);
          } catch (error) {
            log.warn('mbox', '导入后索引失败', { emailId, message: (error as Error).message });
          }
        }

        if (this.deps.attachments && parsedAttachments.length) {
          this.deps.attachments.save(emailId, parsedAttachments);
        }

        imported += 1;
      } catch (error) {
        errors += 1;
        log.warn('mbox', '单封邮件导入失败', { message: (error as Error).message });
      }
    }

    recordMetric('mbox_import', { imported, errors });
    return { imported, folder: folderName, errors };
  }

  /** 导出指定文件夹为明文 MBOX；调用方必须先取得用户显式确认。 */
  async exportFolder(accountId: string, folder: string, destination: string): Promise<MboxExportResult> {
    const rows = this.deps.db
      .prepare(
        `SELECT e.*, b.html AS body_html, b.text AS body_text
           FROM emails e
           LEFT JOIN email_bodies b ON b.email_id = e.id
          WHERE e.account_id = ? AND e.folder = ?
          ORDER BY e.uid ASC`,
      )
      .all(accountId, folder) as Array<{
      id: string;
      uid: number;
      subject: string;
      from_json: string;
      to_json: string;
      date: number;
      body_html: string | null;
      body_text: string | null;
    }>;

    const messages = rows.map((row) => {
      let from: EmailAddress[] = [];
      let to: EmailAddress[] = [];
      try {
        from = JSON.parse(row.from_json) as EmailAddress[];
        to = JSON.parse(row.to_json) as EmailAddress[];
      } catch {
        // 忽略损坏的地址 JSON
      }
      const formatAddress = (address: EmailAddress): string =>
        address.name ? `${address.name} <${address.address}>` : address.address;
      const body = row.body_text ?? (row.body_html ? htmlToPlainText(row.body_html) : '');
      const headers = [
        `From: ${from.map(formatAddress).join(', ')}`,
        `To: ${to.map(formatAddress).join(', ')}`,
        `Subject: ${row.subject}`,
        `Date: ${new Date(row.date).toUTCString()}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: 8bit',
      ];
      return `${headers.join('\n')}\n\n${body}\n`;
    });

    const mbox = buildMbox(messages);
    await fs.promises.writeFile(destination, mbox, 'utf8');
    return { exported: messages.length, path: destination };
  }
}
