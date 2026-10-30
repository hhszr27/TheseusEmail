import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { log } from '../observability/logger';

/**
 * 持久化的应用开关。
 * hardwareAcceleration 必须在 app.whenReady() 之前读取，才能在 GPU 连续崩溃后禁用。
 */

export interface AppFlags {
  hardwareAcceleration: boolean;
}

let flags: AppFlags = { hardwareAcceleration: true };

function flagsPath(): string {
  return path.join(app.getPath('userData'), 'app-flags.json');
}

function write(): void {
  try {
    fs.mkdirSync(path.dirname(flagsPath()), { recursive: true });
    fs.writeFileSync(flagsPath(), JSON.stringify(flags, null, 2), 'utf8');
  } catch (error) {
    log.warn('app-flags', '保存应用开关失败', { message: (error as Error).message });
  }
}

export function loadAppFlags(): AppFlags {
  try {
    const raw = fs.readFileSync(flagsPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<AppFlags>;
    flags = { hardwareAcceleration: parsed.hardwareAcceleration !== false };
  } catch {
    flags = { hardwareAcceleration: true };
  }
  return flags;
}

export function getAppFlags(): AppFlags {
  return flags;
}

export function setHardwareAcceleration(enabled: boolean): void {
  flags = { ...flags, hardwareAcceleration: enabled };
  write();
}
