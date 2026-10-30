import { contextBridge, ipcRenderer } from 'electron';
import type { RecoveryApi } from '../shared/ipc';

/**
 * 恢复窗口 preload（§25.1）。
 * 只暴露读取诊断信息与用户主动触发的恢复动作，没有任何其他能力。
 * 频道名内联以保持 preload 自包含（沙箱 preload 不能 require 额外 chunk）。
 */
const recoveryAPI: RecoveryApi = {
  getInfo: () => ipcRenderer.invoke('recovery:info'),
  reload: () => ipcRenderer.invoke('recovery:reload'),
  quit: () => ipcRenderer.invoke('recovery:quit'),
};

contextBridge.exposeInMainWorld('recoveryAPI', recoveryAPI);
