import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, insertAccount } from './helpers/test-db';
import { DraftsRepo } from '../src/main/db/repositories/drafts-repo';
import { buildDraftMessage } from '../src/main/mail/draft-message';
import { envelopeRecipients } from '../src/main/mail/smtp-sender';

/**
 * 密送（Bcc）的三条硬约束：
 *  1. 发给谁：信封里必须有密送地址（否则密送对象收不到）；
 *  2. 不能泄露：消息头里绝不能出现 Bcc（否则所有收件人都看得到）；
 *  3. 草稿要记住：重新打开/发送时密送不能丢。
 */

describe('SMTP 信封（envelopeRecipients）', () => {
  it('to、cc、bcc 都进信封', () => {
    expect(
      envelopeRecipients({
        to: ['a@example.com'],
        cc: ['b@example.com'],
        bcc: ['c@example.com', 'd@example.com'],
        subject: '',
        text: '',
      }),
    ).toEqual(['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com']);
  });

  it('没有密送时信封等于 to + cc', () => {
    expect(
      envelopeRecipients({ to: ['a@example.com'], cc: ['b@example.com'], subject: '', text: '' }),
    ).toEqual(['a@example.com', 'b@example.com']);
  });

  it('空串与多余空格被清掉', () => {
    expect(
      envelopeRecipients({
        to: [' a@example.com '],
        bcc: ['  ', 'b@example.com'],
        subject: '',
        text: '',
      }),
    ).toEqual(['a@example.com', 'b@example.com']);
  });
});

describe('服务器草稿的 MIME（buildDraftMessage）', () => {
  it('带密送时写出 Bcc 头（草稿要能带回密送）', () => {
    const raw = buildDraftMessage({
      from: 'me@example.com',
      to: ['a@example.com'],
      cc: ['b@example.com'],
      bcc: ['secret@example.com'],
      subject: '主题',
      text: '正文',
    });
    expect(raw).toContain('Bcc: secret@example.com');
    expect(raw).toContain('Cc: b@example.com');
  });

  it('没有密送时不写 Bcc 头', () => {
    const raw = buildDraftMessage({
      from: 'me@example.com',
      to: ['a@example.com'],
      subject: '主题',
      text: '正文',
    });
    expect(raw).not.toContain('Bcc:');
  });
});

describe('草稿表的密送字段', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let repo: DraftsRepo;

  beforeEach(() => {
    testDb = createTestDb();
    insertAccount(testDb.db, 'acc-1');
    repo = new DraftsRepo(testDb.db);
  });

  afterEach(() => {
    testDb.cleanup();
  });

  it('保存后再读回来，密送地址仍在', () => {
    repo.save({
      accountId: 'acc-1',
      to: ['a@example.com'],
      cc: ['b@example.com'],
      bcc: ['secret@example.com'],
      subject: '主题',
      body: '正文',
      attachments: [],
    });
    const loaded = repo.get('acc-1');
    expect(loaded?.bcc).toEqual(['secret@example.com']);
    expect(loaded?.cc).toEqual(['b@example.com']);
  });

  it('更新草稿时密送会被覆盖而不是叠加', () => {
    const base = {
      accountId: 'acc-1',
      to: ['a@example.com'],
      cc: [],
      subject: '主题',
      body: '正文',
      attachments: [],
    };
    repo.save({ ...base, bcc: ['old@example.com'] });
    repo.save({ ...base, bcc: ['new@example.com'] });
    expect(repo.get('acc-1')?.bcc).toEqual(['new@example.com']);
  });

  it('旧草稿（没有 bcc 列值）读出来是空数组而不是崩', () => {
    testDb.db
      .prepare(
        `INSERT INTO drafts (account_id, to_json, cc_json, subject, body, attachments_json, updated_at)
         VALUES ('acc-1', '["a@example.com"]', '[]', '旧草稿', '正文', '[]', 1)`,
      )
      .run();
    expect(repo.get('acc-1')?.bcc).toEqual([]);
  });
});
