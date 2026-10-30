import type { MailtoRequest } from '../../shared/ipc';

/**
 * mailto: 解析（§31.1）。纯函数，便于测试。
 * 仅接受 mailto: scheme；收件人按 RFC 6068 用逗号分隔。
 */
export function parseMailtoUrl(raw: string): MailtoRequest | null {
  const input = (raw ?? '').trim();
  if (!/^mailto:/i.test(input)) return null;

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }

  if (url.protocol.toLowerCase() !== 'mailto:') return null;

  const splitList = (value: string): string[] =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);

  const to = splitList(decodeURIComponent(url.pathname));
  const cc = splitList(url.searchParams.get('cc') ?? '');
  const subject = url.searchParams.get('subject') ?? '';
  const body = url.searchParams.get('body') ?? '';

  return { to, cc, subject, body, raw: input };
}
