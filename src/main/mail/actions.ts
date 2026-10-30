import type { Account, EmailSummary } from '../../shared/types';
import type { AccountsRepo } from '../db/repositories/accounts-repo';
import type { EmailsRepo } from '../db/repositories/emails-repo';
import type { FoldersRepo } from '../db/repositories/folders-repo';
import type { AccountManager } from './account-manager';
import { log } from '../observability/logger';

/**
 * 邮件操作（§8 标志写入、归档/删除）。
 * 顺序固定：先写服务端，成功后再改本地库；服务端失败时不静默改本地数据。
 * 演示账户（settings.demoMode）没有真实凭证，只在本地生效。
 */

export type MailFlagsPatch = { read?: boolean; starred?: boolean };

export class MailActionError extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_FOUND' | 'NO_ARCHIVE' | 'ACCOUNT_MISSING' | 'SERVER_FAILED',
  ) {
    super(message);
    this.name = 'MailActionError';
  }
}

export interface MailActionsDeps {
  emails: EmailsRepo;
  accounts: AccountsRepo;
  folders: FoldersRepo;
  manager: AccountManager;
}

function isDemo(account: Account): boolean {
  return account.settings.demoMode === true;
}

export class MailActionsService {
  constructor(private readonly deps: MailActionsDeps) {}

  private resolve(emailId: string): { email: EmailSummary; account: Account } {
    const email = this.deps.emails.get(emailId);
    if (!email) throw new MailActionError('邮件不存在或已被删除', 'NOT_FOUND');
    const account = this.deps.accounts.get(email.accountId);
    if (!account) throw new MailActionError('邮件所属账户已被删除', 'ACCOUNT_MISSING');
    return { email, account };
  }

  /** 设置已读/未读与星标；返回更新后的本地摘要。 */
  async setFlags(emailId: string, patch: MailFlagsPatch): Promise<EmailSummary> {
    const { email, account } = this.resolve(emailId);
    if (patch.read === undefined && patch.starred === undefined) {
      throw new MailActionError('没有需要修改的标志', 'NOT_FOUND');
    }

    if (!isDemo(account)) {
      const add: string[] = [];
      const remove: string[] = [];
      if (patch.read === true) add.push('\\Seen');
      if (patch.read === false) remove.push('\\Seen');
      if (patch.starred === true) add.push('\\Flagged');
      if (patch.starred === false) remove.push('\\Flagged');
      try {
        await this.deps.manager.setMessageFlags(account, email.folder, email.uid, add, remove);
      } catch (error) {
        log.warn('mail', '标志写入失败', {
          emailId,
          message: (error as Error).message,
        });
        throw new MailActionError(`服务器未接受修改：${(error as Error).message}`, 'SERVER_FAILED');
      }
    }

    this.deps.emails.updateFlags(emailId, {
      ...(patch.read === undefined ? {} : { unread: !patch.read }),
      ...(patch.starred === undefined ? {} : { starred: patch.starred }),
    });
    const updated = this.deps.emails.get(emailId);
    if (!updated) throw new MailActionError('邮件已被删除', 'NOT_FOUND');
    return updated;
  }

  /** 找该账户的归档文件夹：优先 \Archive，其次名字为 Archive/归档。 */
  archiveTarget(accountId: string): string | null {
    const folders = this.deps.folders.list(accountId);
    const bySpecial = folders.find((folder) => folder.specialUse === 'archive');
    if (bySpecial) return bySpecial.path;
    const byName = folders.find((folder) => /^(archive|归档|存档)$/i.test(folder.name.trim()));
    return byName?.path ?? null;
  }

  async archive(emailId: string): Promise<{ folder: string }> {
    const { account } = this.resolve(emailId);
    const target = this.archiveTarget(account.id);
    if (!target) throw new MailActionError('该账户没有归档文件夹', 'NO_ARCHIVE');
    await this.moveTo(emailId, target);
    return { folder: target };
  }

  /** 移动到指定文件夹：服务端成功后移除本地源行，目标文件夹由下一次同步补齐。 */
  async moveTo(emailId: string, target: string): Promise<EmailSummary> {
    const { email, account } = this.resolve(emailId);
    if (email.folder === target) return email;

    if (!isDemo(account)) {
      try {
        await this.deps.manager.moveMessage(account, email.folder, email.uid, target);
      } catch (error) {
        log.warn('mail', '移动邮件失败', { emailId, target, message: (error as Error).message });
        throw new MailActionError(`服务器未接受移动：${(error as Error).message}`, 'SERVER_FAILED');
      }
    }

    this.deps.emails.remove(emailId);
    // 目标文件夹稍后同步会写入新 UID 的行；这里主动触发一次，避免用户等待
    void this.deps.manager.syncFolder(account, target).catch(() => undefined);
    return email;
  }

  async remove(emailId: string): Promise<EmailSummary> {
    const { email, account } = this.resolve(emailId);

    if (!isDemo(account)) {
      try {
        await this.deps.manager.deleteMessage(account, email.folder, email.uid);
      } catch (error) {
        log.warn('mail', '删除邮件失败', { emailId, message: (error as Error).message });
        throw new MailActionError(`服务器未接受删除：${(error as Error).message}`, 'SERVER_FAILED');
      }
    }

    this.deps.emails.remove(emailId);
    return email;
  }
}
