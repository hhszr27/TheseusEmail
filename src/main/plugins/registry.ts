import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PluginManifest } from '../../shared/types';
import type { PluginSignatureStatus, PluginSource, PluginStatus } from '../../shared/plugin';
import { isApiVersionCompatible, parseManifest } from './manifest';
import { verifyManifestSignature } from './signature';

/**
 * 插件注册表扫描与加载（§13.1、§13.2、§13.9）。
 *
 * - manifest.json 必须存在且通过 Zod 校验
 * - 签名无效 / API 不兼容 / 资源缺失 → 不加载
 * - 单插件加载超时（默认 5s）→ 标记 timeout，继续加载其它插件
 * - 并发上限默认 4，避免慢插件拖慢启动
 */

export interface LoadedPlugin {
  manifest: PluginManifest;
  dir: string;
  source: PluginSource;
  signature: PluginSignatureStatus;
  status: PluginStatus;
  enabled: boolean;
  error?: string;
}

export interface PluginDirectory {
  path: string;
  source: PluginSource;
}

export interface PluginLoadOptions {
  dirs: PluginDirectory[];
  publicKeys?: Record<string, string>;
  disabledIds?: string[];
  timeoutMs?: number;
  concurrency?: number;
  readText?: (filePath: string) => Promise<string>;
  exists?: (filePath: string) => Promise<boolean>;
  onWarning?: (message: string) => void;
}

export interface PluginLoadResult {
  plugins: LoadedPlugin[];
  warnings: string[];
}

async function defaultReadText(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf8');
}

async function defaultExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function collectAssets(manifest: PluginManifest): string[] {
  const contributes = manifest.contributes;
  if (!contributes) return [];
  const assets: string[] = [];
  if (contributes.theme) assets.push(contributes.theme);
  if (contributes.readerView) assets.push(contributes.readerView);
  if (contributes.composeView) assets.push(contributes.composeView);
  if (contributes.views) assets.push(...Object.values(contributes.views));
  if (contributes.icons) assets.push(...Object.values(contributes.icons));
  return assets;
}

async function loadOne(
  directory: PluginDirectory,
  options: PluginLoadOptions,
  warning: (message: string) => void,
): Promise<LoadedPlugin | null> {
  const readText = options.readText ?? defaultReadText;
  const exists = options.exists ?? defaultExists;
  const manifestPath = path.join(directory.path, 'manifest.json');

  let raw: string;
  try {
    raw = await readText(manifestPath);
  } catch {
    warning(`${directory.path} 缺少 manifest.json，已跳过`);
    return null;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    return {
      manifest: { id: path.basename(directory.path), name: path.basename(directory.path), version: '0.0.0', apiVersion: 0 },
      dir: directory.path,
      source: directory.source,
      signature: 'unsigned',
      status: 'invalid',
      enabled: false,
      error: `manifest.json 不是合法 JSON：${(error as Error).message}`,
    };
  }

  const parsed = parseManifest(json);
  if (!parsed.ok) {
    return {
      manifest: {
        id: path.basename(directory.path),
        name: path.basename(directory.path),
        version: '0.0.0',
        apiVersion: 0,
      },
      dir: directory.path,
      source: directory.source,
      signature: 'unsigned',
      status: 'invalid',
      enabled: false,
      error: parsed.error,
    };
  }

  const manifest = parsed.manifest;

  if (!isApiVersionCompatible(manifest.apiVersion)) {
    return {
      manifest,
      dir: directory.path,
      source: directory.source,
      signature: 'unsigned',
      status: 'incompatible',
      enabled: false,
      error: `apiVersion ${manifest.apiVersion} 与宿主不兼容`,
    };
  }

  let signatureBase64: string | null = null;
  const signaturePath = path.join(directory.path, 'manifest.sig');
  if (await exists(signaturePath)) {
    try {
      signatureBase64 = (await readText(signaturePath)).trim();
    } catch {
      signatureBase64 = null;
    }
  }

  const verification = verifyManifestSignature(
    json as Record<string, unknown>,
    signatureBase64,
    options.publicKeys?.[manifest.id] ?? null,
  );

  if (verification.status === 'invalid') {
    return {
      manifest,
      dir: directory.path,
      source: directory.source,
      signature: 'invalid',
      status: 'invalid',
      enabled: false,
      error: `签名验证失败：${verification.reason ?? '未知原因'}`,
    };
  }

  for (const asset of collectAssets(manifest)) {
    if (!(await exists(path.join(directory.path, asset)))) {
      return {
        manifest,
        dir: directory.path,
        source: directory.source,
        signature: verification.status,
        status: 'invalid',
        enabled: false,
        error: `引用的资源不存在：${asset}`,
      };
    }
  }

  if (verification.status === 'unsigned') {
    warning(`插件 ${manifest.id} 未签名（来源未知），已按受限权限加载`);
  }

  return {
    manifest,
    dir: directory.path,
    source: directory.source,
    signature: verification.status,
    status: 'ready',
    enabled:
      manifest.defaultEnabled !== false && !(options.disabledIds ?? []).includes(manifest.id),
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | 'timeout'> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function listPluginDirectories(root: string, source: PluginSource): Promise<PluginDirectory[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => ({ path: path.join(root, entry.name), source }));
  } catch {
    return [];
  }
}

export async function loadPlugins(options: PluginLoadOptions): Promise<PluginLoadResult> {
  const warnings: string[] = [];
  const warning = (message: string): void => {
    warnings.push(message);
    options.onWarning?.(message);
  };

  const timeoutMs = options.timeoutMs ?? 5000;
  const concurrency = Math.max(1, options.concurrency ?? 4);

  const directories: PluginDirectory[] = [];
  for (const dir of options.dirs) {
    if (!dir.path) continue;
    directories.push(...(await listPluginDirectories(dir.path, dir.source)));
  }

  const plugins: LoadedPlugin[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < directories.length; index += concurrency) {
    const batch = directories.slice(index, index + concurrency);
    const results = await Promise.all(
      batch.map(async (directory) => {
        const result = await withTimeout(loadOne(directory, options, warning), timeoutMs);
        if (result === 'timeout') {
          return {
            manifest: {
              id: path.basename(directory.path),
              name: path.basename(directory.path),
              version: '0.0.0',
              apiVersion: 0,
            },
            dir: directory.path,
            source: directory.source,
            signature: 'unsigned',
            status: 'timeout',
            enabled: false,
            error: `初始化超时（>${timeoutMs} ms），已禁用`,
          } satisfies LoadedPlugin;
        }
        return result;
      }),
    );

    for (const plugin of results) {
      if (!plugin) continue;
      if (seen.has(plugin.manifest.id)) {
        warning(`重复的插件 id：${plugin.manifest.id}（${plugin.dir}），已忽略后者`);
        continue;
      }
      seen.add(plugin.manifest.id);
      plugins.push(plugin);
    }
  }

  plugins.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
  return { plugins, warnings };
}

/** 开发期插件目录（项目根 plugins/）。 */
export function projectPluginDir(appPath: string): string {
  return path.join(appPath, 'plugins');
}
