import zhCN from './i18n/zh-CN.json';

/**
 * 轻量 i18n（§28.3）。
 * Phase 2 只覆盖外壳文案；伪本地化用于在开发/CI 中暴露写死文本与布局溢出。
 */

export type MessageKey = keyof typeof zhCN;

const catalog: Record<string, string> = zhCN;

export function t(key: MessageKey | string, vars?: Record<string, string | number>): string {
  const template = catalog[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : `{${name}}`,
  );
}

const PSEUDO_MAP: Record<string, string> = {
  a: 'á', b: 'ƀ', c: 'ç', d: 'ð', e: 'é', f: 'ƒ', g: 'ĝ', h: 'ĥ', i: 'í', j: 'ĵ',
  k: 'ķ', l: 'ĺ', m: 'ɱ', n: 'ñ', o: 'ó', p: 'þ', q: 'q', r: 'ŕ', s: 'š', t: 'ţ',
  u: 'ú', v: 'ṽ', w: 'ŵ', x: 'ẋ', y: 'ý', z: 'ž',
};

export function pseudoLocalize(text: string): string {
  const mapped = text.replace(/[a-z]/gi, (character) => {
    const replacement = PSEUDO_MAP[character.toLowerCase()];
    return replacement ?? character;
  });
  return `⟦${mapped}⟧`;
}

export function pseudoMessage(key: MessageKey | string): string {
  return pseudoLocalize(t(key));
}

export function catalogKeys(): string[] {
  return Object.keys(catalog);
}
