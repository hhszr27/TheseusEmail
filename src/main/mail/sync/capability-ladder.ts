import type { SyncCapabilityLevel } from '../../../shared/types';

/**
 * CONDSTORE/QRESYNC 阶梯降级（§8.3）。
 *
 * 关键规则：
 *  - 只在"方言证据"下降级（响应不可解析、明确的能力拒绝）
 *  - 网络错误、临时性 NO 绝不降级
 *  - 降级决策由调用方持久化到 folder_sync_state.capabilityLevel
 */

export const CAPABILITY_LADDER: readonly SyncCapabilityLevel[] = [
  'L1_CHANGEDSINCE',
  'L2_SEARCH_SINCE',
  'L3_UIDNEXT',
] as const;

export function levelRank(level: SyncCapabilityLevel): number {
  const index = CAPABILITY_LADDER.indexOf(level);
  return index < 0 ? 0 : index;
}

export function nextLevel(level: SyncCapabilityLevel): SyncCapabilityLevel | null {
  const index = CAPABILITY_LADDER.indexOf(level);
  if (index < 0 || index >= CAPABILITY_LADDER.length - 1) return null;
  return CAPABILITY_LADDER[index + 1] ?? null;
}

export function initialLevel(capabilities: Set<string> | string[]): SyncCapabilityLevel {
  const has = (name: string): boolean =>
    capabilities instanceof Set
      ? capabilities.has(name)
      : capabilities.some((c) => c.toUpperCase() === name.toUpperCase());
  if (has('CONDSTORE') || has('QRESYNC')) return 'L1_CHANGEDSINCE';
  if (has('SEARCH')) return 'L2_SEARCH_SINCE';
  return 'L3_UIDNEXT';
}

export interface ImapFailureLike {
  message?: string;
  code?: string;
  responseStatus?: string;
  responseText?: string;
}

const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ETIMEOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ERR_SOCKET_CLOSED',
  'NoConnection',
]);

const TRANSIENT_PATTERN =
  /(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|EHOSTUNREACH|ENETUNREACH|socket hang up|connection (?:closed|lost|timeout|timed out)|timed out|timeout|getaddrinfo|network|not connected|disconnected|temporar)/i;

const DIALECT_PATTERN =
  /(cannot parse|unparseable|unexpected (?:response|token|data|end)|invalid (?:fetch|response|modseq|uid)|malformed|unsupported|not supported|unknown command|syntax error|extra argument|protocol error|parse error)/i;

const EXPLICIT_NO_PATTERN =
  /(unsupported|not supported|unknown|invalid|parse|syntax|extra argument|bad command)/i;

/** 网络/临时性失败：必须重试，不能降级。 */
export function isTransientFailure(err: ImapFailureLike): boolean {
  if (err.code && TRANSIENT_CODES.has(err.code)) return true;
  const message = `${err.message ?? ''} ${err.responseText ?? ''}`;
  return TRANSIENT_PATTERN.test(message);
}

/**
 * 是否构成"方言证据"从而需要降级。
 * 返回 reason 用于结构化日志 sync.capability_downgrade。
 */
export function shouldDowngrade(err: ImapFailureLike): { downgrade: boolean; reason: string } {
  if (isTransientFailure(err)) {
    return { downgrade: false, reason: 'transient' };
  }

  const status = (err.responseStatus ?? '').toUpperCase();
  if (status === 'BAD') {
    return { downgrade: true, reason: `BAD ${err.responseText ?? err.message ?? ''}`.trim() };
  }

  if (status === 'NO') {
    const text = `${err.responseText ?? ''} ${err.message ?? ''}`;
    if (EXPLICIT_NO_PATTERN.test(text)) {
      return { downgrade: true, reason: `NO ${text}`.trim() };
    }
    return { downgrade: false, reason: 'NO without dialect evidence' };
  }

  const message = `${err.message ?? ''}`;
  if (DIALECT_PATTERN.test(message)) {
    return { downgrade: true, reason: message };
  }

  return { downgrade: false, reason: 'no dialect evidence' };
}

const AUTH_PATTERN = /(auth|login|credential|password|invalid_grant|unauthori[sz]ed)/i;

export function isAuthFailure(err: ImapFailureLike): boolean {
  const status = (err.responseStatus ?? '').toUpperCase();
  const text = `${err.message ?? ''} ${err.responseText ?? ''}`;
  if (/AUTHENTICATIONFAILED|AUTHORIZATIONFAILED/i.test(text)) return true;
  if (status === 'NO' && AUTH_PATTERN.test(text)) return true;
  return AUTH_PATTERN.test(text) && /fail|invalid|denied|expired/i.test(text);
}
