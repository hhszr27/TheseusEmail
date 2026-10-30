import { afterEach, describe, expect, it } from 'vitest';
import { TranslationService } from '../src/main/translation/service';
import { MicrosoftTranslator, MICROSOFT_ENDPOINT } from '../src/main/translation/microsoft';
import type { SecretStore } from '../src/main/mail/auth/token-store';
import type { EmailsRepo } from '../src/main/db/repositories/emails-repo';
import type { TranslationProvider } from '../src/shared/types';
import {
  LONG_TEXT_CHARS,
  applyTranslations,
  chunkTexts,
  collectTranslatableText,
  looksLikeLanguage,
  splitTranslatable,
  totalChars,
} from '../src/shared/translation';
import { createTestDb, type TestDb } from './helpers/test-db';

let context: TestDb | null = null;

afterEach(() => {
  context?.cleanup();
  context = null;
});

const EN_TEXT = `Hello team,\nThe budget review is scheduled for next Monday.\nPlease send your numbers before Friday.\n\n> On Mon, someone wrote:\n> old quoted text\n\n-- \nAlice`;

function fakeSecrets(present = true): SecretStore {
  return {
    has: async () => present,
    get: async () => (present ? 'test-key' : null),
    set: async () => undefined,
    delete: async () => undefined,
    logPresence: async () => undefined,
  } as unknown as SecretStore;
}

function fakeEmails(text: string, html: string | null = null): EmailsRepo {
  return {
    get: () => ({ id: 'e1', subject: 'subject' }),
    getBody: () => ({ html, text }),
  } as unknown as EmailsRepo;
}

function fakeTranslator(counter: { calls: number }): TranslationProvider {
  return {
    id: 'fake-translator',
    name: 'Fake Translator',
    supportedLanguages: ['zh-Hans', 'en'],
    async translate(texts: string[]): Promise<string[]> {
      counter.calls += 1;
      return texts.map((text) => `[译] ${text}`);
    },
  };
}

describe('翻译文本切分（§14.3）', () => {
  it('跳过引用与签名', () => {
    const segments = splitTranslatable(EN_TEXT);
    const translatable = collectTranslatableText(segments);
    expect(translatable[0]).toContain('Hello team');
    expect(translatable.join('\n')).not.toContain('old quoted text');
    expect(translatable.join('\n')).not.toContain('Alice');

    const reasons = segments.filter((segment) => !segment.translatable).map((segment) => segment.reason);
    expect(reasons).toContain('quote');
    expect(reasons).toContain('signature');
  });

  it('引用头之后的无标记历史行也跳过', () => {
    const text = ['Hello team', 'On Mon, Bob wrote:', 'This is quoted history without markers', 'New reply'].join(
      '\n',
    );
    const segments = splitTranslatable(text);
    const translatable = collectTranslatableText(segments);
    expect(translatable).toEqual(['Hello team']);
  });

  it('回填译文保持原有结构', () => {
    const segments = splitTranslatable('Hello\n\n> quoted\n-- \nsig');
    const translated = applyTranslations(
      segments,
      collectTranslatableText(segments).map((text) => `译:${text}`),
    );
    expect(translated).toContain('译:Hello');
    expect(translated).toContain('> quoted');
    expect(translated).toContain('sig');
  });

  it('目标语言判定保守', () => {
    expect(looksLikeLanguage('这是一封中文邮件，内容足够长用于判断。', 'zh-Hans')).toBe(true);
    expect(looksLikeLanguage('This is an English email body with enough letters.', 'en')).toBe(true);
    expect(looksLikeLanguage('This is an English email body with enough letters.', 'zh-Hans')).toBe(false);
    expect(looksLikeLanguage('短', 'zh-Hans')).toBe(false);
  });

  it('请求分组受字符与条目上限约束', () => {
    const chunks = chunkTexts(['a'.repeat(3000), 'b'.repeat(3000), 'c'], 4000, 25);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(1);
    expect(chunks[1]).toHaveLength(2);
    expect(totalChars(['中文', 'abc'])).toBe(5);
  });
});

