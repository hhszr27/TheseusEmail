import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 结构化日志（§25.2）。
 *  - 主进程 JSON Lines，按天滚动，保留 7 天
 *  - 所有字段先经过脱敏（凭据 / 令牌 / 密码）
 *  - 最近 200 行保留在内存环形缓冲，供恢复页面与崩溃报告使用
 *  - 日志绝不写入邮件正文、附件内容
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  module: string;
  msg: string;
  data?: unknown;
}

const SENSITIVE_KEY =
  /(pass(word)?|secret|token|api[_-]?key|apikey|authorization|cookie|credential|refresh|client[_-]?secret|private[_-]?key)/i;

const MAX_STRING = 4000;
const RING_SIZE = 200;
const RETENTION_DAYS = 7;

const ring: string[] = [];
let stream: fs.WriteStream | null = null;
let currentDay = '';
let logDir = '';

export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > 5) return '[depth-limit]';

  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated]` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redact(item, depth + 1));
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(key)) {
        result[key] = '[redacted]';
      } else {
        result[key] = redact(val, depth + 1);
      }
    }
    return result;
  }
  return String(value);
}

function dayString(date = new Date()): string {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, '0');
  const d = `${date.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function getLogDir(): string {
  if (!logDir) {
    logDir = path.join(app.getPath('userData'), 'logs');
  }
  return logDir;
}

function ensureStream(): fs.WriteStream | null {
  const day = dayString();
  if (stream && currentDay === day) return stream;
  try {
    const dir = getLogDir();
    fs.mkdirSync(dir, { recursive: true });
    stream?.end();
    stream = fs.createWriteStream(path.join(dir, `app-${day}.log`), { flags: 'a' });
    stream.on('error', () => {
      stream = null;
    });
    currentDay = day;
    pruneOldLogs(dir);
    return stream;
  } catch {
    return null;
  }
}

function pruneOldLogs(dir: string): void {
  try {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(dir)) {
      if (!/^app-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
      const filePath = path.join(dir, name);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) fs.unlinkSync(filePath);
    }
  } catch {
    // 清理失败不影响主流程
  }
}

function write(level: LogLevel, module: string, msg: string, data?: unknown): void {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    module,
    msg,
    ...(data === undefined ? {} : { data: redact(data) }),
  };
  let line: string;
  try {
    line = JSON.stringify(entry);
  } catch {
    line = JSON.stringify({ ts: entry.ts, level, module, msg, data: '[unserializable]' });
  }

  ring.push(line);
  if (ring.length > RING_SIZE) ring.shift();

  // Vitest 等非 Electron 环境下 app 可能不可用，此时只保留内存日志
  const electronApp = app as typeof app | undefined;
  const hasApp = Boolean(electronApp && typeof electronApp.getPath === 'function');
  const isDev = !hasApp || !electronApp?.isPackaged;

  if (isDev) {
    // 开发期同时输出到控制台，便于观察
    const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    consoleFn(`[${level}] ${module}: ${msg}`, data ?? '');
  }

  if (!hasApp) return;

  const target = ensureStream();
  target?.write(`${line}\n`);
}

export const log = {
  debug: (module: string, msg: string, data?: unknown) => write('debug', module, msg, data),
  info: (module: string, msg: string, data?: unknown) => write('info', module, msg, data),
  warn: (module: string, msg: string, data?: unknown) => write('warn', module, msg, data),
  error: (module: string, msg: string, data?: unknown) => write('error', module, msg, data),
};

export function getRecentLogs(limit = 80): string[] {
  return ring.slice(-limit);
}

export function closeLogger(): void {
  stream?.end();
  stream = null;
}
