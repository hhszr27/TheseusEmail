import type { Db } from '../open';
import type { P2pMessage } from '../../../shared/types';

interface P2pMessageRow {
  id: string;
  peer_client_id: string;
  direction: 'inbound' | 'outbound';
  content: string;
  sent_at: number;
  delivered_at: number | null;
}

function toMessage(row: P2pMessageRow): P2pMessage {
  return {
    id: row.id,
    peerClientId: row.peer_client_id,
    direction: row.direction,
    content: row.content,
    sentAt: row.sent_at,
    ...(row.delivered_at === null ? {} : { deliveredAt: row.delivered_at }),
  };
}

/**
 * P2P 聊天记录（§24.1.1）：消息只落本地加密库，不跨设备同步。
 * direction 区分收发；deliveredAt 为对方确认送达的时间（WebRTC DataChannel 回执）。
 */
export class P2pRepo {
  constructor(private readonly db: Db) {}

  append(message: P2pMessage): void {
    this.db
      .prepare(
        `INSERT INTO p2p_messages (id, peer_client_id, direction, content, sent_at, delivered_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        message.id,
        message.peerClientId,
        message.direction,
        message.content,
        message.sentAt,
        message.deliveredAt ?? null,
      );
  }

  markDelivered(id: string, at: number): void {
    this.db
      .prepare(
        `UPDATE p2p_messages SET delivered_at = ?
         WHERE id = ? AND delivered_at IS NULL`,
      )
      .run(at, id);
  }

  /** 单个会话按时间正序返回，limit 取最近 N 条。 */
  conversation(peerClientId: string, limit = 200): P2pMessage[] {
    const rows = this.db
      .prepare(
        `SELECT id, peer_client_id, direction, content, sent_at, delivered_at
         FROM p2p_messages
         WHERE peer_client_id = ?
         ORDER BY sent_at DESC
         LIMIT ?`,
      )
      .all(peerClientId, limit) as P2pMessageRow[];
    return rows.map(toMessage).reverse();
  }

  /** 联系人列表：已交换过消息的客户端 + 最后一条消息时间。 */
  peers(): Array<{ peerClientId: string; lastMessageAt: number; count: number }> {
    const rows = this.db
      .prepare(
        `SELECT peer_client_id, MAX(sent_at) AS last_message_at, COUNT(*) AS count
         FROM p2p_messages
         GROUP BY peer_client_id
         ORDER BY last_message_at DESC`,
      )
      .all() as Array<{ peer_client_id: string; last_message_at: number; count: number }>;
    return rows.map((row) => ({
      peerClientId: row.peer_client_id,
      lastMessageAt: row.last_message_at,
      count: row.count,
    }));
  }
}
