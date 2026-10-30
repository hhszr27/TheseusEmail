import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ComposeAttachmentStore,
  mimeForFilename,
  safeFilename,
} from '../src/main/mail/compose-attachments';
import { formatFileSize } from '../src/renderer/lib/compose';

/**
 * 写信附件暂存：
 *  - 文件复制进暂存目录，渲染进程只拿 id；
 *  - 文件名净化，防路径穿越；
 *  - 释放与孤儿清理都只作用于暂存目录内。
 */

let root = '';
let store: ComposeAttachmentStore;
let sourceDir = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-compose-att-'));
  store = new ComposeAttachmentStore(path.join(root, 'stage'));
  sourceDir = path.join(root, 'src');
  fs.mkdirSync(sourceDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function makeFile(name: string, content: string): string {
  const file = path.join(sourceDir, name);
  fs.writeFileSync(file, content);
  return file;
}

describe('文件名与类型', () => {
  it('净化路径分隔符与控制字符', () => {
    expect(safeFilename('../../etc/passwd')).toBe('passwd');
    expect(safeFilename('a<b>c.txt')).toBe('a_b_c.txt');
    expect(safeFilename('')).toBe('attachment');
  });

  it('按扩展名推断 MIME，未知类型回退二进制', () => {
    expect(mimeForFilename('报表.pdf')).toBe('application/pdf');
    expect(mimeForFilename('a.DOCX')).toContain('wordprocessingml');
    expect(mimeForFilename('x.bin')).toBe('application/octet-stream');
  });
});

describe('暂存与解析', () => {
  it('复制文件并返回可展示信息', async () => {
    const source = makeFile('报告.pdf', 'hello attachment');
    const [info] = await store.stageFiles([source]);

    expect(info?.filename).toBe('报告.pdf');
    expect(info?.size).toBe(Buffer.byteLength('hello attachment'));
    expect(info?.mimeType).toBe('application/pdf');

    const stored = fs.readdirSync(path.join(root, 'stage'));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toBe(`${info?.id}__报告.pdf`);
  });

  it('resolve 按 id 找回暂存文件', async () => {
    const [info] = await store.stageFiles([makeFile('a.txt', 'x')]);
    const resolved = store.resolve([info!.id]);

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.filename).toBe('a.txt');
    expect(fs.readFileSync(resolved[0]!.path, 'utf8')).toBe('x');
  });

  it('非法 id 被忽略，不抛错', () => {
    expect(store.resolve(['../../etc/passwd'])).toEqual([]);
  });

  it('超过 25 MB 的文件被跳过', async () => {
    const big = path.join(sourceDir, 'big.bin');
    fs.writeFileSync(big, '');
    fs.truncateSync(big, 26 * 1024 * 1024);

    expect(await store.stageFiles([big])).toEqual([]);
  });

  it('最多暂存 10 个文件', async () => {
    const files = Array.from({ length: 12 }, (_, index) =>
      makeFile(`f${index}.txt`, String(index)),
    );
    const staged = await store.stageFiles(files);
    expect(staged).toHaveLength(10);
  });
});

describe('释放与清理', () => {
  it('release 只删除指定 id 的文件', async () => {
    const [a] = await store.stageFiles([makeFile('a.txt', 'a')]);
    const [b] = await store.stageFiles([makeFile('b.txt', 'b')]);

    store.release([a!.id]);

    expect(fs.readdirSync(path.join(root, 'stage'))).toHaveLength(1);
    expect(store.resolve([b!.id])).toHaveLength(1);
  });

  it('releasePaths 拒绝暂存目录之外的路径', async () => {
    const outside = makeFile('keep.txt', 'keep');
    store.releasePaths([outside]);
    expect(fs.existsSync(outside)).toBe(true);
  });

  it('cleanupUnreferenced 保留被引用的文件', async () => {
    const [a] = await store.stageFiles([makeFile('a.txt', 'a')]);
    await store.stageFiles([makeFile('b.txt', 'b')]);
    const kept = store.resolve([a!.id])[0]!.path;

    const removed = store.cleanupUnreferenced(new Set([kept]));

    expect(removed).toBe(1);
    expect(fs.existsSync(kept)).toBe(true);
  });
});

describe('formatFileSize', () => {
  it('按单位展示并去掉多余的 .0', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(2048)).toBe('2 KB');
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatFileSize(5 * 1024 * 1024)).toBe('5 MB');
  });
});
