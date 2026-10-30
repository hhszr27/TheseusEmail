import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCRYPT,
  deriveMasterKey,
  isMasterPayload,
  safeEqualHex,
  unwrapDbKey,
  wrapDbKey,
} from '../src/main/db/master-password';

describe('wrapDbKey / unwrapDbKey 往返（§6.6）', () => {
  it('正确密码能解回原 db key，且 payload 形态符合契约', () => {
    const keyHex = 'a'.repeat(64);
    const payload = wrapDbKey(keyHex, 'super-secret');
    expect(payload.v).toBe(2);
    expect(payload.protection).toBe('master');
    expect(payload.kdf).toEqual(DEFAULT_SCRYPT);
    expect(unwrapDbKey(payload, 'super-secret')).toBe(keyHex);
  });

  it('每次 wrap 都用新盐/IV（密文不重复），但都能解回', () => {
    const keyHex = 'b'.repeat(64);
    const a = wrapDbKey(keyHex, 'pw123456');
    const b = wrapDbKey(keyHex, 'pw123456');
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.wrapped).not.toBe(b.wrapped);
    expect(unwrapDbKey(a, 'pw123456')).toBe(keyHex);
    expect(unwrapDbKey(b, 'pw123456')).toBe(keyHex);
  });

  it('错误密码一律得到「主密码不正确」，绝不泄露原始异常', () => {
    const payload = wrapDbKey('c'.repeat(64), 'right-password');
    expect(() => unwrapDbKey(payload, 'wrong-password')).toThrow('主密码不正确');
  });

  it('NFKC 归一化：全角密码与半角等价', () => {
    const keyHex = 'd'.repeat(64);
    const payload = wrapDbKey(keyHex, 'ｐａｓｓｗｏｒｄ'); // 全角，长度 8
    expect(unwrapDbKey(payload, 'password')).toBe(keyHex);
    expect(unwrapDbKey(payload, 'ｐａｓｓｗｏｒｄ')).toBe(keyHex);
  });
});

describe('wrapDbKey 校验（§36 弱口令拦截）', () => {
  const keyHex = 'e'.repeat(64);
  it('空密码被拒', () => {
    expect(() => wrapDbKey(keyHex, '')).toThrow('主密码至少需要 8 个字符');
  });
  it('7 位密码被拒', () => {
    expect(() => wrapDbKey(keyHex, '1234567')).toThrow('主密码至少需要 8 个字符');
  });
  it('8 位密码放行', () => {
    expect(wrapDbKey(keyHex, '12345678').protection).toBe('master');
  });
});

describe('isMasterPayload（脏数据 / 形态校验）', () => {
  it('真实 payload 被识别', () => {
    const payload = wrapDbKey('f'.repeat(64), 'abcdefgh');
    expect(isMasterPayload(payload)).toBe(true);
  });
  it('null / 非对象 / 串 / 数字被拒', () => {
    expect(isMasterPayload(null)).toBe(false);
    expect(isMasterPayload('x')).toBe(false);
    expect(isMasterPayload(5)).toBe(false);
    expect(isMasterPayload({})).toBe(false);
  });
  it('缺字段 / 字段类型错被拒', () => {
    expect(isMasterPayload({ v: 2, protection: 'master' })).toBe(false);
    expect(
      isMasterPayload({
        v: 2,
        protection: 'master',
        salt: 1,
        iv: '',
        tag: '',
        wrapped: '',
        kdf: DEFAULT_SCRYPT,
      }),
    ).toBe(false);
  });
  it('kdf 缺数字字段（形态损坏）被拒，而不是放行后崩溃', () => {
    const badKdf = { ...wrapDbKey('g'.repeat(64), 'abcdefgh'), kdf: {} as never };
    expect(isMasterPayload(badKdf)).toBe(false);
  });
  it('即便绕过 isMasterPayload 强行解包，坏 kdf 也得到「主密码不正确」而非崩溃', () => {
    const payload = wrapDbKey('h'.repeat(64), 'abcdefgh') as unknown as Record<string, unknown>;
    payload.kdf = {};
    expect(() => unwrapDbKey(payload as never, 'abcdefgh')).toThrow('主密码不正确');
  });
});

describe('safeEqualHex（恒定时间比较）', () => {
  it('相同内容（含空串）返回 true', () => {
    expect(safeEqualHex('abcd', 'abcd')).toBe(true);
    expect(safeEqualHex('', '')).toBe(true);
  });
  it('内容不同（等长）返回 false', () => {
    expect(safeEqualHex('abcd', 'abce')).toBe(false);
  });
  it('长度不同返回 false', () => {
    expect(safeEqualHex('abcd', 'abc')).toBe(false);
  });
});

describe('deriveMasterKey', () => {
  it('相同口令+盐得到相同密钥；不同盐得到不同密钥', () => {
    const salt = Buffer.from('0123456789abcdef', 'hex');
    const k1 = deriveMasterKey('pw', salt).toString('hex');
    const k2 = deriveMasterKey('pw', salt).toString('hex');
    const k3 = deriveMasterKey('pw', Buffer.from('fedcba9876543210', 'hex')).toString('hex');
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
  });
  it('导出密钥长度等于 keylen', () => {
    expect(deriveMasterKey('pw', Buffer.alloc(16)).length).toBe(DEFAULT_SCRYPT.keylen);
  });
});
