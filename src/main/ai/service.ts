import type { Db } from '../db/open';
import type { EmailsRepo } from '../db/repositories/emails-repo';
import type { ContactsRepo } from '../db/repositories/contacts-repo';
import type { SecretStore } from '../mail/auth/token-store';
import type { AiSettingsView, CommandPreparation, SemanticSearchResult } from '../../shared/ipc';
import type { AiProvider, EmailSummary } from '../../shared/types';
import { htmlToPlainText } from '../security/sanitize';
import { log } from '../observability/logger';
import { recordMetric } from '../observability/metrics';
import { EmbeddingIndex } from './embeddings';
import { OpenAiCompatibleProvider } from './openai-compatible';
import { CommandOrchestrator } from './orchestrator';
import type { RecipientChoice } from './orchestrator';
import { aiPresetById } from '../../shared/ai-providers';

/**
 * AI 能力装配（§15）：四类能力共用一份提供者配置，但可独立启用。
 * Key 存 safeStorage，绝不进入渲染进程。
 */

interface AiSettings {
  enabled: boolean;
  providerId: string;
  model: string;
  baseUrl: string;
  local: boolean;
  features: { summarize: boolean; semanticSearch: boolean; command: boolean };
  allowFastPath: boolean;
}

const SETTINGS_KEY = 'ai.settings';
const KEY_REF = 'ai-api-key';

const DEFAULTS: AiSettings = {
  enabled: false,
  providerId: 'openai',
  model: 'gpt-4o-mini',
  baseUrl: 'https://api.openai.com/v1',
  local: false,
  features: { summarize: true, semanticSearch: true, command: true },
  allowFastPath: false,
};

/** 旧版仅存的两种形态需要映射到新预设 id，避免下拉框空白。 */
function normalizeProviderId(id: string | undefined): string {
  if (id === 'openai-compatible') return 'openai';
  if (!id) return DEFAULTS.providerId;
  return id;
}

export const AI_DATA_NOTICE =
  '启用云端模型后，邮件正文会发送到所配置的服务端点。使用本地模型（如 Ollama）时内容不离开本机。';

export class AiService {
  readonly embeddings: EmbeddingIndex;
  private cachedProvider: AiProvider | null = null;

  constructor(
    private readonly db: Db,
    private readonly secrets: SecretStore,
    private readonly emails: EmailsRepo,
    private readonly contacts: ContactsRepo,
  ) {
    this.embeddings = new EmbeddingIndex(db);
  }

  private readSettings(): AiSettings {
    const row = this.db
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get(SETTINGS_KEY) as { value: string } | undefined;
    if (!row) return DEFAULTS;
    try {
      const parsed = JSON.parse(row.value) as Partial<AiSettings>;
      return {
        enabled: parsed.enabled === true,
        providerId: normalizeProviderId(parsed.providerId),
        model: typeof parsed.model === 'string' && parsed.model ? parsed.model : DEFAULTS.model,
        baseUrl: typeof parsed.baseUrl === 'string' && parsed.baseUrl ? parsed.baseUrl : DEFAULTS.baseUrl,
        local: parsed.local === true,
        features: {
          summarize: parsed.features?.summarize !== false,
          semanticSearch: parsed.features?.semanticSearch !== false,
          command: parsed.features?.command !== false,
        },
        allowFastPath: parsed.allowFastPath === true,
      };
    } catch {
      return DEFAULTS;
    }
  }

  private writeSettings(settings: AiSettings): void {
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(SETTINGS_KEY, JSON.stringify(settings), Date.now());
    this.cachedProvider = null;
  }

  async settings(): Promise<AiSettingsView> {
    const settings = this.readSettings();
    const hasKey = await this.secrets.has(KEY_REF);
    return {
      enabled: settings.enabled,
      providerId: settings.providerId,
      model: settings.model,
      baseUrl: settings.baseUrl,
      local: settings.local,
      configured: settings.local ? Boolean(settings.baseUrl) : hasKey,
      features: settings.features,
      dataTransferNotice: AI_DATA_NOTICE,
    };
  }

  async update(patch: Partial<AiSettingsView> & { apiKey?: string }): Promise<void> {
    const current = this.readSettings();
    const next: AiSettings = {
      enabled: patch.enabled === undefined ? current.enabled : patch.enabled === true,
      providerId:
        typeof patch.providerId === 'string' && patch.providerId
          ? patch.providerId
          : current.providerId,
      model: typeof patch.model === 'string' && patch.model ? patch.model : current.model,
      baseUrl: typeof patch.baseUrl === 'string' && patch.baseUrl ? patch.baseUrl : current.baseUrl,
      local: patch.local === undefined ? current.local : patch.local === true,
      features: {
        summarize: patch.features?.summarize ?? current.features.summarize,
        semanticSearch: patch.features?.semanticSearch ?? current.features.semanticSearch,
        command: patch.features?.command ?? current.features.command,
      },
      allowFastPath: current.allowFastPath,
    };
    this.writeSettings(next);

    if (patch.apiKey !== undefined) {
      if (patch.apiKey) await this.secrets.set(KEY_REF, patch.apiKey);
      else await this.secrets.delete(KEY_REF);
    }
  }

