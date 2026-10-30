import { describe, expect, it } from 'vitest';
import { parseMailtoUrl } from '../src/main/app/mailto';

describe('mailto 解析（§31.1）', () => {
  it('解析收件人、抄送、主题与正文', () => {
    const result = parseMailtoUrl(
      'mailto:a@example.com,b@example.com?cc=c@example.com&subject=Hello%20World&body=Line%201%0ALine%202',
    );
    expect(result).not.toBeNull();
    expect(result?.to).toEqual(['a@example.com', 'b@example.com']);
    expect(result?.cc).toEqual(['c@example.com']);
    expect(result?.subject).toBe('Hello World');
    expect(result?.body).toBe('Line 1\nLine 2');
  });

  it('拒绝非 mailto 协议', () => {
    expect(parseMailtoUrl('https://example.com')).toBeNull();
    expect(parseMailtoUrl('javascript:alert(1)')).toBeNull();
    expect(parseMailtoUrl('')).toBeNull();
  });

  it('仅收件人也可解析', () => {
    const result = parseMailtoUrl('mailto:someone@example.com');
    expect(result?.to).toEqual(['someone@example.com']);
    expect(result?.subject).toBe('');
  });
});
