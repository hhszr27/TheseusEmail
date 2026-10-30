import { describe, expect, it } from 'vitest';
import { evaluateRules, matchesRule, selectFirstMatch, type RuleRecord } from '../src/main/rules/engine';
import type { EmailSummary } from '../src/shared/types';

const email: EmailSummary = {
  id: 'e1',
  uid: 1,
  folder: 'INBOX',
  accountId: 'a1',
  subject: '季度预算报告',
  from: [{ name: 'Alice', address: 'alice@example.com' }],
  to: [{ address: 'me@example.com' }],
  date: new Date().toISOString(),
  snippet: '',
  hasAttachments: true,
  unread: true,
  starred: false,
  pinned: false,
};

function rule(partial: Partial<RuleRecord> & Pick<RuleRecord, 'id' | 'priority'>): RuleRecord {
  return {
    name: partial.id,
    enabled: true,
    conditions: {},
    actions: {},
    ...partial,
  };
}

describe('规则引擎（§17）', () => {
  it('按 from / subject / attachment / folder 匹配', () => {
    expect(matchesRule(rule({ id: 'r', priority: 1, conditions: { from: 'alice' } }), email)).toBe(true);
    expect(matchesRule(rule({ id: 'r', priority: 1, conditions: { subject_contains: '预算' } }), email)).toBe(true);
    expect(matchesRule(rule({ id: 'r', priority: 1, conditions: { has_attachment: true } }), email)).toBe(true);
    expect(matchesRule(rule({ id: 'r', priority: 1, conditions: { folder: 'Sent' } }), email)).toBe(false);
    expect(matchesRule(rule({ id: 'r', priority: 1, conditions: { from: 'bob' } }), email)).toBe(false);
  });

  it('第一条匹配规则阻止后续规则', () => {
    const rules = [
      rule({ id: 'second', priority: 20, actions: { star: true } }),
      rule({ id: 'first', priority: 10, actions: { markRead: true } }),
      rule({ id: 'third', priority: 30, actions: { pin: true } }),
    ];
    const effect = evaluateRules(rules, email);
    expect(effect?.ruleId).toBe('first');
    expect(effect?.actions).toEqual({ markRead: true });
    expect(selectFirstMatch(rules, email)?.id).toBe('first');
  });

  it('禁用规则不参与匹配', () => {
    const disabled = rule({ id: 'off', priority: 1, enabled: false, actions: { star: true } });
    expect(matchesRule(disabled, email)).toBe(false);
    expect(selectFirstMatch([disabled], email)).toBeNull();
  });
});
