-- MailForge V002：Phase 2 所需的应用设置、插件能力、快捷键与通知偏好

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS plugin_capabilities (
  plugin_id TEXT NOT NULL,
  permission TEXT NOT NULL,
  granted INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (plugin_id, permission)
);

CREATE TABLE IF NOT EXISTS keybindings (
  command_id TEXT PRIMARY KEY,
  binding_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_prefs (
  id TEXT PRIMARY KEY,
  rules_json TEXT NOT NULL DEFAULT '[]',
  dnd_json TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_emails_pinned
  ON emails (account_id, folder, pinned DESC, date DESC);

CREATE INDEX IF NOT EXISTS idx_emails_body_fetched
  ON emails (body_fetched, id);
