import { describe, expect, it } from 'vitest';
import type { FolderView } from '../src/shared/types';
import { applyFolderOrder, buildFolderTree, flattenFolderTree } from '../src/renderer/lib/folder-tree';

function folder(path: string, delimiter = '/', unread = 0): FolderView {
  const name = path.includes(delimiter) ? path.slice(path.lastIndexOf(delimiter) + 1) : path;
  return { accountId: 'acc-1', path, name, delimiter, unread, total: 0 };
}

/** 侧栏要把扁平的 IMAP 文件夹还原成树：父子关系、层级缩进、可折叠。 */
describe('文件夹树（buildFolderTree）', () => {
  it('按路径还原父子关系并算出层级', () => {
    const tree = buildFolderTree([
      folder('INBOX'),
      folder('其他文件夹'),
      folder('其他文件夹/银行'),
      folder('其他文件夹/知乎'),
      folder('归档'),
    ]);

    expect(tree.map((node) => node.folder.path)).toEqual(['INBOX', '其他文件夹', '归档']);
    const container = tree.find((node) => node.folder.path === '其他文件夹');
    expect(container?.children.map((child) => child.folder.path)).toEqual([
      '其他文件夹/银行',
      '其他文件夹/知乎',
    ]);
    expect(container?.depth).toBe(0);
    expect(container?.children[0]?.depth).toBe(1);
  });

  it('父文件夹不在列表里时当成根节点，绝不丢行', () => {
    const tree = buildFolderTree([folder('孤儿子目录/子')]);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.folder.path).toBe('孤儿子目录/子');
    expect(tree[0]?.depth).toBe(0);
  });

  it('按文件夹自己的分隔符切分（点是分隔符也算）', () => {
    const tree = buildFolderTree([folder('Archive', '.'), folder('Archive.2026', '.')]);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.children[0]?.folder.path).toBe('Archive.2026');
  });

  it('三层嵌套的 depth 依次递增', () => {
    const tree = buildFolderTree([folder('A'), folder('A/B'), folder('A/B/C')]);
    expect(tree[0]?.depth).toBe(0);
    expect(tree[0]?.children[0]?.depth).toBe(1);
    expect(tree[0]?.children[0]?.children[0]?.depth).toBe(2);
  });

  it('没有文件夹时返回空数组', () => {
    expect(buildFolderTree([])).toEqual([]);
  });
});

describe('按折叠状态压平（flattenFolderTree）', () => {
  const tree = buildFolderTree([
    folder('其他文件夹'),
    folder('其他文件夹/银行'),
    folder('其他文件夹/知乎'),
    folder('INBOX'),
  ]);

  it('默认展开：父在子前', () => {
    const rows = flattenFolderTree(tree, () => false).map((node) => node.folder.path);
    expect(rows).toEqual(['其他文件夹', '其他文件夹/银行', '其他文件夹/知乎', 'INBOX']);
  });

  it('折叠父节点后只留父节点本身', () => {
    const rows = flattenFolderTree(tree, (path) => path === '其他文件夹').map(
      (node) => node.folder.path,
    );
    expect(rows).toEqual(['其他文件夹', 'INBOX']);
  });

  it('折叠一个不相干的路径不影响别的节点', () => {
    const rows = flattenFolderTree(tree, (path) => path === 'INBOX').map((node) => node.folder.path);
    expect(rows).toHaveLength(4);
  });
});

describe('自定义顺序（applyFolderOrder）', () => {
  const makeTree = () =>
    buildFolderTree([
      folder('其他文件夹'),
      folder('其他文件夹/NAS'),
      folder('其他文件夹/银行'),
      folder('其他文件夹/知乎'),
    ]);

  it('order 里列出的按给定顺序，其余排在后面', () => {
    const tree = makeTree();
    applyFolderOrder(tree, { '其他文件夹': ['其他文件夹/知乎', '其他文件夹/NAS'] });
    expect(tree[0]?.children.map((node) => node.folder.path)).toEqual([
      '其他文件夹/知乎',
      '其他文件夹/NAS',
      '其他文件夹/银行',
    ]);
  });

  it('根层用空串当键', () => {
    const tree = buildFolderTree([folder('B'), folder('A')]);
    applyFolderOrder(tree, { '': ['B', 'A'] });
    expect(tree.map((node) => node.folder.path)).toEqual(['B', 'A']);
  });

  it('没有 order 时保持原顺序', () => {
    const tree = makeTree();
    applyFolderOrder(tree, {});
    expect(tree[0]?.children.map((node) => node.folder.path)).toEqual([
      '其他文件夹/NAS',
      '其他文件夹/银行',
      '其他文件夹/知乎',
    ]);
  });
});
