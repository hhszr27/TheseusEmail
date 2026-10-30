import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { P2pClientIdentity } from '../../shared/types';

/**
 * P2P 客户端身份（§24.1.1）：
 *  - clientId 是 UUID v4，客户端级，与邮箱账户无关；
 *  - 持久化在数据库密钥同一配置文件（`db-key.json`）里，首次启动生成，之后复用；
 *  - 字段名用 `clientId` / `clientCreatedAt`，避开密钥载荷自身的 `createdAt`。
 */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const CLIENT_ID_FIELD = 'clientId';
export const CLIENT_CREATED_AT_FIELD = 'clientCreatedAt';

export function isClientId(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4.test(value);
}

function readRecord(filePath: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 文件不存在或不是合法 JSON：按无身份处理
  }
  return {};
}

/** 读取已持久化的身份；缺失或格式非法时返回 null（视为需要重新生成）。 */
export function readClientIdentity(filePath: string): P2pClientIdentity | null {
  const record = readRecord(filePath);
  const clientId = record[CLIENT_ID_FIELD];
  const createdAt = record[CLIENT_CREATED_AT_FIELD];
  if (!isClientId(clientId) || typeof createdAt !== 'number' || !Number.isFinite(createdAt)) {
    return null;
  }
  return { clientId, createdAt };
}

/**
 * 写入身份：与既有配置合并，绝不覆盖数据库密钥载荷。
 */
export function writeClientIdentity(filePath: string, identity: P2pClientIdentity): void {
  const record = readRecord(filePath);
  record[CLIENT_ID_FIELD] = identity.clientId;
  record[CLIENT_CREATED_AT_FIELD] = identity.createdAt;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(record), { mode: 0o600 });
}

/** 首次调用生成并落盘；之后的调用原样返回已存在的身份。 */
export function loadOrCreateClientIdentity(
  filePath: string,
  now: number = Date.now(),
): P2pClientIdentity {
  const existing = readClientIdentity(filePath);
  if (existing) return existing;
  const identity: P2pClientIdentity = { clientId: randomUUID(), createdAt: now };
  writeClientIdentity(filePath, identity);
  return identity;
}

/** 从密钥文件里挑出需要跨重写保留的字段（供 key-manager 复用）。 */
export function preservedIdentityFields(filePath: string): Record<string, string | number> {
  const identity = readClientIdentity(filePath);
  if (!identity) return {};
  return {
    [CLIENT_ID_FIELD]: identity.clientId,
    [CLIENT_CREATED_AT_FIELD]: identity.createdAt,
  };
}
