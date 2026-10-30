-- 通知去重：每封邮件最多弹一次桌面通知。
-- 启动时已经在邮箱里的未读邮件只登记、不弹；之后重启或全量重同步也不会重复弹。
ALTER TABLE emails ADD COLUMN notified_at INTEGER;
