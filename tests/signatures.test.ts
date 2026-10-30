import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { SignatureStore } from '../src/main/signatures/store';
import { createTestDb, insertAccount, type TestDb } from './helpers/test-db';

/**
 * 签名存储逻辑（§ 撰写）：每账户多套、默认新邮件/回复转发各自唯一、删除顺延。
 * 走真实 SQLite（临时文件），不经 IPC。
 */
describe('SignatureStore', () => {
  let testDb: TestDb;
  let store: SignatureStore;

  beforeEach(() => {
    testDb = createTestDb();
    insertAccount(testDb.db, 'acc1', 'me@example.com');
    insertAccount(testDb.db, 'acc2', 'you@example.com');
    store = new SignatureStore(testDb.db);
  });

  afterEach(() => {
    testDb.cleanup();
  });

  it('第一套签名自动成为新邮件与回复转发的默认', () => {
    const created = store.create('acc1', '主签名');
    expect(created.name).toBe('主签名');
    expect(created.isDefaultNew).toBe(true);
    expect(created.isDefaultReply).toBe(true);

    const list = store.list('acc1');
    expect(list).toHaveLength(1);
    expect(store.defaultId('acc1', 'new')).toBe(created.id);
    expect(store.defaultId('acc1', 'reply')).toBe(created.id);
  });

  it('空名称回退为「新签名」', () => {
    const created = store.create('acc1', '   ');
    expect(created.name).toBe('新签名');
  });

  it('保存正文后能从库里读回', () => {
    const created = store.create('acc1');
    store.saveHtml(created.id, '<p>Best regards</p>');
    const reloaded = store.get(created.id);
    expect(reloaded?.html).toBe('<p>Best regards</p>');
  });

  it('重命名生效', () => {
    const created = store.create('acc1');
    store.rename(created.id, '商务');
    expect(store.get(created.id)?.name).toBe('商务');
  });

  it('后续签名不会抢占默认', () => {
    const first = store.create('acc1', 'A');
    store.create('acc1', 'B');
    expect(store.defaultId('acc1', 'new')).toBe(first.id);
    expect(store.defaultId('acc1', 'reply')).toBe(first.id);
  });

  it('设置默认只在同账户同档位唯一', () => {
    const a = store.create('acc1', 'A');
    const b = store.create('acc1', 'B');
    store.setDefault('acc1', 'new', b.id);
    expect(store.defaultId('acc1', 'new')).toBe(b.id);
    // reply 档位仍指向第一套，互不影响
    expect(store.defaultId('acc1', 'reply')).toBe(a.id);
    // 同档位旧默认被清除
    const rows = store.list('acc1');
    expect(rows.find((item) => item.id === a.id)?.isDefaultNew).toBe(false);
  });

  it('删除默认签名后顺延到同账户剩余第一套', () => {
    const a = store.create('acc1', 'A');
    const b = store.create('acc1', 'B');
    store.setDefault('acc1', 'new', b.id);
    store.remove(b.id);
    expect(store.get(b.id)).toBeNull();
    // reply 默认（一直是 A）顺延；new 默认（原是 B）顺延到剩余第一套 A
    expect(store.defaultId('acc1', 'new')).toBe(a.id);
    expect(store.defaultId('acc1', 'reply')).toBe(a.id);
  });

  it('不同账户互相隔离', () => {
    const a1 = store.create('acc1', 'A1');
    store.create('acc2', 'A2');
    expect(store.list('acc1')).toHaveLength(1);
    expect(store.list('acc2')).toHaveLength(1);
    expect(store.defaultId('acc1', 'new')).toBe(a1.id);
  });

  it('setDefault 传 null 清除该档默认', () => {
    const a = store.create('acc1', 'A');
    store.setDefault('acc1', 'new', null);
    expect(store.defaultId('acc1', 'new')).toBeNull();
    // 另一档位不受影响
    expect(store.defaultId('acc1', 'reply')).toBe(a.id);
  });
});
