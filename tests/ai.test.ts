import { afterEach, describe, expect, it } from 'vitest';
import {
  formatIssuesForRetry,
  parsedCommandSchema,
  requiresConfirmation,
  validateParsedCommand,
} from '../src/main/ai/command-schema';
import { CommandOrchestrator, DEFAULT_MAX_REPAIRS, deriveSubject } from '../src/main/ai/orchestrator';
import { EmbeddingIndex, cosineSimilarity, embedText } from '../src/main/ai/embeddings';
import type { AiProvider, ParsedCommand } from '../src/shared/types';
import type { ContactSuggestion } from '../src/shared/ipc';
import { createTestDb, insertAccount, insertEmail, type TestDb } from './helpers/test-db';

let context: TestDb | null = null;

afterEach(() => {
  context?.cleanup();
  context = null;
});

const NOW = Date.UTC(2026, 9, 21, 4, 0, 0);
const FUTURE = NOW + 60 * 60 * 1000;

function validCommand(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'schedule_send',
    sendAt: FUTURE,
    recipients: [{ name: '张总', address: 'boss@example.com' }],
    bodyInstruction: { type: 'explicit_text', content: '项目进度已更新，请查收。' },
    confidence: 0.95,
    ...overrides,
  };
}

function fakeAi(responses: unknown[], generated = '模型生成的正文'): AiProvider & { calls: number } {
  const state = { calls: 0 };
  return {
    id: 'fake',
    name: 'Fake AI',
    local: true,
    get calls() {
      return state.calls;
    },
    async summarize() {
      return 'summary';
    },
    async draftReply() {
      return generated;
    },
    async rewrite(text: string) {
      return text;
    },
    async semanticSearch() {
      return [];
    },
    async parseCommand() {
      const response = responses[Math.min(state.calls, responses.length - 1)];
      state.calls += 1;
      return response;
    },
  };
}

const CONTACTS: ContactSuggestion[] = [
  { email: 'zhang@example.com', displayName: '张总', interactionCount: 5, lastContactedAt: NOW },
  { email: 'zhang2@example.com', displayName: '张总（分公司）', interactionCount: 2, lastContactedAt: NOW },
];

