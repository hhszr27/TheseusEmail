import { app, safeStorage } from 'electron';
import { randomBytes } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { log } from '../observability/logger';
import { writeFileAtomic } from '../security/atomic-file';
import { preservedIdentityFields } from '../p2p/client-id';
import {
  isMasterPayload,
  unwrapDbKey,
  wrapDbKey,
  type MasterKeyPayload,
} from './master-password';

/**
 * 数据库密钥管线（§6.2 / §6.6）。
 * 32 字节随机密钥 → safeStorage 包装（默认）或主密码包装（可选）→ userData/db-key.json。
 * 密钥绝不写入日志、崩溃报告或渲染进程。
 */

const KEY_FILE = 'db-key.json';

export type KeyProtection = 'safeStorage' | 'plain' | 'master';

export interface DbKey {
  key: Buffer;
  hex: string;
  protection: KeyProtection;
}

interface SafeStoragePayload {
  v: 1;
  protection: 'safeStorage' | 'plain';
  data: string;
  createdAt: number;
}

type KeyFilePayload = SafeStoragePayload | MasterKeyPayload;

export class MasterPasswordRequiredError extends Error {
  constructor() {
    super('需要主密码解锁数据库');
    this.name = 'MasterPasswordRequiredError';
  }
}

export function keyFilePath(): string {
  return path.join(app.getPath('userData'), KEY_FILE);
}

function readPayload(raw: string): KeyFilePayload | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isMasterPayload(parsed)) return parsed;
    const record = parsed as Partial<SafeStoragePayload>;
    if (record.v !== 1 || typeof record.data !== 'string') return null;
    if (record.protection !== 'safeStorage' && record.protection !== 'plain') return null;
    return record as SafeStoragePayload;
  } catch {
    return null;
  }
}

function readPayloadSync(): KeyFilePayload | null {
  try {
    return readPayload(readFileSync(keyFilePath(), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * db-key.json 同时保存 P2P clientId（§24.1.1：与数据库密钥同一配置文件）。
 * 重写密钥载荷时必须带上这些字段，否则启用/关闭主密码会把客户端身份抹掉。
 */
function withPreservedFields<T extends object>(payload: T): Record<string, unknown> {
  const identity = preservedIdentityFields(keyFilePath());
  return { ...(payload as Record<string, unknown>), ...identity };
}

export function masterPasswordEnabled(): boolean {
  return isMasterPayload(readPayloadSync());
}

/** 只校验密码，不返回密钥（供解锁界面使用）。 */
export function verifyMasterPassword(password: string): boolean {
  const payload = readPayloadSync();
  if (!isMasterPayload(payload)) return false;
  try {
    const hex = unwrapDbKey(payload, password);
    return /^[0-9a-f]{64}$/i.test(hex);
  } catch {
    return false;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Windows 上 Chromium 的 OSCrypt 密钥存放在 userData/Local State，
 * safeStorage.encryptString 首次调用时该文件可能尚未落盘。
 */
async function waitForOsCryptPersistence(timeoutMs = 5000): Promise<boolean> {
  if (process.platform !== 'win32') return true;
  const localState = path.join(app.getPath('userData'), 'Local State');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fileExists(localState)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

async function writeSafeStoragePayload(keyHex: string): Promise<SafeStoragePayload> {
  const available = safeStorage.isEncryptionAvailable();
  const payload: SafeStoragePayload = {
    v: 1,
    protection: available ? 'safeStorage' : 'plain',
    data: available
      ? safeStorage.encryptString(keyHex).toString('base64')
      : Buffer.from(keyHex, 'hex').toString('base64'),
    createdAt: Date.now(),
  };
  await fs.mkdir(path.dirname(keyFilePath()), { recursive: true });
  // 原子写：先临时文件再 rename。直写会在崩溃窗口期留下空/半截密钥文件，
  // 那种文件既解不开库也没法自动恢复。
  await writeFileAtomic(keyFilePath(), JSON.stringify(withPreservedFields(payload)));

  if (available) {
    const persisted = await waitForOsCryptPersistence();
    if (!persisted) {
      log.warn('key-manager', '未在预期时间内观察到 OSCrypt 密钥落盘；首次启动后请避免强制结束进程');
    }
  } else {
    log.warn('key-manager', 'safeStorage 不可用，数据库密钥以 base64 明文保存；建议安装 libsecret/gnome-keyring');
  }
  return payload;
}

export async function loadOrCreateDbKey(options: { masterPassword?: string } = {}): Promise<DbKey> {
  const filePath = keyFilePath();
  const available = safeStorage.isEncryptionAvailable();

  if (await fileExists(filePath)) {
    const raw = await fs.readFile(filePath, 'utf8');
    const payload = readPayload(raw);
    if (!payload) {
      throw new Error('数据库密钥文件损坏，无法解密本地数据');
    }

    if (isMasterPayload(payload)) {
      if (!options.masterPassword) throw new MasterPasswordRequiredError();
      const hex = unwrapDbKey(payload, options.masterPassword);
      const key = Buffer.from(hex, 'hex');
      if (key.length !== 32) throw new Error('数据库密钥长度非法');
      return { key, hex, protection: 'master' };
    }

    if (payload.protection === 'safeStorage') {
      if (!available) {
        throw new Error('系统安全存储不可用，无法解开数据库密钥');
      }
      const hex = safeStorage.decryptString(Buffer.from(payload.data, 'base64'));
      const key = Buffer.from(hex, 'hex');
      if (key.length !== 32) throw new Error('数据库密钥长度非法');
      return { key, hex, protection: 'safeStorage' };
    }

    const key = Buffer.from(payload.data, 'base64');
    if (key.length !== 32) throw new Error('数据库密钥长度非法');
    log.warn('key-manager', '数据库密钥以弱保护方式存储（safeStorage 不可用）');
    return { key, hex: key.toString('hex'), protection: 'plain' };
  }

  const key = randomBytes(32);
  const payload = await writeSafeStoragePayload(key.toString('hex'));
  return {
    key,
    hex: key.toString('hex'),
    protection: payload.protection === 'safeStorage' ? 'safeStorage' : 'plain',
  };
}

/** 启用主密码：把当前数据库密钥用主密码重新包装。 */
export async function enableMasterPassword(password: string): Promise<void> {
  if (masterPasswordEnabled()) throw new Error('主密码已启用');
  const current = await loadOrCreateDbKey();
  const payload = wrapDbKey(current.hex, password);
  await fs.mkdir(path.dirname(keyFilePath()), { recursive: true });
  // 原子写：先临时文件再 rename。直写会在崩溃窗口期留下空/半截密钥文件，
  // 那种文件既解不开库也没法自动恢复。
  await writeFileAtomic(keyFilePath(), JSON.stringify(withPreservedFields(payload)));
  log.info('key-manager', '主密码已启用');
}

/** 关闭主密码：校验后恢复 safeStorage 包装。 */
export async function disableMasterPassword(password: string): Promise<void> {
  const payload = readPayloadSync();
  if (!isMasterPayload(payload)) throw new Error('主密码未启用');
  const hex = unwrapDbKey(payload, password);
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('数据库密钥长度非法');
  await writeSafeStoragePayload(hex);
  log.info('key-manager', '主密码已关闭');
}
