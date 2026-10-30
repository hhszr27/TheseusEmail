import { createVerify, verify as cryptoVerify } from 'node:crypto';

/**
 * 插件签名验证（§30.1）。
 *
 * 签名对象是 manifest 的规范化 JSON（键排序、去除 signature 字段），
 * 独立存放在 manifest.sig（base64 Ed25519 签名）。
 * 这样单独篡改 manifest.permissions 会导致验签失败。
 */

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(',')}}`;
}

export function manifestSigningPayload(manifest: Record<string, unknown>): Buffer {
  const clone = { ...manifest };
  delete clone.signature;
  return Buffer.from(canonicalJson(clone), 'utf8');
}

export interface SignatureVerification {
  status: 'verified' | 'unsigned' | 'invalid';
  reason?: string;
}

export function verifyManifestSignature(
  manifest: Record<string, unknown>,
  signatureBase64: string | null,
  publicKeyPem: string | null,
): SignatureVerification {
  if (!signatureBase64) {
    return { status: 'unsigned' };
  }
  if (!publicKeyPem) {
    return { status: 'invalid', reason: '插件带有签名，但宿主没有对应的公钥' };
  }

  let signature: Buffer;
  try {
    signature = Buffer.from(signatureBase64.trim(), 'base64');
  } catch {
    return { status: 'invalid', reason: '签名不是合法的 base64' };
  }

  try {
    const ok = cryptoVerify(null, manifestSigningPayload(manifest), publicKeyPem, signature);
    return ok ? { status: 'verified' } : { status: 'invalid', reason: '签名与 manifest 不匹配' };
  } catch (error) {
    return { status: 'invalid', reason: (error as Error).message };
  }
}

/** 兼容需要显式指定算法的场景（测试/未来支持 RSA）。 */
export function verifyWithAlgorithm(
  algorithm: string,
  manifest: Record<string, unknown>,
  signatureBase64: string,
  publicKeyPem: string,
): boolean {
  const verifier = createVerify(algorithm);
  verifier.update(manifestSigningPayload(manifest));
  verifier.end();
  return verifier.verify(publicKeyPem, Buffer.from(signatureBase64, 'base64'));
}
