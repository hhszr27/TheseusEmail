import type {
  CommandDefinition,
  EmailAddress,
  KeyBinding,
  MenuRegion,
  PluginManifest,
  PluginPermission,
  PluginRibbonSource,
  SlotName,
} from './types';

/**
 * Phase 2 插件运行时契约（§13、§30）。
 * 这里只放跨进程传输的结构，宿主内部状态不进入渲染进程。
 */

export const PLUGIN_API_VERSION = 1;

export type PluginStatus = 'ready' | 'disabled' | 'invalid' | 'timeout' | 'incompatible';
export type PluginSignatureStatus = 'verified' | 'unsigned' | 'invalid';
export type PluginSource = 'builtin' | 'dev' | 'user';

export interface PluginRuntimeInfo {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  description?: string;
  author?: string;
  permissions: PluginPermission[];
  /** 清单声明的默认启用状态（缺省 true），插件页展示与首次登记使用。 */
  defaultEnabled: boolean;
  status: PluginStatus;
  enabled: boolean;
  signature: PluginSignatureStatus;
  source: PluginSource;
  hasReaderView: boolean;
  hasComposeView: boolean;
  slots: SlotName[];
  /** accountId -> 是否在该账户启用；缺省继承 enabled（§7.8.4）。 */
  accountOverrides?: Record<string, boolean>;
  themes: string[];
  icons: string[];
  revokedPermissions?: PluginPermission[];
  error?: string;
}

export interface ThemeEntry {
  id: string;
  name: string;
  pluginId: string | null;
  builtin: boolean;
}

export interface PluginCommand extends CommandDefinition {
  pluginId: string;
}

export interface PluginKeybinding extends KeyBinding {
  pluginId: string;
}

export interface PluginRuleAction {
  id: string;
  label: string;
  description: string;
  pluginId: string;
}

export interface PluginRegistrySnapshot {
  plugins: PluginRuntimeInfo[];
  themes: ThemeEntry[];
  commands: PluginCommand[];
  keybindings: PluginKeybinding[];
  ruleActions: PluginRuleAction[];
  /** 已就绪且启用的插件对工具栏的贡献（渲染层按账户启用再过滤一次）。 */
  ribbon: PluginRibbonSource[];
  warnings: string[];
}

export interface PluginViewSession {
  pluginId: string;
  slot: SlotName;
  url: string;
  partition: string;
  preloadUrl: string;
}

export interface PluginHandshake {
  pluginId: string;
  nonce: string;
  permissions: PluginPermission[];
  name: string;
}

export type PluginCallMethod =
  | 'getCurrentEmail'
  | 'getCurrentEmailAttachments'
  | 'getAttachmentRisk'
  | 'getDraftContext'
  | 'setDraftContent'
  | 'getThemeVariables'
  | 'getAccounts'
  | 'getAccount'
  | 'log';

export interface PluginCallRequest {
  nonce: string;
  method: PluginCallMethod;
  args?: unknown;
}

export interface PluginCurrentEmail {
  id: string;
  subject: string;
  from: { name?: string; address: string }[];
  body: string;
  text: string;
}

/** 插件可读取的账户摘要（§13.4）：仅暴露展示所需字段，不含密钥。 */
export interface PluginAccountInfo {
  id: string;
  displayName: string;
  email: string;
  protocol: string;
  providerPreset?: string;
  imapHost?: string;
  imapPort?: number;
  imapSecure?: boolean;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  authState: string;
  enabled: boolean;
  unreadCount: number;
  status: string;
}

export interface PluginCallResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

/** 菜单区域的一项（§13.3.1）。 */
export interface PluginMenuItem {
  pluginId: string;
  pluginName: string;
  commandId: string;
  label: string;
  description?: string;
  missingPermission?: PluginPermission;
}

export interface PluginMenuQuery {
  region: MenuRegion;
  accountId?: string | null;
  context?: Record<string, boolean>;
}

export interface PluginCommandRunResult {
  delivered: number;
}

/** compose-view 上下文（§13.4）：插件读写当前草稿。 */
export interface PluginDraftContext {
  accountId: string;
  subject: string;
  to: EmailAddress[];
  cc: EmailAddress[];
  body: string;
}

export interface PluginDraftPatch {
  subject?: string;
  to?: EmailAddress[];
  cc?: EmailAddress[];
  body?: string;
}

/** 插件 webview 内可用的能力句柄表面（window.mailAPI）。 */
export interface PluginMailApi {
  getCurrentEmail(): Promise<PluginCallResult>;
  getCurrentEmailAttachments(): Promise<PluginCallResult>;
  getAttachmentRisk(attachmentId: string): Promise<PluginCallResult>;
  getDraftContext(): Promise<PluginCallResult>;
  setDraftContent(patch: PluginDraftPatch): Promise<PluginCallResult>;
  getThemeVariables(): Promise<PluginCallResult>;
  getAccounts(): Promise<PluginCallResult>;
  getAccount(id: string): Promise<PluginCallResult>;
  onEmailChanged(callback: (email: unknown) => void): () => void;
  onCommand(callback: (command: { id: string; region: string; accountId?: string | null }) => void): () => void;
  onDraftChanged(callback: (draft: PluginDraftContext) => void): () => void;
  __debug: { log(message: string): Promise<PluginCallResult> };
}

/** 内置主题（非插件）。 */
export const BUILTIN_THEMES: ThemeEntry[] = [
  { id: 'builtin:light', name: '亮色', pluginId: null, builtin: true },
  { id: 'builtin:dark', name: '暗色', pluginId: null, builtin: true },
];

export const DEFAULT_SLOT: SlotName = 'reader-panel-top';

export function manifestToRuntime(
  manifest: PluginManifest,
  base: Omit<
    PluginRuntimeInfo,
    | 'id'
    | 'name'
    | 'version'
    | 'apiVersion'
    | 'permissions'
    | 'defaultEnabled'
    | 'hasReaderView'
    | 'hasComposeView'
    | 'slots'
    | 'themes'
    | 'icons'
  >,
): PluginRuntimeInfo {
  const contributes = manifest.contributes ?? {};
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    apiVersion: manifest.apiVersion,
    ...(manifest.description ? { description: manifest.description } : {}),
    ...(manifest.author ? { author: manifest.author } : {}),
    permissions: manifest.permissions ?? [],
    defaultEnabled: manifest.defaultEnabled !== false,
    hasReaderView: Boolean(contributes.readerView),
    hasComposeView: Boolean(contributes.composeView),
    slots: contributes.views ? (Object.keys(contributes.views) as SlotName[]) : [],
    themes: contributes.theme ? [manifest.id] : [],
    icons: contributes.icons ? Object.keys(contributes.icons) : [],
    ...base,
  };
}
