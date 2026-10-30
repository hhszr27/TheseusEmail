import Database from 'better-sqlite3-multiple-ciphers';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EmailsRepo } from '../src/main/db/repositories/emails-repo';
import { SearchService } from '../src/main/search/service';
import type { RawEmailSummary } from '../src/main/mail/sync/protocol';

let dir = '';
let db: Database.Database;
let emails: EmailsRepo;
let search: SearchService;

function raw(
  uid: number,
  subject: string,
  hasAttachments = false,
  unread = false,
  starred = false,
): RawEmailSummary {
  return {
    uid,
    messageId: `<${uid}@example.com>`,
    subject,
    from: [{ name: 'Alice', address: 'alice@example.com' }],
    to: [{ address: 'me@example.com' }],
    dateMs: Date.UTC(2026, 9, 1) + uid,
    snippet: '摘要',
    hasAttachments,
    unread,
    starred,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-search-'));
  db = new Database(path.join(dir, 'db.sqlite'));
  db.pragma(`key = "x'${'cc'.repeat(32)}'"`);
  db.exec(fs.readFileSync(path.resolve('migrations/V001__initial.sql'), 'utf8'));
  db.exec(fs.readFileSync(path.resolve('migrations/V002__phase2.sql'), 'utf8'));
  db.exec(fs.readFileSync(path.resolve('migrations/V003__scheduled_retry.sql'), 'utf8'));

  emails = new EmailsRepo(db);
  search = new SearchService(db, emails);

  emails.upsertMany('acc', 'INBOX', 1, [raw(1, '季度预算'), raw(2, '项目周报', true)]);
  emails.saveBody('acc|INBOX|1', '<p>机密项目预算报告，含 <b>预算</b> 说明</p>', '机密项目预算报告');
  emails.saveBody('acc|INBOX|2', '<p>本周进展</p>', '本周进展');
  search.indexEmail('acc|INBOX|1');
  search.indexEmail('acc|INBOX|2');
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('FTS 检索（§18）', () => {
  it('中文双字词可命中正文（短词 LIKE 回退）', () => {
    const result = search.search({ query: '预算' });
    expect(result.total).toBe(1);
    expect(result.emails[0]?.subject).toBe('季度预算');
  });

  it('三字以上中文走 trigram', () => {
    const result = search.search({ query: '项目预算' });
    expect(result.total).toBe(1);
  });

  it('支持 from / has / after 过滤器', () => {
    expect(search.search({ query: 'from:alice' }).total).toBe(2);
    expect(search.search({ query: 'has:attachment' }).total).toBe(1);
    expect(search.search({ query: 'after:2026-10-01' }).total).toBe(2);
  });

  it('filter 与列表同口径：未读 / 已标记', () => {
    emails.upsertMany('acc', 'INBOX', 1, [
      raw(3, '未读的那封', false, true),
      raw(4, '已标记的那封', false, false, true),
    ]);
    // from:alice 命中全部四封；加 filter 后各自只剩符合条件的
    expect(search.search({ query: 'from:alice' }).total).toBe(4);

    const unread = search.search({ query: 'from:alice', filter: 'unread' });
    expect(unread.total).toBe(1);
    expect(unread.emails[0]?.subject).toBe('未读的那封');

    const starred = search.search({ query: 'from:alice', filter: 'starred' });
    expect(starred.total).toBe(1);
    expect(starred.emails[0]?.subject).toBe('已标记的那封');

    // 非白名单值回落「所有邮件」，不会把结果筛空
    expect(search.search({ query: 'from:alice', filter: 'bogus' as never }).total).toBe(4);
  });

  it('sort 与列表同口径：默认按日期倒序，可按主题升序', () => {
    emails.upsertMany('acc', 'INBOX', 1, [raw(3, 'Alpha'), raw(4, 'Zeta')]);
    expect(search.search({ query: 'from:alice' }).emails.map((email) => email.subject)).toEqual([
      'Zeta',
      'Alpha',
      '项目周报',
      '季度预算',
    ]);
    const bySubject = search.search({ query: 'from:alice', sort: 'subject' });
    expect(bySubject.emails.slice(0, 2).map((email) => email.subject)).toEqual(['Alpha', 'Zeta']);
  });

  it('删除邮件后对账清理孤儿索引，搜索不再命中', () => {
    db.prepare('DELETE FROM emails WHERE id = ?').run('acc|INBOX|1');
    search.reconcile();
    expect(search.search({ query: '预算' }).total).toBe(0);
  });

  it('optimize 后段数收敛为 1', () => {
    for (let index = 3; index < 60; index += 1) {
      emails.upsertMany('acc', 'INBOX', 1, [raw(index, `批量邮件 ${index}`)]);
      emails.saveBody(`acc|INBOX|${index}`, `<p>批量内容 ${index}</p>`, `批量内容 ${index}`);
      search.indexEmail(`acc|INBOX|${index}`);
    }
    const before = search.segmentCount();
    expect(before).toBeGreaterThan(1);
    const optimized = search.optimize();
    expect(optimized.segments).toBe(1);
    // 57 封邮件逐条写 FTS，在 90+ 个测试文件并行时会超过默认 5s；
    // 这里放宽超时，避免把「机器忙」误报成索引回归。
  }, 15_000);
});
