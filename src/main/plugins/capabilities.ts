import { randomUUID } from 'node:crypto';
import type { PluginPermission } from '../../shared/types';
import type { PluginCallMethod, PluginHandshake } from '../../shared/plugin';

/**
 * 插件能力句柄（§13.4、§30.5）。
 *
 * 句柄不是永久全局对象：每次 webview 导航/重载都会重新握手生成新 nonce，
 * 旧 nonce 的调用立即失效；权限撤销在调用时二次校验。
 */

export const METHOD_PERMISSIONS: Record<PluginCallMethod, PluginPermission | null> = {
  getCurrentEmail: 'read:email-body',
  getCurrentEmailAttachments: 'read:email-meta',
  getAttachmentRisk: 'read:email-meta',
  getDraftContext: 'read:email-body',
  setDraftContent: 'write:draft',
  getThemeVariables: null,
  getAccounts: 'read:email-meta',
  getAccount: 'read:email-meta',
  log: null,
};

export interface CapabilitySession {
  webContentsId: number;
  pluginId: string;
  nonce: string;
  permissions: PluginPermission[];
  issuedAt: number;
}

export class CapabilityManager {
  private readonly sessions = new Map<number, CapabilitySession>();
  private readonly revoked = new Map<string, Set<PluginPermission>>();

  /** 握手：为当前 webview 会话签发新 nonce，旧 nonce 自动失效。 */
  handshake(webContentsId: number, pluginId: string, permissions: PluginPermission[]): PluginHandshake {
    const revoked = this.revoked.get(pluginId) ?? new Set<PluginPermission>();
    const effective = permissions.filter((permission) => !revoked.has(permission));
    const session: CapabilitySession = {
      webContentsId,
      pluginId,
      nonce: randomUUID(),
      permissions: effective,
      issuedAt: Date.now(),
    };
    this.sessions.set(webContentsId, session);
    return { pluginId, nonce: session.nonce, permissions: effective, name: pluginId };
  }

  invalidate(webContentsId: number): void {
    this.sessions.delete(webContentsId);
  }

  invalidatePlugin(pluginId: string): void {
    for (const [webContentsId, session] of this.sessions) {
      if (session.pluginId === pluginId) this.sessions.delete(webContentsId);
    }
  }

  getSession(webContentsId: number): CapabilitySession | null {
    return this.sessions.get(webContentsId) ?? null;
  }

  /** 校验发送方与 nonce；不匹配返回 null。 */
  resolve(webContentsId: number, nonce: string): CapabilitySession | null {
    const session = this.sessions.get(webContentsId);
    if (!session) return null;
    if (session.nonce !== nonce) return null;
    return session;
  }

  allows(pluginId: string, permission: PluginPermission | null): boolean {
    if (!permission) return true;
    const revoked = this.revoked.get(pluginId);
    if (revoked?.has(permission)) return false;
    return true;
  }

  hasPermission(session: CapabilitySession, permission: PluginPermission | null): boolean {
    if (!permission) return true;
    if (!session.permissions.includes(permission)) return false;
    return this.allows(session.pluginId, permission);
  }

  setRevoked(pluginId: string, permission: PluginPermission, isRevoked: boolean): void {
    const set = this.revoked.get(pluginId) ?? new Set<PluginPermission>();
    if (isRevoked) set.add(permission);
    else set.delete(permission);
    if (set.size === 0) this.revoked.delete(pluginId);
    else this.revoked.set(pluginId, set);
  }

  isRevoked(pluginId: string, permission: PluginPermission): boolean {
    return this.revoked.get(pluginId)?.has(permission) ?? false;
  }

  revokedFor(pluginId: string): PluginPermission[] {
    return [...(this.revoked.get(pluginId) ?? new Set<PluginPermission>())];
  }

  activeCount(): number {
    return this.sessions.size;
  }

  activeSessions(): CapabilitySession[] {
    return [...this.sessions.values()];
  }
}
