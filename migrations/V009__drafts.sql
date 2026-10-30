-- 本地草稿（每个账户保留一封，关闭撰写弹层后自动保存）
-- 附件以暂存 id + 元信息保存，文件本体在 userData/compose-attachments。

CREATE TABLE IF NOT EXISTS drafts (
  account_id TEXT PRIMARY KEY,
  to_json TEXT NOT NULL DEFAULT '[]',
  cc_json TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  attachments_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);
