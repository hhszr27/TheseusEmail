import { describe, expect, it } from 'vitest';
import {
  isIdnHost,
  toAsciiHost,
  validateExternalUrl,
} from '../src/main/security/url-policy';

describe('validateExternalUrl（协议白名单）', () => {
  it('允许 http / https / mailto', () => {
    expect(validateExternalUrl('https://example.com/a?b=1').ok).toBe(true);
    expect(validateExternalUrl('http://example.com').ok).toBe(true);
    expect(validateExternalUrl('mailto:someone@example.com').ok).toBe(true);
  });

  it('拒绝 javascript / file / data 与未知协议', () => {
    for (const url of [
      'javascript:alert(1)',
      'file:///C:/Windows/System32/calc.exe',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'ftp://example.com',
    ]) {
      const result = validateExternalUrl(url);
      expect(result.ok, url).toBe(false);
    }
  });

  it('拒绝无法解析的输入与空串', () => {
    expect(validateExternalUrl('not a url').ok).toBe(false);
    expect(validateExternalUrl('   ').ok).toBe(false);
  });

  it('剥离 URL 中的用户名密码', () => {
    const result = validateExternalUrl('https://user:pass@example.com/path');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url.username).toBe('');
      expect(result.url.password).toBe('');
      expect(result.url.toString()).toBe('https://example.com/path');
    }
  });
});

describe('IDN 同形字检测', () => {
  it('识别 punycode 与非 ASCII 域名', () => {
    expect(isIdnHost('xn--fsqu00a.xn--0zwm56d')).toBe(true);
    expect(isIdnHost('例子.测试')).toBe(true);
    expect(isIdnHost('example.com')).toBe(false);
    expect(isIdnHost('127.0.0.1')).toBe(false);
    expect(isIdnHost('[::1]')).toBe(false);
  });

  it('URL 解析后给出 punycode 形式', () => {
    const result = validateExternalUrl('https://例子.测试/path');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.isIdn).toBe(true);
      expect(result.displayHost).toBe('xn--fsqu00a.xn--0zwm56d');
      expect(result.displayHost).toBe(toAsciiHost(result.url.hostname));
    }
  });
});
