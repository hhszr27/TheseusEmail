import { ipcMain } from 'electron';
import { createUnlockWindow } from './main-window';
import { verifyMasterPassword } from '../db/key-manager';
import { log } from '../observability/logger';

/**
 * 启动时的主密码提示（§6.6）。
 * 密码只在主进程内校验，不落盘；取消或关闭窗口即视为放弃启动。
 */
export function promptMasterPassword(): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const window = createUnlockWindow();
    let settled = false;
    let failures = 0;

    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      ipcMain.removeHandler('unlock:submit');
      ipcMain.removeHandler('unlock:cancel');
      if (!window.isDestroyed()) window.destroy();
      resolve(value);
    };

    ipcMain.handle('unlock:submit', async (event, password: unknown) => {
      if (event.sender.id !== window.webContents.id) {
        return { ok: false, message: '来源不合法' };
      }
      if (typeof password !== 'string' || password.length === 0) {
        return { ok: false, message: '请输入主密码。' };
      }

      // 失败次数越多等待越久，降低本地暴力尝试速度
      if (failures > 0) {
        await new Promise((done) => setTimeout(done, Math.min(2000, failures * 300)));
      }

      if (!verifyMasterPassword(password)) {
        failures += 1;
        log.warn('security', '主密码校验失败', { failures });
        return { ok: false, message: '主密码不正确。' };
      }

      finish(password);
      return { ok: true };
    });

    ipcMain.handle('unlock:cancel', (event) => {
      if (event.sender.id === window.webContents.id) finish(null);
    });

    window.on('closed', () => finish(null));
  });
}
