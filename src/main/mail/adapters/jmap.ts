import type { Account, EmailSummary, FolderView, SyncCapabilityLevel } from '../../../shared/types';

/**
 * JMAP 适配器接口预留（§35 Phase 2，仅接口）。
 * 具体实现不在 Phase 2 范围，调用时明确抛错而不是静默失败。
 */

export interface JmapSession {
  apiUrl: string;
  accountId: string;
  capabilities: string[];
}

export interface JmapSyncResult {
  emails: EmailSummary[];
  uidValidity: number;
  cursor?: string;
  capabilityLevel: SyncCapabilityLevel;
}

export interface MailAdapter {
  readonly protocol: 'imap-smtp' | 'graph' | 'jmap';
  connect(): Promise<void>;
  listFolders(): Promise<FolderView[]>;
  syncFolder(folder: string, limit: number): Promise<JmapSyncResult>;
  fetchBody(folder: string, uid: number): Promise<{ html: string | null; text: string | null }>;
  disconnect(): Promise<void>;
}

export class JmapAdapter implements MailAdapter {
  readonly protocol = 'jmap' as const;

  constructor(private readonly account: Account) {}

  async connect(): Promise<void> {
    throw new Error(`JMAP 适配器尚未实现（账户 ${this.account.id}）`);
  }

  async listFolders(): Promise<FolderView[]> {
    throw new Error('JMAP 适配器尚未实现');
  }

  async syncFolder(): Promise<JmapSyncResult> {
    throw new Error('JMAP 适配器尚未实现');
  }

  async fetchBody(): Promise<{ html: string | null; text: string | null }> {
    throw new Error('JMAP 适配器尚未实现');
  }

  async disconnect(): Promise<void> {
    // 无连接可关闭
  }
}
