import Database from 'better-sqlite3-multiple-ciphers';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * V014 的存量数据回填。
 *
 * 新邮件在解析时就会带上 inline 标记；但升级前已经入库的邮件不会再解析一遍，
 * 所以必须在迁移里按「正文是否用 cid: 引用了它」补标记，否则用户重启后
 * 老邮件里的签名图仍然会挂在附件条上。
 *
 * 同时要守住反面：正文没引用的图片（用户真的附了一张图）不能被误藏。
 */

function migrationFiles(): string[] {
  return fs
    .readdirSync(path.resolve('migrations'))
    .filter((name) => /^V\d+__.+\.sql$/i.test(name))
    .sort(
      (a, b) =>
        Number(/^V(\d+)__/i.exec(a)?.[1] ?? 0) - Number(/^V(\d+)__/i.exec(b)?.[1] ?? 0),
    );
}

const MIGRATIONS = migrationFiles();
const V14 = 'V014__attachment_inline.sql';

let dir = '';
let db: Database.Database | null = null;

afterEach(() => {
  try {
    db?.close();
  } catch {
    // ignore
  }
  db = null;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = '';
});

/** 建一个只跑到 V013 的库，模拟升级前的状态。 */
function openBeforeV14(): Database.Database {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailforge-mig-'));
  const database = new Database(path.join(dir, 'test.db'));
  database.pragma('foreign_keys = ON');
  for (const file of MIGRATIONS) {
    const version = Number(/^V(\d+)__/i.exec(file)?.[1] ?? 0);
    if (version >= 14) continue;
    database.exec(fs.readFileSync(path.resolve('migrations', file), 'utf8'));
  }
  return database;
}

function seedEmail(database: Database.Database, id: string, uid: number, html: string): void {
  database
    .prepare(
      `INSERT INTO accounts (id, display_name, email, protocol, auth_type, created_at)
       VALUES ('acc', 'acc', 'acc@example.com', 'imap-smtp', 'password', 1)`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO emails
         (id, account_id, folder, uid, uidvalidity, subject, from_json, to_json, date, snippet, has_attachments)
       VALUES (?, 'acc', 'INBOX', ?, 1, 's', '[]', '[]', 1, '', 1)`,
    )
    .run(id, uid);
  database
    .prepare('INSERT INTO email_bodies (email_id, html, text, fetched_at) VALUES (?, ?, ?, 1)')
    .run(id, html, '');
}

function seedAttachment(
  database: Database.Database,
  input: { id: string; emailId: string; filename: string; mimeType: string; contentId?: string },
): void {
  database
    .prepare(
      `INSERT INTO attachments (id, email_id, filename, mime_type, size, ext, sha256, content_id)
       VALUES (?, ?, ?, ?, 10, '', ?, ?)`,
    )
    .run(
      input.id,
      input.emailId,
      input.filename,
      input.mimeType,
      `sha-${input.id}`,
      input.contentId ?? null,
    );
}

function applyV14(database: Database.Database): void {
  database.exec(fs.readFileSync(path.resolve('migrations', V14), 'utf8'));
}

describe('V014 存量内嵌图回填', () => {
  it('正文 cid 引用过的图片标为 inline；真实附件不受影响', () => {
    db = openBeforeV14();
    seedEmail(db, 'm1', 1, '<p><img src="cid:logo@x"></p>');
    seedAttachment(db, {
      id: 'a-logo',
      emailId: 'm1',
      filename: 'logo.png',
      mimeType: 'image/png',
      contentId: 'logo@x',
    });
    seedAttachment(db, {
      id: 'a-pdf',
      emailId: 'm1',
      filename: 'report.pdf',
      mimeType: 'application/pdf',
    });

    applyV14(db);

    const rows = db
      .prepare('SELECT id, inline FROM attachments WHERE email_id = ? ORDER BY id')
      .all('m1') as Array<{ id: string; inline: number }>;
    expect(rows).toEqual([
      { id: 'a-logo', inline: 1 },
      { id: 'a-pdf', inline: 0 },
    ]);
    // 有真实附件 → 回形针保留
    expect(
      (db.prepare('SELECT has_attachments FROM emails WHERE id = ?').get('m1') as {
        has_attachments: number;
      }).has_attachments,
    ).toBe(1);
  });

  it('只有内嵌图的邮件去掉回形针', () => {
    db = openBeforeV14();
    seedEmail(db, 'm2', 2, '<p><img src="cid:sig@x"></p>');
    seedAttachment(db, {
      id: 'a-sig',
      emailId: 'm2',
      filename: 'signature.png',
      mimeType: 'image/png',
      contentId: 'sig@x',
    });

    applyV14(db);

    expect(
      (db.prepare('SELECT inline FROM attachments WHERE id = ?').get('a-sig') as {
        inline: number;
      }).inline,
    ).toBe(1);
    expect(
      (db.prepare('SELECT has_attachments FROM emails WHERE id = ?').get('m2') as {
        has_attachments: number;
      }).has_attachments,
    ).toBe(0);
  });

  it('正文没引用的图片（用户真的附了一张图）不能被误藏', () => {
    db = openBeforeV14();
    seedEmail(db, 'm3', 3, '<p><img src="cid:other@x"></p>');
    seedAttachment(db, {
      id: 'a-photo',
      emailId: 'm3',
      filename: 'photo.jpg',
      mimeType: 'image/jpeg',
      contentId: 'photo@x',
    });

    applyV14(db);

    expect(
      (db.prepare('SELECT inline FROM attachments WHERE id = ?').get('a-photo') as {
        inline: number;
      }).inline,
    ).toBe(0);
    expect(
      (db.prepare('SELECT has_attachments FROM emails WHERE id = ?').get('m3') as {
        has_attachments: number;
      }).has_attachments,
    ).toBe(1);
  });
});
