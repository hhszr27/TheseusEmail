/**
 * 账户级插件启用（§7.8.4）主进程入口。
 * 判定逻辑放在 shared，保证主进程与渲染进程使用同一份语义。
 */
export {
  isPluginEnabledForAccount,
  explicitOverride,
  withoutAccount,
  type AccountOverrides,
} from '../../shared/plugin-access';
