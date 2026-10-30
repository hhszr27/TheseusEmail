-- MailForge V004：Phase 3 附件存储、翻译缓存、日历账户与离线写队列

-- 附件内容落盘位置与扫描结果（附件表原字段保持不变）
ALTER TABLE attachments ADD COLUMN local_path TEXT;
ALTER TABLE attachments ADD COLUMN content_id TEXT;
ALTER TABLE attachments ADD COLUMN scan_verdict TEXT;
ALTER TABLE attachments ADD COLUMN scan_source TEXT;
ALTER TABLE attachments ADD COLUMN scan_detail TEXT;
ALTER TABLE attachments ADD COLUMN scan_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_attachments_email_name
  ON attachments (email_id, filename);

CREATE TABLE IF NOT EXISTS translation_cache (
  email_id TEXT NOT NULL,
  target_lang TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  translated_text TEXT NOT NULL,
  provider TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (email_id, target_lang, source_hash)
);

CREATE TABLE IF NOT EXISTS calendar_accounts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('caldav', 'ics')),
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  username TEXT,
  secret_ref TEXT,
  color TEXT,
  read_only INTEGER NOT NULL DEFAULT 1,
  ctag TEXT,
  sync_token TEXT,
  last_sync_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_calendar_events_calendar
  ON calendar_events (calendar_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_calendar_events_uid
  ON calendar_events (calendar_id, uid);

CREATE TABLE IF NOT EXISTS calendar_outbox (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('PUT', 'DELETE')),
  href TEXT NOT NULL,
  payload TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_calendar_outbox_account
  ON calendar_outbox (account_id, created_at);
