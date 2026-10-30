import { SPECIAL_USE_NAME_HINTS } from '../../../shared/constants';
import type { SpecialUse } from '../../../shared/types';

/**
 * IMAP 文件夹三层发现（§7.7）：
 *   1. SPECIAL-USE (RFC 6154) / XLIST —— 服务器直接给出语义标志
 *   2. 名称启发式 —— 仅在前两者不可用时兜底，必须记录警告
 *   3. NAMESPACE (RFC 2342) —— 由适配器读取并持久化 delimiter / 前缀
 *
 * 本模块只做纯映射，不依赖 imapflow。
 */

export type SpecialUseCapability = 'special-use' | 'xlist' | 'none';

export interface RawMailbox {
  path: string;
  name?: string;
  delimiter?: string;
  specialUse?: string | string[] | null;
  /** imapflow 已经完成三层判定，可直接沿用其结果。 */
  specialUseSource?: 'user' | 'extension' | 'name';
}

export interface DiscoveredFolder {
  path: string;
  name: string;
  delimiter: string;
  specialUse?: SpecialUse;
  specialUseSource?: 'user' | 'extension' | 'name';
}

export interface DiscoveryResult {
  folders: DiscoveredFolder[];
  /** 需要写入结构化日志的警告。 */
  warnings: string[];
}

const FLAG_MAP: Record<string, SpecialUse> = {
  '\\sent': 'sent',
  '\\drafts': 'drafts',
  '\\draft': 'drafts',
  '\\trash': 'trash',
  '\\deleted': 'trash',
  '\\archive': 'archive',
  '\\all': 'all',
  '\\allmail': 'all',
  '\\junk': 'junk',
  '\\spam': 'junk',
  '\\flagged': 'flagged',
};

export function normalizeSpecialUseFlag(raw: unknown): SpecialUse | undefined {
  if (!raw) return undefined;
  const values = Array.isArray(raw) ? raw : [raw];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const normalized = value.trim().toLowerCase();
    const mapped = FLAG_MAP[normalized];
    if (mapped) return mapped;
    // 有些服务器返回不带反斜杠的形式
    const withSlash = `\\${normalized.replace(/^\\/, '')}`;
    const mapped2 = FLAG_MAP[withSlash];
    if (mapped2) return mapped2;
  }
  return undefined;
}

export function lastPathSegment(path: string, delimiter: string): string {
  if (!path) return '';
  if (!delimiter) return path;
  const parts = path.split(delimiter);
  return parts[parts.length - 1] ?? path;
}

/** 名称启发式（第三层）。 */
export function inferSpecialUseFromName(name: string): SpecialUse | undefined {
  const normalized = name.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!normalized) return undefined;
  for (const hint of SPECIAL_USE_NAME_HINTS) {
    if (hint.names.some((candidate) => candidate === normalized)) {
      return hint.use;
    }
  }
  return undefined;
}

export function discoverFolders(
  mailboxes: RawMailbox[],
  options: { specialUseCapability: SpecialUseCapability; namespacePrefix?: string },
): DiscoveryResult {
  const folders: DiscoveredFolder[] = [];
  const warnings: string[] = [];
  const claimed = new Map<SpecialUse, string>();
  const delimiter = mailboxes.find((m) => m.delimiter)?.delimiter ?? '/';

  for (const mailbox of mailboxes) {
    const path = mailbox.path;
    if (!path) continue;

    const name = mailbox.name ?? lastPathSegment(path, mailbox.delimiter || delimiter);
    const folder: DiscoveredFolder = {
      path,
      name,
      delimiter: mailbox.delimiter || delimiter,
    };

    let use = normalizeSpecialUseFlag(mailbox.specialUse);
    let source: 'user' | 'extension' | 'name' | undefined;

    if (use) {
      if (mailbox.specialUseSource === 'name') {
        source = 'name';
        warnings.push(
          `folder ${path} 通过名称启发式识别为 ${use}（specialUseSource=name），非英语 locale 下可能出错`,
        );
      } else if (mailbox.specialUseSource === 'user') {
        source = 'user';
      } else {
        source = 'extension';
        if (options.specialUseCapability === 'none') {
          warnings.push(
            `folder ${path} 返回了特殊用途标志，但服务器未声明 SPECIAL-USE/XLIST，按扩展标志处理`,
          );
        }
      }
    } else if (options.specialUseCapability === 'none') {
      use = inferSpecialUseFromName(name) ?? inferSpecialUseFromName(path);
      if (use) {
        source = 'name';
        warnings.push(
          `folder ${path} 通过名称启发式识别为 ${use}（specialUseSource=name），非英语 locale 下可能出错`,
        );
      }
    }

    if (use) {
      const existing = claimed.get(use);
      if (existing) {
        warnings.push(`folder ${path} 与 ${existing} 同时声明 ${use}，保留先注册者`);
        folder.specialUse = undefined;
        folder.specialUseSource = undefined;
      } else {
        claimed.set(use, path);
        folder.specialUse = use;
        folder.specialUseSource = source;
      }
    }

    folders.push(folder);
  }

  return { folders, warnings };
}

/** 文件夹排序：INBOX 最前，其次特殊文件夹，最后按名称。 */
export function folderSortKey(folder: DiscoveredFolder): [number, number, string] {
  const isInbox = folder.path.toUpperCase() === 'INBOX' ? 0 : 1;
  const specialRank = folder.specialUse ? 0 : 1;
  return [isInbox, specialRank, folder.name.toLowerCase()];
}

export function sortFolders(folders: DiscoveredFolder[]): DiscoveredFolder[] {
  return [...folders].sort((a, b) => {
    const ka = folderSortKey(a);
    const kb = folderSortKey(b);
    if (ka[0] !== kb[0]) return ka[0] - kb[0];
    if (ka[1] !== kb[1]) return ka[1] - kb[1];
    return ka[2].localeCompare(kb[2]);
  });
}
