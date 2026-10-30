import crypto from 'node:crypto';
import type { Db } from '../db/open';
import { htmlToPlainText } from '../security/sanitize';

/**
 * 本地语义索引（§15.2）：
 * 无外部依赖的字符 n-gram 哈希向量 + 余弦相似度。
 * - 不联网、不外发邮件内容
 * - 对词序变化、拼写差异、中文分词缺失都保持鲁棒
 * - 配置了外部 AI 时，可用服务商 embedding 重建（model 字段区分）
 */

export const EMBEDDING_DIM = 256;
export const LOCAL_MODEL = 'local-ngram-v1';

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/[.,;:!?'"“”‘’()[\]{}<>《》【】、，。；：！？]/g, '')
    .trim();
}

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 生成 L2 归一化的稀疏装桶向量（定长数组，便于 JSON 存储）。 */
export function embedText(text: string, dim = EMBEDDING_DIM): number[] {
  const vector = new Array<number>(dim).fill(0);
  const normalized = normalize(text);
  if (!normalized) return vector;

  const tokens = normalized.split(' ').filter(Boolean);
  const grams: string[] = [];

  for (const token of tokens) {
    grams.push(`w:${token}`);
    const chars = Array.from(token);
    for (let size = 2; size <= 3; size += 1) {
      for (let index = 0; index + size <= chars.length; index += 1) {
        grams.push(`g:${chars.slice(index, index + size).join('')}`);
      }
    }
  }

  for (const gram of grams) {
    const hash = fnv1a(gram);
    const bucket = hash % dim;
    const sign = (hash & 0x80000000) === 0 ? 1 : -1;
    vector[bucket]! += sign;
  }

  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm === 0) return vector;
  return vector.map((value) => value / norm);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let index = 0; index < length; index += 1) {
    dot += a[index]! * b[index]!;
    na += a[index]! * a[index]!;
    nb += b[index]! * b[index]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface SemanticHit {
  emailId: string;
  score: number;
}

interface EmbeddingRow {
  email_id: string;
  model: string;
  vector_json: string;
}

export class EmbeddingIndex {
  constructor(
    private readonly db: Db,
    private readonly model = LOCAL_MODEL,
  ) {}

  index(emailId: string, text: string): void {
    const vector = embedText(text);
    this.db
      .prepare(
        `INSERT INTO ai_embeddings (email_id, model, vector_json, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(email_id) DO UPDATE SET model = excluded.model, vector_json = excluded.vector_json, created_at = excluded.created_at`,
      )
      .run(emailId, this.model, JSON.stringify(vector), Date.now());
  }

  remove(emailId: string): void {
    this.db.prepare('DELETE FROM ai_embeddings WHERE email_id = ?').run(emailId);
  }

  /** 为已有正文但尚未建索引的邮件补建索引。 */
  ensureIndexed(limit = 200): number {
    const rows = this.db
      .prepare(
        `SELECT b.email_id AS email_id, b.html AS html, b.text AS text
           FROM email_bodies b
           LEFT JOIN ai_embeddings e ON e.email_id = b.email_id AND e.model = ?
          WHERE e.email_id IS NULL
          LIMIT ?`,
      )
      .all(this.model, limit) as Array<{ email_id: string; html: string | null; text: string | null }>;

    const tx = this.db.transaction((items: typeof rows) => {
      for (const item of items) {
        const text = item.text && item.text.trim() ? item.text : htmlToPlainText(item.html ?? '');
        if (!text.trim()) continue;
        this.index(item.email_id, text.slice(0, 20_000));
      }
    });
    tx(rows);
    return rows.length;
  }

  search(query: string, limit = 20): SemanticHit[] {
    const queryVector = embedText(query);
    const rows = this.db
      .prepare('SELECT email_id, model, vector_json FROM ai_embeddings WHERE model = ?')
      .all(this.model) as EmbeddingRow[];

    const hits: SemanticHit[] = [];
    for (const row of rows) {
      let vector: number[];
      try {
        vector = JSON.parse(row.vector_json) as number[];
      } catch {
        continue;
      }
      const score = cosineSimilarity(queryVector, vector);
      if (score > 0.05) hits.push({ emailId: row.email_id, score });
    }

    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, Math.max(1, limit));
  }

  count(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM ai_embeddings WHERE model = ?')
      .get(this.model) as { c: number };
    return row.c;
  }

  /** 稳定 ID：仅用于日志关联，不含内容。 */
  fingerprint(text: string): string {
    return crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);
  }
}
