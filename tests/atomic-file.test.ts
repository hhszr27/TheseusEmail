import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileAtomic } from '../src/main/security/atomic-file';

/**
 * 原子写（密钥/凭证文件的崩溃安全）。
 *
 * 背景：db-key.json 与凭证以前用 fs.writeFile 直写（先截断后落盘）。
 * 启用/关闭主密码或保存凭证时若进程恰好崩在中间，文件就是空的或半截 JSON，
 * 数据库密钥不可恢复——设计约定此时「库未初始化→重建、有数据→报错停止」，
 * 用户既打不开库也拿不回数据。
 */

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailforge-atomic-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('writeFileAtomic', () => {
  it('写入内容并覆盖旧文件，不留下临时文件', async () => {
    const target = path.join(dir, 'key.json');
    await writeFileAtomic(target, 'first');
    await writeFileAtomic(target, 'second');

    expect(fs.readFileSync(target, 'utf8')).toBe('second');
    expect(fs.readdirSync(dir)).toEqual(['key.json']);
  });

  it('目标目录不存在时自动创建', async () => {
    const target = path.join(dir, 'nested', 'deeper', 'key.bin');
    await writeFileAtomic(target, 'x');

    expect(fs.readFileSync(target, 'utf8')).toBe('x');
  });

  it('写入失败（目标是目录）时清掉临时文件，不污染用户数据目录', async () => {
    const target = path.join(dir, 'key.json');
    fs.mkdirSync(target);

    await expect(writeFileAtomic(target, 'boom')).rejects.toThrow();

    // 除了那个目录本身，不该留下任何 .tmp-* 残骸
    expect(fs.readdirSync(dir)).toEqual(['key.json']);
  });

  it('并发写同一目标不会互相污染（各自临时名）', async () => {
    const target = path.join(dir, 'key.json');
    await Promise.all([
      writeFileAtomic(target, 'a'),
      writeFileAtomic(target, 'bb'),
      writeFileAtomic(target, 'ccc'),
    ]);

    expect(['a', 'bb', 'ccc']).toContain(fs.readFileSync(target, 'utf8'));
    expect(fs.readdirSync(dir)).toEqual(['key.json']);
  });
});
