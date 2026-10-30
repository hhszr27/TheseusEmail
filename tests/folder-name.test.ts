import { describe, expect, it } from 'vitest';
import {
  MAX_FOLDER_NAME_LENGTH,
  buildFolderPath,
  folderNameErrorMessage,
  isProtectedFolder,
  isSameOrDescendantPath,
  leafNameOf,
  parentPathOf,
  replacePathPrefix,
  validateFolderName,
} from '../src/shared/folder-name';

/**
 * 新建文件夹要把名字送到服务端。名字非法时服务器只会回一句很难懂的话，
 * 所以本地先挡住：空、分隔符、通配符、控制字符、超长、保留字。
 */
describe('文件夹名校验（validateFolderName）', () => {
  it('正常名字通过（含中文与空格）', () => {
    expect(validateFolderName('项目资料', '/').ok).toBe(true);
    expect(validateFolderName('  Work 2026  ', '/').ok).toBe(true);
  });

  it('空名字与纯空格都不行', () => {
    expect(validateFolderName('', '/')).toEqual({ ok: false, error: 'empty' });
    expect(validateFolderName('   ', '/')).toEqual({ ok: false, error: 'empty' });
  });

  it('不能含层级分隔符（各服务商分隔符不同）', () => {
    expect(validateFolderName('a/b', '/')).toEqual({ ok: false, error: 'delimiter' });
    expect(validateFolderName('a.b', '.')).toEqual({ ok: false, error: 'delimiter' });
    // 分隔符是 . 的时候，名字里的 / 是无害的
    expect(validateFolderName('a/b', '.').ok).toBe(true);
  });

  it('不能含 LIST 通配符与控制字符', () => {
    expect(validateFolderName('a*b', '/')).toEqual({ ok: false, error: 'wildcard' });
    expect(validateFolderName('a%b', '/')).toEqual({ ok: false, error: 'wildcard' });
    expect(validateFolderName('a\u0000b', '/')).toEqual({ ok: false, error: 'control' });
  });

  it('INBOX 是保留名（大小写不敏感）', () => {
    expect(validateFolderName('INBOX', '/')).toEqual({ ok: false, error: 'reserved' });
    expect(validateFolderName('inbox', '/')).toEqual({ ok: false, error: 'reserved' });
  });

  it('超长名字被拒', () => {
    expect(validateFolderName('x'.repeat(MAX_FOLDER_NAME_LENGTH), '/').ok).toBe(true);
    expect(validateFolderName('x'.repeat(MAX_FOLDER_NAME_LENGTH + 1), '/')).toEqual({
      ok: false,
      error: 'too-long',
    });
  });
});

describe('文件夹路径拼接（buildFolderPath）', () => {
  it('父路径为空时就是根下的名字', () => {
    expect(buildFolderPath('', '/', '项目')).toBe('项目');
  });

  it('拼接父路径，并去掉父路径末尾多余的分隔符', () => {
    expect(buildFolderPath('INBOX', '/', '项目')).toBe('INBOX/项目');
    expect(buildFolderPath('INBOX/', '/', '项目')).toBe('INBOX/项目');
  });

  it('分隔符是点号时不会被当成正则', () => {
    expect(buildFolderPath('Archive.2026', '.', '项目')).toBe('Archive.2026.项目');
  });

  it('没给分隔符时回落到 /', () => {
    expect(buildFolderPath('Other', '', '项目')).toBe('Other/项目');
  });
});

describe('路径工具（改名/移动/删除的边界）', () => {
  it('取父路径与叶子名', () => {
    expect(parentPathOf('A/B/C', '/')).toBe('A/B');
    expect(parentPathOf('A', '/')).toBe('');
    expect(parentPathOf('a.b', '.')).toBe('a');
    expect(leafNameOf('A/B/C', '/')).toBe('C');
    expect(leafNameOf('A', '/')).toBe('A');
  });

  it('自身或子路径判定：A2 不是 A 的子路径', () => {
    expect(isSameOrDescendantPath('A', 'A', '/')).toBe(true);
    expect(isSameOrDescendantPath('A/B', 'A', '/')).toBe(true);
    expect(isSameOrDescendantPath('A2', 'A', '/')).toBe(false);
    expect(isSameOrDescendantPath('B/A', 'A', '/')).toBe(false);
  });

  it('前缀替换只作用在自身与子路径上', () => {
    expect(replacePathPrefix('A', 'A', 'X', '/')).toBe('X');
    expect(replacePathPrefix('A/B', 'A', 'X', '/')).toBe('X/B');
    expect(replacePathPrefix('A/BB', 'A', 'X', '/')).toBe('X/BB');
    expect(replacePathPrefix('A2', 'A', 'X', '/')).toBe('A2');
  });

  it('系统文件夹受保护：INBOX 与带 special-use 的都在内', () => {
    expect(isProtectedFolder({ path: 'INBOX' })).toBe(true);
    expect(isProtectedFolder({ path: 'inbox' })).toBe(true);
    expect(isProtectedFolder({ path: 'Sent Messages', specialUse: 'sent' })).toBe(true);
    expect(isProtectedFolder({ path: '我的文件夹' })).toBe(false);
    expect(isProtectedFolder({ path: '我的文件夹', specialUse: null })).toBe(false);
  });
});

describe('错误原因文案（folderNameErrorMessage）', () => {
  it('每种错误都有可读的中文说明', () => {
    const errors = ['empty', 'delimiter', 'wildcard', 'control', 'too-long', 'reserved'] as const;
    const texts = errors.map((error) => folderNameErrorMessage(error));
    expect(texts.every((text) => text.length > 0)).toBe(true);
    expect(new Set(texts).size).toBe(errors.length);
    expect(folderNameErrorMessage(undefined)).toBe('名称不能为空');
  });
});
