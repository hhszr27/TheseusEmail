/**
 * 企业代理规则解析（§8.9）。
 * 纯逻辑，便于单元测试；实际 ProxyAgent 装配在 app/proxy.ts。
 */

export type ProxyKind = 'http' | 'https' | 'socks4' | 'socks5';

export interface ParsedProxy {
  kind: ProxyKind;
  host: string;
  port: number;
}

const KIND_MAP: Record<string, ProxyKind> = {
  PROXY: 'http',
  HTTP: 'http',
  HTTPS: 'https',
  SOCKS: 'socks5',
  SOCKS4: 'socks4',
  SOCKS5: 'socks5',
};

/**
 * 解析 Chromium/Electron resolveProxy 或环境变量形式的代理规则。
 * 例："PROXY 10.0.0.1:8080; DIRECT" / "SOCKS5 127.0.0.1:1080" / "DIRECT"
 */
export function parseProxyRules(rules: string | null | undefined): ParsedProxy | null {
  if (!rules) return null;
  for (const rawEntry of rules.split(';')) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    if (/^DIRECT$/i.test(entry)) continue;

    const match = /^([A-Z0-9]+)\s+(.+)$/i.exec(entry);
    if (!match) continue;
    const kindToken = (match[1] ?? '').toUpperCase();
    const kind = KIND_MAP[kindToken];
    if (!kind) continue;

    let hostPort = (match[2] ?? '').trim();
    // 允许 "host:port" 与 "[::1]:8080"
    const portMatch = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(hostPort);
    if (!portMatch) continue;
    const host = (portMatch[1] ?? '').replace(/^\[|\]$/g, '');
    const port = Number(portMatch[2]);
    if (!host || !Number.isFinite(port) || port <= 0 || port > 65535) continue;

    return { kind, host, port };
  }
  return null;
}

export function proxyToUri(proxy: ParsedProxy): string {
  const authority = proxy.host.includes(':') ? `[${proxy.host}]` : proxy.host;
  return `${proxy.kind}://${authority}:${proxy.port}`;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    value = (value << 8) + n;
  }
  return value >>> 0;
}

function inIpv4Range(ipInt: number, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split('/');
  const baseInt = ipv4ToInt(base ?? '');
  if (baseInt === null) return false;
  const bits = Number(bitsRaw ?? '32');
  if (!Number.isFinite(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

const PRIVATE_V4 = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '0.0.0.0/8',
  '100.64.0.0/10',
];

/** 私网/本机地址：直连，不走代理。 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.internal')) return true;

  const v4 = ipv4ToInt(host);
  if (v4 !== null) {
    return PRIVATE_V4.some((cidr) => inIpv4Range(v4, cidr));
  }

  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return true; // fc00::/7
    if (/^fe[89ab][0-9a-f]:/.test(host)) return true; // fe80::/10
    if (host.startsWith('::ffff:')) {
      const mapped = host.slice('::ffff:'.length);
      const mappedInt = ipv4ToInt(mapped);
      if (mappedInt !== null) return PRIVATE_V4.some((cidr) => inIpv4Range(mappedInt, cidr));
    }
  }

  return false;
}

/** NO_PROXY 匹配：精确、后缀（.example.com）、通配 *。 */
export function matchesNoProxy(hostname: string, noProxy: string | undefined): boolean {
  if (!noProxy) return false;
  const host = hostname.trim().toLowerCase();
  for (const raw of noProxy.split(/[,;]/)) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === '*') return true;
    const withoutPort = entry.replace(/:\d+$/, '');
    if (host === withoutPort) return true;
    if (withoutPort.startsWith('.') && host.endsWith(withoutPort)) return true;
    if (host.endsWith(`.${withoutPort}`)) return true;
  }
  return false;
}

/** 从环境变量读取代理 URI（含认证信息时保留在 URI 内，不写日志）。 */
export function proxyFromEnv(env: NodeJS.ProcessEnv): string | null {
  const candidates = [
    env.HTTPS_PROXY,
    env.https_proxy,
    env.HTTP_PROXY,
    env.http_proxy,
    env.ALL_PROXY,
    env.all_proxy,
  ];
  for (const candidate of candidates) {
    if (candidate && candidate.trim()) return candidate.trim();
  }
  return null;
}
