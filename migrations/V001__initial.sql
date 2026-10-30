-- MailForge V001 初始 schema
-- 所有表均位于 SQLCipher 加密数据库内，随库透明加密。

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  email TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN ('imap-smtp', 'graph', 'jmap')),
  provider_preset TEXT,
  imap_host TEXT,
  imap_port INTEGER,
  imap_secure INTEGER,
  smtp_host TEXT,
  smtp_port INTEGER,
  smtp_secure INTEGER,
  auth_type TEXT NOT NULL,
  secret_ref TEXT,
  auth_state TEXT NOT NULL DEFAULT 'ok' CHECK (auth_state IN ('ok', 'requires_reauth')),
  namespace_prefix TEXT,
  folder_delimiter TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS folder_sync_state (
  account_id TEXT NOT NULL,
  folder TEXT NOT NULL,
  delimiter TEXT NOT NULL DEFAULT '/',
  uidvalidity INTEGER NOT NULL DEFAULT 0,
  highest_modseq INTEGER,
  uidnext INTEGER,
  capability_level TEXT NOT NULL DEFAULT 'L1_CHANGEDSINCE'
    CHECK (capability_level IN ('L1_CHANGEDSINCE', 'L2_SEARCH_SINCE', 'L3_UIDNEXT')),
  special_use TEXT,
  special_use_source TEXT,
  last_sync_at INTEGER NOT NULL DEFAULT 0,
  needs_full_resync INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, folder)
);

CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  folder TEXT NOT NULL,
  uid INTEGER NOT NULL,
  uidvalidity INTEGER NOT NULL DEFAULT 0,
  message_id TEXT,
  subject TEXT NOT NULL DEFAULT '',
  from_json TEXT NOT NULL DEFAULT '[]',
  to_json TEXT NOT NULL DEFAULT '[]',
  date INTEGER NOT NULL,
  snippet TEXT NOT NULL DEFAULT '',
  has_attachments INTEGER NOT NULL DEFAULT 0,
  unread INTEGER NOT NULL DEFAULT 0,
  starred INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  snoozed_until INTEGER,
  body_fetched INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_emails_uid
  ON emails (account_id, folder, uid);
CREATE INDEX IF NOT EXISTS idx_emails_list
  ON emails (account_id, folder, date DESC);
CREATE INDEX IF NOT EXISTS idx_emails_folder
  ON emails (folder, date DESC);
CREATE INDEX IF NOT EXISTS idx_emails_snooze
  ON emails (snoozed_until);

CREATE TABLE IF NOT EXISTS email_bodies (
  email_id TEXT PRIMARY KEY,
  html TEXT,
  text TEXT,
  fetched_at INTEGER NOT NULL,
  FOREIGN KEY (email_id) REFERENCES emails (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  email_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  ext TEXT NOT NULL,
  sha256 TEXT,
  FOREIGN KEY (email_id) REFERENCES emails (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_attachments_email ON attachments (email_id);
CREATE INDEX IF NOT EXISTS idx_attachments_sha ON attachments (sha256);

CREATE TABLE IF NOT EXISTS scan_cache (
  key TEXT PRIMARY KEY,
  result_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  intent TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  undo_json TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  last_error_code TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox (status, next_retry_at);

CREATE TABLE IF NOT EXISTS plugins (
  id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  config_json TEXT NOT NULL DEFAULT '{}',
  signature_status TEXT,
  installed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  conditions_json TEXT NOT NULL,
  actions_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  folder TEXT,
  from_pattern TEXT,
  priority TEXT,
  action TEXT NOT NULL CHECK (action IN ('notify', 'silent', 'badge_only'))
);

CREATE TABLE IF NOT EXISTS scheduled_sends (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  send_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_due ON scheduled_sends (status, send_at);

CREATE TABLE IF NOT EXISTS contacts (
  email TEXT PRIMARY KEY,
  display_name TEXT,
  last_contacted_at INTEGER NOT NULL DEFAULT 0,
  interaction_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_contacts_rank
  ON contacts (interaction_count DESC, last_contacted_at DESC);

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  body TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL,
  uid TEXT,
  etag TEXT,
  summary TEXT,
  starts_at INTEGER,
  ends_at INTEGER,
  all_day INTEGER NOT NULL DEFAULT 0,
  data_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS caldav_sync (
  calendar_id TEXT PRIMARY KEY,
  ctag TEXT,
  last_sync_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  email_id TEXT,
  title TEXT NOT NULL,
  due_at INTEGER,
  done INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ai_embeddings (
  email_id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  vector_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor TEXT,
  action TEXT NOT NULL,
  target TEXT,
  detail_json TEXT,
  prev_hash TEXT,
  hash TEXT
);

-- 全文检索：trigram tokenizer 支持中文子串匹配
CREATE VIRTUAL TABLE IF NOT EXISTS emails_fts USING fts5 (
  email_id UNINDEXED,
  subject,
  body,
  tokenize = 'trigram'
);
