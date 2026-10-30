import { z } from 'zod';
import type { ParsedCommand } from '../../shared/types';

/**
 * §15.3 硬性要求：LLM 输出必须先经过 Zod 结构化验证，
 * 形状不正确时不得执行任何动作。
 */

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

const recipientSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    address: z.string().trim().max(254).optional(),
  })
  .refine((value) => Boolean(value.name || value.address), {
    message: '收件人至少需要 name 或 address',
  })
  .refine((value) => !value.address || EMAIL_RE.test(value.address), {
    message: '收件人地址格式不正确',
  });

function parseSendAt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value);
  }
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && value.trim() !== '') return Math.round(numeric);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export const parsedCommandSchema = z.object({
  action: z.enum(['schedule_send', 'send_now', 'draft']),
  sendAt: z
    .union([z.number(), z.string()])
    .optional()
    .transform((value) => (value === undefined ? undefined : parseSendAt(value)))
    .refine((value) => value === undefined || value !== null, {
      message: 'sendAt 不是合法时间',
    }),
  recipients: z.array(recipientSchema).min(1, '缺少 recipients 字段'),
  bodyInstruction: z.object({
    type: z.enum(['explicit_text', 'generate_from_prompt']),
    content: z.string().min(1, '正文内容为空'),
  }),
  confidence: z.number().min(0).max(1),
});

export type ParsedCommandShape = z.infer<typeof parsedCommandSchema>;

export interface ValidationIssue {
  path: string;
  code: string;
  message: string;
}

export interface ValidationOutcome {
  ok: boolean;
  command?: ParsedCommand;
  issues: ValidationIssue[];
}

/** 时间必须明确且在未来（允许 60 秒时钟偏差）。 */
export const PAST_TOLERANCE_MS = 60_000;

export function validateParsedCommand(
  raw: unknown,
  options: { now: number; rawInput: string; requireSendAt?: boolean },
): ValidationOutcome {
  const parsed = parsedCommandSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        code: issue.code,
        message: issue.message,
      })),
    };
  }

  const value = parsed.data;
  const issues: ValidationIssue[] = [];

  if (value.action === 'schedule_send') {
    if (typeof value.sendAt !== 'number') {
      issues.push({ path: 'sendAt', code: 'required', message: '定时发送需要 sendAt' });
    } else if (value.sendAt <= options.now - PAST_TOLERANCE_MS) {
      issues.push({ path: 'sendAt', code: 'past', message: '发送时间已过去' });
    }
  }

  if (value.action === 'send_now' && value.sendAt !== undefined && value.sendAt < options.now - PAST_TOLERANCE_MS) {
    issues.push({ path: 'sendAt', code: 'past', message: '发送时间已过去' });
  }

  if (options.requireSendAt && typeof value.sendAt !== 'number') {
    issues.push({ path: 'sendAt', code: 'required', message: '缺少发送时间' });
  }

  if (issues.length > 0) return { ok: false, issues };

  const command: ParsedCommand = {
    action: value.action,
    ...(value.sendAt !== undefined ? { sendAt: value.sendAt } : {}),
    recipients: value.recipients,
    bodyInstruction: value.bodyInstruction,
    confidence: value.confidence,
    raw: options.rawInput,
  };

  return { ok: true, command, issues: [] };
}

/**
 * 修复重试只回传结构化错误（哪一类失败、哪个字段），
 * 不回传用户原文或完整模型输出（§15.3）。
 */
export function formatIssuesForRetry(issues: ValidationIssue[]): string {
  return issues
    .slice(0, 8)
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join('; ');
}

/** 确认策略（§15.3）：默认必须确认；快速通道需同时满足全部条件且用户显式开启。 */
export interface ConfirmPolicyInput {
  command: ParsedCommand;
  recipientUnique: boolean;
  allowFastPath: boolean;
  now: number;
}

export function requiresConfirmation(input: ConfirmPolicyInput): boolean {
  const { command } = input;

  // AI 生成的正文必须确认，无论其他条件如何
  if (command.generated === true) return true;
  if (command.bodyInstruction.type === 'generate_from_prompt') return true;

  if (!input.allowFastPath) return true;
  if (!input.recipientUnique) return true;
  if (command.confidence < 0.9) return true;
  if (command.action === 'schedule_send') {
    if (typeof command.sendAt !== 'number') return true;
    if (command.sendAt <= input.now) return true;
  }

  return false;
}
