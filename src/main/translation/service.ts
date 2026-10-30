import crypto from 'node:crypto';
import type { Db } from '../db/open';
import type { EmailsRepo } from '../db/repositories/emails-repo';
import type { SecretStore } from '../mail/auth/token-store';
import type { TranslationOutcome, TranslationSettingsView } from '../../shared/ipc';
import {
  LONG_TEXT_CHARS,
  applyTranslations,
  chunkTexts,
  collectTranslatableText,
  countChars,
  joinSegments,
  looksLikeLanguage,
  quotaNotice,
  splitTranslatable,
  totalChars,
} from '../../shared/translation';
import { htmlToPlainText } from '../security/sanitize';
import { log } from '../observability/logger';
import { recordMetric } from '../observability/metrics';
import { MicrosoftTranslator } from './microsoft';
import type { TranslationProvider } from '../../shared/types';

/**
 * 翻译服务（§14.3 / §14.4）：
 * 按需触发、缓存、长文确认、可取消；原文永不被覆盖。
 */

interface TranslationSettings {
  enabled: boolean;
  providerId: string;
  targetLang: string;
  region: string;
}

const SETTINGS_KEY = 'translation.settings';
const MICROSOFT_KEY_REF = 'microsoft-translator-key';

const DEFAULTS: TranslationSettings = {
  enabled: false,
  providerId: 'microsoft',
  targetLang: 'zh-Hans',
  region: '',
};

export const DATA_TRANSFER_NOTICE =
  '启用后，待翻译的邮件文本会发送到所选翻译服务商。请确认这符合你的数据合规要求。';

