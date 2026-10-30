-- Phase 2 欠账：账户级插件启用（§7.8.4、§13.3.1）
-- plugins.account_overrides 存储 { accountId: boolean }；未列出的账户继承全局 enabled。

ALTER TABLE plugins ADD COLUMN account_overrides TEXT NOT NULL DEFAULT '{}';
