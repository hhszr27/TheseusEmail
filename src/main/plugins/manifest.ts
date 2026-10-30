import path from 'node:path';
import { z } from 'zod';
import type { PluginManifest } from '../../shared/types';
import { PLUGIN_API_VERSION } from '../../shared/plugin';
import { RIBBON_BUILTIN_TAB_IDS, RIBBON_ICON_NAMES, RIBBON_WHEN_NAMES } from '../../shared/ribbon';

/**
 * manifest 校验（§13.1）。
 * 所有路径必须是插件目录内的相对路径，且只允许受控扩展名。
 */

const SLOT_NAMES = [
  'mail-list-header',
  'mail-list-item',
  'reader-view',
  'reader-panel-top',
  'reader-panel-bottom',
  'compose-view',
  'compose-toolbar',
  'sidebar-item',
  'settings-section',
  'status-bar',
  'global-toolbar',
  'panel',
] as const;

const MENU_REGIONS = [
  'main',
  'context:mail-list',
  'context:reader',
  'context:compose',
  'context:account',
] as const;

const PERMISSIONS = [
  'read:email-body',
  'read:email-meta',
  'write:draft',
  'network:external',
  'fs:temp',
  'notifications',
] as const;

function isSafeRelativePath(value: string): boolean {
  if (!value || value.length > 200) return false;
  if (value.startsWith('/') || value.startsWith('\\')) return false;
  if (/^[a-zA-Z]:/.test(value)) return false;
  if (value.includes('\\')) return false;
  const normalized = path.posix.normalize(value);
  if (normalized.startsWith('..') || normalized.includes('/../')) return false;
  return true;
}

function assetPath(extensions: RegExp) {
  return z
    .string()
    .min(1)
    .max(200)
    .refine((value) => isSafeRelativePath(value), '必须是不含 .. 的相对路径')
    .refine((value) => extensions.test(value), '扩展名不被允许');
}

const htmlPath = assetPath(/\.html?$/i);
const cssPath = assetPath(/\.css$/i);
const svgPath = assetPath(/\.svg$/i);

const keybindingSchema = z.object({
  key: z.string().min(1).max(40),
  modifiers: z.array(z.enum(['ctrl', 'meta', 'alt', 'shift'])).max(4).optional(),
  command: z.string().min(1).max(120),
  when: z.string().max(200).optional(),
});

/** ribbon 贡献：图标与可见性条件都走封闭白名单，插件不能自带新值。 */
const ribbonSchema = z
  .object({
    tabs: z
      .array(
        z
          .object({
            id: z
              .string()
              .min(1)
              .max(40)
              .regex(/^[a-z0-9][a-z0-9-]*$/, '标签 id 只能包含小写字母、数字和连字符'),
            label: z.string().min(1).max(40),
            order: z.number().int().min(-1000).max(1000).optional(),
          })
          .strict(),
      )
      .max(3)
      .optional(),
    tools: z
      .array(
        z
          .object({
            tab: z.string().min(1).max(80),
            id: z
              .string()
              .min(1)
              .max(60)
              .regex(/^[a-z0-9][a-z0-9.-]*$/, '工具 id 只能包含小写字母、数字、点和连字符'),
            label: z.string().min(1).max(40),
            command: z.string().min(1).max(120),
            icon: z.enum(RIBBON_ICON_NAMES).optional(),
            when: z.enum(RIBBON_WHEN_NAMES).optional(),
            order: z.number().int().min(-1000).max(1000).optional(),
          })
          .strict(),
      )
      .max(20)
      .optional(),
  })
  .strict();

