import type { EmailAddress } from '../../shared/types';

/**
 * compose-view 整体接管（§13.3、§13.4）的草稿上下文与补丁校验。
 *
 * 插件通过 getDraftContext 读、setDraftContent 写；补丁必须经宿主校验后才回填，
 * 插件不能借此写入超长正文或非法地址。
 */

export interface DraftContextSnapshot {
  accountId: string;
  subject: string;
  to: EmailAddress[];
  cc: EmailAddress[];
  body: string;
}

export interface DraftPatch {
  subject?: string;
  to?: EmailAddress[];
  cc?: EmailAddress[];
  body?: string;
}

const MAX_SUBJECT = 998;
const MAX_BODY = 500_000;
const MAX_RECIPIENTS = 100;
const ADDRESS_PATTERN = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

function normalizeAddresses(value: unknown): EmailAddress[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length > MAX_RECIPIENTS) return null;
  const result: EmailAddress[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    const record = item as { address?: unknown; name?: unknown };
    const address = typeof record.address === 'string' ? record.address.trim() : '';
    if (!ADDRESS_PATTERN.test(address)) return null;
    const name = typeof record.name === 'string' ? record.name.trim().slice(0, 120) : '';
    result.push(name ? { name, address } : { address });
  }
  return result;
}

export type DraftPatchResult =
  | { ok: true; patch: DraftPatch }
  | { ok: false; error: string };

/** 校验插件回传的草稿补丁；任何非法字段整体拒绝，不做部分应用。 */
export function normalizeDraftPatch(input: unknown): DraftPatchResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: '补丁必须是对象' };
  }
  const record = input as Record<string, unknown>;
  const patch: DraftPatch = {};

  if (record.subject !== undefined) {
    if (typeof record.subject !== 'string') return { ok: false, error: 'subject 必须是字符串' };
    if (record.subject.length > MAX_SUBJECT) return { ok: false, error: 'subject 过长' };
    patch.subject = record.subject;
  }

  if (record.body !== undefined) {
    if (typeof record.body !== 'string') return { ok: false, error: 'body 必须是字符串' };
    if (record.body.length > MAX_BODY) return { ok: false, error: 'body 过长' };
    patch.body = record.body;
  }

  if (record.to !== undefined) {
    const to = normalizeAddresses(record.to);
    if (!to) return { ok: false, error: 'to 中含有非法地址或数量过多' };
    patch.to = to;
  }

  if (record.cc !== undefined) {
    const cc = normalizeAddresses(record.cc);
    if (!cc) return { ok: false, error: 'cc 中含有非法地址或数量过多' };
    patch.cc = cc;
  }

  if (Object.keys(patch).length === 0) return { ok: false, error: '补丁为空' };
  return { ok: true, patch };
}

/** 校验渲染进程上送的草稿快照（宿主与插件之间唯一的草稿真值来源）。 */
export function normalizeDraftContext(input: unknown): DraftContextSnapshot | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const accountId = typeof record.accountId === 'string' ? record.accountId : '';
  if (!accountId) return null;
  const subject = typeof record.subject === 'string' ? record.subject.slice(0, MAX_SUBJECT) : '';
  const body = typeof record.body === 'string' ? record.body.slice(0, MAX_BODY) : '';
  const to = normalizeAddresses(record.to ?? []);
  const cc = normalizeAddresses(record.cc ?? []);
  if (!to || !cc) return null;
  return { accountId, subject, to, cc, body };
}
