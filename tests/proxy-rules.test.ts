import { describe, expect, it } from 'vitest';
import {
  isPrivateHost,
  matchesNoProxy,
  parseProxyRules,
  proxyFromEnv,
  proxyToUri,
} from '../src/main/app/proxy-rules';

describe('代理规则解析（§8.9）', () => {
  it('解析 PROXY / HTTPS / SOCKS5', () => {
    expect(parseProxyRules('PROXY 10.0.0.1:8080; DIRECT')).toEqual({
      kind: 'http',
      host: '10.0.0.1',
      port: 8080,
    });
    expect(parseProxyRules('HTTPS proxy.example.com:443')).toEqual({
      kind: 'https',
      host: 'proxy.example.com',
      port: 443,
    });
    expect(parseProxyRules('SOCKS5 [::1]:1080')).toEqual({
      kind: 'socks5',
      host: '::1',
      port: 1080,
    });
  });

  it('DIRECT 或无效规则返回 null', () => {
    expect(parseProxyRules('DIRECT')).toBeNull();
    expect(parseProxyRules('')).toBeNull();
    expect(parseProxyRules(null)).toBeNull();
    expect(parseProxyRules('PROXY nonsense')).toBeNull();
  });

  it('生成 undici 可用的代理 URI', () => {
    expect(proxyToUri({ kind: 'http', host: '10.0.0.1', port: 8080 })).toBe('http://10.0.0.1:8080');
    expect(proxyToUri({ kind: 'socks5', host: '::1', port: 1080 })).toBe('socks5://[::1]:1080');
  });

  it('私网地址识别', () => {
    expect(isPrivateHost('localhost')).toBe(true);
    expect(isPrivateHost('10.1.2.3')).toBe(true);
    expect(isPrivateHost('172.16.0.1')).toBe(true);
    expect(isPrivateHost('172.32.0.1')).toBe(false);
    expect(isPrivateHost('192.168.1.10')).toBe(true);
    expect(isPrivateHost('127.0.0.1')).toBe(true);
    expect(isPrivateHost('169.254.1.1')).toBe(true);
    expect(isPrivateHost('8.8.8.8')).toBe(false);
    expect(isPrivateHost('example.com')).toBe(false);
    expect(isPrivateHost('::1')).toBe(true);
    expect(isPrivateHost('fe80::1')).toBe(true);
    expect(isPrivateHost('fd00::1')).toBe(true);
  });

  it('NO_PROXY 后缀与通配匹配', () => {
    expect(matchesNoProxy('mail.corp.example', '.corp.example')).toBe(true);
    expect(matchesNoProxy('corp.example', 'corp.example')).toBe(true);
    expect(matchesNoProxy('example.com', '*')).toBe(true);
    expect(matchesNoProxy('example.com', 'other.com')).toBe(false);
  });

  it('环境变量优先级', () => {
    expect(proxyFromEnv({ HTTPS_PROXY: 'http://a:1', HTTP_PROXY: 'http://b:2' })).toBe('http://a:1');
    expect(proxyFromEnv({ ALL_PROXY: 'socks5://c:1080' })).toBe('socks5://c:1080');
    expect(proxyFromEnv({})).toBeNull();
  });
});
