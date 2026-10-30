import type { EmailSummary } from '../../shared/types';

/**
 * 通知策略与免打扰（§22）。
 * 隐私边界：通知只包含发件人与主题，绝不包含正文或摘要。
 */

export type NotificationAction = 'notify' | 'silent' | 'badge_only';

export interface NotificationPolicy {
  id?: string;
  accountId?: string;
  folder?: string;
  from?: string;
  action: NotificationAction;
}

export interface DndSettings {
  enabled: boolean;
  startHour: number;
  endHour: number;
}

export const DEFAULT_DND: DndSettings = { enabled: false, startHour: 22, endHour: 8 };

export function isDndActive(dnd: DndSettings, date: Date): boolean {
  if (!dnd.enabled) return false;
  const hour = date.getHours();
  const start = Math.min(23, Math.max(0, dnd.startHour));
  const end = Math.min(23, Math.max(0, dnd.endHour));
  if (start === end) return true;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

function policyMatches(policy: NotificationPolicy, email: EmailSummary): boolean {
  if (policy.accountId && policy.accountId !== email.accountId) return false;
  if (policy.folder && policy.folder !== email.folder) return false;
  if (policy.from) {
    const needle = policy.from.toLowerCase();
    const haystack = email.from
      .map((address) => `${address.name ?? ''} ${address.address}`)
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

export function decideNotification(
  email: EmailSummary,
  policies: NotificationPolicy[],
  dnd: DndSettings,
  now: Date,
): NotificationAction {
  if (isDndActive(dnd, now)) return 'silent';

  for (const policy of policies) {
    if (policyMatches(policy, email)) return policy.action;
  }

  return email.unread ? 'notify' : 'silent';
}

/** 通知内容只允许发件人与主题（§22.2）。 */
export function buildNotificationPayload(email: EmailSummary): { title: string; body: string } {
  const sender = email.from[0];
  const title = sender ? sender.name || sender.address : '新邮件';
  return { title, body: email.subject };
}

/**
 * 设置页「发送测试通知」的文案。
 * 与邮件通知同一条隐私边界：只含固定文案，不夹带任何账户数据。
 */
export function buildTestNotification(): { title: string; body: string } {
  return {
    title: 'MailForge 测试通知',
    body: '如果你看到这条通知，说明桌面通知已正常工作。',
  };
}

/**
 * 新邮件是否真的要弹系统通知。
 * 三道闸门：设置总开关 → 免打扰 → 策略动作（§22.1/§22.3）。
 */
export function shouldNotifyMail(
  mailEnabled: boolean,
  action: NotificationAction,
  dnd: DndSettings,
  now: Date,
): boolean {
  if (!mailEnabled) return false;
  if (isDndActive(dnd, now)) return false;
  return action === 'notify';
}

export interface MailGroupNotification {
  title: string;
  body: string;
  /** 单封时非空：点击后定位到该邮件。 */
  emailId: string | null;
}

/**
 * 批量新邮件的合并文案（§22.2：只含发件人与主题）。
 * 空列表返回 null；单封直出；多封合并为「N 封新邮件」。
 */
export function buildMailGroupNotification(
  emails: readonly EmailSummary[],
): MailGroupNotification | null {
  const first = emails[0];
  if (!first) return null;
  if (emails.length === 1) {
    const payload = buildNotificationPayload(first);
    return { title: payload.title, body: payload.body, emailId: first.id };
  }
  const sender = first.from[0];
  const who = sender ? sender.name || sender.address : '新发件人';
  return {
    title: `${emails.length} 封新邮件`,
    body: `最新：${who} — ${first.subject}`,
    emailId: null,
  };
}
