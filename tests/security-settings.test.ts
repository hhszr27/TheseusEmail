import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCRYPT,
  deriveMasterKey,
  isMasterPayload,
  unwrapDbKey,
  wrapDbKey,
} from '../src/main/db/master-password';
import { dohSwitches } from '../src/main/app/doh';
import {
  MAX_METADATA_BYTES,
  NOTIFICATION_ENTRY,
  buildGetMetadataCommand,
  buildSetMetadataCommand,
  parseMetadataValue,
  quoteImap,
  supportsMetadata,
} from '../src/main/mail/imap-metadata';

const KEY_HEX = 'ab'.repeat(32);

describe('主密码包装（§6.6）', () => {
  it('wrap → unwrap 往返一致', () => {
    const payload = wrapDbKey(KEY_HEX, 'correct horse battery staple');
    expect(isMasterPayload(payload)).toBe(true);
    expect(unwrapDbKey(payload, 'correct horse battery staple')).toBe(KEY_HEX);
  });

  it('错误密码无法解开', () => {
    const payload = wrapDbKey(KEY_HEX, 'right-password');
    expect(() => unwrapDbKey(payload, 'wrong-password')).toThrow('主密码不正确');
  });

  it('密文被篡改时完整性校验失败', () => {
    const payload = wrapDbKey(KEY_HEX, 'password-123');
    const tampered = {
      ...payload,
      wrapped: Buffer.from('tampered').toString('base64'),
    };
    expect(() => unwrapDbKey(tampered, 'password-123')).toThrow('主密码不正确');
  });

  it('短密码被拒绝', () => {
    expect(() => wrapDbKey(KEY_HEX, 'short')).toThrow('至少需要 8 个字符');
  });

  it('相同密码与盐派生相同密钥，不同盐不同', () => {
    const salt = Buffer.from('0123456789abcdef');
    const a = deriveMasterKey('password-123', salt);
    const b = deriveMasterKey('password-123', salt);
    const c = deriveMasterKey('password-123', Buffer.from('fedcba9876543210'));
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
    expect(a.length).toBe(32);
  });

  it('持久化 scrypt 参数', () => {
    const payload = wrapDbKey(KEY_HEX, 'password-123');
    expect(payload.kdf).toEqual(DEFAULT_SCRYPT);
    expect(payload.kdf.N).toBeGreaterThanOrEqual(16384);
  });
});

describe('DoH 开关（§31.5）', () => {
  it('关闭时不追加任何开关', () => {
    expect(dohSwitches(false)).toEqual([]);
  });

  it('启用时指向指定端点', () => {
    const switches = dohSwitches(true);
    expect(switches).toContainEqual(['enable-features', 'DnsOverHttps']);
    expect(switches).toContainEqual(['dns-over-https-templates', 'https://cloudflare-dns.com/dns-query']);
    expect(switches).toContainEqual(['dns-over-https-mode', 'automatic']);
  });
});

describe('IMAP METADATA 协议（§8.8）', () => {
  it('能力检测忽略大小写', () => {
    expect(supportsMetadata(['IMAP4rev1', 'metadata'])).toBe(true);
    expect(supportsMetadata(['IMAP4rev1', 'IDLE'])).toBe(false);
  });

  it('命令构造正确转义', () => {
    expect(quoteImap('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(() => quoteImap('line\nbreak')).toThrow('非法字符');

    expect(buildGetMetadataCommand('INBOX')).toBe(
      `GETMETADATA "INBOX" (${NOTIFICATION_ENTRY})`,
    );
    expect(buildSetMetadataCommand('INBOX', '{"v":1}')).toContain(
      `SETMETADATA "INBOX" (${NOTIFICATION_ENTRY} "{\\"v\\":1}")`,
    );
  });

  it('超过大小上限被拒绝', () => {
    expect(() => buildSetMetadataCommand('INBOX', 'x'.repeat(MAX_METADATA_BYTES + 1))).toThrow(
      '超过大小上限',
    );
  });

  it('解析 quoted 与 literal 两种响应', () => {
    const quoted = ['* METADATA "INBOX" (/private/mailforge/notification-prefs "{\\"v\\":1}")'];
    expect(parseMetadataValue(quoted)).toBe('{"v":1}');

    const literal = ['* METADATA "INBOX" (/private/mailforge/notification-prefs {11}'];
    expect(parseMetadataValue(literal, [Buffer.from('{"v":1,"a":1}', 'utf8')])).toBe('{"v":1,"a":1}');

    expect(parseMetadataValue(['* OK done'])).toBeNull();
  });
});
