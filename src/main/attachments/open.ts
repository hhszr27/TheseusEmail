import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { shell } from 'electron';
import { markOfTheWebContent, quarantineXattrArgs } from '../../shared/attachments';
import { log } from '../observability/logger';

const execFileAsync = promisify(execFile);

/**
 * 系统默认程序打开（§11.6）。
 * Windows 写 :Zone.Identifier ADS；macOS 写 com.apple.quarantine。
 * 两者都是强制步骤：写入失败时拒绝打开，避免产生“看似受保护”的文件。
 */

export function sanitizeFileName(input: string): string {
  const base = input.replace(/\\/g, '/').split('/').pop() ?? 'attachment';
  const cleaned = base
    .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  const safe = cleaned || 'attachment';
  return safe.length > 120 ? safe.slice(-120) : safe;
}

export function sessionTempDir(): string {
  return path.join(os.tmpdir(), 'MailForge', 'attachments');
}

/** Windows：写入 Zone.Identifier 备用数据流。 */
export async function writeMarkOfTheWeb(filePath: string): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  try {
    await fs.promises.writeFile(`${filePath}:Zone.Identifier`, markOfTheWebContent(), 'utf8');
    return true;
  } catch (error) {
    log.warn('attachment', '写入 Mark-of-the-Web 失败', { message: (error as Error).message });
    return false;
  }
}

export async function readMarkOfTheWeb(filePath: string): Promise<string | null> {
  if (process.platform !== 'win32') return null;
  try {
    return await fs.promises.readFile(`${filePath}:Zone.Identifier`, 'utf8');
  } catch {
    return null;
  }
}

/** macOS：写入隔离属性。 */
export async function applyQuarantine(filePath: string): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  const hex = Math.floor(Date.now() / 1000).toString(16);
  try {
    await execFileAsync('xattr', quarantineXattrArgs(filePath, hex));
    return true;
  } catch (error) {
    log.warn('attachment', '写入 quarantine 属性失败', { message: (error as Error).message });
    return false;
  }
}

/** 把附件复制到会话临时目录，并写入平台标记。返回可交给系统打开的真实路径。 */
export async function stageForExternalOpen(
  sourcePath: string,
  filename: string,
): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  const dir = sessionTempDir();
  await fs.promises.mkdir(dir, { recursive: true });

  const target = path.join(dir, sanitizeFileName(filename));
  try {
    await fs.promises.copyFile(sourcePath, target);
  } catch (error) {
    return { ok: false, reason: `无法写入临时文件：${(error as Error).message}` };
  }

  if (process.platform === 'win32') {
    const marked = await writeMarkOfTheWeb(target);
    if (!marked) {
      await fs.promises.rm(target, { force: true });
      return { ok: false, reason: '无法写入系统的来源标记，已取消打开。' };
    }
  } else if (process.platform === 'darwin') {
    const marked = await applyQuarantine(target);
    if (!marked) {
      await fs.promises.rm(target, { force: true });
      return { ok: false, reason: '无法写入系统的隔离属性，已取消打开。' };
    }
  }

  return { ok: true, path: target };
}

export async function openStagedFile(filePath: string): Promise<string> {
  const error = await shell.openPath(filePath);
  return error;
}

/** 另存为：保留文件名，写入 MotW/Quarantine 后再落盘。 */
export async function saveTo(
  sourcePath: string,
  destination: string,
): Promise<{ ok: boolean; reason?: string }> {
  try {
    await fs.promises.copyFile(sourcePath, destination);
  } catch (error) {
    return { ok: false, reason: `保存失败：${(error as Error).message}` };
  }

  if (process.platform === 'win32') {
    await writeMarkOfTheWeb(destination);
  } else if (process.platform === 'darwin') {
    await applyQuarantine(destination);
  }

  return { ok: true };
}

/** 启动时清理上次会话遗留的临时附件（超过 TTL）。 */
export async function cleanupStaleTempFiles(maxAgeMs: number): Promise<number> {
  const dir = sessionTempDir();
  let removed = 0;
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const filePath = path.join(dir, entry.name);
      try {
        const stat = await fs.promises.stat(filePath);
        if (now - stat.mtimeMs > maxAgeMs) {
          await fs.promises.rm(filePath, { force: true });
          removed += 1;
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // 目录不存在
  }
  return removed;
}
