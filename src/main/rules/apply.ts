import type { Db } from '../db/open';
import type { EmailSummary } from '../../shared/types';
import type { RuleEffect } from './engine';
import { log } from '../observability/logger';

export interface RuleApplyHooks {
  notify?: (email: EmailSummary) => void;
  pluginAction?: (effect: RuleEffect, email: EmailSummary) => void;
}

/**
 * 把规则动作落到本地数据库（§17.2）。
 * 移动文件夹在 Phase 2 只改本地状态；服务器端 IMAP 移动在后续 Phase 接入。
 */
export function applyRuleEffect(
  db: Db,
  email: EmailSummary,
  effect: RuleEffect,
  hooks: RuleApplyHooks = {},
): boolean {
  const actions = effect.actions;
  const assignments: string[] = [];
  const params: unknown[] = [];

  if (actions.markRead) assignments.push('unread = 0');
  if (actions.star) assignments.push('starred = 1');
  if (actions.pin) assignments.push('pinned = 1');
  if (actions.moveTo) {
    assignments.push('folder = ?');
    params.push(actions.moveTo);
  }

  if (assignments.length > 0) {
    db.prepare(`UPDATE emails SET ${assignments.join(', ')} WHERE id = ?`).run(...params, email.id);
  }

  if (actions.notify) hooks.notify?.(email);
  if (actions.pluginAction) hooks.pluginAction?.(effect, email);

  log.info('rules', '规则已执行', {
    ruleId: effect.ruleId,
    emailId: email.id,
    actions: Object.keys(actions),
  });

  return assignments.length > 0;
}
