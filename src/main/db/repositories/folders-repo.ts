import type { FolderView, SpecialUse, SyncCapabilityLevel } from '../../../shared/types';
import { SPECIAL_USE_LABELS } from '../../../shared/constants';
import { isSameOrDescendantPath, replacePathPrefix } from '../../../shared/folder-name';
import type { Db } from '../open';
import type { DiscoveredFolder } from '../../mail/sync/folder-discovery';

interface FolderRow {
  account_id: string;
  folder: string;
  delimiter: string;
  uidvalidity: number;
  highest_modseq: number | null;
  uidnext: number | null;
  capability_level: SyncCapabilityLevel;
  special_use: SpecialUse | null;
  special_use_source: string | null;
  last_sync_at: number;
  needs_full_resync: number;
  total?: number;
  unread?: number;
}

export interface FolderState {
  accountId: string;
  folder: string;
  delimiter: string;
  uidValidity: number;
  highestModseq: number | null;
  uidNext: number | null;
  capabilityLevel: SyncCapabilityLevel;
  specialUse: SpecialUse | null;
  specialUseSource: string | null;
  lastSyncAt: number;
  needsFullResync: boolean;
}

function toState(row: FolderRow): FolderState {
  return {
    accountId: row.account_id,
    folder: row.folder,
    delimiter: row.delimiter,
    uidValidity: row.uidvalidity,
    highestModseq: row.highest_modseq,
    uidNext: row.uidnext,
    capabilityLevel: row.capability_level,
    specialUse: row.special_use,
    specialUseSource: row.special_use_source,
    lastSyncAt: row.last_sync_at,
    needsFullResync: row.needs_full_resync === 1,
  };
}

export function folderDisplayName(path: string, delimiter: string, specialUse?: SpecialUse | null): string {
  if (path.toUpperCase() === 'INBOX') return '收件箱';
  if (specialUse) return SPECIAL_USE_LABELS[specialUse];
  if (!delimiter) return path;
  const parts = path.split(delimiter);
  return parts[parts.length - 1] ?? path;
}

export class FoldersRepo {
  constructor(private readonly db: Db) {}

  upsertFolder(accountId: string, folder: DiscoveredFolder): void {
    this.db
      .prepare(
        `INSERT INTO folder_sync_state
           (account_id, folder, delimiter, special_use, special_use_source, last_sync_at)
         VALUES (?, ?, ?, ?, ?, 0)
         ON CONFLICT(account_id, folder) DO UPDATE SET
           delimiter = excluded.delimiter,
           special_use = COALESCE(excluded.special_use, folder_sync_state.special_use),
           special_use_source = COALESCE(excluded.special_use_source, folder_sync_state.special_use_source)`,
      )
      .run(
        accountId,
        folder.path,
        folder.delimiter,
        folder.specialUse ?? null,
        folder.specialUseSource ?? null,
      );
  }

  list(accountId: string): FolderView[] {
    const rows = this.db
      .prepare(
        `SELECT f.*, COALESCE(c.total, 0) AS total, COALESCE(c.unread, 0) AS unread
           FROM folder_sync_state f
           LEFT JOIN (
             SELECT folder,
                    COUNT(*) AS total,
                    SUM(CASE WHEN unread = 1 THEN 1 ELSE 0 END) AS unread
               FROM emails
              WHERE account_id = ?
              GROUP BY folder
           ) c ON c.folder = f.folder
          WHERE f.account_id = ?
          ORDER BY
            CASE WHEN UPPER(f.folder) = 'INBOX' THEN 0 ELSE 1 END,
            CASE WHEN f.special_use IS NULL THEN 1 ELSE 0 END,
            f.folder COLLATE NOCASE`,
      )
      .all(accountId, accountId) as FolderRow[];

    return rows.map((row) => ({
      accountId: row.account_id,
      path: row.folder,
      name: folderDisplayName(row.folder, row.delimiter, row.special_use),
      delimiter: row.delimiter,
      ...(row.special_use ? { specialUse: row.special_use } : {}),
      ...(row.special_use_source
        ? { specialUseSource: row.special_use_source as 'user' | 'extension' | 'name' }
        : {}),
      unread: row.unread ?? 0,
      total: row.total ?? 0,
    }));
  }

