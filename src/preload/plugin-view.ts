import { contextBridge, ipcRenderer } from 'electron';
import type { PluginCallResult, PluginDraftContext, PluginHandshake } from '../shared/plugin';

/**
 * 插件 webview preload（§13.4、§30.5）。
 *
 * 只暴露绑定到当前会话的能力句柄 mailAPI：
 * - 每次导航/重载都会重新握手，旧 nonce 的调用由主进程拒绝
 * - 不暴露 ipcRenderer / require / fs / window.api
 */

let nonce = '';

const handshake: Promise<PluginHandshake | null> = ipcRenderer
  .invoke('plugin:handshake')
  .then((result: PluginHandshake) => {
    nonce = result.nonce;
    return result;
  })
  .catch(() => null);

async function call(method: string, args?: unknown): Promise<PluginCallResult> {
  const ready = await handshake;
  if (!ready) {
    return { ok: false, error: '插件能力握手失败' };
  }
  return ipcRenderer.invoke('plugin:call', { nonce, method, args }) as Promise<PluginCallResult>;
}

const mailAPI = {
  getCurrentEmail: () => call('getCurrentEmail'),
  getCurrentEmailAttachments: () => call('getCurrentEmailAttachments'),
  getAttachmentRisk: (attachmentId: string) => call('getAttachmentRisk', { attachmentId }),
  getDraftContext: () => call('getDraftContext'),
  setDraftContent: (patch: unknown) => call('setDraftContent', patch),
  getThemeVariables: () => call('getThemeVariables'),
  getAccounts: () => call('getAccounts'),
  getAccount: (id: string) => call('getAccount', { id }),
  onEmailChanged: (callback: (email: unknown) => void) => {
    const listener = (_event: unknown, payload: { nonce: string; email: unknown }) => {
      if (payload?.nonce === nonce) callback(payload.email);
    };
    ipcRenderer.on('plugin:email-changed', listener);
    return () => {
      ipcRenderer.removeListener('plugin:email-changed', listener);
    };
  },
  onCommand: (callback: (command: { id: string; region: string }) => void) => {
    const listener = (
      _event: unknown,
      payload: { nonce: string; command: { id: string; region: string } },
    ) => {
      if (payload?.nonce === nonce) callback(payload.command);
    };
    ipcRenderer.on('plugin:command', listener);
    return () => {
      ipcRenderer.removeListener('plugin:command', listener);
    };
  },
  onDraftChanged: (callback: (draft: PluginDraftContext) => void) => {
    const listener = (
      _event: unknown,
      payload: { nonce: string; draft: PluginDraftContext },
    ) => {
      if (payload?.nonce === nonce) callback(payload.draft);
    };
    ipcRenderer.on('plugin:draft-changed', listener);
    return () => {
      ipcRenderer.removeListener('plugin:draft-changed', listener);
    };
  },
  __debug: {
    log: (message: string) => call('log', { message: String(message) }),
  },
};

contextBridge.exposeInMainWorld('mailAPI', mailAPI);
