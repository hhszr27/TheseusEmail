import Database from 'better-sqlite3-multiple-ciphers';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContactsRepo } from '../src/main/db/repositories/contacts-repo';

let dir = '';
let db: Database.Database;
let repo: ContactsRepo;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-contacts-'));
  db = new Database(path.join(dir, 'db.sqlite'));
  db.pragma(`key = "x'${'aa'.repeat(32)}'"`);
  db.exec(fs.readFileSync(path.resolve('migrations/V001__initial.sql'), 'utf8'));
  repo = new ContactsRepo(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('联系人补全（§20.1）', () => {
  it('按交互频率与最近时间排序', () => {
    const now = Date.now();
    for (let i = 0; i < 5; i += 1) {
      repo.upsertFrom({ name: 'Alice', address: 'alice@example.com' }, now - i * 1000);
    }
    for (let i = 0; i < 2; i += 1) {
      repo.upsertFrom({ name: 'Bob', address: 'bob@example.com' }, now - i * 1000);
    }

    const results = repo.search('');
    expect(results[0]?.email).toBe('alice@example.com');
    expect(results[0]?.interactionCount).toBe(5);
    expect(results[1]?.email).toBe('bob@example.com');
  });

  it('按邮箱或显示名搜索，忽略大小写', () => {
    repo.upsertFrom({ name: '张总', address: 'Boss@Example.com' }, Date.now());
    expect(repo.search('boss')[0]?.email).toBe('boss@example.com');
    expect(repo.search('张')[0]?.displayName).toBe('张总');
    expect(repo.search('nobody')).toHaveLength(0);
  });

  it('拒绝无效地址', () => {
    repo.upsertFrom({ address: 'not-an-address' }, Date.now());
    repo.upsertFrom({ address: '' }, Date.now());
    expect(repo.count()).toBe(0);
  });
});
