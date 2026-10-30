import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { log } from '../observability/logger';
import { createVerifiedBackup, sourceCounts } from './backup';
import type { Db } from './open';

/**
 * 迁移机制（§5.2）：
 *  - migrations/V001__*.sql，按版本顺序执行
 *  - 有数据的库在迁移前必须做 online backup + 完整性验证
 *  - 任一验证失败则中止迁移，保留原始数据库
 */

export interface MigrationFile {
  version: number;
  name: string;
  sql: string;
  file: string;
}

export interface MigrationResult {
  applied: number[];
  backupPath?: string;
}

export function migrationsDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'migrations')
    : path.join(app.getAppPath(), 'migrations');
}

export function loadMigrations(dir = migrationsDir()): MigrationFile[] {
  if (!fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir)
    .filter((name) => /^V\d+__.+\.sql$/i.test(name))
    .sort((a, b) => {
      const va = Number(/^V(\d+)__/i.exec(a)?.[1] ?? 0);
      const vb = Number(/^V(\d+)__/i.exec(b)?.[1] ?? 0);
      return va - vb;
    });

  return files.map((file) => {
    const version = Number(/^V(\d+)__/i.exec(file)?.[1] ?? 0);
    const name = file.replace(/^V\d+__/i, '').replace(/\.sql$/i, '');
    return {
      version,
      name,
      sql: fs.readFileSync(path.join(dir, file), 'utf8'),
      file,
    };
  });
}

function tableExists(db: Db, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(table) as { name?: string } | undefined;
  return Boolean(row?.name);
}

function countOf(db: Db, table: string): number {
  if (!tableExists(db, table)) return 0;
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number } | undefined;
  return row?.c ?? 0;
}

function ensureSchemaVersions(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_versions (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
}

function appliedVersions(db: Db): Set<number> {
  const rows = db.prepare('SELECT version FROM schema_versions').all() as Array<{ version: number }>;
  return new Set(rows.map((row) => row.version));
}

export async function runMigrations(
  db: Db,
  context: { keyHex: string; dbPath: string; backupDir?: string },
): Promise<MigrationResult> {
  ensureSchemaVersions(db);

  const migrations = loadMigrations();
  const applied = appliedVersions(db);
  const pending = migrations.filter((migration) => !applied.has(migration.version));

  if (pending.length === 0) return { applied: [] };

  let backupPath: string | undefined;

  // 只有"已有数据"的库才需要迁移前备份；全新库无需备份
  const hasData = countOf(db, 'accounts') > 0 || countOf(db, 'emails') > 0;
  if (hasData) {
    const firstVersion = pending[0]?.version ?? 0;
    const dir = context.backupDir ?? path.join(path.dirname(context.dbPath), 'backups');
    backupPath = path.join(
      dir,
      `pre-migration-v${firstVersion}-${new Date().toISOString().replace(/[:.]/g, '-')}.db`,
    );
    const counts = sourceCounts(db);
    log.info('migrate', '迁移前备份开始', { backupPath, counts });
    try {
      await createVerifiedBackup(db, backupPath, context.keyHex, counts);
    } catch (error) {
      log.error('migrate', '迁移前备份验证失败，中止迁移', { message: (error as Error).message });
      throw new Error('迁移前备份未通过完整性验证，已中止迁移（原始数据库保持不变）');
    }
    log.info('migrate', '迁移前备份验证通过', { counts });
  }

  const appliedNow: number[] = [];
  for (const migration of pending) {
    const started = Date.now();
    db.exec('BEGIN');
    try {
      db.exec(migration.sql);
      db.prepare(
        'INSERT INTO schema_versions (version, name, applied_at) VALUES (?, ?, ?)',
      ).run(migration.version, migration.name, Date.now());
      db.exec('COMMIT');
      appliedNow.push(migration.version);
      log.info('migrate', 'migration applied', {
        version: migration.version,
        name: migration.name,
        durationMs: Date.now() - started,
      });
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // ignore
      }
      log.error('migrate', 'migration failed', {
        version: migration.version,
        name: migration.name,
        message: (error as Error).message,
      });
      throw error;
    }
  }

  return { applied: appliedNow, ...(backupPath ? { backupPath } : {}) };
}
