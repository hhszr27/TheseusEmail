import type { Db } from '../open';
import type { ComposeAttachmentInfo } from '../../../shared/ipc';

/**
 * 本地草稿（每账户一封）。
 * 只保存宿主写信表单的字段；正文是纯文本，附件只存暂存 id 与元信息。
 * 富文本场景额外保存 html；与服务器 Drafts 文件夹双向同步时记录 server_uid。
 */

export interface DraftRecord {
  accountId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  attachments: ComposeAttachmentInfo[];
  updatedAt: number;
  /** 富文本正文（HTML）；缺省空串。 */
  html?: string;
  /** 对应服务器 Drafts 文件夹的 uid；-1 表示尚未对应。 */
  serverUid?: number;
}

interface DraftRow {
  account_id: string;
  to_json: string;
  cc_json: string;
  bcc_json: string;
  subject: string;
  body: string;
  attachments_json: string;
  updated_at: number;
  body_html: string;
  server_uid: number;
}

function parseArray<T>(raw: string, fallback: T[]): T[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : fallback;
  } catch {
    return fallback;
  }
}

function toDraft(row: DraftRow): DraftRecord {
  return {
    accountId: row.account_id,
    to: parseArray<string>(row.to_json, []),
    cc: parseArray<string>(row.cc_json, []),
    bcc: parseArray<string>(row.bcc_json ?? '[]', []),
    subject: row.subject,
    body: row.body,
    attachments: parseArray<ComposeAttachmentInfo>(row.attachments_json, []),
    updatedAt: row.updated_at,
    html: row.body_html ?? '',
    serverUid: row.server_uid ?? -1,
  };
}

export class DraftsRepo {
  constructor(private readonly db: Db) {}

  save(draft: Omit<DraftRecord, 'updatedAt'>, now = Date.now()): DraftRecord {
    this.db
      .prepare(
        `INSERT INTO drafts (account_id, to_json, cc_json, bcc_json, subject, body, attachments_json, updated_at, body_html, server_uid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET
           to_json = excluded.to_json,
           cc_json = excluded.cc_json,
           bcc_json = excluded.bcc_json,
           subject = excluded.subject,
           body = excluded.body,
           attachments_json = excluded.attachments_json,
           updated_at = excluded.updated_at,
           body_html = excluded.body_html,
           server_uid = excluded.server_uid`,
      )
      .run(
        draft.accountId,
        JSON.stringify(draft.to),
        JSON.stringify(draft.cc),
        JSON.stringify(draft.bcc ?? []),
        draft.subject,
        draft.body,
        JSON.stringify(draft.attachments),
        now,
        draft.html ?? '',
        draft.serverUid ?? -1,
      );
    return { ...draft, html: draft.html ?? '', serverUid: draft.serverUid ?? -1, updatedAt: now };
  }

  get(accountId: string): DraftRecord | null {
    const row = this.db.prepare('SELECT * FROM drafts WHERE account_id = ?').get(accountId) as
      | DraftRow
      | undefined;
    return row ? toDraft(row) : null;
  }

  remove(accountId: string): boolean {
    return this.db.prepare('DELETE FROM drafts WHERE account_id = ?').run(accountId).changes > 0;
  }

  /** 记录本地草稿对应的服务器 uid（同步成功后回填），下次删除时用于清理服务器草稿。 */
  setServerUid(accountId: string, uid: number): void {
    this.db
      .prepare('UPDATE drafts SET server_uid = ? WHERE account_id = ?')
      .run(uid, accountId);
  }

  list(): DraftRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM drafts ORDER BY updated_at DESC')
      .all() as DraftRow[];
    return rows.map(toDraft);
  }

  /** 所有草稿引用到的附件 id，供启动时保护暂存文件不被清理。 */
  attachmentIds(): string[] {
    const ids = new Set<string>();
    for (const draft of this.list()) {
      for (const attachment of draft.attachments) ids.add(attachment.id);
    }
    return [...ids];
  }
}
