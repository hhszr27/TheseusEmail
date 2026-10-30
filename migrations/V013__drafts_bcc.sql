-- 密送（Bcc）：草稿必须记住密送对象，重新打开/发送时不能丢。
ALTER TABLE drafts ADD COLUMN bcc_json TEXT NOT NULL DEFAULT '[]';
