import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DND,
  buildMailGroupNotification,
  buildNotificationPayload,
  buildTestNotification,
  decideNotification,
  isDndActive,
  shouldNotifyMail,
  type NotificationPolicy,
} from '../src/main/notifications/policy';
import type { EmailSummary } from '../src/shared/types';

const email: EmailSummary = {
  id: 'e1',
  uid: 1,
  folder: 'INBOX',
  accountId: 'acc-1',
  subject: '会议纪要',
  from: [{ name: 'Alice', address: 'alice@example.com' }],
  to: [{ address: 'me@example.com' }],
  date: new Date().toISOString(),
  snippet: '这里是很长的正文摘要，不应该出现在通知里',
  hasAttachments: false,
  unread: true,
  starred: false,
  pinned: false,
};

function at(hour: number): Date {
  const date = new Date();
  date.setHours(hour, 30, 0, 0);
  return date;
}

describe('通知策略（§22）', () => {
  it('DND 跨午夜时段生效', () => {
    const dnd = { enabled: true, startHour: 22, endHour: 8 };
    expect(isDndActive(dnd, at(23))).toBe(true);
    expect(isDndActive(dnd, at(7))).toBe(true);
    expect(isDndActive(dnd, at(12))).toBe(false);
    expect(isDndActive({ ...dnd, enabled: false }, at(23))).toBe(false);
  });

  it('按账户/文件夹/发件人匹配策略', () => {
    const policies: NotificationPolicy[] = [
      { accountId: 'other', action: 'notify' },
      { accountId: 'acc-1', folder: 'INBOX', from: 'alice', action: 'badge_only' },
    ];
    expect(decideNotification(email, policies, DEFAULT_DND, at(10))).toBe('badge_only');
  });

  it('DND 优先级高于通知策略', () => {
    const policies: NotificationPolicy[] = [{ action: 'notify' }];
    expect(
      decideNotification(email, policies, { enabled: true, startHour: 22, endHour: 8 }, at(23)),
    ).toBe('silent');
  });

  it('默认未读通知、已读静默', () => {
    expect(decideNotification(email, [], DEFAULT_DND, at(10))).toBe('notify');
    expect(decideNotification({ ...email, unread: false }, [], DEFAULT_DND, at(10))).toBe('silent');
  });

  it('通知内容不含正文摘要', () => {
    const payload = buildNotificationPayload(email);
    expect(payload.title).toBe('Alice');
    expect(payload.body).toBe('会议纪要');
    expect(JSON.stringify(payload)).not.toContain('正文摘要');
  });
});

describe('通知闸门 shouldNotifyMail（§22）', () => {
  it('设置总开关关闭时一律不弹', () => {
    expect(shouldNotifyMail(false, 'notify', DEFAULT_DND, at(10))).toBe(false);
  });

  it('DND 期间静默，即使策略是 notify', () => {
    const dnd = { enabled: true, startHour: 22, endHour: 8 };
    expect(shouldNotifyMail(true, 'notify', dnd, at(23))).toBe(false);
    expect(shouldNotifyMail(true, 'notify', dnd, at(10))).toBe(true);
  });

  it('只有 notify 动作会弹窗', () => {
    expect(shouldNotifyMail(true, 'silent', DEFAULT_DND, at(10))).toBe(false);
    expect(shouldNotifyMail(true, 'badge_only', DEFAULT_DND, at(10))).toBe(false);
    expect(shouldNotifyMail(true, 'notify', DEFAULT_DND, at(10))).toBe(true);
  });
});

describe('批量新邮件合并文案', () => {
  const second: EmailSummary = {
    ...email,
    id: 'e2',
    subject: '季度预算',
    from: [{ name: 'Bob', address: 'bob@example.com' }],
  };

  it('空列表返回 null', () => {
    expect(buildMailGroupNotification([])).toBeNull();
  });

  it('单封直出并带回 emailId（点击可定位）', () => {
    const group = buildMailGroupNotification([email]);
    expect(group).toEqual({ title: 'Alice', body: '会议纪要', emailId: 'e1' });
  });

  it('多封合并为计数标题，内容只含发件人与主题', () => {
    const group = buildMailGroupNotification([email, second]);
    expect(group?.title).toBe('2 封新邮件');
    expect(group?.body).toBe('最新：Alice — 会议纪要');
    expect(group?.emailId).toBeNull();
    expect(JSON.stringify(group)).not.toContain('正文摘要');
  });

  it('发件人只有地址时用地址', () => {
    const noName: EmailSummary = { ...email, from: [{ address: 'noname@example.com' }] };
    const group = buildMailGroupNotification([noName, second]);
    expect(group?.body).toBe('最新：noname@example.com — 会议纪要');
  });

  it('发件人为空时用兜底文案', () => {
    const empty: EmailSummary = { ...email, from: [] };
    const group = buildMailGroupNotification([empty, second]);
    expect(group?.body).toBe('最新：新发件人 — 会议纪要');
  });
});

describe('测试通知文案', () => {
  it('含产品名与可自行验证的提示', () => {
    const payload = buildTestNotification();
    expect(payload.title).toContain('MailForge');
    expect(payload.body).toContain('桌面通知');
  });

  it('文案固定，不夹带任何邮件数据', () => {
    // 同一函数两次调用必须一致：测试通知与具体邮件无关
    expect(buildTestNotification()).toEqual(buildTestNotification());
  });
});
