import { emailIdFor } from '../db/repositories/emails-repo';
import type { Db } from '../db/open';
import type { ContactsRepo } from '../db/repositories/contacts-repo';
import { log } from '../observability/logger';
import { evaluateRules } from '../rules/engine';
import { applyRuleEffect } from '../rules/apply';
import type { RulesRepo } from '../rules/repo';
import type { NotificationService } from './service';
import { decideNotification, shouldNotifyMail } from './policy';
import { readDndSettings, readNotificationPolicies, readNotificationSettings } from './settings';
import type { Account, EmailSummary } from '../../shared/types';
import type { RawEmailSummary } from '../mail/sync/protocol';

/**
 * 新邮件到达后的本地管道：联系人 → 规则（首匹配阻断）→ 通知策略（§17 + §22）。
 *
 * 为什么从主进程入口抽出来：这段逻辑同时依赖数据库、规则、联系人与通知服务，
 * 原来只能通过 tryGetServices() 单例取依赖，无法用真实库做集成测试。
 * 这里改为显式依赖注入——调用方（主进程 bootstrap）负责装配，测试直接造依赖。
 *
 * 前置条件：邮件行已由同步层 upsert 落库（AccountManager 先 upsertMany 再
 * 触发 onNewEmails），规则动作的 UPDATE 才有目标行。
 */

export interface NewEmailPipelineDeps {
  db: Db;
  rules: RulesRepo;
  contacts: ContactsRepo;
  notifications: Pick<NotificationService, 'notifyMail'>;
  /** 通知去重（跨重启）：这封邮件是否已经处理过。 */
  isNotified(emailId: string): boolean;
  /** 登记已处理，避免下次同步/重启再弹。 */
  markNotified(emailId: string, at: number): void;
}

export function handleNewEmails(
  deps: NewEmailPipelineDeps,
  account: Account,
  folder: string,
  emails: RawEmailSummary[],
  options: { suppressNotifications?: boolean } = {},
): void {
  const rules = deps.rules.list();
  const policies = readNotificationPolicies(deps.db);
  const dnd = readDndSettings(deps.db);
  const mailEnabled = readNotificationSettings(deps.db).mail;
  const now = new Date();

  for (const raw of emails) {
    for (const address of raw.from) {
      deps.contacts.upsertFrom(address, raw.dateMs);
    }

    const summary: EmailSummary = {
      id: emailIdFor(account.id, folder, raw.uid),
      uid: raw.uid,
      folder,
      accountId: account.id,
      subject: raw.subject,
      from: raw.from,
      to: raw.to,
      date: new Date(raw.dateMs).toISOString(),
      snippet: raw.snippet,
      hasAttachments: raw.hasAttachments,
      unread: raw.unread,
      starred: raw.starred,
      pinned: false,
    };

    // 启动时已经在邮箱里的邮件只登记不弹；同一封邮件也只弹一次（跨重启）
    const alreadyHandled = deps.isNotified(summary.id);
    const canNotify = !options.suppressNotifications && !alreadyHandled;

    let notified = false;
    const effect = evaluateRules(rules, summary);
    if (effect) {
      applyRuleEffect(deps.db, summary, effect, {
        notify: (email) => {
          if (!canNotify) return;
          if (!shouldNotifyMail(mailEnabled, 'notify', dnd, now)) return;
          deps.notifications.notifyMail(email);
          notified = true;
        },
        pluginAction: (applied, email) => {
          log.info('rules', '插件规则动作（Phase 2 仅记录）', {
            ruleId: applied.ruleId,
            pluginId: applied.actions.pluginAction?.pluginId,
            actionId: applied.actions.pluginAction?.actionId,
            emailId: email.id,
          });
        },
      });
    }

    // 规则已通知过就不再重复弹（避免同一封邮件两条 toast）
    if (!notified && canNotify) {
      const action = decideNotification(summary, policies, dnd, now);
      if (shouldNotifyMail(mailEnabled, action, dnd, now)) {
        deps.notifications.notifyMail(summary);
      }
    }

    // 无论弹没弹（启动登记 / 免打扰 / 规则已弹），都记一笔，后续不再重复
    if (!alreadyHandled) deps.markNotified(summary.id, now.getTime());
  }
}
