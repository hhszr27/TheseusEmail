-- Phase 3.5：账户管理（§7.8）
-- accounts 补齐生命周期与展示字段；rules/templates 补账户维度；新增联系人-账户关联表。

ALTER TABLE accounts ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE accounts ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN color TEXT;
ALTER TABLE accounts ADD COLUMN last_sync_at INTEGER;
ALTER TABLE accounts ADD COLUMN last_error_json TEXT;
ALTER TABLE accounts ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}';

ALTER TABLE rules ADD COLUMN account_id TEXT;
ALTER TABLE templates ADD COLUMN account_id TEXT;

CREATE TABLE IF NOT EXISTS contact_accounts (
  account_id TEXT NOT NULL,
  email TEXT NOT NULL,
  last_contacted_at INTEGER NOT NULL DEFAULT 0,
  interaction_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, email)
);
CREATE INDEX IF NOT EXISTS idx_contact_accounts_email
  ON contact_accounts (email);
