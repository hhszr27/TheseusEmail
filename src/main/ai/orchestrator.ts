import type { AiProvider, ParsedCommand } from '../../shared/types';
import type { ContactSuggestion } from '../../shared/ipc';
import {
  formatIssuesForRetry,
  requiresConfirmation,
  validateParsedCommand,
  type ValidationIssue,
} from './command-schema';

/**
 * 自然语言命令编排（§15.3）：
 * 解析 → Zod 验证 → 修复重试（共享预算）→ 收件人补全 → 确认策略。
 * 本模块不直接发送邮件，也不写队列；写入由 IPC 在用户确认后执行。
 */

export const DEFAULT_MAX_REPAIRS = 2;

export interface CommandOrchestratorDeps {
  ai: Pick<AiProvider, 'parseCommand' | 'draftReply'>;
  searchContacts(query: string): ContactSuggestion[];
  now(): number;
  allowFastPath(): boolean;
  maxRepairs?: number;
}

export interface RecipientChoice {
  index: number;
  query: string;
  candidates: ContactSuggestion[];
}

export type CommandPreparation =
  | {
      status: 'ready';
      command: ParsedCommand;
      requiresConfirmation: boolean;
      attempts: number;
    }
  | {
      status: 'needs_choice';
      choices: RecipientChoice[];
      command: ParsedCommand;
      attempts: number;
    }
  | {
      status: 'rejected';
      message: string;
      attempts: number;
      issues: ValidationIssue[];
    };

export class CommandOrchestrator {
  constructor(private readonly deps: CommandOrchestratorDeps) {}

  async prepare(input: string): Promise<CommandPreparation> {
    const trimmed = input.trim();
    if (!trimmed) {
      return { status: 'rejected', message: '请输入指令内容。', attempts: 0, issues: [] };
    }

    const maxRepairs = this.deps.maxRepairs ?? DEFAULT_MAX_REPAIRS;
    let attempts = 0;
    let lastIssues: ValidationIssue[] = [];
    let feedback = '';

    while (attempts <= maxRepairs) {
      attempts += 1;
      const prompt = feedback
        ? `${trimmed}\n\n[校验反馈] 上一次输出未通过结构化校验：${feedback}\n请只输出修正后的 JSON。`
        : trimmed;

      let raw: unknown;
      try {
        raw = await this.deps.ai.parseCommand(prompt);
      } catch (error) {
        lastIssues = [
          { path: '(request)', code: 'provider_error', message: (error as Error).message },
        ];
        feedback = formatIssuesForRetry(lastIssues);
        continue;
      }

      const outcome = validateParsedCommand(raw, {
        now: this.deps.now(),
        rawInput: trimmed,
        requireSendAt: true,
      });

      if (!outcome.ok || !outcome.command) {
        lastIssues = outcome.issues;
        feedback = formatIssuesForRetry(outcome.issues);
        continue;
      }

      return this.finalize(outcome.command, attempts);
    }

    return {
      status: 'rejected',
      message: '未能理解指令，请换一种说法或手动填写。',
      attempts,
      issues: lastIssues,
    };
  }

  private async finalize(command: ParsedCommand, attempts: number): Promise<CommandPreparation> {
    const resolved: ParsedCommand = {
      ...command,
      recipients: command.recipients.map((recipient) => ({ ...recipient })),
    };

    const choices: RecipientChoice[] = [];
    for (let index = 0; index < resolved.recipients.length; index += 1) {
      const recipient = resolved.recipients[index]!;
      if (recipient.address) continue;

      const query = recipient.name ?? '';
      const candidates = this.deps.searchContacts(query);
      if (candidates.length === 1) {
        resolved.recipients[index] = {
          ...(recipient.name ? { name: recipient.name } : {}),
          address: candidates[0]!.email,
        };
        continue;
      }
      choices.push({ index, query, candidates });
    }

    if (choices.length > 0) {
      return { status: 'needs_choice', choices, command: resolved, attempts };
    }

    // 需要模型生成正文时先补齐，再让用户确认（确认卡片展示最终正文）
    if (resolved.bodyInstruction.type === 'generate_from_prompt') {
      try {
        const generated = await this.deps.ai.draftReply({
          subject: resolved.bodyInstruction.content.slice(0, 120),
          body: '',
          from: [],
        });
        resolved.bodyInstruction = { type: 'explicit_text', content: generated };
        resolved.generated = true;
      } catch {
        return {
          status: 'rejected',
          message: '正文生成失败，请手动填写正文后重试。',
          attempts,
          issues: [],
        };
      }
    }

    const requireConfirm = requiresConfirmation({
      command: resolved,
      recipientUnique: true,
      allowFastPath: this.deps.allowFastPath(),
      now: this.deps.now(),
    });

    return {
      status: 'ready',
      command: resolved,
      requiresConfirmation: requireConfirm,
      attempts,
    };
  }
}

/** 指令正文转成邮件主题（无独立 subject 字段时的确定性映射）。 */
export function deriveSubject(command: ParsedCommand): string {
  const firstLine = command.bodyInstruction.content.split(/\r?\n/)[0]?.trim() ?? '';
  const base = firstLine || '（AI 指令）';
  return base.length > 80 ? `${base.slice(0, 77)}…` : base;
}
