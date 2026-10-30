import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isClientId,
  loadOrCreateClientIdentity,
  preservedIdentityFields,
  readClientIdentity,
  writeClientIdentity,
} from '../src/main/p2p/client-id';
import { P2pRepo } from '../src/main/db/repositories/p2p-repo';
import type { P2pMessage } from '../src/shared/types';
import { createTestDb, type TestDb } from './helpers/test-db';

/**
 * Phase 4 P2P 基础（§24.1.1）：
 *  - clientId 首次启动生成、持久化、重启复用，且与数据库密钥同文件共存
 *  - p2p_messages 表可写入、按会话有序读取、可标记送达
 */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let dir = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailforge-p2p-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('clientId 生成与持久化（§24.1.1）', () => {
  it('首次调用生成 UUID v4 并落盘，返回创建时间', () => {
    const file = path.join(dir, 'db-key.json');
    const identity = loadOrCreateClientIdentity(file, 1_700_000_000_000);

    expect(identity.clientId).toMatch(UUID_V4);
    expect(identity.createdAt).toBe(1_700_000_000_000);

    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(onDisk.clientId).toBe(identity.clientId);
    expect(onDisk.clientCreatedAt).toBe(1_700_000_000_000);
  });

  it('再次调用（模拟重启）返回同一个 clientId，不重新生成', () => {
    const file = path.join(dir, 'db-key.json');
    const first = loadOrCreateClientIdentity(file, 1);
    const second = loadOrCreateClientIdentity(file, 999_999);

    expect(second.clientId).toBe(first.clientId);
    expect(second.createdAt).toBe(first.createdAt);
  });

  it('与数据库密钥载荷共存：写身份不覆盖密钥字段', () => {
    const file = path.join(dir, 'db-key.json');
    const keyPayload = { v: 1, protection: 'safeStorage', data: 'ciphertext', createdAt: 123 };
    fs.writeFileSync(file, JSON.stringify(keyPayload));

    const identity = loadOrCreateClientIdentity(file, 456);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;

    expect(onDisk).toMatchObject(keyPayload);
    expect(onDisk.clientId).toBe(identity.clientId);
  });

  it('重写密钥载荷时可通过 preservedIdentityFields 保住身份', () => {
    const file = path.join(dir, 'db-key.json');
    const identity = loadOrCreateClientIdentity(file, 789);

    const preserved = preservedIdentityFields(file);
    // 模拟 key-manager 重写：{ ...新载荷, ...保留字段 }
    fs.writeFileSync(
      file,
      JSON.stringify({ v: 1, protection: 'safeStorage', data: 'new', createdAt: 1, ...preserved }),
    );

    expect(readClientIdentity(file)).toEqual(identity);
  });

  it('非法或缺失身份时重新生成，且不影响其它字段', () => {
    const file = path.join(dir, 'db-key.json');
    fs.writeFileSync(file, JSON.stringify({ v: 1, data: 'x', clientId: 'not-a-uuid' }));

    const identity = loadOrCreateClientIdentity(file, 42);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;

    expect(isClientId(identity.clientId)).toBe(true);
    expect(identity.clientId).not.toBe('not-a-uuid');
    expect(onDisk.data).toBe('x');
  });

  it('配置文件损坏（非 JSON）不崩溃，重建身份', () => {
    const file = path.join(dir, 'db-key.json');
    fs.writeFileSync(file, '{ broken');

    const identity = loadOrCreateClientIdentity(file, 7);
    expect(isClientId(identity.clientId)).toBe(true);
    expect(preservedIdentityFields(path.join(dir, 'missing.json'))).toEqual({});
  });

  it('writeClientIdentity 覆盖已有身份但不删除密钥字段', () => {
    const file = path.join(dir, 'db-key.json');
    fs.writeFileSync(file, JSON.stringify({ v: 1, data: 'keep' }));
    writeClientIdentity(file, { clientId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', createdAt: 5 });

    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(onDisk.data).toBe('keep');
    expect(onDisk.clientId).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  });
});

describe('p2p_messages 存储（§24.1.1、§5.1）', () => {
  let context: TestDb;
  let repo: P2pRepo;

  beforeEach(() => {
    context = createTestDb();
    repo = new P2pRepo(context.db);
  });

  afterEach(() => {
    context.cleanup();
  });

  function message(overrides: Partial<P2pMessage> = {}): P2pMessage {
    return {
      id: 'm1',
      peerClientId: 'peer-a',
      direction: 'outbound',
      content: 'hello',
      sentAt: 1_000,
      ...overrides,
    };
  }

  it('迁移创建 p2p_messages 表', () => {
    const row = context.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='p2p_messages'")
      .get() as { name?: string } | undefined;
    expect(row?.name).toBe('p2p_messages');
  });

  it('写入后按时间正序读出，且不产生重复行', () => {
    repo.append(message({ id: 'm2', content: 'second', sentAt: 2_000 }));
    repo.append(message({ id: 'm1', content: 'first', sentAt: 1_000 }));
    repo.append(message({ id: 'm1', content: 'first', sentAt: 1_000 }));

    const conversation = repo.conversation('peer-a');
    expect(conversation.map((item) => item.content)).toEqual(['first', 'second']);
    expect(conversation.every((item) => item.peerClientId === 'peer-a')).toBe(true);
  });

  it('只返回指定会话的消息', () => {
    repo.append(message({ id: 'm1', peerClientId: 'peer-a', sentAt: 1_000 }));
    repo.append(message({ id: 'm2', peerClientId: 'peer-b', sentAt: 2_000 }));

    expect(repo.conversation('peer-b').map((item) => item.id)).toEqual(['m2']);
  });

  it('标记送达后 deliveredAt 有值，且不覆盖已有时间', () => {
    repo.append(message({ id: 'm1' }));
    repo.markDelivered('m1', 1_500);
    repo.markDelivered('m1', 9_999);

    const [item] = repo.conversation('peer-a');
    expect(item?.deliveredAt).toBe(1_500);
  });

  it('联系人列表按最后消息时间倒序聚合', () => {
    repo.append(message({ id: 'm1', peerClientId: 'peer-a', sentAt: 1_000 }));
    repo.append(message({ id: 'm2', peerClientId: 'peer-a', sentAt: 3_000 }));
    repo.append(message({ id: 'm3', peerClientId: 'peer-b', sentAt: 2_000 }));

    expect(repo.peers()).toEqual([
      { peerClientId: 'peer-a', lastMessageAt: 3_000, count: 2 },
      { peerClientId: 'peer-b', lastMessageAt: 2_000, count: 1 },
    ]);
  });

  it('direction 只允许 inbound / outbound', () => {
    expect(() =>
      context.db
        .prepare(
          `INSERT INTO p2p_messages (id, peer_client_id, direction, content, sent_at)
           VALUES ('bad', 'peer-a', 'sideways', 'x', 1)`,
        )
        .run(),
    ).toThrow();
  });
});
