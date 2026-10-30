import type { Account, P2pClientIdentity } from '../shared/types';
import type { Db } from './db/open';
import type { AccountsRepo } from './db/repositories/accounts-repo';
import type { FoldersRepo } from './db/repositories/folders-repo';
import type { EmailsRepo } from './db/repositories/emails-repo';
import type { SecretStore } from './mail/auth/token-store';
import type { AccountManager } from './mail/account-manager';
import type { PluginService } from './plugins/service';
import type { CapabilityManager } from './plugins/capabilities';
import type { PluginsRepo } from './db/repositories/plugins-repo';
import type { SearchService } from './search/service';
import type { ContactsRepo } from './db/repositories/contacts-repo';
import type { P2pRepo } from './db/repositories/p2p-repo';
import type { MailActionsService } from './mail/actions';
import type { ComposeAttachmentStore } from './mail/compose-attachments';
import type { DraftsRepo } from './db/repositories/drafts-repo';
import type { ScheduledSendService } from './mail/scheduled-service';
import type { RulesRepo } from './rules/repo';
import type { AttachmentStore } from './attachments/store';
import type { ScanService } from './attachments/scan';
import type { SignatureStore } from './signatures/store';
import type { TranslationService } from './translation/service';
import type { AiService } from './ai/service';
import type { CalendarService } from './calendar/service';
import type { MboxService } from './mbox/service';
import type { MetadataService } from './mail/metadata-service';
import type { AccountService } from './accounts/service';
import type { TrayService } from './app/tray';
import type { NotificationService } from './notifications/service';
import type { ReminderService } from './notifications/reminders';
import type { ProxyStatus } from '../shared/ipc';

/** 主进程服务的集中持有，避免在 IPC 层层层传参。 */

export interface Services {
  db: Db;
  accounts: AccountsRepo;
  accountService: AccountService;
  folders: FoldersRepo;
  emails: EmailsRepo;
  secrets: SecretStore;
  manager: AccountManager;
  plugins: PluginService;
  capabilities: CapabilityManager;
  pluginsRepo: PluginsRepo;
  search: SearchService;
  contacts: ContactsRepo;
  /** 邮件标志/归档/删除（先服务端后本地）。 */
  mailActions: MailActionsService;
  /** 写信附件的暂存目录（渲染进程只拿 id）。 */
  composeAttachments: ComposeAttachmentStore;
  /** 本地草稿（每账户一封）。 */
  drafts: DraftsRepo;
  /** P2P 聊天记录（§24.1.1）。 */
  p2p: P2pRepo;
  /** 客户端级 P2P 身份，与邮箱账户无关。 */
  p2pIdentity: P2pClientIdentity;
  rules: RulesRepo;
  scheduled: ScheduledSendService;
  attachments: AttachmentStore;
  scanner: ScanService;
  /** 签名（每账户多套，新邮件/回复转发各自默认）。 */
  signatures: SignatureStore;
  translation: TranslationService;
  ai: AiService;
  calendar: CalendarService;
  mbox: MboxService;
  metadata: MetadataService;
  /** 系统托盘（宿主能力；bootstrap 里创建后才非空）。 */
  tray: TrayService | null;
  /** 桌面通知：新邮件 / 发送结果 / 日程提醒（§22）。 */
  notifications: NotificationService;
  /** 日程提醒周期扫描（§16 + §22）。 */
  reminders: ReminderService;
  dbPath: string;
  dbEncrypted: boolean;
  keyProtection: 'safeStorage' | 'plain' | 'master';
  proxy: ProxyStatus;
  /** 由 .env 提供的开发期账户（若存在）。 */
  envAccount: Account | null;
}

let current: Services | null = null;

export function setServices(services: Services): void {
  current = services;
}

/** 主窗口创建后再注入托盘（TrayService 只依赖 db，可延迟创建）。 */
export function setTrayService(tray: TrayService | null): void {
  if (current) current.tray = tray;
}

export function getServices(): Services {
  if (!current) throw new Error('服务尚未初始化');
  return current;
}

export function tryGetServices(): Services | null {
  return current;
}