  private async provider(): Promise<AiProvider | null> {
    const settings = this.readSettings();
    if (!settings.enabled) return null;
    if (this.cachedProvider) return this.cachedProvider;

    const apiKey = settings.local ? undefined : ((await this.secrets.get(KEY_REF)) ?? undefined);
    if (!settings.local && !apiKey) return null;

    const preset = aiPresetById(settings.providerId);
    this.cachedProvider = new OpenAiCompatibleProvider({
      baseUrl: settings.baseUrl,
      model: settings.model,
      local: settings.local,
      name: preset?.label ?? (settings.local ? '本地模型' : '自定义模型'),
      ...(apiKey ? { apiKey } : {}),
    });
    return this.cachedProvider;
  }

  private bodyText(emailId: string): string {
    const stored = this.emails.getBody(emailId);
    if (!stored) return '';
    if (stored.text && stored.text.trim()) return stored.text;
    return htmlToPlainText(stored.html ?? '');
  }

  async summarize(emailId: string): Promise<{ summary: string; provider: string }> {
    const settings = this.readSettings();
    if (!settings.enabled || !settings.features.summarize) {
      throw new Error('AI 摘要未启用。');
    }
    const provider = await this.provider();
    if (!provider) throw new Error('尚未配置 AI 服务密钥或端点。');

    const email = this.emails.get(emailId);
    if (!email) throw new Error('邮件不存在。');
    const text = this.bodyText(emailId);
    if (!text.trim()) throw new Error('正文尚未载入，无法生成摘要。');

    const summary = await provider.summarize([`主题：${email.subject}\n\n${text}`]);
    recordMetric('ai_command', { kind: 'summarize', ok: 'true' });
    return { summary, provider: provider.name };
  }

  async semanticSearch(query: string, limit = 20): Promise<SemanticSearchResult> {
    const settings = this.readSettings();
    if (!settings.features.semanticSearch) {
      throw new Error('语义搜索未启用。');
    }
    if (!query.trim()) return { emailIds: [], scores: [], emails: [] };

    this.embeddings.ensureIndexed();
    const hits = this.embeddings.search(query, limit);
    const emails: EmailSummary[] = [];
    for (const hit of hits) {
      const email = this.emails.get(hit.emailId);
      if (email) emails.push(email);
    }

    return {
      emailIds: hits.map((hit) => hit.emailId),
      scores: hits.map((hit) => ({ emailId: hit.emailId, score: Number(hit.score.toFixed(4)) })),
      emails,
    };
  }

  async prepareCommand(input: string): Promise<CommandPreparation> {
    const settings = this.readSettings();
    if (!settings.enabled || !settings.features.command) {
      return { status: 'rejected', message: 'AI 指令未启用。', attempts: 0, issues: [] };
    }
    const provider = await this.provider();
    if (!provider) {
      return { status: 'rejected', message: '尚未配置 AI 服务密钥或端点。', attempts: 0, issues: [] };
    }

    const orchestrator = new CommandOrchestrator({
      ai: provider,
      searchContacts: (query) =>
        this.contacts.search(query).map((item) => ({
          email: item.email,
          displayName: item.displayName,
          interactionCount: item.interactionCount,
          lastContactedAt: item.lastContactedAt,
        })),
      now: () => Date.now(),
      allowFastPath: () => settings.allowFastPath,
    });

    const result = await orchestrator.prepare(input);
    recordMetric('ai_command', {
      kind: 'prepare',
      status: result.status,
      attempts: result.attempts,
    });

    if (result.status === 'needs_choice') {
      return {
        status: 'needs_choice',
        command: result.command,
        choices: result.choices.map((choice: RecipientChoice) => ({
          index: choice.index,
          query: choice.query,
          candidates: choice.candidates.map((candidate) => ({
            email: candidate.email,
            displayName: candidate.displayName,
          })),
        })),
        attempts: result.attempts,
      };
    }

    if (result.status === 'rejected') {
      return {
        status: 'rejected',
        message: result.message,
        attempts: result.attempts,
        issues: result.issues.map((issue) => ({ path: issue.path, message: issue.message })),
      };
    }

    return {
      status: 'ready',
      command: result.command,
      requiresConfirmation: result.requiresConfirmation,
      attempts: result.attempts,
    };
  }

  /** 正文写入后更新索引（由 IPC 在保存正文时调用）。 */
  indexEmail(emailId: string): void {
    const text = this.bodyText(emailId);
    if (!text.trim()) return;
    try {
      this.embeddings.index(emailId, text.slice(0, 20_000));
    } catch (error) {
      log.warn('ai', '语义索引写入失败', { message: (error as Error).message });
    }
  }
}
