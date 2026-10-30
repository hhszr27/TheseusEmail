import { domainToASCII, domainToUnicode } from 'node:url';

/**
 * 外链策略（§10.1 / §6.2 等价条款）：
 *  - 只用 URL 构造函数解析，解析失败即拒绝
 *  - 协议白名单：http / https / mailto
 *  - 剥离 http(s) URL 中的用户名密码，避免钓鱼与日志泄露
 *  - IDN 同形字需要以 punycode 形式让用户确认
 */

export type UrlRejectCode = 'empty' | 'invalid' | 'protocol' | 'host';

export type UrlValidation =
  | { ok: true; url: URL; isIdn: boolean; displayHost: string }
  | { ok: false; code: UrlRejectCode; message: string };

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

export function validateExternalUrl(raw: string): UrlValidation {
  const input = (raw ?? '').trim();
  if (!input) {
    return { ok: false, code: 'empty', message: '空链接' };
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, code: 'invalid', message: '无法解析的链接' };
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol.toLowerCase())) {
    return { ok: false, code: 'protocol', message: `不支持的协议 ${url.protocol}` };
  }

  if (url.protocol === 'http:' || url.protocol === 'https:') {
    if (!url.hostname) {
      return { ok: false, code: 'host', message: '链接缺少主机名' };
    }
    if (url.username || url.password) {
      url.username = '';
      url.password = '';
    }
  }

  return {
    ok: true,
    url,
    isIdn: isIdnHost(url.hostname),
    displayHost: toAsciiHost(url.hostname),
  };
}

/** 是否包含 punycode 标签或非 ASCII 字符（同形字风险）。 */
export function isIdnHost(hostname: string): boolean {
  if (!hostname) return false;
  const lower = hostname.toLowerCase();
  if (lower.startsWith('[')) return false; // IPv6 字面量
  if (/[^\x00-\x7f]/.test(lower)) return true;
  return lower.split('.').some((label) => label.startsWith('xn--'));
}

/** 统一转为 ASCII/punycode 形式，供确认弹窗原样展示。 */
export function toAsciiHost(hostname: string): string {
  if (!hostname) return '';
  try {
    return domainToASCII(hostname) || hostname;
  } catch {
    return hostname;
  }
}

/** 用于展示的 Unicode 形式（仅在确认文本中作为辅助说明）。 */
export function toUnicodeHost(hostname: string): string {
  if (!hostname) return '';
  try {
    return domainToUnicode(hostname) || hostname;
  } catch {
    return hostname;
  }
}
