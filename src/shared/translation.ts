/**
 * 翻译模块的纯逻辑（§14.3）：
 * 引用/签名跳过、语言判定、字符量估算与请求分组。
 */

export interface TextSegment {
  text: string;
  translatable: boolean;
  reason?: 'quote' | 'signature' | 'empty';
}

const QUOTE_LINE = /^\s*>/;
const QUOTE_HEADER =
  /^\s*(on .+wrote:|-{2,}\s*original message\s*-{2,}|-{2,}\s*原始邮件\s*-{2,}|发件人[:：]|from:\s.+|在.+写道[:：]?)\s*$/i;

/**
 * 拆分正文为可翻译段与跳过段。
 * 规则：`>` 引用、标准回复头之后的内容、签名分隔符（-- ）之后的内容都跳过。
 */
export function splitTranslatable(input: string): TextSegment[] {
  const normalized = input.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const segments: TextSegment[] = [];

  let quoteMode = false;
  let signatureMode = false;

  for (const line of lines) {
    if (signatureMode) {
      segments.push({ text: line, translatable: false, reason: 'signature' });
      continue;
    }

    if (/^--\s*$/.test(line)) {
      signatureMode = true;
      segments.push({ text: line, translatable: false, reason: 'signature' });
      continue;
    }

    if (!quoteMode && QUOTE_HEADER.test(line)) {
      quoteMode = true;
      segments.push({ text: line, translatable: false, reason: 'quote' });
      continue;
    }

    if (QUOTE_LINE.test(line)) {
      segments.push({ text: line, translatable: false, reason: 'quote' });
      continue;
    }

    if (line.trim() === '') {
      segments.push({ text: line, translatable: false, reason: 'empty' });
      continue;
    }

    segments.push({ text: line, translatable: !quoteMode, ...(quoteMode ? { reason: 'quote' as const } : {}) });
  }

  return segments;
}

export function joinSegments(segments: TextSegment[]): string {
  return segments.map((segment) => segment.text).join('\n');
}

/** 只翻译可翻译行，保留原文骨架用于回填。 */
export function collectTranslatableText(segments: TextSegment[]): string[] {
  return segments.filter((segment) => segment.translatable).map((segment) => segment.text);
}

export function applyTranslations(segments: TextSegment[], translations: string[]): string {
  let cursor = 0;
  return segments
    .map((segment) => {
      if (!segment.translatable) return segment.text;
      const value = translations[cursor] ?? segment.text;
      cursor += 1;
      return value;
    })
    .join('\n');
}

/** 以 Unicode 码点计字符数（与翻译服务的计费口径一致）。 */
export function countChars(text: string): number {
  return Array.from(text).length;
}

export function totalChars(texts: string[]): number {
  return texts.reduce((sum, text) => sum + countChars(text), 0);
}

/** 长文本阈值：超过后需要用户确认额度消耗（§14.3）。 */
export const LONG_TEXT_CHARS = 6000;

export function needsQuotaConfirm(chars: number): boolean {
  return chars > LONG_TEXT_CHARS;
}

export function quotaNotice(chars: number): string {
  return `此邮件较长，翻译将消耗约 ${chars} 字符额度。是否继续？`;
}

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
const LATIN = /[A-Za-z]/g;

/**
 * 保守的语言判定：只在“明显已经是目标语言”时返回 true，
 * 避免因为少量混排文本而跳过用户真正需要的翻译。
 */
export function looksLikeLanguage(text: string, targetLang: string): boolean {
  const sample = text.slice(0, 4000);
  const total = sample.replace(/\s/g, '').length;
  if (total < 12) return false;

  const cjk = sample.match(CJK)?.length ?? 0;
  const latin = sample.match(LATIN)?.length ?? 0;
  const normalized = targetLang.toLowerCase();

  if (normalized.startsWith('zh') || normalized.startsWith('ja') || normalized.startsWith('ko')) {
    return cjk / total > 0.5;
  }
  if (normalized.startsWith('en')) {
    return latin / total > 0.85 && cjk === 0;
  }
  return false;
}

/** Microsoft Translator 单请求上限内分组：<= 25 段且 <= 4000 字符。 */
export function chunkTexts(texts: string[], maxChars = 4000, maxItems = 25): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentChars = 0;

  for (const text of texts) {
    const length = countChars(text);
    if (current.length > 0 && (currentChars + length > maxChars || current.length >= maxItems)) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(text);
    currentChars += length;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** 翻译缓存键：邮件 ID + 目标语言 + 文本哈希（§14.3）。 */
export function translationCacheKey(emailId: string, targetLang: string, sourceHash: string): string {
  return `${emailId}|${targetLang}|${sourceHash}`;
}
