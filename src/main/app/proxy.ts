import { session } from 'electron';
import { Agent, ProxyAgent, fetch as undiciFetch, setGlobalDispatcher } from 'undici';
import type { ProxyStatus } from '../../shared/ipc';
import { log } from '../observability/logger';
import {
  isPrivateHost,
  matchesNoProxy,
  parseProxyRules,
  proxyFromEnv,
  proxyToUri,
} from './proxy-rules';

/**
 * 企业代理（§8.9）：
 *  - 优先 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY
 *  - 否则读系统代理（含 PAC/WPAD）
 *  - 统一用 undici ProxyAgent + setGlobalDispatcher
 *  - 私网地址与 NO_PROXY 直连
 */

let status: ProxyStatus = { enabled: false, source: 'none', bypassPrivate: true };
let proxyDispatcher: ProxyAgent | null = null;
let directDispatcher: Agent | null = null;

function safeUriForLog(uri: string): string {
  try {
    const parsed = new URL(uri);
    return `${parsed.protocol}//${parsed.hostname}:${parsed.port || ''}`.replace(/:$/, '');
  } catch {
    return '[invalid-proxy-uri]';
  }
}

export async function initProxy(): Promise<ProxyStatus> {
  directDispatcher = new Agent({
    connect: { timeout: 15_000 },
  });

  const envProxy = proxyFromEnv(process.env);
  let uri: string | null = null;
  let source: ProxyStatus['source'] = 'none';

  if (envProxy) {
    uri = envProxy;
    source = 'env';
  } else {
    try {
      const rules = await session.defaultSession.resolveProxy('https://mail.google.com');
      const parsed = parseProxyRules(rules);
      if (parsed) {
        uri = proxyToUri(parsed);
        source = 'system';
      }
    } catch (error) {
      log.warn('proxy', '读取系统代理失败', { message: (error as Error).message });
    }
  }

  if (uri) {
    try {
      proxyDispatcher = new ProxyAgent({ uri });
      setGlobalDispatcher(proxyDispatcher);
      status = { enabled: true, source, uri: safeUriForLog(uri), bypassPrivate: true };
      log.info('proxy', '代理已启用', { source, uri: safeUriForLog(uri) });
    } catch (error) {
      proxyDispatcher = null;
      setGlobalDispatcher(directDispatcher);
      status = { enabled: false, source: 'none', bypassPrivate: true };
      log.error('proxy', '代理初始化失败，回退直连', { message: (error as Error).message });
    }
  } else {
    setGlobalDispatcher(directDispatcher);
    status = { enabled: false, source: 'none', bypassPrivate: true };
    log.info('proxy', '未配置代理，使用直连');
  }

  return status;
}

export function getProxyStatus(): ProxyStatus {
  return status;
}

function shouldBypass(hostname: string): boolean {
  if (!proxyDispatcher) return true;
  if (isPrivateHost(hostname)) return true;
  const noProxy = process.env.NO_PROXY ?? process.env.no_proxy;
  if (matchesNoProxy(hostname, noProxy)) return true;
  return false;
}

/** 主进程统一出网入口：自动选择代理/直连。 */
export async function httpFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input.toString();
  let hostname = '';
  try {
    hostname = new URL(url).hostname;
  } catch {
    hostname = '';
  }

  const dispatcher = shouldBypass(hostname) ? directDispatcher : proxyDispatcher;

  return undiciFetch(url, {
    ...(init as Record<string, unknown>),
    ...(dispatcher ? { dispatcher } : {}),
  }) as unknown as Promise<Response>;
}

/** 把 undici/Node 网络错误翻译为可读提示。 */
export function describeFetchError(error: unknown): string {
  const cause = (error as { cause?: { code?: string } })?.cause;
  const code = cause?.code ?? (error as { code?: string })?.code;
  switch (code) {
    case 'ENOTFOUND':
      return '无法解析服务器地址，请检查网络或 DNS 设置';
    case 'ECONNREFUSED':
      return '连接被拒绝，请检查代理或防火墙设置';
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
      return '连接超时，请检查网络或代理配置';
    case 'CERT_HAS_EXPIRED':
      return '服务器证书已过期';
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return '无法验证服务器证书链';
    default:
      return `网络请求失败${code ? `（${code}）` : ''}`;
  }
}