describe('结构化验证（§15.3 硬性要求）', () => {
  it('缺少 recipients 时校验失败，路径可定位', () => {
    const outcome = validateParsedCommand(
      { action: 'schedule_send', sendAt: FUTURE, bodyInstruction: { type: 'explicit_text', content: 'x' }, confidence: 0.9 },
      { now: NOW, rawInput: '指令' },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.issues.some((issue) => issue.path.includes('recipients'))).toBe(true);
  });

  it('过去时间被拒绝', () => {
    const outcome = validateParsedCommand(validCommand({ sendAt: NOW - 10 * 60 * 1000 }), {
      now: NOW,
      rawInput: '指令',
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.issues.some((issue) => issue.code === 'past')).toBe(true);
  });

  it('接受 ISO 时间字符串并转为毫秒', () => {
    const iso = new Date(FUTURE).toISOString();
    const outcome = validateParsedCommand(validCommand({ sendAt: iso }), { now: NOW, rawInput: '指令' });
    expect(outcome.ok).toBe(true);
    expect(outcome.command?.sendAt).toBe(FUTURE);
  });

  it('非法邮箱被拒绝', () => {
    const outcome = validateParsedCommand(validCommand({ recipients: [{ address: 'not-an-email' }] }), {
      now: NOW,
      rawInput: '指令',
    });
    expect(outcome.ok).toBe(false);
  });

  it('schema 拒绝未知动作与越界置信度', () => {
    expect(parsedCommandSchema.safeParse(validCommand({ action: 'delete_all' })).success).toBe(false);
    expect(parsedCommandSchema.safeParse(validCommand({ confidence: 1.5 })).success).toBe(false);
  });

  it('重试反馈只包含字段与原因', () => {
    const text = formatIssuesForRetry([
      { path: 'recipients', code: 'too_small', message: '缺少 recipients 字段' },
    ]);
    expect(text).toBe('recipients: 缺少 recipients 字段');
  });
});

describe('确认策略（§15.3）', () => {
  const base: ParsedCommand = {
    action: 'schedule_send',
    sendAt: FUTURE,
    recipients: [{ address: 'a@example.com' }],
    bodyInstruction: { type: 'explicit_text', content: 'hi' },
    confidence: 0.95,
    raw: '',
  };

  it('默认必须确认', () => {
    expect(
      requiresConfirmation({ command: base, recipientUnique: true, allowFastPath: false, now: NOW }),
    ).toBe(true);
  });

  it('快速通道需同时满足全部条件', () => {
    expect(
      requiresConfirmation({ command: base, recipientUnique: true, allowFastPath: true, now: NOW }),
    ).toBe(false);
    expect(
      requiresConfirmation({ command: base, recipientUnique: false, allowFastPath: true, now: NOW }),
    ).toBe(true);
    expect(
      requiresConfirmation({
        command: { ...base, confidence: 0.5 },
        recipientUnique: true,
        allowFastPath: true,
        now: NOW,
      }),
    ).toBe(true);
  });

  it('AI 生成正文强制确认，即使满足快速通道', () => {
    expect(
      requiresConfirmation({
        command: {
          ...base,
          bodyInstruction: { type: 'generate_from_prompt', content: '写一封催款邮件' },
          generated: true,
        },
        recipientUnique: true,
        allowFastPath: true,
        now: NOW,
      }),
    ).toBe(true);
  });
});

describe('命令编排（§15.3）', () => {
  it('首次输出缺少 recipients，重试后成功', async () => {
    const ai = fakeAi([
      { action: 'schedule_send', sendAt: FUTURE, confidence: 0.9, bodyInstruction: { type: 'explicit_text', content: 'x' } },
      validCommand(),
    ]);
    const orchestrator = new CommandOrchestrator({
      ai,
      searchContacts: () => [],
      now: () => NOW,
      allowFastPath: () => false,
    });

    const result = await orchestrator.prepare('明天下午3点发邮件给张总');
    expect(result.status).toBe('ready');
    expect(result.attempts).toBe(2);
    expect(ai.calls).toBe(2);
  });

  it('持续失败时耗尽预算并返回可读错误', async () => {
    const invalid = {
      action: 'schedule_send',
      sendAt: FUTURE,
      confidence: 0.9,
      bodyInstruction: { type: 'explicit_text', content: 'x' },
    };
    const ai = fakeAi([invalid]);
    const orchestrator = new CommandOrchestrator({
      ai,
      searchContacts: () => [],
      now: () => NOW,
      allowFastPath: () => false,
    });

    const result = await orchestrator.prepare('发邮件');
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.message).toContain('未能理解指令');
    expect(result.attempts).toBe(DEFAULT_MAX_REPAIRS + 1);
    expect(ai.calls).toBe(DEFAULT_MAX_REPAIRS + 1);
  });

  it('收件人歧义进入选择流程', async () => {
    const orchestrator = new CommandOrchestrator({
      ai: fakeAi([validCommand({ recipients: [{ name: '张总' }] })]),
      searchContacts: (query) => (query === '张总' ? CONTACTS : []),
      now: () => NOW,
      allowFastPath: () => false,
    });

    const result = await orchestrator.prepare('发邮件给张总');
    expect(result.status).toBe('needs_choice');
    if (result.status !== 'needs_choice') return;
    expect(result.choices[0]?.candidates).toHaveLength(2);
  });

  it('唯一联系人自动补全地址', async () => {
    const orchestrator = new CommandOrchestrator({
      ai: fakeAi([validCommand({ recipients: [{ name: '唯一联系人' }] })]),
      searchContacts: () => [CONTACTS[0]!],
      now: () => NOW,
      allowFastPath: () => false,
    });

    const result = await orchestrator.prepare('发邮件');
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.command.recipients[0]?.address).toBe('zhang@example.com');
  });

  it('生成正文后仍需确认', async () => {
    const orchestrator = new CommandOrchestrator({
      ai: fakeAi([
        validCommand({
          bodyInstruction: { type: 'generate_from_prompt', content: '写一封项目进度说明' },
        }),
      ]),
      searchContacts: () => [],
      now: () => NOW,
      allowFastPath: () => true,
    });

    const result = await orchestrator.prepare('写一封进度说明发给张总');
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.command.bodyInstruction.type).toBe('explicit_text');
    expect(result.command.generated).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
  });

  it('主题由正文首行推导并截断', () => {
    const command: ParsedCommand = {
      action: 'schedule_send',
      recipients: [{ address: 'a@example.com' }],
      bodyInstruction: { type: 'explicit_text', content: `${'长'.repeat(120)}\n第二行` },
      confidence: 1,
      raw: '',
    };
    expect(deriveSubject(command).length).toBeLessThanOrEqual(78);
  });
});

describe('本地语义索引（§15.2）', () => {
  it('相同文本相似度高于无关文本', () => {
    const a = embedText('季度预算评审会议安排在下周一');
    const b = embedText('下周一安排季度预算评审会议');
    const c = embedText('周末去爬山看日出');
    expect(cosineSimilarity(a, b)).toBeGreaterThan(cosineSimilarity(a, c));
    expect(cosineSimilarity(a, a)).toBeCloseTo(1, 5);
  });

  it('索引后可检索并按分数排序', () => {
    context = createTestDb();
    const index = new EmbeddingIndex(context.db);
    index.index('e1', '预算评审会议安排在下周一上午十点');
    index.index('e2', '周末徒步路线推荐与装备清单');
    index.index('e3', '季度预算评审需要准备的材料');

    const hits = index.search('预算评审会议', 3);
    expect(hits[0]?.emailId).not.toBe('e2');
    expect(hits.map((hit) => hit.emailId)).toContain('e1');
    expect(hits.every((hit) => hit.score > 0)).toBe(true);
  });

  it('ensureIndexed 为已有正文补建索引', () => {
    context = createTestDb();
    insertAccount(context.db, 'acc-1');
    insertEmail(context.db, { id: 'e1', accountId: 'acc-1', uid: 1 });
    context.db
      .prepare(
        `INSERT INTO email_bodies (email_id, html, text, fetched_at) VALUES ('e1', NULL, '正文内容', ?)`,
      )
      .run(Date.now());
    const index = new EmbeddingIndex(context.db);
    expect(index.ensureIndexed()).toBe(1);
    expect(index.count()).toBe(1);
    expect(index.ensureIndexed()).toBe(0);
  });
});
