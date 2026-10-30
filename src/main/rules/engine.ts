import type { EmailSummary } from '../../shared/types';

/**
 * 本地规则引擎（§17）。
 * 规则按 priority 升序执行，第一条匹配的规则阻止后续规则。
 */

export interface RuleConditions {
  from?: string;
  subject_contains?: string;
  has_attachment?: boolean;
  folder?: string;
}

export interface RuleActions {
  markRead?: boolean;
  star?: boolean;
  pin?: boolean;
  moveTo?: string;
  notify?: boolean;
  pluginAction?: { pluginId: string; actionId: string };
}

export interface RuleRecord {
  id: string;
  name: string;
  priority: number;
  enabled: boolean;
  conditions: RuleConditions;
  actions: RuleActions;
}

export function matchesRule(rule: RuleRecord, email: EmailSummary): boolean {
  if (!rule.enabled) return false;
  const conditions = rule.conditions;

  if (conditions.folder && email.folder !== conditions.folder) return false;

  if (conditions.has_attachment !== undefined && email.hasAttachments !== conditions.has_attachment) {
    return false;
  }

  if (conditions.subject_contains) {
    const needle = conditions.subject_contains.toLowerCase();
    if (!email.subject.toLowerCase().includes(needle)) return false;
  }

  if (conditions.from) {
    const needle = conditions.from.toLowerCase();
    const haystack = email.from
      .map((address) => `${address.name ?? ''} ${address.address}`)
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(needle)) return false;
  }

  return true;
}

/** 返回第一条匹配规则；没有匹配返回 null。 */
export function selectFirstMatch(rules: RuleRecord[], email: EmailSummary): RuleRecord | null {
  const ordered = [...rules].sort((a, b) => a.priority - b.priority);
  for (const rule of ordered) {
    if (matchesRule(rule, email)) return rule;
  }
  return null;
}

export interface RuleEffect {
  ruleId: string;
  actions: RuleActions;
}

export function evaluateRules(rules: RuleRecord[], email: EmailSummary): RuleEffect | null {
  const rule = selectFirstMatch(rules, email);
  return rule ? { ruleId: rule.id, actions: rule.actions } : null;
}