export const manifestSchema = z
  .object({
    id: z
      .string()
      .min(2)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'id 只能包含小写字母、数字和连字符'),
    name: z.string().min(1).max(80),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, '版本号需为 semver'),
    apiVersion: z.number().int().positive(),
    description: z.string().max(500).optional(),
    author: z.string().max(120).optional(),
    defaultEnabled: z.boolean().optional(),
    permissions: z.array(z.enum(PERMISSIONS)).max(10).optional(),
    main: z.string().max(200).optional(),
    contributes: z
      .object({
        theme: cssPath.optional(),
        icons: z.record(z.string().min(1).max(80), svgPath).optional(),
        readerView: htmlPath.optional(),
        composeView: htmlPath.optional(),
        views: z.partialRecord(z.enum(SLOT_NAMES), htmlPath).optional(),
        securityScanner: z.boolean().optional(),
        translationProvider: z.boolean().optional(),
        aiProvider: z.boolean().optional(),
        taskProvider: z.boolean().optional(),
        feedReader: z.boolean().optional(),
        cryptoProvider: z.boolean().optional(),
        importer: z.boolean().optional(),
        keybindings: z.array(keybindingSchema).max(50).optional(),
        ruleActions: z
          .array(
            z.object({
              id: z.string().min(1).max(80),
              label: z.string().min(1).max(80),
              description: z.string().max(300),
            }),
          )
          .max(20)
          .optional(),
        commands: z
          .array(
            z.object({
              id: z.string().min(1).max(120),
              label: z.string().min(1).max(80),
              description: z.string().max(300).optional(),
              menu: z.enum(MENU_REGIONS).optional(),
              when: z.string().max(200).optional(),
              requires: z.enum(PERMISSIONS).optional(),
              defaultKeybinding: keybindingSchema.optional(),
            }),
          )
          .max(50)
          .optional(),
        ribbon: ribbonSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ManifestParseResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; error: string };

export function parseManifest(raw: unknown): ManifestParseResult {
  const result = manifestSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.join('.') ?? 'manifest';
    return { ok: false, error: `${where}: ${issue?.message ?? '校验失败'}` };
  }
  const manifest = result.data as PluginManifest;

  // 跨字段校验：ribbon 工具必须指向本插件已声明的命令，且目标标签必须真实存在。
  // 少了这一步，插件可以挂一个点了没反应的按钮，或把按钮塞进不存在的标签。
  const ribbon = manifest.contributes?.ribbon;
  if (ribbon) {
    const declaredTabs = new Set((ribbon.tabs ?? []).map((tab) => tab.id));
    const builtinTabs = new Set<string>(RIBBON_BUILTIN_TAB_IDS);
    const commandIds = new Set((manifest.contributes?.commands ?? []).map((command) => command.id));
    const seen = new Set<string>();
    for (const tool of ribbon.tools ?? []) {
      if (!commandIds.has(tool.command)) {
        return {
          ok: false,
          error: `contributes.ribbon.tools.${tool.id}: command "${tool.command}" 未在 contributes.commands 中声明`,
        };
      }
      if (!builtinTabs.has(tool.tab) && !declaredTabs.has(tool.tab)) {
        return {
          ok: false,
          error: `contributes.ribbon.tools.${tool.id}: 目标标签 "${tool.tab}" 既不是内置标签，也没有在 contributes.ribbon.tabs 中声明`,
        };
      }
      if (seen.has(tool.id)) {
        return { ok: false, error: `contributes.ribbon.tools: 工具 id "${tool.id}" 重复` };
      }
      seen.add(tool.id);
    }
    const tabIds = new Set<string>();
    for (const tab of ribbon.tabs ?? []) {
      if (tabIds.has(tab.id)) {
        return { ok: false, error: `contributes.ribbon.tabs: 标签 id "${tab.id}" 重复` };
      }
      tabIds.add(tab.id);
    }
  }

  return { ok: true, manifest };
}

export function isApiVersionCompatible(apiVersion: number): boolean {
  return apiVersion === PLUGIN_API_VERSION;
}

/** 插件目录内的安全路径解析，阻止目录穿越。 */
export function resolvePluginAsset(pluginDir: string, relative: string): string | null {
  if (!isSafeRelativePath(relative)) return null;
  const root = path.resolve(pluginDir);
  const target = path.resolve(root, relative);
  const withSeparator = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (target !== root && !target.startsWith(withSeparator)) return null;
  return target;
}
