import type { FolderView } from '../../shared/types';

/**
 * 文件夹树（纯函数）。
 *
 * IMAP 的文件夹本来就是树（`其他文件夹/银行`），但列表接口是扁平的。
 * 侧栏要像 QQ 邮箱/Outlook 那样按层级缩进、可折叠，就得先把父子关系还原出来：
 * 用每个文件夹自己的分隔符切 path，父路径恰好也在列表里才算子节点，
 * 否则（父文件夹没被发现/已被删）就当成根节点，绝不丢行。
 */

export interface FolderNode {
  folder: FolderView;
  /** 层级，根为 0。 */
  depth: number;
  children: FolderNode[];
}

export function buildFolderTree(folders: readonly FolderView[]): FolderNode[] {
  const nodes = new Map<string, FolderNode>();
  for (const folder of folders) {
    nodes.set(folder.path, { folder, depth: 0, children: [] });
  }

  const roots: FolderNode[] = [];
  for (const folder of folders) {
    const node = nodes.get(folder.path);
    if (!node) continue;
    const delimiter = folder.delimiter || '/';
    const index = folder.path.lastIndexOf(delimiter);
    const parentPath = index > 0 ? folder.path.slice(0, index) : '';
    const parent = parentPath ? nodes.get(parentPath) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const assignDepth = (list: FolderNode[], depth: number): void => {
    for (const node of list) {
      node.depth = depth;
      assignDepth(node.children, depth + 1);
    }
  };
  assignDepth(roots, 0);
  return roots;
}

/** 按折叠状态压平成可渲染的行：父节点永远排在它的子节点前面。 */
export function flattenFolderTree(
  nodes: readonly FolderNode[],
  isCollapsed: (path: string) => boolean,
): FolderNode[] {
  const rows: FolderNode[] = [];
  const walk = (list: readonly FolderNode[]): void => {
    for (const node of list) {
      rows.push(node);
      if (node.children.length > 0 && !isCollapsed(node.folder.path)) {
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return rows;
}

/**
 * 应用用户自定义顺序（右键「上移/下移」的结果）。
 * order 的键是父路径（根用空串），值是同级路径数组；没列进去的排在后面按名称。
 */
export function applyFolderOrder(
  nodes: FolderNode[],
  order: Record<string, readonly string[]>,
): void {
  const walk = (list: FolderNode[], parentPath: string): void => {
    const ranked = order[parentPath];
    if (ranked && ranked.length > 0) {
      const rank = new Map(ranked.map((path, index) => [path, index]));
      list.sort((a, b) => {
        const left = rank.get(a.folder.path) ?? Number.MAX_SAFE_INTEGER;
        const right = rank.get(b.folder.path) ?? Number.MAX_SAFE_INTEGER;
        if (left !== right) return left - right;
        return a.folder.name.localeCompare(b.folder.name, 'zh');
      });
    }
    for (const node of list) walk(node.children, node.folder.path);
  };
  walk(nodes, '');
}