describe('Microsoft Translator 适配器（§14.2）', () => {
  it('发送官方端点、密钥头与文本数组', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(
        JSON.stringify([{ translations: [{ text: '你好', to: 'zh-Hans' }] }]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const translator = new MicrosoftTranslator({
      apiKey: 'secret',
      region: 'eastasia',
      fetchImpl,
    });
    const result = await translator.translate(['Hello'], 'zh-Hans');

    expect(result).toEqual(['你好']);
    expect(capturedUrl.startsWith(`${MICROSOFT_ENDPOINT}/translate`)).toBe(true);
    expect(capturedUrl).toContain('to=zh-Hans');
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers['Ocp-Apim-Subscription-Key']).toBe('secret');
    expect(headers['Ocp-Apim-Subscription-Region']).toBe('eastasia');
    expect(JSON.parse(String(capturedInit?.body))).toEqual([{ Text: 'Hello' }]);
  });

  it('非 200 抛出可读错误', async () => {
    const translator = new MicrosoftTranslator({
      apiKey: 'k',
      fetchImpl: (async () => new Response('nope', { status: 429 })) as unknown as typeof fetch,
    });
    await expect(translator.translate(['x'], 'zh-Hans')).rejects.toThrow('HTTP 429');
  });
});

describe('翻译服务（§14.3 / §14.4）', () => {
  it('未启用时返回不可用', async () => {
    context = createTestDb();
    const service = new TranslationService(context.db, fakeSecrets(), fakeEmails(EN_TEXT));
    const result = await service.translateEmail('e1');
    expect(result.status).toBe('unavailable');
  });

  it('启用后翻译并缓存，第二次不重复调用', async () => {
    context = createTestDb();
    const counter = { calls: 0 };
    const service = new TranslationService(
      context.db,
      fakeSecrets(),
      fakeEmails(EN_TEXT),
      () => fakeTranslator(counter),
    );
    await service.update({ enabled: true, targetLang: 'zh-Hans', apiKey: 'k' });

    const first = await service.translateEmail('e1');
    expect(first.status).toBe('ok');
    if (first.status !== 'ok') return;
    expect(first.cached).toBe(false);
    expect(first.text).toContain('[译] Hello team');
    expect(first.text).not.toContain('[译] old quoted text');
    expect(first.provider).toBe('fake-translator');

    const second = await service.translateEmail('e1');
    expect(second.status).toBe('ok');
    if (second.status !== 'ok') return;
    expect(second.cached).toBe(true);
    expect(counter.calls).toBe(1);
    expect(service.cacheCount()).toBe(1);
  });

  it('长文本先确认，确认后继续', async () => {
    context = createTestDb();
    const counter = { calls: 0 };
    const longText = 'word '.repeat(LONG_TEXT_CHARS / 5 + 200);
    const service = new TranslationService(
      context.db,
      fakeSecrets(),
      fakeEmails(longText),
      () => fakeTranslator(counter),
    );
    await service.update({ enabled: true });

    const pending = await service.translateEmail('e1');
    expect(pending.status).toBe('needs_confirm');
    expect(counter.calls).toBe(0);

    const confirmed = await service.translateEmail('e1', undefined, true);
    expect(confirmed.status).toBe('ok');
    expect(counter.calls).toBeGreaterThanOrEqual(1);
  });

  it('已是目标语言时跳过', async () => {
    context = createTestDb();
    const service = new TranslationService(
      context.db,
      fakeSecrets(),
      fakeEmails('这是一封足够长的中文邮件正文，用于判断语言是否已经是目标语言。'),
      () => fakeTranslator({ calls: 0 }),
    );
    await service.update({ enabled: true, targetLang: 'zh-Hans' });
    const result = await service.translateEmail('e1');
    expect(result).toEqual({ status: 'skipped', reason: 'same-language' });
  });

  it('缺少密钥时给出可读提示', async () => {
    context = createTestDb();
    const service = new TranslationService(context.db, fakeSecrets(false), fakeEmails(EN_TEXT));
    await service.update({ enabled: true, apiKey: '' });
    const result = await service.translateEmail('e1');
    expect(result.status).toBe('unavailable');
  });
});
