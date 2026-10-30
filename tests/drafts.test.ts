import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DraftsRepo } from '../src/main/db/repositories/drafts-repo';
import { draftMatchesComposeRequest } from '../src/renderer/lib/compose';
import { createTestDb, type TestDb } from './helpers/test-db';

/**
 * 本地草稿（每账户一封）：
 *  - 按账户覆盖保存，不产生多行；
 *  - 读取时字段结构完整；
 *  - 删除只影响该账户；
 *  - attachmentIds 汇总所有草稿引用的附件，用于启动清理时的保护。
 */

let context: TestDb;
let repo: DraftsRepo;

beforeEach(() => {
  context = createTestDb();
  repo = new DraftsRepo(context.db);
});

afterEach(() => {
  context.cleanup();
});

function draft(accountId = 'acc-1', overrides: Record<string, unknown> = {}) {
  return {
    accountId,
    to: ['a@example.com'],
    cc: [],

    bcc: [],
    subject: '草稿主题',
    body: '正文',
    attachments: [],
    ...overrides,
  };
}

describe('DraftsRepo', () => {
  it('保存后可按账户读回', () => {
    repo.save(draft(), 1_000);
    const loaded = repo.get('acc-1');

    expect(loaded).toMatchObject({
      accountId: 'acc-1',
      to: ['a@example.com'],
      subject: '草稿主题',
      body: '正文',
      updatedAt: 1_000,
    });
  });

  it('同一账户重复保存只保留最新一份', () => {
    repo.save(draft(), 1_000);
    repo.save(draft('acc-1', { subject: '改过的主题', body: '新正文' }), 2_000);

    expect(repo.list()).toHaveLength(1);
    expect(repo.get('acc-1')?.subject).toBe('改过的主题');
    expect(repo.get('acc-1')?.updatedAt).toBe(2_000);
  });

  it('不同账户互不影响', () => {
    repo.save(draft('acc-1'), 1_000);
    repo.save(draft('acc-2', { subject: '另一封' }), 2_000);

    expect(repo.list()).toHaveLength(2);
    expect(repo.get('acc-2')?.subject).toBe('另一封');
  });

  it('删除只移除指定账户', () => {
    repo.save(draft('acc-1'), 1_000);
    repo.save(draft('acc-2'), 2_000);

    expect(repo.remove('acc-1')).toBe(true);
    expect(repo.get('acc-1')).toBeNull();
    expect(repo.get('acc-2')).not.toBeNull();
    expect(repo.remove('acc-1')).toBe(false);
  });

  it('附件元信息按原样保存', () => {
    repo.save(
      draft('acc-1', {
        attachments: [{ id: 'att-1', filename: 'a.pdf', size: 12, mimeType: 'application/pdf' }],
      }),
      1_000,
    );
    expect(repo.get('acc-1')?.attachments[0]?.filename).toBe('a.pdf');
  });

  it('attachmentIds 汇总且去重', () => {
    repo.save(
      draft('acc-1', {
        attachments: [
          { id: 'att-1', filename: 'a.pdf', size: 1, mimeType: 'application/pdf' },
          { id: 'att-2', filename: 'b.txt', size: 1, mimeType: 'text/plain' },
        ],
      }),
      1_000,
    );
    repo.save(
      draft('acc-2', {
        attachments: [{ id: 'att-1', filename: 'a.pdf', size: 1, mimeType: 'application/pdf' }],
      }),
      2_000,
    );

    expect(repo.attachmentIds().sort()).toEqual(['att-1', 'att-2']);
  });

  it('list 按更新时间倒序（草稿箱最新在上）', () => {
    repo.save(draft('acc-1', { subject: '旧' }), 1_000);
    repo.save(draft('acc-2', { subject: '新' }), 5_000);
    repo.save(draft('acc-3', { subject: '中' }), 3_000);

    expect(repo.list().map((item) => item.subject)).toEqual(['新', '中', '旧']);
  });

  it('JSON 损坏时回退为空数组而不是抛错', () => {
    context.db
      .prepare(
        `INSERT INTO drafts (account_id, to_json, cc_json, subject, body, attachments_json, updated_at)
         VALUES ('acc-x', 'not-json', '[]', 's', 'b', 'oops', 1)`,
      )
      .run();

    expect(repo.get('acc-x')).toMatchObject({ to: [], cc: [],
 bcc: [], attachments: [] });
  });

  it('html 与 serverUid 随草稿一并持久化与读回', () => {
    const html = '<p>富文本 <b>加粗</b></p>';
    repo.save(draft('acc-1', { html, serverUid: 42 }), 1_000);
    const loaded = repo.get('acc-1');
    expect(loaded?.html).toBe(html);
    expect(loaded?.serverUid).toBe(42);
  });

  it('未提供 html/serverUid 时回退为空串与 -1', () => {
    repo.save(draft('acc-1'), 1_000);
    const loaded = repo.get('acc-1');
    expect(loaded?.html).toBe('');
    expect(loaded?.serverUid).toBe(-1);
  });

  it('保存时显式传入 serverUid 会被持久化', () => {
    repo.save(draft('acc-1', { serverUid: 9 }), 1_000);
    expect(repo.get('acc-1')?.serverUid).toBe(9);
  });

  it('setServerUid 单独回填服务器 uid', () => {
    repo.save(draft('acc-1'), 1_000);
    repo.setServerUid('acc-1', 11);
    expect(repo.get('acc-1')?.serverUid).toBe(11);
  });

  it('list 返回的草稿也携带 html 与 serverUid', () => {
    repo.save(draft('acc-1', { html: '<i>x</i>', serverUid: 3 }), 1_000);
    const listed = repo.list().find((item) => item.accountId === 'acc-1');
    expect(listed?.html).toBe('<i>x</i>');
    expect(listed?.serverUid).toBe(3);
  });
});

describe('draftMatchesComposeRequest', () => {
  const base = {
    accountId: 'acc-1',
    to: ['a@example.com'],
    cc: [],

    bcc: [],
    subject: '主题',
    body: '正文',
    attachments: [],
    updatedAt: 1,
  };

  it('内容与附件都一致时视为同一草稿', () => {
    expect(
      draftMatchesComposeRequest(base, {
        to: ['a@example.com'],
        cc: [],
        subject: '主题',
        body: '正文',
      }),
    ).toBe(true);
  });

  it('正文不同则不算同一草稿', () => {
    expect(
      draftMatchesComposeRequest(base, {
        to: ['a@example.com'],
        cc: [],
        subject: '主题',
        body: '改过的正文',
      }),
    ).toBe(false);
  });

  it('附件数量不同则不算同一草稿', () => {
    expect(
      draftMatchesComposeRequest(
        { ...base, attachments: [{ id: 'a', filename: 'a.pdf', size: 1, mimeType: 'application/pdf' }] },
        { to: ['a@example.com'], cc: [], subject: '主题', body: '正文' },
      ),
    ).toBe(false);
  });
});
