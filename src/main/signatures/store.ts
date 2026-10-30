import { randomUUID } from 'node:crypto';
import type { Db } from '../db/open';

/**
 * 签名存储（§ 撰写）。
 * 每个账户可有多套签名；新邮件与回复/转发分别记录一个默认签名 id。
 * 富文本正文以 HTML 落库，发出前由主进程 sanitizeComposeHtml 再次净化。
 */
export interface Signature {
  id: string;
  accountId: string;
  name: string;
  html: string;
  isDefaultNew: boolean;
  isDefaultReply: boolean;
  createdAt: number;
  updatedAt: number;
}

interface SignatureRow {
  id: string;
  account_id: string;
  name: string;
  html: string;
  is_default_new: number;
  is_default_reply: number;
  created_at: number;
  updated_at: number;
}

function toSignature(row: SignatureRow): Signature {
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    html: row.html,
    isDefaultNew: row.is_default_new === 1,
    isDefaultReply: row.is_default_reply === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SignatureStore {
  constructor(private readonly db: Db) {}

  /** 某账户的全部签名，按创建时间排序（先建的排在列表前面）。 */
  list(accountId: string): Signature[] {
    const rows = this.db
      .prepare('SELECT * FROM signatures WHERE account_id = ? ORDER BY created_at ASC')
      .all(accountId) as SignatureRow[];
    return rows.map(toSignature);
  }

  get(id: string): Signature | null {
    const row = this.db.prepare('SELECT * FROM signatures WHERE id = ?').get(id) as
      | SignatureRow
      | undefined;
    return row ? toSignature(row) : null;
  }

  /** 新建一套空签名；若是该账户第一套，自动成为新邮件与回复/转发的默认。 */
  create(accountId: string, name?: string): Signature {
    const id = randomUUID();
    const now = Date.now();
    const finalName = (name ?? '').trim() || '新签名';
    const existing = this.list(accountId);
    const makeDefault = existing.length === 0 ? 1 : 0;
    this.db
      .prepare(
        `INSERT INTO signatures
           (id, account_id, name, html, is_default_new, is_default_reply, created_at, updated_at)
         VALUES (?, ?, ?, '', ?, ?, ?, ?)`,
      )
      .run(id, accountId, finalName, makeDefault, makeDefault, now, now);
    return this.get(id) as Signature;
  }

  rename(id: string, name: string): void {
    const finalName = (name ?? '').trim() || '新签名';
    this.db.prepare('UPDATE signatures SET name = ?, updated_at = ? WHERE id = ?').run(
      finalName,
      Date.now(),
      id,
    );
  }

  remove(id: string): void {
    const target = this.get(id);
    if (!target) return;
    const accountId = target.accountId;
    this.db.prepare('DELETE FROM signatures WHERE id = ?').run(id);
    // 删掉的是默认签名时，把同账户剩下的第一套补成对应档位的默认，避免默认悬空；
    // 只补「缺失的那一档」，另一档位保持不变（原本就默认的那套仍默认）。
    const remaining = this.list(accountId);
    const first = remaining[0];
    if (!first) return;
    const tx = this.db.transaction(() => {
      if (target.isDefaultNew) {
        this.db
          .prepare('UPDATE signatures SET is_default_new = 1, updated_at = ? WHERE id = ?')
          .run(Date.now(), first.id);
      }
      if (target.isDefaultReply) {
        this.db
          .prepare('UPDATE signatures SET is_default_reply = 1, updated_at = ? WHERE id = ?')
          .run(Date.now(), first.id);
      }
    });
    tx();
  }

  /** 保存中间编辑框的 HTML 内容。 */
  saveHtml(id: string, html: string): void {
    this.db
      .prepare('UPDATE signatures SET html = ?, updated_at = ? WHERE id = ?')
      .run(html, Date.now(), id);
  }

  /** 设置某账户的默认签名（kind = 新邮件 / 回复转发）；传入 null 即清除该档默认。 */
  setDefault(accountId: string, kind: 'new' | 'reply', signatureId: string | null): void {
    const column = kind === 'new' ? 'is_default_new' : 'is_default_reply';
    const clear = this.db.prepare(
      `UPDATE signatures SET ${column} = 0, updated_at = ? WHERE account_id = ?`,
    );
    const tx = this.db.transaction(() => {
      clear.run(Date.now(), accountId);
      if (signatureId) {
        this.db
          .prepare(`UPDATE signatures SET ${column} = 1, updated_at = ? WHERE id = ?`)
          .run(Date.now(), signatureId);
      }
    });
    tx();
  }

  /** 取账户当前默认签名 id（没有则返回 null）。 */
  defaultId(accountId: string, kind: 'new' | 'reply'): string | null {
    const column = kind === 'new' ? 'is_default_new' : 'is_default_reply';
    const row = this.db
      .prepare(`SELECT id FROM signatures WHERE account_id = ? AND ${column} = 1 LIMIT 1`)
      .get(accountId) as { id: string } | undefined;
    return row?.id ?? null;
  }
}
