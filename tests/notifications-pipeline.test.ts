import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, insertAccount, insertEmail } from './helpers/test-db';
import { handleNewEmails } from '../src/main/notifications/pipeline';
import { ContactsRepo } from '../src/main/db/repositories/contacts-repo';
import { EmailsRepo } from '../src/main/db/repositories/emails-repo';
import { RulesRepo } from '../src/main/rules/repo';
import { writeDndSettings, writeNotificationSettings } from '../src/main/notifications/settings';
import type { Account, EmailSummary } from '../src/shared/types';
import type { RawEmailSummary } from '../src/main/mail/sync/protocol';

/**
 * 新邮件本地管道（联系人 → 规则 → 通知策略）的集成测试。
 * 与单元测试的区别：这里跑真实 SQLite 库 + 真实 RulesRepo/ContactsRepo，
 * 只有通知服务用 spy——它依赖 Electron 的 Notification，无法在 node 下实例化。
 */

const ACCOUNT_ID = 'acc-1';
const FOLDER = 'INBOX';

const account = { id: ACCOUNT_ID } as unknown as Account;

function raw(overrides: Partial<RawEmailSummary> = {}): RawEmailSummary {
  return {
    uid: 7,
    messageId: '<7@example.com>',
    subject: '季度预算',
    from: [{ name: 'Alice', address: 'alice@example.com' }],
    to: [{ address: 'me@example.com' }],
    dateMs: Date.now(),
    snippet: '正文摘要不应出现在任何断言里',
    hasAttachments: false,
    unread: true,
    starred: false,
    ...overrides,
  };
}

/** 邮件行必须先落库（AccountManager 的顺序：先 upsertMany 再 onNewEmails）。 */
function seedEmailRow(testDb: ReturnType<typeof createTestDb>, uid = 7): void {
  insertEmail(testDb.db, { id: `${ACCOUNT_ID}|${FOLDER}|${uid}`, accountId: ACCOUNT_ID, uid });
  // 助手不写 unread（默认 0），这里显式置未读，让 markRead 类断言真正可判红
  testDb.db
    .prepare('UPDATE emails SET unread = 1 WHERE id = ?')
    .run(`${ACCOUNT_ID}|${FOLDER}|${uid}`);
}

function run(
  testDb: ReturnType<typeof createTestDb>,
  emails: RawEmailSummary[],
  notified: EmailSummary[],
  options: { suppressNotifications?: boolean } = {},
): void {
  const rules = new RulesRepo(testDb.db);
  const contacts = new ContactsRepo(testDb.db);
  const emailsRepo = new EmailsRepo(testDb.db);
  handleNewEmails(
    {
      db: testDb.db,
      rules,
      contacts,
      notifications: { notifyMail: (email) => notified.push(email) },
      isNotified: (emailId) => emailsRepo.isNotified(emailId),
      markNotified: (emailId, at) => emailsRepo.markNotified(emailId, at),
    },
    account,
    FOLDER,
    emails,
    options,
  );
}

let testDb: ReturnType<typeof createTestDb>;

beforeEach(() => {
  testDb = createTestDb();
  insertAccount(testDb.db, ACCOUNT_ID);
});

afterEach(() => {
  testDb.cleanup();
});

