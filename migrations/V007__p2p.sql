-- Phase 4：P2P 聊天记录（§24.1.1、§5.1）
-- 消息随主数据库 SQLCipher 透明加密；第一版不支持文件传输。

CREATE TABLE IF NOT EXISTS p2p_messages (
  id TEXT PRIMARY KEY,
  peer_client_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  content TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  delivered_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_p2p_messages_peer ON p2p_messages (peer_client_id, sent_at);
