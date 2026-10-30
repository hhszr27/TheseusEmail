-- V003：定时发送的重试状态
ALTER TABLE scheduled_sends ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduled_sends ADD COLUMN next_retry_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduled_sends ADD COLUMN last_error TEXT;

DROP INDEX IF EXISTS idx_scheduled_due;
CREATE INDEX IF NOT EXISTS idx_scheduled_due
  ON scheduled_sends (status, next_retry_at, send_at);
