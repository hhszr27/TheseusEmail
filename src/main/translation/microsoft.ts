import type { TranslationProvider } from '../../shared/types';

/**
 * Microsoft Translator 适配器（§14.2）。
 * 请求由主进程直接发往官方端点，不经过自建中转。
 */

export const MICROSOFT_ENDPOINT = 'https://api.cognitive.microsofttranslator.com';

interface MicrosoftResponseItem {
  translations?: Array<{ text?: string; to?: string }>;
}

export interface MicrosoftTranslatorOptions {
  apiKey: string;
  region?: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export class MicrosoftTranslator implements TranslationProvider {
  readonly id = 'microsoft';
  readonly name = 'Microsoft Translator';
  readonly supportedLanguages: string[] = [
    'zh-Hans',
    'zh-Hant',
    'en',
    'ja',
    'ko',
    'fr',
    'de',
    'es',
    'ru',
    'pt',
    'it',
    'ar',
  ];

  constructor(private readonly options: MicrosoftTranslatorOptions) {}

  async translate(texts: string[], targetLang: string, sourceLang?: string): Promise<string[]> {
    if (texts.length === 0) return [];

    const params = new URLSearchParams({ 'api-version': '3.0', to: targetLang });
    if (sourceLang) params.set('from', sourceLang);

    const response = await (this.options.fetchImpl ?? fetch)(
      `${this.options.endpoint ?? MICROSOFT_ENDPOINT}/translate?${params.toString()}`,
      {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': this.options.apiKey,
          ...(this.options.region ? { 'Ocp-Apim-Subscription-Region': this.options.region } : {}),
          'content-type': 'application/json',
        },
        body: JSON.stringify(texts.map((text) => ({ Text: text }))),
        ...(this.options.signal ? { signal: this.options.signal } : {}),
      },
    );

    if (!response.ok) {
      throw new Error(`翻译服务返回 HTTP ${response.status}`);
    }

    const payload = (await response.json()) as MicrosoftResponseItem[];
    if (!Array.isArray(payload) || payload.length !== texts.length) {
      throw new Error('翻译服务返回数量与请求不一致');
    }

    return payload.map((item, index) => {
      const translated = item.translations?.[0]?.text;
      return typeof translated === 'string' ? translated : texts[index]!;
    });
  }
}
