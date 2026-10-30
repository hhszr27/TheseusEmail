import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { log } from '../observability/logger';

/**
 * 「程序运行唯一性」开关。
 *
 * 必须在 `app.whenReady()` 之前就能读到（单实例锁是启动最早期做的决定），
 * 所以存在 userData 下的一个小 JSON，而不是加密库里——那时库还没打开。
 * 缺省 true：第二次启动会切回已打开的窗口。
 */
const FILE_NAME = 'instance-mode.json';

function filePath(): string {
  return path.join(app.getPath('userData'), FILE_NAME);
}

export function readSingleInstanceMode(): boolean {
  try {
    const raw = fs.readFileSync(filePath(), 'utf8');
    const parsed = JSON.parse(raw) as { singleInstance?: unknown };
    // 只有显式写成 false 才允许多开；文件损坏/缺失都按单实例处理
    return parsed.singleInstance !== false;
  } catch {
    return true;
  }
}

export function writeSingleInstanceMode(singleInstance: boolean): void {
  try {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), JSON.stringify({ singleInstance }, null, 2), 'utf8');
  } catch (error) {
    log.warn('instance-mode', '写入单实例开关失败', { message: (error as Error).message });
  }
}