describe('新邮件通知管道（§17 + §22）', () => {
  it('默认设置下新邮件弹一次通知', () => {
    seedEmailRow(testDb);
    const notified: EmailSummary[] = [];
    run(testDb, [raw()], notified);
    expect(notified).toHaveLength(1);
    expect(notified[0]!.id).toBe('acc-1|INBOX|7');
    expect(notified[0]!.subject).toBe('季度预算');
    // 隐私边界说明：管道把完整 summary 交给通知服务，
    // 「只含发件人与主题」的裁剪发生在 buildMailGroupNotification，
    // 由 tests/notifications.test.ts 锁定。
  });

  it('通知总开关关闭时不弹', () => {
    seedEmailRow(testDb);
    writeNotificationSettings(testDb.db, {
      mail: false,
      sendResult: true,
      reminders: true,
      reminderMinutes: 10,
    });
    const notified: EmailSummary[] = [];
    run(testDb, [raw()], notified);
    expect(notified).toHaveLength(0);
  });

  it('免打扰期间不弹', () => {
    seedEmailRow(testDb);
    // startHour === endHour 时 isDndActive 恒真，避免依赖运行时刻
    writeDndSettings(testDb.db, { enabled: true, startHour: 12, endHour: 12 });
    const notified: EmailSummary[] = [];
    run(testDb, [raw()], notified);
    expect(notified).toHaveLength(0);
  });

  it('策略 silent 覆盖默认未读通知', () => {
    seedEmailRow(testDb);
    testDb.db
      .prepare(
        `INSERT INTO notifications (id, account_id, folder, from_pattern, action)
         VALUES ('p1', ?, ?, NULL, 'silent')`,
      )
      .run(ACCOUNT_ID, FOLDER);
    const notified: EmailSummary[] = [];
    run(testDb, [raw()], notified);
    expect(notified).toHaveLength(0);
  });

  it('策略 badge_only 不弹窗', () => {
    seedEmailRow(testDb);
    testDb.db
      .prepare(
        `INSERT INTO notifications (id, account_id, folder, from_pattern, action)
         VALUES ('p1', ?, ?, NULL, 'badge_only')`,
      )
      .run(ACCOUNT_ID, FOLDER);
    const notified: EmailSummary[] = [];
    run(testDb, [raw()], notified);
    expect(notified).toHaveLength(0);
  });

  it('已读邮件静默（decideNotification 默认动作）', () => {
    seedEmailRow(testDb);
    const notified: EmailSummary[] = [];
    run(testDb, [raw({ unread: false })], notified);
    expect(notified).toHaveLength(0);
  });

  it('规则 notify 命中时只弹一次（不重复走默认策略）', () => {
    seedEmailRow(testDb);
    const rules = new RulesRepo(testDb.db);
    rules.upsert({
      id: 'rule-notify',
      name: '预算必弹',
      priority: 1,
      enabled: true,
      conditions: { subject_contains: '预算' },
      actions: { notify: true },
    });
    const notified: EmailSummary[] = [];
    run(testDb, [raw()], notified);
    expect(notified).toHaveLength(1);
    expect(notified[0]!.id).toBe('acc-1|INBOX|7');
  });

  it('规则 notify 也受通知总开关约束', () => {
    seedEmailRow(testDb);
    const rules = new RulesRepo(testDb.db);
    rules.upsert({
      id: 'rule-notify',
      name: '预算必弹',
      priority: 1,
      enabled: true,
      conditions: { subject_contains: '预算' },
      actions: { notify: true },
    });
    writeNotificationSettings(testDb.db, {
      mail: false,
      sendResult: true,
      reminders: true,
      reminderMinutes: 10,
    });
    const notified: EmailSummary[] = [];
    run(testDb, [raw()], notified);
    expect(notified).toHaveLength(0);
  });

  it('规则动作落库：markRead 写回邮件行', () => {
    seedEmailRow(testDb);
    const rules = new RulesRepo(testDb.db);
    rules.upsert({
      id: 'rule-read',
      name: '预算标已读',
      priority: 1,
      enabled: true,
      conditions: { subject_contains: '预算' },
      actions: { markRead: true },
    });
    const notified: EmailSummary[] = [];
    run(testDb, [raw()], notified);
    const row = testDb.db
      .prepare('SELECT unread FROM emails WHERE id = ?')
      .get('acc-1|INBOX|7') as { unread: number };
    expect(row.unread).toBe(0);
    // 没有 notify 动作，默认策略未读判断用 summary（raw.unread=true），仍应弹一次
    expect(notified).toHaveLength(1);
  });

  it('未命中规则时走默认策略弹窗', () => {
    seedEmailRow(testDb);
    const rules = new RulesRepo(testDb.db);
    rules.upsert({
      id: 'rule-other',
      name: '只匹配报销',
      priority: 1,
      enabled: true,
      conditions: { subject_contains: '报销' },
      actions: { markRead: true },
    });
    const notified: EmailSummary[] = [];
    run(testDb, [raw()], notified);
    expect(notified).toHaveLength(1);
    const row = testDb.db
      .prepare('SELECT unread FROM emails WHERE id = ?')
      .get('acc-1|INBOX|7') as { unread: number };
    expect(row.unread).toBe(1);
  });

  it('发件人写入联系人表（含计数累加）', () => {
    seedEmailRow(testDb);
    const notified: EmailSummary[] = [];
    run(testDb, [raw()], notified);
    const contacts = new ContactsRepo(testDb.db);
    const found = contacts.search('alice');
    expect(found).toHaveLength(1);
    expect(found[0]!.email).toBe('alice@example.com');
    expect(found[0]!.displayName).toBe('Alice');
    expect(found[0]!.interactionCount).toBe(1);

    // 第二封同发件人邮件：计数累加而非新建行
    seedEmailRow(testDb, 8);
    run(testDb, [raw({ uid: 8 })], notified);
    const after = contacts.search('alice');
    expect(after).toHaveLength(1);
    expect(after[0]!.interactionCount).toBe(2);
  });

  it('批量多封各自判定（一封静默一封弹）', () => {
    seedEmailRow(testDb);
    seedEmailRow(testDb, 8);
    testDb.db
      .prepare(
        `INSERT INTO notifications (id, account_id, folder, from_pattern, action)
         VALUES ('p1', ?, ?, 'alice', 'silent')`,
      )
      .run(ACCOUNT_ID, FOLDER);
    const notified: EmailSummary[] = [];
    run(testDb, [raw({ uid: 7 }), raw({ uid: 8, from: [{ address: 'bob@example.com' }] })], notified);
    expect(notified).toHaveLength(1);
    expect(notified[0]!.id).toBe('acc-1|INBOX|8');
  });
});

describe('通知去重（只弹到达的那一次）', () => {
  it('启动补拉不弹窗，但会登记，之后也不会再弹', () => {
    seedEmailRow(testDb);
    const notified: EmailSummary[] = [];
    run(testDb, [raw()], notified, { suppressNotifications: true });
    expect(notified).toHaveLength(0);
    // 第二次（正常同步）也不弹：已经登记过
    run(testDb, [raw()], notified);
    expect(notified).toHaveLength(0);
  });

  it('同一封邮件重复进入管道只弹一次', () => {
    seedEmailRow(testDb);
    const notified: EmailSummary[] = [];
    run(testDb, [raw()], notified);
    run(testDb, [raw()], notified);
    expect(notified).toHaveLength(1);
  });

  it('不同邮件各弹一次', () => {
    seedEmailRow(testDb, 7);
    seedEmailRow(testDb, 8);
    const notified: EmailSummary[] = [];
    run(testDb, [raw({ uid: 7 }), raw({ uid: 8, subject: '第二封' })], notified);
    expect(notified).toHaveLength(2);
  });

  it('免打扰期间不弹，但同样登记，解除后不会补弹', () => {
    seedEmailRow(testDb);
    writeDndSettings(testDb.db, { enabled: true, startHour: 12, endHour: 12 });
    const notified: EmailSummary[] = [];
    run(testDb, [raw()], notified);
    writeDndSettings(testDb.db, { enabled: false, startHour: 0, endHour: 0 });
    run(testDb, [raw()], notified);
    expect(notified).toHaveLength(0);
  });
});
