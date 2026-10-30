import type { Db } from '../db/open';
import type { RuleActions, RuleConditions, RuleRecord } from './engine';

interface RuleRow {
  id: string;
  name: string;
  priority: number;
  enabled: number;
  conditions_json: string;
  actions_json: string;
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export class RulesRepo {
  constructor(private readonly db: Db) {}

  list(): RuleRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM rules ORDER BY priority ASC, name ASC')
      .all() as RuleRow[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      priority: row.priority,
      enabled: row.enabled === 1,
      conditions: parseJson<RuleConditions>(row.conditions_json, {}),
      actions: parseJson<RuleActions>(row.actions_json, {}),
    }));
  }

  upsert(rule: RuleRecord): void {
    this.db
      .prepare(
        `INSERT INTO rules (id, name, priority, enabled, conditions_json, actions_json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           priority = excluded.priority,
           enabled = excluded.enabled,
           conditions_json = excluded.conditions_json,
           actions_json = excluded.actions_json`,
      )
      .run(
        rule.id,
        rule.name,
        rule.priority,
        rule.enabled ? 1 : 0,
        JSON.stringify(rule.conditions),
        JSON.stringify(rule.actions),
      );
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM rules WHERE id = ?').run(id);
  }
}
