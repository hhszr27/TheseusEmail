import { describe, expect, it } from 'vitest';
import { catalogKeys, pseudoLocalize, pseudoMessage, t } from '../src/shared/i18n';

describe('i18n 与伪本地化（§28.3）', () => {
  it('文案插值', () => {
    expect(t('app.status.search', { query: '预算', count: 3 })).toContain('预算');
    expect(t('app.status.search', { query: '预算', count: 3 })).toContain('3');
  });

  it('缺失 key 回退为 key 本身（不抛异常）', () => {
    expect(t('missing.key')).toBe('missing.key');
  });

  it('伪本地化包裹并替换 ASCII 字母', () => {
    const pseudo = pseudoLocalize('Hi');
    expect(pseudo.startsWith('⟦')).toBe(true);
    expect(pseudo).not.toBe('Hi');
    expect(pseudoMessage('toolbar.refresh')).toContain('⟦');
  });

  it('目录包含外壳文案', () => {
    const keys = catalogKeys();
    expect(keys).toContain('toolbar.refresh');
    expect(keys).toContain('app.status.folder');
  });
});
