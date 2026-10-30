import { describe, expect, it } from 'vitest';
import {
  MAX_INLINE_PART_BYTES,
  isInlinablePart,
  normalizeContentId,
  referencedCids,
  resolveInlineImages,
  type InlinePartSource,
} from '../src/main/mail/inline-parts';
import { sanitizeEmailHtml } from '../src/main/security/sanitize';

/** 1×1 透明 PNG（测试侧自带期望值，不与被测代码同源）。 */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_BYTES = new Uint8Array(Buffer.from(PNG_BASE64, 'base64'));

function part(cid: string, mimeType = 'image/png', content: Uint8Array = PNG_BYTES): InlinePartSource {
  return { cid, mimeType, content };
}

describe('normalizeContentId', () => {
  it('去掉尖括号与 cid: 前缀', () => {
    expect(normalizeContentId('<logo@example.com>')).toBe('logo@example.com');
    expect(normalizeContentId('cid:logo@example.com')).toBe('logo@example.com');
    expect(normalizeContentId('  logo@example.com  ')).toBe('logo@example.com');
  });

  it('空值与非字符串一律返回 null', () => {
    expect(normalizeContentId('')).toBeNull();
    expect(normalizeContentId('   ')).toBeNull();
    expect(normalizeContentId(null)).toBeNull();
    expect(normalizeContentId(undefined)).toBeNull();
  });

  it('病态长度的 id 直接放弃', () => {
    expect(normalizeContentId(`cid:${'a'.repeat(400)}`)).toBeNull();
  });
});

describe('referencedCids', () => {
  it('按出现顺序收集并去重', () => {
    const html = '<img src="cid:a@x"><p>x</p><img src="cid:b@x"><img src="cid:a@x">';
    expect(referencedCids(html)).toEqual(['a@x', 'b@x']);
  });

  it('不误伤 data-src 之类的自定义属性', () => {
    expect(referencedCids('<img data-src="cid:zz@x">')).toEqual([]);
    expect(referencedCids('<img x-src="cid:zz@x">')).toEqual([]);
  });

  it('没有 cid 引用时返回空数组', () => {
    expect(referencedCids('<p>纯文本</p>')).toEqual([]);
    expect(referencedCids('')).toEqual([]);
  });
});

describe('isInlinablePart', () => {
  it('光栅图且在体积上限内才认为可内联', () => {
    expect(isInlinablePart('image/png', 1024)).toBe(true);
    expect(isInlinablePart('image/jpeg', 1024)).toBe(true);
    expect(isInlinablePart('image/webp', 1024)).toBe(true);
    expect(isInlinablePart('image/svg+xml', 1024)).toBe(false);
    expect(isInlinablePart('application/pdf', 1024)).toBe(false);
    expect(isInlinablePart('image/png', 0)).toBe(false);
    expect(isInlinablePart('image/png', MAX_INLINE_PART_BYTES + 1)).toBe(false);
  });
});

describe('resolveInlineImages：把 cid 还原成正文里的图', () => {
  it('命中的 cid 被改写成 data URI', () => {
    const html = '<p>你好</p><img src="cid:logo@x">';
    const result = resolveInlineImages(html, [part('logo@x')]);
    expect(result.html).toContain(`data:image/png;base64,${PNG_BASE64}`);
    expect(result.html).not.toContain('cid:logo@x');
    expect(result.usedCids).toEqual(['logo@x']);
    expect(result.skipped).toBe(0);
  });

  it('Content-ID 带尖括号也能对上正文里的裸 cid', () => {
    const html = '<img src="cid:logo@x">';
    const result = resolveInlineImages(html, [part('<logo@x>')]);
    expect(result.html).toContain('data:image/png;base64,');
    expect(result.usedCids).toEqual(['logo@x']);
  });

  it('同一张图被引用多次只算一次 usedCids，但每处都要替换', () => {
    const html = '<img src="cid:logo@x"><img src="cid:logo@x">';
    const result = resolveInlineImages(html, [part('logo@x')]);
    expect(result.usedCids).toEqual(['logo@x']);
    expect(result.html.split('data:image/png;base64,').length - 1).toBe(2);
  });

  it('找不到对应 part 时保留原样并计入 skipped（不伪造图片）', () => {
    const html = '<img src="cid:missing@x">';
    const result = resolveInlineImages(html, [part('other@x')]);
    expect(result.html).toBe(html);
    expect(result.usedCids).toEqual([]);
    expect(result.skipped).toBe(1);
  });

  it('非光栅图与超限的 part 不内联', () => {
    const pdf = part('logo@x', 'application/pdf');
    expect(resolveInlineImages('<img src="cid:logo@x">', [pdf]).skipped).toBe(1);

    const huge = part('logo@x', 'image/png', new Uint8Array(MAX_INLINE_PART_BYTES + 1));
    expect(resolveInlineImages('<img src="cid:logo@x">', [huge]).skipped).toBe(1);
  });

  it('没有 cid 引用时原样返回，不做无谓改写', () => {
    const html = '<p>普通正文</p>';
    expect(resolveInlineImages(html, [part('logo@x')]).html).toBe(html);
    expect(resolveInlineImages('', [part('logo@x')]).html).toBe('');
  });
});

describe('与净化器串起来的行为（这条是本次修复的核心）', () => {
  it('未还原的 cid 引用会被净化器整条删掉 —— 所以必须先还原', () => {
    // 守住「为什么必须要有 inline-parts 这一层」：净化器对 cid: 是丢弃的
    const cleaned = sanitizeEmailHtml('<p>你好</p><img src="cid:logo@x">');
    expect(cleaned.html).not.toContain('cid:logo@x');
    expect(cleaned.html).not.toContain('data:image');
    expect(cleaned.html).toBe('<p>你好</p><img>');
  });

  it('先还原再净化，图片就能真正显示出来', () => {
    const raw = '<p>你好</p><img src="cid:logo@x">';
    const resolved = resolveInlineImages(raw, [part('logo@x')]);
    const cleaned = sanitizeEmailHtml(resolved.html);
    expect(cleaned.html).toContain(`data:image/png;base64,${PNG_BASE64}`);
    expect(cleaned.html).toContain('<img');
  });
});
