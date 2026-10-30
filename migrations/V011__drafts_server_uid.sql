-- 草稿与服务器 Drafts 文件夹双向同步（Part B）：记录服务器草稿 uid。
-- -1 表示本地草稿尚未对应到服务器草稿（例如演示账户、尚不知道 Drafts 文件夹、或同步失败）。
ALTER TABLE drafts ADD COLUMN server_uid INTEGER NOT NULL DEFAULT -1;
