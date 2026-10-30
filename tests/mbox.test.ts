import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MboxService } from '../src/main/mbox/service';
import { buildMbox, escapeFromLines, isMbox, splitMbox, unescapeFromLines } from '../src/main/mbox/mbox';
import { AccountsRepo } from '../src/main/db/repositories/accounts-repo';
import { FoldersRepo } from '../src/main/db/repositories/folders-repo';
import { EmailsRepo } from '../src/main/db/repositories/emails-repo';
import { SearchService } from '../src/main/search/service';
import { createTestDb, insertAccount, type TestDb } from './helpers/test-db';

let context: TestDb | null = null;

afterEach(() => {
  context?.cleanup();
  context = null;
});

const MBOX = `From alice@example.com Mon Oct 20 10:00:00 2026
From: Alice <alice@example.com>
To: me@example.com
Subject: Budget review
Date: Mon, 20 Oct 2026 10:00:00 +0800
MIME-Version: 1.0
Content-Type: text/html; charset=utf-8

<html><body><p>季度预算评审</p><script>alert(1)</script><p>请准备材料</p></body></html>

From bob@example.com Mon Oct 20 11:00:00 2026
From: Bob <bob@example.com>
To: me@example.com
Subject: Lunch
Date: Mon, 20 Oct 2026 11:00:00 +0800
MIME-Version: 1.0
Content-Type: text/plain; charset=utf-8

明天一起吃饭吗？
`;

describe('MBOX 文本层（§32.1）', () => {
  it('按 From_ 行拆分并还原 >From', () => {
    const messages = splitMbox(MBOX);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain('Subject: Budget review');
    expect(messages[1]).toContain('明天一起吃饭吗？');

    expect(unescapeFromLines('>From here')).toBe('From here');
    expect(escapeFromLines('From here\nFrom there')).toBe('>From here\n>From there');
  });

  it('导出后再拆分保持不变', () => {
    const mbox = buildMbox(['Subject: a\n\nFrom the start\n', 'Subject: b\n\nbody']);
    expect(isMbox(mbox)).toBe(true);
    const messages = splitMbox(mbox);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain('From the start');
  });

  it('没有 From_ 行时按单封处理', () => {
    expect(splitMbox('Subject: only\n\nbody')).toHaveLength(1);
    expect(splitMbox('   ')).toHaveLength(0);
  });
});

describe('MBOX 导入导出（§32.1）', () => {
  function buildService(db: TestDb): {
    service: MboxService;
    emails: EmailsRepo;
    search: SearchService;
  } {
    insertAccount(db.db, 'acc-1');
    const accounts = new AccountsRepo(db.db);
    const folders = new FoldersRepo(db.db);
    const emails = new EmailsRepo(db.db);
    const search = new SearchService(db.db, emails);
    const service = new MboxService({
      db: db.db,
      accounts,
      folders,
      emails,
      indexEmail: (emailId) => search.indexEmail(emailId),
    });
    return { service, emails, search };
  }

  it('导入后邮件入库、净化并进入 FTS', async () => {
    context = createTestDb();
    const { service, emails, search } = buildService(context);
    const file = path.join(context.dir, 'inbox.mbox');
    fs.writeFileSync(file, MBOX, 'utf8');

    const result = await service.importFile('acc-1', file);
    expect(result).toEqual({ imported: 2, folder: 'MBOX 导入', errors: 0 });

    expect(emails.total('acc-1', 'MBOX 导入')).toBe(2);
    const listed = emails.list('acc-1', 'MBOX 导入', 0, 10);
    const budget = listed.find((email) => email.subject === 'Budget review');
    expect(budget).toBeTruthy();

    const body = emails.getBody(budget!.id);
    expect(body?.html).toContain('季度预算评审');
    expect(body?.html).not.toContain('<script');
    expect(body?.html).not.toContain('alert(1)');

    const hits = search.search({ query: '季度预算', accountId: 'acc-1', limit: 10 });
    expect(hits.total).toBeGreaterThan(0);
    expect(hits.emails[0]?.subject).toBe('Budget review');
  });

  it('导出为明文 MBOX 并可被重新拆分', async () => {
    context = createTestDb();
    const { service } = buildService(context);
    const importFile = path.join(context.dir, 'inbox.mbox');
    fs.writeFileSync(importFile, MBOX, 'utf8');
    await service.importFile('acc-1', importFile);

    const output = path.join(context.dir, 'out.mbox');
    const result = await service.exportFolder('acc-1', 'MBOX 导入', output);
    expect(result.exported).toBe(2);

    const text = fs.readFileSync(output, 'utf8');
    expect(splitMbox(text)).toHaveLength(2);
    expect(text).toContain('Subject: Budget review');
    expect(text).toContain('明天一起吃饭吗？');
  });

  it('空 MBOX 导入返回可读错误', async () => {
    context = createTestDb();
    const { service } = buildService(context);
    const file = path.join(context.dir, 'empty.mbox');
    fs.writeFileSync(file, '', 'utf8');
    await expect(service.importFile('acc-1', file)).rejects.toThrow('没有可导入的邮件');
  });
});
