import { Notification } from 'electron';
import { IPC_EVENTS } from '../../shared/constants';
import type { EmailSummary } from '../../shared/types';
import { focusMainWindow, sendToRenderer } from '../app/app-context';
import { log } from '../observability/logger';
import { buildMailGroupNotification, buildTestNotification } from './policy';

/**
 * 桌面通知服务（§22）。
 *
 * 隐私硬约束（§22.2）：邮件通知只含发件人与主题，绝不带正文或摘要。
 * 批量到达合并：同一 900ms 窗口内的多封新邮件合并为一条，避免 toast 风暴
 * （合并文案见 policy.buildMailGroupNotification）。
 */

const COALESCE_MS = 900;

interface PendingMail {
  emails: EmailSummary[];
  timer: NodeJS.Timeout | null;
}

export class NotificationService {
  private pending: PendingMail = { emails: [], timer: null };

  /** 新邮件到达（由同步管道调用；设置/DND 闸门在调用方判定）。 */
  notifyMail(email: EmailSummary): void {
    this.pending.emails.push(email);
    if (this.pending.timer) return;
    this.pending.timer = setTimeout(() => {
      const batch = this.pending.emails;
      this.pending = { emails: [], timer: null };
      const group = buildMailGroupNotification(batch);
      if (!group) return;
      this.show(group.title, group.body, () => {
        focusMainWindow();
        if (group.emailId) {
          sendToRenderer(IPC_EVENTS.notificationOpen, { emailId: group.emailId });
        }
      });
    }, COALESCE_MS);
  }

  /** 定时发送结果（成功/失败/取消）。 */
  notifySendResult(title: string, body: string): void {
    this.show(title, body, () => {
      focusMainWindow();
      sendToRenderer(IPC_EVENTS.trayAction, { action: 'outbox' });
    });
  }

  /** 日程提醒（§16 + §22）。 */
  notifyReminder(title: string, body: string): void {
    this.show(title, body, () => {
      focusMainWindow();
    });
  }

  /**
   * 设置页「发送测试通知」：验证系统通知通道是否真的能弹出。
   * 故意绕过设置开关与免打扰——按钮的用途就是确认 OS 层通道可用。
   */
  notifyTest(): void {
    const { title, body } = buildTestNotification();
    this.show(title, body, () => {
      focusMainWindow();
    });
  }

  private show(title: string, body: string, onClick: () => void): void {
    if (!Notification.isSupported()) {
      log.info('notify', '系统不支持通知，已跳过', { title });
      return;
    }
    try {
      const notification = new Notification({ title, body, silent: false });
      notification.on('click', onClick);
      notification.show();
      log.info('notify', '已弹出系统通知', { title, body });
    } catch (error) {
      log.warn('notify', '通知发送失败', { title, message: (error as Error).message });
    }
  }

  /** 退出前清掉未 flush 的合并计时器，避免 before-quit 竞态。 */
  dispose(): void {
    if (this.pending.timer) clearTimeout(this.pending.timer);
    this.pending = { emails: [], timer: null };
  }
}
