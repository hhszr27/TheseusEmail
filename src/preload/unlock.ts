import { contextBridge, ipcRenderer } from 'electron';

/**
 * 解锁窗口 preload：只暴露提交主密码与取消两个动作。
 * 密码只通过 IPC 传给主进程校验，不落盘、不进入日志。
 */
contextBridge.exposeInMainWorld('unlockApi', {
  submit: (password: string) => ipcRenderer.invoke('unlock:submit', password),
  cancel: () => ipcRenderer.invoke('unlock:cancel'),
});