export class TranslationService {
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly db: Db,
    private readonly secrets: SecretStore,
    private readonly emails: EmailsRepo,
    /** 测试可注入替代实现；生产固定使用 Microsoft Translator。 */
    private readonly translatorFactory: (options: {
      apiKey: string;
      region?: string;
      signal: AbortSignal;
    }) => TranslationProvider = (options) => new MicrosoftTranslator(options),
  ) {}

  private readSettings(): TranslationSettings {
    const row = this.db
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get(SETTINGS_KEY) as { value: string } | undefined;
    if (!row) return DEFAULTS;
    try {
      const parsed = JSON.parse(row.value) as Partial<TranslationSettings>;
      return {
        enabled: parsed.enabled === true,
        providerId: typeof parsed.providerId === 'string' ? parsed.providerId : DEFAULTS.providerId,
        targetLang: typeof parsed.targetLang === 'string' ? parsed.targetLang : DEFAULTS.targetLang,
        region: typeof parsed.region === 'string' ? parsed.region : '',
      };
    } catch {
      return DEFAULTS;
    }
  }

  private writeSettings(settings: TranslationSettings): void {
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(SETTINGS_KEY, JSON.stringify(settings), Date.now());
  }

  async settings(): Promise<TranslationSettingsView> {
    const settings = this.readSettings();
    const configured = (await this.secrets.has(MICROSOFT_KEY_REF)) && settings.providerId === 'microsoft';
    return {
      enabled: settings.enabled,
      providerId: settings.providerId,
      targetLang: settings.targetLang,
      configured,
      dataTransferNotice: DATA_TRANSFER_NOTICE,
    };
  }

  async update(patch: Partial<TranslationSettingsView> & { apiKey?: string; region?: string }): Promise<void> {
    const current = this.readSettings();
    const next: TranslationSettings = {
      enabled: patch.enabled === undefined ? current.enabled : patch.enabled === true,
      providerId: typeof patch.providerId === 'string' ? patch.providerId : current.providerId,
      targetLang: typeof patch.targetLang === 'string' ? patch.targetLang : current.targetLang,
      region: typeof patch.region === 'string' ? patch.region : current.region,
    };
    this.writeSettings(next);
    if (patch.apiKey !== undefined) {
      if (patch.apiKey) await this.secrets.set(MICROSOFT_KEY_REF, patch.apiKey);
      else await this.secrets.delete(MICROSOFT_KEY_REF);
    }
  }

  /** 用户离开邮件时取消正在进行的翻译（§14.3 可取消）。 */
  cancel(emailId?: string): void {
    if (emailId) {
      this.controllers.get(emailId)?.abort();
      this.controllers.delete(emailId);
      return;
    }
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
  }

  private emailText(emailId: string): string {
    const stored = this.emails.getBody(emailId);
    if (!stored) return '';
    if (stored.text && stored.text.trim().length > 0) return stored.text;
    return stored.html ? htmlToPlainText(stored.html) : '';
  }

  async translateEmail(
    emailId: string,
    targetLangOverride?: string,
    confirmLong = false,
  ): Promise<TranslationOutcome> {
    const settings = this.readSettings();
    if (!settings.enabled) {
      return { status: 'unavailable', message: '翻译功能未启用。请在设置中启用并配置服务商密钥。' };
    }
    if (settings.providerId !== 'microsoft') {
      return { status: 'unavailable', message: '当前翻译服务商不可用。' };
    }

    const apiKey = await this.secrets.get(MICROSOFT_KEY_REF);
    if (!apiKey) {
      return { status: 'unavailable', message: '尚未配置 Microsoft Translator 密钥。' };
    }

    const targetLang = targetLangOverride || settings.targetLang;
    const raw = this.emailText(emailId);
    if (!raw.trim()) {
      return { status: 'skipped', reason: 'empty' };
    }

    const segments = splitTranslatable(raw);
    const lines = collectTranslatableText(segments);
    if (lines.length === 0) return { status: 'skipped', reason: 'empty' };

    const sourceText = joinSegments(segments);
    if (looksLikeLanguage(sourceText, targetLang)) {
      return { status: 'skipped', reason: 'same-language' };
    }

    const chars = totalChars(lines);
    if (chars > LONG_TEXT_CHARS && !confirmLong) {
      return { status: 'needs_confirm', chars, message: quotaNotice(chars) };
    }

    const sourceHash = crypto
      .createHash('sha256')
      .update(`${targetLang}\n${lines.join('\n')}`)
      .digest('hex');

    const cached = this.db
      .prepare(
        'SELECT translated_text FROM translation_cache WHERE email_id = ? AND target_lang = ? AND source_hash = ?',
      )
      .get(emailId, targetLang, sourceHash) as { translated_text: string } | undefined;

    if (cached) {
      return {
        status: 'ok',
        emailId,
        targetLang,
        provider: settings.providerId,
        text: cached.translated_text,
        cached: true,
        chars,
      };
    }

    const controller = new AbortController();
    this.controllers.get(emailId)?.abort();
    this.controllers.set(emailId, controller);

    const translator = this.translatorFactory({
      apiKey,
      ...(settings.region ? { region: settings.region } : {}),
      signal: controller.signal,
    });

    const startedAt = Date.now();
    try {
      const translatedLines: string[] = [];
      for (const chunk of chunkTexts(lines)) {
        const result = await translator.translate(chunk, targetLang);
        translatedLines.push(...result);
      }

      const text = applyTranslations(segments, translatedLines);
      this.db
        .prepare(
          `INSERT INTO translation_cache
             (email_id, target_lang, source_hash, translated_text, provider, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(email_id, target_lang, source_hash) DO UPDATE SET
             translated_text = excluded.translated_text,
             provider = excluded.provider,
             created_at = excluded.created_at`,
        )
        .run(emailId, targetLang, sourceHash, text, translator.id, Date.now());

      recordMetric('translation_request', {
        chars,
        cached: 'false',
        durationMs: Date.now() - startedAt,
      });

      return {
        status: 'ok',
        emailId,
        targetLang,
        provider: translator.id,
        text,
        cached: false,
        chars,
      };
    } catch (error) {
      if (controller.signal.aborted) {
        return { status: 'unavailable', message: '翻译已取消。' };
      }
      log.warn('translation', '翻译失败', { message: (error as Error).message });
      return { status: 'unavailable', message: `翻译失败：${(error as Error).message}` };
    } finally {
      if (this.controllers.get(emailId) === controller) this.controllers.delete(emailId);
    }
  }

  /** 设置页展示当前缓存条目数（只读统计，不含内容）。 */
  cacheCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM translation_cache').get() as { c: number };
    return row.c;
  }

  /** 仅测试/诊断用：估算一次翻译的字符量。 */
  estimateChars(emailId: string): number {
    const segments = splitTranslatable(this.emailText(emailId));
    return countChars(joinSegments(segments.filter((segment) => segment.translatable)));
  }
}
