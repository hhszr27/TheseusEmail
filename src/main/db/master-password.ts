import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * 可选主密码（§6.6）：
 * 数据库密钥再用主密码派生密钥包装一层（scrypt + AES-256-GCM）。
 * 默认关闭；关闭时恢复 safeStorage 包装。
 */

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
  keylen: number;
}

export const DEFAULT_SCRYPT: ScryptParams = { N: 16384, r: 8, p: 1, keylen: 32 };

export interface MasterKeyPayload {
  v: 2;
  protection: 'master';
  salt: string;
  iv: string;
  tag: string;
  wrapped: string;
  kdf: ScryptParams;
  createdAt: number;
}

export function deriveMasterKey(
  password: string,
  salt: Buffer,
  params: ScryptParams = DEFAULT_SCRYPT,
): Buffer {
  return scryptSync(password.normalize('NFKC'), salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 128 * 1024 * 1024,
  });
}

export function wrapDbKey(
  keyHex: string,
  password: string,
  params: ScryptParams = DEFAULT_SCRYPT,
  now = Date.now(),
): MasterKeyPayload {
  if (!password || password.length < 8) {
    throw new Error('主密码至少需要 8 个字符');
  }
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const derived = deriveMasterKey(password, salt, params);
  const cipher = createCipheriv('aes-256-gcm', derived, iv);
  const encrypted = Buffer.concat([cipher.update(keyHex, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    v: 2,
    protection: 'master',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    wrapped: encrypted.toString('base64'),
    kdf: params,
    createdAt: now,
  };
}

export function unwrapDbKey(payload: MasterKeyPayload, password: string): string {
  try {
    const salt = Buffer.from(payload.salt, 'base64');
    const iv = Buffer.from(payload.iv, 'base64');
    const tag = Buffer.from(payload.tag, 'base64');
    const wrapped = Buffer.from(payload.wrapped, 'base64');
    const derived = deriveMasterKey(password, salt, payload.kdf);
    const decipher = createDecipheriv('aes-256-gcm', derived, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(wrapped), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    throw new Error('主密码不正确');
  }
}

export function isMasterPayload(value: unknown): value is MasterKeyPayload {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<MasterKeyPayload>;
  const kdf = record.kdf as Partial<ScryptParams> | undefined;
  return (
    record.v === 2 &&
    record.protection === 'master' &&
    typeof record.salt === 'string' &&
    typeof record.iv === 'string' &&
    typeof record.tag === 'string' &&
    typeof record.wrapped === 'string' &&
    Boolean(kdf) &&
    typeof kdf!.N === 'number' &&
    typeof kdf!.r === 'number' &&
    typeof kdf!.p === 'number' &&
    typeof kdf!.keylen === 'number'
  );
}

/** 恒定时间比较，避免通过错误信息差异推断密码。 */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}