  getState(accountId: string, folder: string): FolderState | null {
    const row = this.db
      .prepare('SELECT * FROM folder_sync_state WHERE account_id = ? AND folder = ?')
      .get(accountId, folder) as FolderRow | undefined;
    return row ? toState(row) : null;
  }

  updateAfterSync(
    accountId: string,
    folder: string,
    update: {
      uidValidity: number;
      highestModseq?: number | null;
      uidNext?: number | null;
      capabilityLevel: SyncCapabilityLevel;
      lastSyncAt: number;
      needsFullResync?: boolean;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE folder_sync_state
            SET uidvalidity = ?,
                highest_modseq = ?,
                uidnext = ?,
                capability_level = ?,
                last_sync_at = ?,
                needs_full_resync = ?
          WHERE account_id = ? AND folder = ?`,
      )
      .run(
        update.uidValidity,
        update.highestModseq ?? null,
        update.uidNext ?? null,
        update.capabilityLevel,
        update.lastSyncAt,
        update.needsFullResync ? 1 : 0,
        accountId,
        folder,
      );
  }

  setCapability(accountId: string, folder: string, level: SyncCapabilityLevel): void {
    this.db
      .prepare(
        'UPDATE folder_sync_state SET capability_level = ? WHERE account_id = ? AND folder = ?',
      )
      .run(level, accountId, folder);
  }

  setNeedsFullResync(accountId: string, folder: string, value: boolean): void {
    this.db
      .prepare(
        'UPDATE folder_sync_state SET needs_full_resync = ? WHERE account_id = ? AND folder = ?',
      )
      .run(value ? 1 : 0, accountId, folder);
  }

  private pathsUnder(accountId: string, path: string, delimiter: string): string[] {
    const rows = this.db
      .prepare('SELECT folder FROM folder_sync_state WHERE account_id = ?')
      .all(accountId) as Array<{ folder: string }>;
    return rows
      .map((row) => row.folder)
      .filter((folder) => isSameOrDescendantPath(folder, path, delimiter));
  }

  /**
   * 改名/移动的本地级联（服务端已完成改名后才调用）：
   * 把 path 及其所有子路径整体换前缀，邮件与同步状态在同一事务里更新。
   * 返回实际迁移的文件夹数（0 表示本地没有这个文件夹）。
   */
  renameFolder(accountId: string, oldPath: string, newPath: string, delimiter: string): number {
    const affected = this.pathsUnder(accountId, oldPath, delimiter);
    if (affected.length === 0) return 0;

    const updateEmails = this.db.prepare(
      'UPDATE emails SET folder = ? WHERE account_id = ? AND folder = ?',
    );
    const updateState = this.db.prepare(
      'UPDATE folder_sync_state SET folder = ? WHERE account_id = ? AND folder = ?',
    );

    this.db.transaction(() => {
      for (const folder of affected) {
        const next = replacePathPrefix(folder, oldPath, newPath, delimiter);
        if (next === folder) continue;
        updateEmails.run(next, accountId, folder);
        updateState.run(next, accountId, folder);
      }
    })();
    return affected.length;
  }

  /**
   * 删除文件夹的本地级联（服务端已删除后才调用）：连同子文件夹一起清掉
   * 已存邮件、搜索结果索引与同步状态。附件/正文由外键 ON DELETE CASCADE 带走。
   */
  removeFolder(
    accountId: string,
    path: string,
    delimiter: string,
  ): { folders: number; emails: number } {
    const affected = this.pathsUnder(accountId, path, delimiter);
    if (affected.length === 0) return { folders: 0, emails: 0 };

    const dropFts = this.db.prepare(
      'DELETE FROM emails_fts WHERE email_id IN (SELECT id FROM emails WHERE account_id = ? AND folder = ?)',
    );
    const dropEmails = this.db.prepare('DELETE FROM emails WHERE account_id = ? AND folder = ?');
    const dropState = this.db.prepare(
      'DELETE FROM folder_sync_state WHERE account_id = ? AND folder = ?',
    );

    let emails = 0;
    this.db.transaction(() => {
      for (const folder of affected) {
        dropFts.run(accountId, folder);
        emails += Number(dropEmails.run(accountId, folder).changes ?? 0);
        dropState.run(accountId, folder);
      }
    })();
    return { folders: affected.length, emails };
  }
}
