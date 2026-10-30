import type { Db } from '../open';
import type { EmailAddress } from '../../../shared/types';

export interface ContactEntry {
  email: string;
  displayName: string | null;
  interactionCount: number;
  lastContactedAt: number;
}

interface ContactRow {
  email: string;
  display_name: string | null;
  last_contacted_at: number;
  interaction_count: number;
}

/** 联系人自动补全（§20.1）：只基于本地邮件历史，按交互频率 × 最近时间排序。 */
export class ContactsRepo {
  constructor(private readonly db: Db) {}

  upsertFrom(address: EmailAddress, at: number): void {
    const email = address.address?.trim().toLowerCase();
    if (!email || !email.includes('@')) return;

    this.db
      .prepare(
        `INSERT INTO contacts (email, display_name, last_contacted_at, interaction_count)
         VALUES (?, ?, ?, 1)
         ON CONFLICT(email) DO UPDATE SET
           display_name = COALESCE(excluded.display_name, contacts.display_name),
           last_contacted_at = MAX(contacts.last_contacted_at, excluded.last_contacted_at),
           interaction_count = contacts.interaction_count + 1`,
      )
      .run(email, address.name ?? null, at);
  }

  private score(row: ContactRow, now: number): number {
    const days = Math.max(0, (now - row.last_contacted_at) / 86_400_000);
    const recency = 1 / (1 + days / 30);
    return row.interaction_count * (0.5 + recency);
  }

  search(query: string, limit = 8): ContactEntry[] {
    const needle = query.trim().toLowerCase();
    // 池子取 500：自动补全只用前 8 条，但联系人面板一次要能拿到一批（上限 500）
    const rows = this.db
      .prepare('SELECT * FROM contacts ORDER BY interaction_count DESC, last_contacted_at DESC LIMIT 500')
      .all() as ContactRow[];

    const now = Date.now();
    return rows
      .filter((row) => {
        if (!needle) return true;
        return (
          row.email.toLowerCase().includes(needle) ||
          (row.display_name ?? '').toLowerCase().includes(needle)
        );
      })
      .sort((a, b) => this.score(b, now) - this.score(a, now))
      .slice(0, limit)
      .map((row) => ({
        email: row.email,
        displayName: row.display_name,
        interactionCount: row.interaction_count,
        lastContactedAt: row.last_contacted_at,
      }));
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM contacts').get() as { c: number };
    return row.c;
  }
}
