-- 签名（§ 撰写）：每个账户可有多套签名，新邮件与回复/转发可分别指定默认签名。
CREATE TABLE IF NOT EXISTS signatures (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  html TEXT NOT NULL DEFAULT '',
  is_default_new INTEGER NOT NULL DEFAULT 0,
  is_default_reply INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_signatures_account ON signatures (account_id);
