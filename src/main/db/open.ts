import Database from 'better-sqlite3-multiple-ciphers';
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { log } from '../observability/logger';
import { isPlaintextSqlite } from './backup';

export type Db = Database.Database;

export function databasePath(): string {
  return path.join(app.getPath('userData'), 'mailforge.db');
}

/**
 * SQLCipher 配置（§6.3）。PRAGMA key 必须在任何读写前执行。
 */
export function applyCipherPragmas(db: Db, keyHex: string): void {
  db.pragma(`key = "x'${keyHex}'"`);
  db.pragma('kdf_iter = 256000');
  db.pragma('cipher_memory_security = ON');
  db.pragma('cipher_page_size = 4096');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
}

export interface OpenResult {
  db: Db;
  path: string;
  keyProtectionNote: 'encrypted';
}

export function openEncryptedDatabase(keyHex: string, dbPath = databasePath()): OpenResult {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  applyCipherPragmas(db, keyHex);

  try {
    // 第一次真实读取：密钥错误会在这里抛 SQLITE_NOTADB
    db.prepare('SELECT COUNT(*) AS c FROM sqlite_master').get();
  } catch (error) {
    db.close();
    log.error('db', '数据库无法解密', { message: (error as Error).message });
    throw new Error('本地数据库无法解密：密钥不匹配或文件已损坏');
  }

  // 落盘后立即校验文件头不是明文 SQLite
  if (fs.existsSync(dbPath) && isPlaintextSqlite(dbPath)) {
    db.close();
    throw new Error('本地数据库以明文 SQLite 存储，拒绝启动');
  }

  return { db, path: dbPath, keyProtectionNote: 'encrypted' };
}
