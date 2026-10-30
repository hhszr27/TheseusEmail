import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * instance-mode（单实例开关口径，§36 边界 / 启动最早期决定）。
 *
 * 唯一不变量：只有显式写 `singleInstance: false` 才允许「多开」；
 * 文件缺失、JSON 损坏、键缺失、非布尔值（null/0/1）一律回落到「单实例（true）」，
 * 因为双开会同时打开同一加密库，可能导致库损坏。
 *
 * app.getPath 由 electron 提供，这里用 vi.mock 桩到临时目录，文件系统用真实实现。
 */
const h = vi.hoisted(() => {
  let userData = '';
  return {
    setUserData: (v: string): void => {
      userData = v;
    },
    appMock: {
      getPath: (): string => userData,
      isPackaged: false,
      getVersion: (): string => '0.0.0',
    },
  };
});
vi.mock('electron', () => ({ app: h.appMock }));

import { readSingleInstanceMode, writeSingleInstanceMode } from '../src/main/app/instance-mode';

let dir = '';
let file = '';

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'im-test-'));
  h.setUserData(dir);
  file = path.join(dir, 'instance-mode.json');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(content: string): void {
  writeFileSync(file, content, 'utf8');
}

describe('readSingleInstanceMode（单实例开关口径）', () => {
  it('显式 false → 允许多开', () => {
    write(JSON.stringify({ singleInstance: false }));
    expect(readSingleInstanceMode()).toBe(false);
  });

  it('显式 true → 单实例', () => {
    write(JSON.stringify({ singleInstance: true }));
    expect(readSingleInstanceMode()).toBe(true);
  });

  it('键缺失（{}）→ 单实例（fail-safe）', () => {
    write('{}');
    expect(readSingleInstanceMode()).toBe(true);
  });

  it('显式 null（非布尔）→ 单实例', () => {
    write(JSON.stringify({ singleInstance: null }));
    expect(readSingleInstanceMode()).toBe(true);
  });

  it('非布尔数值 0 / 1 → 单实例', () => {
    write(JSON.stringify({ singleInstance: 0 }));
    expect(readSingleInstanceMode()).toBe(true);
    write(JSON.stringify({ singleInstance: 1 }));
    expect(readSingleInstanceMode()).toBe(true);
  });

  it('JSON 损坏 → 单实例（fail-safe）', () => {
    write('{ this is not valid json');
    expect(readSingleInstanceMode()).toBe(true);
  });

  it('文件缺失 → 单实例（fail-safe）', () => {
    rmSync(file, { force: true });
    expect(readSingleInstanceMode()).toBe(true);
  });
});

describe('writeSingleInstanceMode', () => {
  it('写入后读回 round-trip 反映取值', () => {
    writeSingleInstanceMode(false);
    expect(readSingleInstanceMode()).toBe(false);
    writeSingleInstanceMode(true);
    expect(readSingleInstanceMode()).toBe(true);
  });
});
