/**
 * 独立备份验证工具（§5.2）。
 *
 * 用法（通过 ELECTRON_RUN_AS_NODE 运行，以匹配 ABI）：
 *   npm run verify:backup -- --db <备份文件> --key-hex <64位hex> [--expect-emails N] [--expect-accounts N] [--expect-folders N]
 *   npm run verify:backup -- --db <备份文件> --key-file <含 hex 或 {"keyHex":"..."} 的文件>
 *   MAILFORGE_DB_KEY=<hex> npm run verify:backup -- --db <备份文件>
 *
 * 注意：safeStorage 包装的 db-key.json 无法在应用外解开，因此本工具需要原始 hex。
 * 退出码：0 通过；2 参数错误；3 验证失败。
 */
import Database from 'better-sqlite3-multiple-ciphers';
import fs from 'node:fs';

interface Args {
  db?: string;
  keyHex?: string;
  keyFile?: string;
  expectEmails?: number;
  expectAccounts?: number;
  expectFolders?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    switch (token) {
      case '--db':
        args.db = next;
        index += 1;
        break;
      case '--key-hex':
        args.keyHex = next;
        index += 1;
        break;
      case '--key-file':
        args.keyFile = next;
        index += 1;
        break;
      case '--expect-emails':
        args.expectEmails = Number(next);
        index += 1;
        break;
      case '--expect-accounts':
        args.expectAccounts = Number(next);
        index += 1;
        break;
      case '--expect-folders':
        args.expectFolders = Number(next);
        index += 1;
        break;
      default:
        break;
    }
  }
  return args;
}

function readKeyFromFile(file: string): string | null {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (!raw) return null;
    if (raw.startsWith('{')) {
      const parsed = JSON.parse(raw) as { keyHex?: string };
      return parsed.keyHex ?? null;
    }
    return raw;
  } catch {
    return null;
  }
}

function isPlaintextSqlite(file: string): boolean {
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(16);
  const read = fs.readSync(fd, buffer, 0, 16, 0);
  fs.closeSync(fd);
  return read === 16 && buffer.toString('latin1') === 'SQLite format 3\0';
}

function countTable(db: Database.Database, table: string): number {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number } | undefined;
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  const keyHex = args.keyHex ?? (args.keyFile ? readKeyFromFile(args.keyFile) : null) ?? process.env.MAILFORGE_DB_KEY ?? '';

  if (!args.db) {
    console.error(JSON.stringify({ ok: false, errors: ['缺少 --db 参数'] }, null, 2));
    return 2;
  }
  if (!/^[0-9a-f]{64}$/i.test(keyHex)) {
    console.error(JSON.stringify({ ok: false, errors: ['缺少可用的 32 字节密钥（--key-hex / --key-file / MAILFORGE_DB_KEY）'] }, null, 2));
    return 2;
  }
  if (!fs.existsSync(args.db)) {
    console.error(JSON.stringify({ ok: false, errors: ['备份文件不存在'] }, null, 2));
    return 3;
  }

  const errors: string[] = [];
  const encryptedHeader = !isPlaintextSqlite(args.db);
  if (!encryptedHeader) {
    errors.push('备份文件是明文 SQLite（应为 SQLCipher 加密）');
  }

  let integrity = 'not-checked';
  const counts = { emails: 0, accounts: 0, folders: 0 };
  let db: Database.Database | null = null;

  try {
    db = new Database(args.db, { readonly: true, fileMustExist: true });
    db.pragma(`key = "x'${keyHex}'"`);
    db.pragma('busy_timeout = 5000');

    const rows = db.pragma('integrity_check') as Array<{ integrity_check?: string }>;
    integrity = rows.map((row) => row.integrity_check ?? '').join(';') || 'unknown';
    if (integrity !== 'ok') errors.push(`integrity_check 返回 ${integrity}`);

    counts.emails = countTable(db, 'emails');
    counts.accounts = countTable(db, 'accounts');
    counts.folders = countTable(db, 'folder_sync_state');

    if (args.expectEmails !== undefined && counts.emails !== args.expectEmails) {
      errors.push(`emails 计数不一致：${counts.emails} / 预期 ${args.expectEmails}`);
    }
    if (args.expectAccounts !== undefined && counts.accounts !== args.expectAccounts) {
      errors.push(`accounts 计数不一致：${counts.accounts} / 预期 ${args.expectAccounts}`);
    }
    if (args.expectFolders !== undefined && counts.folders !== args.expectFolders) {
      errors.push(`folder_sync_state 计数不一致：${counts.folders} / 预期 ${args.expectFolders}`);
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

  const ok = errors.length === 0;
  console.log(JSON.stringify({ ok, integrity, counts, encryptedHeader, errors }, null, 2));
  return ok ? 0 : 3;
}

process.exit(main());
