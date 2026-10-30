import type { EmailAddress, SpecialUse, SyncCapabilityLevel } from '../../../shared/types';

/** 主进程 ↔ 账户 worker 的协议（§7.6）。 */

export interface ImapAccountConfig {
  accountId: string;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

export interface RawEmailSummary {
  uid: number;
  messageId: string | null;
  subject: string;
  from: EmailAddress[];
  to: EmailAddress[];
  dateMs: number;
  snippet: string;
  hasAttachments: boolean;
  unread: boolean;
  starred: boolean;
}

export interface RawAttachmentMeta {
  filename: string;
  mimeType: string;
  size: number;
  /** 正文抓取时一并回传的附件内容（仅主进程内存中转，随后落盘）。 */
  content?: Uint8Array;
  /**
   * MIME part 的 Content-ID（`multipart/related` 的内嵌图片用它被正文 `cid:` 引用）。
   * 没有就是普通附件；有了才可能在阅读时把 cid 解析成图（inline-parts.ts）。
   */
  contentId?: string;
  /**
   * 正文内嵌图（签名/正文引用）：仍要落盘以便把 `cid:` 还原成图，
   * 但不出现在附件列表里。
   */
  inline?: boolean;
}

export interface FolderDTO {
  path: string;
  name: string;
  delimiter: string;
  specialUse?: SpecialUse;
  specialUseSource?: 'user' | 'extension' | 'name';
}

export type WorkerCommand =
  | { id: number; type: 'connect'; config: ImapAccountConfig }
  | { id: number; type: 'list-folders' }
  | {
      id: number;
      type: 'sync-folder';
      folder: string;
      uidValidity: number;
      highestModseq?: number;
      highestUid?: number;
      capabilityLevel: SyncCapabilityLevel;
      lastSyncAt: number;
      limit: number;
    }
  | { id: number; type: 'fetch-body'; folder: string; uid: number }
  /** 读/未读、星标等 IMAP 标志写入（§8）。 */
  | { id: number; type: 'set-flags'; folder: string; uid: number; add: string[]; remove: string[] }
  /** 移动邮件（归档）。服务端不支持 MOVE 时由 imapflow 退化为 COPY+STORE。 */
  | { id: number; type: 'move'; folder: string; uid: number; target: string }
  | { id: number; type: 'delete'; folder: string; uid: number }
  /** 把本地草稿作为 RFC822 写入服务器 Drafts 文件夹（§草稿同步）。 */
  | { id: number; type: 'append-draft'; folder: string; raw: string; flags?: string[] }
  /** 删除服务器 Drafts 文件夹里的某封草稿（复用 delete 的 IMAP 删除能力）。 */
  | { id: number; type: 'delete-draft'; folder: string; uid: number }
  /** 在服务端新建文件夹（侧栏右键「新建文件夹」）。 */
  | { id: number; type: 'create-folder'; path: string }
  /** 服务端改名/移动文件夹。 */
  | { id: number; type: 'rename-folder'; path: string; newPath: string }
  /** 服务端删除文件夹。 */
  | { id: number; type: 'delete-folder'; path: string }
  /** 清空文件夹里的邮件（uids 为空 = 全部）。 */
  | { id: number; type: 'clear-folder'; folder: string; uids?: number[] }
  /** 复制文件夹：建目标 + 复制全部邮件（不含子文件夹）。 */
  | { id: number; type: 'copy-folder'; from: string; to: string }
  /** 把整个文件夹标为已读（批量 STORE \Seen）。 */
  | { id: number; type: 'mark-folder-read'; folder: string }
  | { id: number; type: 'close' };

export type WorkerResponse =
  | {
      id: number;
      type: 'connected';
      capabilities: string[];
      namespacePrefix?: string;
      delimiter?: string;
      specialUseCapability: 'special-use' | 'xlist' | 'none';
    }
  | {
      id: number;
      type: 'folders';
      folders: FolderDTO[];
      warnings: string[];
      namespacePrefix?: string;
      delimiter?: string;
    }
  | {
      id: number;
      type: 'sync-result';
      folder: string;
      uidValidity: number;
      highestModseq?: number;
      uidNext?: number;
      capabilityLevel: SyncCapabilityLevel;
      downgraded?: { from: SyncCapabilityLevel; to: SyncCapabilityLevel; reason: string };
      reset: boolean;
      emails: RawEmailSummary[];
    }
  | {
      /** 服务器拒绝打开该文件夹（\Noselect 容器 / 已删除）：跳过，不算同步失败。 */
      id: number;
      type: 'sync-skipped';
      folder: string;
      reason: string;
    }
  | {
      id: number;
      type: 'body';
      folder: string;
      uid: number;
      html: string | null;
      text: string | null;
      attachments: RawAttachmentMeta[];
    }
  | {
      id: number;
      type: 'action-done';
      action: 'set-flags' | 'move' | 'delete';
      uid: number;
      /** move 时返回服务端确认的目标文件夹。 */
      targetFolder?: string;
    }
  | { id: number; type: 'append-done'; uid: number }
  | {
      /** 文件夹级操作（新建 / 整批标已读）完成，不带单封 uid。 */
      id: number;
      type: 'folder-done';
      /** 服务端返回的实际路径（新建时用）。 */
      path?: string;
      /** 服务器表示「已存在」时置 true。 */
      existed?: boolean;
      /** 复制文件夹时带回的邮件数。 */
      copied?: number;
      /** 清空文件夹时带回的邮件数。 */
      removed?: number;
    }
  | {
      /** 非请求响应：IDLE 期间服务器推来 EXISTS（id 固定为 0）。 */
      id: number;
      type: 'mailbox-changed';
      folder: string;
    }
  | { id: number; type: 'closed' }
  | {
      id: number;
      type: 'error';
      code: string;
      message: string;
      transient: boolean;
      authFailed: boolean;
      fatal: boolean;
    };

export type WorkerEvent =
  | WorkerResponse
  | { id: 0; type: 'worker-ready' }
  | { id: 0; type: 'worker-log'; level: 'info' | 'warn' | 'error'; message: string };
