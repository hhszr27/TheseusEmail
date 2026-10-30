import Database from 'better-sqlite3-multiple-ciphers';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 备份创建与完整性验证（§5.2 / §6.8）。
 *
 * 硬约束：迁移前备份必须
 *  1) 使用 SQLite online backup API（而非文件复制）
 *  2) 用同一密钥重新打开并 PRAGMA integrity_check
 *  3) 关键表计数与迁移前一致
 * 任一失败则中止迁移。
 */

export interface BackupCounts {
  emails: number;
  accounts: number;
  folders: number;
}

export interface VerificationResult {
  ok: boolean;
  integrity: string;
  counts: Partial<BackupCounts>;
  errors: string[];
  encryptedHeader: boolean;
}

const PLAINTEXT_HEADER = 'SQLite format 3\0';

export function isPlaintextSqlite(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(16);
    const read = fs.readSync(fd, buffer, 0, 16, 0);
    fs.closeSync(fd);
    return read === 16 && buffer.toString('latin1') === PLAINTEXT_HEADER;
  } catch {
    return false;
  }
}

function countTable(db: Database.Database, table: string): number {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number } | undefined;
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

/**
 * 打开备份文件校验：integrity_check + 关键表计数。
 * 该函数不依赖 Electron，可被 verify-backup 脚本复用（脚本内有等价实现）。
 */
export function verifyBackupFile(
  filePath: string,
  keyHex: string,
  expected?: Partial<BackupCounts>,
): VerificationResult {
  const errors: string[] = [];
  const counts: Partial<BackupCounts> = {};
  let integrity = 'not-checked';
  let encryptedHeader = false;

  if (!fs.existsSync(filePath)) {
    return {
      ok: false,
      integrity: 'missing',
      counts,
      errors: ['备份文件不存在'],
      encryptedHeader: false,
    };
  }

  encryptedHeader = !isPlaintextSqlite(filePath);

  let db: Database.Database | null = null;
  try {
    db = new Database(filePath, { readonly: true, fileMustExist: true });
    db.pragma(`key = "x'${keyHex}'"`);
    db.pragma('busy_timeout = 5000');

    const rows = db.pragma('integrity_check') as Array<{ integrity_check?: string }>;
    integrity = rows.map((row) => row.integrity_check ?? '').join(';') || 'unknown';
    if (integrity !== 'ok') {
      errors.push(`integrity_check 返回 ${integrity}`);
    }

    counts.emails = countTable(db, 'emails');
    counts.accounts = countTable(db, 'accounts');
    counts.folders = countTable(db, 'folder_sync_state');

    if (expected) {
      for (const key of ['emails', 'accounts', 'folders'] as const) {
        const want = expected[key];
        if (want === undefined) continue;
        const got = counts[key] ?? 0;
        if (got !== want) {
          errors.push(`关键表 ${key} 计数不一致：备份 ${got} / 预期 ${want}`);
        }
      }
    }
  } catch (error) {
    errors.push(`无法用给定密钥打开备份：${(error as Error).message}`);
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }

  return {
    ok: errors.length === 0 && integrity === 'ok',
    integrity,
    counts,
    errors,
    encryptedHeader,
  };
}

export function sourceCounts(db: Database.Database): BackupCounts {
  return {
    emails: countTable(db, 'emails'),
    accounts: countTable(db, 'accounts'),
    folders: countTable(db, 'folder_sync_state'),
  };
}

export async function createVerifiedBackup(
  db: Database.Database,
  destination: string,
  keyHex: string,
  expected: BackupCounts,
): Promise<VerificationResult> {
  fs.mkdirSync(path.dirname(destination), { recursive: true });

  /**
   * §5.2 要求"使用 online backup API，而非文件复制"。
   * 实测：better-sqlite3 的 db.backup() 在 SQLCipher 加密库上会抛
   * "backup is not supported with incompatible source and target databases"
   * ——目标连接是明文页格式，与加密源页格式不兼容。
   *
   * 因此改用 SQLite 的 VACUUM INTO：
   *  - 在单个读事务中生成一致性快照（不是文件复制，写入期间也安全）
   *  - 沿用当前连接的 SQLCipher 密钥，产物保持 AES-256 加密
   *  - 产物仍需通过 integrity_check + 关键表计数验证
   */
  if (fs.existsSync(destination)) {
    fs.unlinkSync(destination);
  }

  const quoted = `'${destination.replace(/'/g, "''")}'`;
  db.exec(`VACUUM INTO ${quoted}`);

  const result = verifyBackupFile(destination, keyHex, expected);
  if (!result.ok) {
    throw new Error(`备份验证失败：${result.errors.join('；')}`);
  }
  if (!result.encryptedHeader) {
    throw new Error('备份文件为明文 SQLite，拒绝继续');
  }
  return result;
}
