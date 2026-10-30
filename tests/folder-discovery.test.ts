import { describe, expect, it } from 'vitest';
import {
  discoverFolders,
  inferSpecialUseFromName,
  normalizeSpecialUseFlag,
  sortFolders,
} from '../src/main/mail/sync/folder-discovery';

describe('IMAP 文件夹三层发现（§7.7）', () => {
  it('规范化 SPECIAL-USE 标志', () => {
    expect(normalizeSpecialUseFlag('\\Sent')).toBe('sent');
    expect(normalizeSpecialUseFlag(['\\Trash'])).toBe('trash');
    expect(normalizeSpecialUseFlag('\\All')).toBe('all');
    expect(normalizeSpecialUseFlag('\\Junk')).toBe('junk');
    expect(normalizeSpecialUseFlag('Sent')).toBe('sent');
    expect(normalizeSpecialUseFlag(undefined)).toBeUndefined();
  });

  it('优先使用服务器扩展标志，来源标记 extension', () => {
    const result = discoverFolders(
      [
        { path: 'INBOX', name: 'INBOX', delimiter: '/', specialUse: null },
        { path: 'Sent', name: 'Sent', delimiter: '/', specialUse: '\\Sent', specialUseSource: 'extension' },
        { path: 'Trash', name: 'Trash', delimiter: '/', specialUse: '\\Trash', specialUseSource: 'extension' },
      ],
      { specialUseCapability: 'special-use' },
    );

    const sent = result.folders.find((folder) => folder.path === 'Sent');
    expect(sent?.specialUse).toBe('sent');
    expect(sent?.specialUseSource).toBe('extension');
    expect(result.warnings).toHaveLength(0);
  });

  it('服务器只提供名称时，第三层启发式生效并记录警告', () => {
    const result = discoverFolders(
      [
        { path: 'INBOX', name: 'INBOX', delimiter: '.' },
        { path: '已发送', name: '已发送', delimiter: '.' },
        { path: 'Drafts', name: 'Drafts', delimiter: '.' },
      ],
      { specialUseCapability: 'none' },
    );

    const sent = result.folders.find((folder) => folder.path === '已发送');
    expect(sent?.specialUse).toBe('sent');
    expect(sent?.specialUseSource).toBe('name');
    expect(result.warnings.some((warning) => warning.includes('specialUseSource=name'))).toBe(true);
  });

  it('imapflow 已判定为 name 时沿用并告警', () => {
    const result = discoverFolders(
      [{ path: 'Gesendet', name: 'Gesendet', delimiter: '/', specialUse: '\\Sent', specialUseSource: 'name' }],
      { specialUseCapability: 'special-use' },
    );
    expect(result.folders[0]?.specialUseSource).toBe('name');
    expect(result.warnings.length).toBe(1);
  });

  it('同一语义只保留先注册者并告警', () => {
    const result = discoverFolders(
      [
        { path: 'Sent', name: 'Sent', delimiter: '/', specialUse: '\\Sent', specialUseSource: 'extension' },
        { path: 'Sent Items', name: 'Sent Items', delimiter: '/', specialUse: '\\Sent', specialUseSource: 'extension' },
      ],
      { specialUseCapability: 'special-use' },
    );
    const claimed = result.folders.filter((folder) => folder.specialUse === 'sent');
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.path).toBe('Sent');
    expect(result.warnings.length).toBe(1);
  });

  it('名称启发式覆盖常见中英文命名', () => {
    expect(inferSpecialUseFromName('Sent Items')).toBe('sent');
    expect(inferSpecialUseFromName('已发送')).toBe('sent');
    expect(inferSpecialUseFromName('Drafts')).toBe('drafts');
    expect(inferSpecialUseFromName('垃圾邮件')).toBe('junk');
    expect(inferSpecialUseFromName('Project Alpha')).toBeUndefined();
  });

  it('INBOX 排在最前，其次特殊文件夹', () => {
    const result = discoverFolders(
      [
        { path: 'Zebra', name: 'Zebra', delimiter: '/' },
        { path: 'Sent', name: 'Sent', delimiter: '/', specialUse: '\\Sent', specialUseSource: 'extension' },
        { path: 'INBOX', name: 'INBOX', delimiter: '/' },
      ],
      { specialUseCapability: 'special-use' },
    );
    const sorted = sortFolders(result.folders).map((folder) => folder.path);
    expect(sorted[0]).toBe('INBOX');
    expect(sorted[1]).toBe('Sent');
  });
});
