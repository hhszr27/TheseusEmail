/**
 * 插件内容安全策略（§13.7）。
 *
 * 单独放在纯模块里，方便测试直接断言——`script-src 'self'` 意味着插件页面里的
 * **内联 `<script>` 会被静默拦截**（不报错，只是不执行），必须用同源外部脚本。
 * 2026-10-27 踩过：panel-note 用内联脚本，面板永远停在「正在加载账户…」。
 */

export const PLUGIN_SCHEME = 'mailforge-plugin';

export const PLUGIN_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');
