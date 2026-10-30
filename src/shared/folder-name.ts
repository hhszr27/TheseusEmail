/**
 * IMAP 文件夹名与路径的校验（纯函数，可单测）。
 *
 * 新建文件夹要落到服务端，名字非法会被服务器以很难懂的理由拒绝，
 * 所以先在本地挡住：空名字、层级分隔符、通配符、控制字符、超长名。
 */

export const MAX_FOLDER_NAME_LENGTH = 120;

export type FolderNameError =
  | 'empty'
  | 'delimiter'
  | 'wildcard'
  | 'control'
  | 'too-long'
  | 'reserved';

export interface FolderNameCheck {
  ok: boolean;
  error?: FolderNameError;
}

/** 名称里不能出现分隔符（否则会被当成层级）、IMAP 通配符与控制字符。 */
export function validateFolderName(raw: string, delimiter: string): FolderNameCheck {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) return { ok: false, error: 'empty' };
  if (name.length > MAX_FOLDER_NAME_LENGTH) return { ok: false, error: 'too-long' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return { ok: false, error: 'control' };
  if (delimiter && name.includes(delimiter)) return { ok: false, error: 'delimiter' };
  // `*` 与 `%` 是 LIST 的通配符，放进名字里会让后续列表查询变味
  if (/[*%]/.test(name)) return { ok: false, error: 'wildcard' };
  // 保留给「收件箱」的是 INBOX 本身，不允许用户再造一个同名（大小写不敏感）
  if (name.toUpperCase() === 'INBOX') return { ok: false, error: 'reserved' };
  return { ok: true };
}

/** 校验结果 → 给用户看的中文原因（主进程原样回给界面）。 */
export function folderNameErrorMessage(error: FolderNameError | undefined): string {
  switch (error) {
    case 'delimiter':
      return '名称里不能包含层级分隔符';
    case 'wildcard':
      return '名称里不能包含 * 或 %';
    case 'control':
      return '名称里不能包含控制字符';
    case 'too-long':
      return `名称不能超过 ${MAX_FOLDER_NAME_LENGTH} 个字符`;
    case 'reserved':
      return '「INBOX」是保留名称';
    default:
      return '名称不能为空';
  }
}

/** 拼出完整路径：父路径为空时就是根下的名字。 */
export function buildFolderPath(parentPath: string, delimiter: string, name: string): string {
  const parent = typeof parentPath === 'string' ? parentPath.trim() : '';
  const leaf = name.trim();
  if (!parent) return leaf;
  const separator = delimiter || '/';
  return `${parent.replace(new RegExp(`${escapeRegExp(separator)}$`), '')}${separator}${leaf}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 取父路径（`A/B/C` → `A/B`；根下的文件夹返回空串）。 */
export function parentPathOf(path: string, delimiter: string): string {
  const separator = delimiter || '/';
  const index = path.lastIndexOf(separator);
  return index <= 0 ? '' : path.slice(0, index);
}

/** 取叶子名（`A/B/C` → `C`）。 */
export function leafNameOf(path: string, delimiter: string): string {
  const separator = delimiter || '/';
  const index = path.lastIndexOf(separator);
  return index < 0 ? path : path.slice(index + separator.length);
}

/** candidate 是否是 parent 本身或它的子路径（用来拦住「移动到自己的子目录」）。 */
export function isSameOrDescendantPath(
  candidate: string,
  parent: string,
  delimiter: string,
): boolean {
  const separator = delimiter || '/';
  return candidate === parent || candidate.startsWith(`${parent}${separator}`);
}

/** 把 path 及其子路径整体换前缀（改名/移动后的路径迁移）。 */
export function replacePathPrefix(
  path: string,
  oldPrefix: string,
  newPrefix: string,
  delimiter: string,
): string {
  if (path === oldPrefix) return newPrefix;
  if (!isSameOrDescendantPath(path, oldPrefix, delimiter)) return path;
  return `${newPrefix}${path.slice(oldPrefix.length)}`;
}

/**
 * 系统文件夹保护：收件箱与带 special-use 的文件夹（已发送/草稿/垃圾/已删除/归档…）
 * 不允许改名、移动、删除——这些是服务端语义的一部分，改坏会直接影响收发信。
 */
export function isProtectedFolder(folder: { path: string; specialUse?: string | null }): boolean {
  if (folder.path.toUpperCase() === 'INBOX') return true;
  return Boolean(folder.specialUse);
}
