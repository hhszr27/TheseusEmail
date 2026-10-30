import type { AiProvider, EmailAddress } from '../../shared/types';

/**
 * OpenAI 兼容 / Ollama 适配器（§15）。
 * baseUrl 可指向官方端点、兼容网关或本机 Ollama（/v1）。
 * Key 只存在于主进程内存；local=true 时使用本地模型，邮件内容不出设备。
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  local: boolean;
  /** 展示用服务商名称（如预设 label），缺省按 local 推断。 */
  name?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const COMMAND_SYSTEM_PROMPT = `你是邮件客户端的指令解析器。只输出一个 JSON 对象，不要输出解释或代码块。
JSON 结构：
{
  "action": "schedule_send" | "send_now" | "draft",
  "sendAt": 毫秒时间戳（定时发送时必填，必须是未来时间）,
  "recipients": [{"name": "可选", "address": "可选，合法邮箱"}],
  "bodyInstruction": {"type": "explicit_text" | "generate_from_prompt", "content": "正文或生成正文的提示"},
  "confidence": 0 到 1 的数字
}
规则：
- 用户说“明天下午3点”等相对时间时，基于当前时间换算为毫秒时间戳。
- 用户只给了姓名时，recipients 里只填 name，不要编造邮箱。
- 用户给出了正文原文时用 explicit_text；只描述意图时用 generate_from_prompt。
- 缺少收件人时不要输出空的 recipients，应返回错误。`;

function stripCodeFence(input: string): string {
  const trimmed = input.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
}

export class OpenAiCompatibleProvider implements AiProvider {
  readonly id: string;
  readonly name: string;
  readonly local: boolean;

  constructor(private readonly options: OpenAiCompatibleOptions) {
    this.local = options.local;
    this.id = options.local ? 'ollama' : 'openai-compatible';
    this.name =
      options.name ?? (options.local ? '本地模型（Ollama）' : 'OpenAI 兼容服务');
  }

  private async chat(messages: ChatMessage[], jsonMode = false): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 60_000);

    try {
      const response = await (this.options.fetchImpl ?? fetch)(
        `${this.options.baseUrl.replace(/\/$/, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: this.options.model,
            temperature: 0.2,
            messages,
            ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
          }),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        throw new Error(`模型服务返回 HTTP ${response.status}`);
      }

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('模型返回内容为空');
      return content;
    } finally {
      clearTimeout(timeout);
    }
  }

  async summarize(texts: string[]): Promise<string> {
    const body = texts.join('\n\n').slice(0, 24_000);
    return this.chat([
      {
        role: 'system',
        content:
          '你是邮件阅读助手。用中文输出 3-6 条要点，涵盖事项、时间、需要回复的动作。不要编造原文没有的信息。',
      },
      { role: 'user', content: body },
    ]);
  }

  async draftReply(context: { subject: string; body: string; from: EmailAddress[] }): Promise<string> {
    const sender = context.from.map((item) => item.name || item.address).join('、');
    return this.chat([
      { role: 'system', content: '你是邮件写作助手。用中文写一封简洁、礼貌、可直接发送的回复正文。' },
      {
        role: 'user',
        content: `主题：${context.subject}\n发件人：${sender}\n原文：\n${context.body.slice(0, 12_000)}`,
      },
    ]);
  }

  async rewrite(text: string, tone: 'formal' | 'friendly' | 'concise'): Promise<string> {
    const toneLabel = tone === 'formal' ? '正式' : tone === 'friendly' ? '友好' : '简洁';
    return this.chat([
      { role: 'system', content: `你是邮件改写助手，将用户提供的正文改写为${toneLabel}语气，保持事实不变。` },
      { role: 'user', content: text.slice(0, 12_000) },
    ]);
  }

  async semanticSearch(query: string, emailIds: string[]): Promise<string[]> {
    if (emailIds.length === 0) return [];
    // 外部模型不做本地排序，语义检索由宿主 EmbeddingIndex 完成
    void query;
    return emailIds;
  }

  async parseCommand(input: string): Promise<unknown> {
    const now = new Date();
    const content = await this.chat(
      [
        {
          role: 'system',
          content: `${COMMAND_SYSTEM_PROMPT}\n当前时间：${now.toISOString()}（${now.getTime()} 毫秒）`,
        },
        { role: 'user', content: input },
      ],
      true,
    );

    const json = stripCodeFence(content);
    return JSON.parse(json) as unknown;
  }
}
